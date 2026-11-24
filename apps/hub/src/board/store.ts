import { useEffect, useReducer, useState } from "react";
import {
  displayName,
  type BoardState,
  type Device,
  type HubEvent,
  type Person,
  type Session,
  type StreamMessage,
} from "../shared/types";
import { SignedOut, api } from "./api";
import { setServerOffset } from "./time";

export type Conn = "connecting" | "live" | "reconnecting";

export interface Model {
  project: BoardState["project"];
  me: Person;
  people: Person[];
  devices: Record<string, Device>;
  sessions: Record<string, Session>;
  /** Newest first, deduped on (deviceId, id). */
  events: HubEvent[];
  /** Keys of rows that arrived while the board was open; only these animate in. */
  fresh: Set<string>;
}

type Action =
  | { type: "snapshot"; state: BoardState }
  | { type: "msg"; msg: StreamMessage }
  | { type: "history"; events: HubEvent[] };

const MAX_EVENTS = 3000;
export const eventKey = (e: Pick<HubEvent, "deviceId" | "id">) => `${e.deviceId}:${e.id}`;

function mergeEvents(existing: HubEvent[], incoming: HubEvent[]): HubEvent[] {
  if (!incoming.length) return existing;
  const seen = new Set(existing.map(eventKey));
  const add = incoming.filter((e) => !seen.has(eventKey(e)));
  if (!add.length) return existing;
  return [...add, ...existing].sort((a, b) => b.ts - a.ts).slice(0, MAX_EVENTS);
}

function withPerson(people: Person[], email: string): Person[] {
  return people.some((p) => p.email === email) ? people : [...people, { email, name: displayName(email) }];
}

function reducer(model: Model | null, action: Action): Model | null {
  if (action.type === "snapshot") {
    const s = action.state;
    return {
      project: s.project,
      me: s.me,
      people: s.people,
      devices: Object.fromEntries(s.devices.map((d) => [d.id, d])),
      sessions: Object.fromEntries(s.sessions.map((x) => [x.hubKey, x])),
      events: mergeEvents(model?.events ?? [], s.events),
      fresh: model?.fresh ?? new Set(),
    };
  }
  if (!model) return model;
  if (action.type === "history") return { ...model, events: mergeEvents(model.events, action.events) };

  const msg = action.msg;
  switch (msg.type) {
    case "hello":
      return model;
    case "device": {
      const devices = { ...model.devices };
      if (msg.device.revokedAt != null) delete devices[msg.device.id];
      else devices[msg.device.id] = msg.device;
      return { ...model, devices, people: withPerson(model.people, msg.device.email) };
    }
    case "session": {
      const isNew = !model.sessions[msg.session.hubKey];
      const fresh = isNew ? new Set(model.fresh).add(msg.session.hubKey) : model.fresh;
      return {
        ...model,
        sessions: { ...model.sessions, [msg.session.hubKey]: msg.session },
        people: withPerson(model.people, msg.session.email),
        fresh,
      };
    }
    case "events": {
      const fresh = new Set(model.fresh);
      for (const e of msg.events) fresh.add(eventKey(e));
      if (fresh.size > 2 * MAX_EVENTS) {
        const keep = [...fresh].slice(-MAX_EVENTS);
        fresh.clear();
        for (const k of keep) fresh.add(k);
      }
      return { ...model, events: mergeEvents(model.events, msg.events), fresh };
    }
  }
}

/**
 * Board state from /api/state, kept current by /api/stream. On every (re)connect the board refetches the snapshot
 * and replays whatever the socket delivered meanwhile, so a dropped socket never leaves it stale.
 */
export function useBoard() {
  const [model, dispatch] = useReducer(reducer, null);
  const [conn, setConn] = useState<Conn>("connecting");
  const [signedOut, setSignedOut] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let buffer: StreamMessage[] | null = null;
    let lastHeard = Date.now();

    const stop = () => {
      stopped = true;
      clearTimeout(retryTimer);
      ws?.close();
    };

    async function refetch() {
      const replay: StreamMessage[] = (buffer ??= []);
      try {
        const s = await api.state();
        setServerOffset(s.serverNow - Date.now());
        dispatch({ type: "snapshot", state: s });
        for (const m of replay) dispatch({ type: "msg", msg: m });
        setLoadError(false);
      } catch (err) {
        if (err instanceof SignedOut) {
          setSignedOut(true);
          stop();
        } else setLoadError(true);
      } finally {
        if (buffer === replay) buffer = null;
      }
    }

    function connect() {
      if (stopped) return;
      const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/stream`);
      ws = sock;
      sock.onopen = () => {
        attempt = 0;
        lastHeard = Date.now();
        setConn("live");
        void refetch();
      };
      sock.onmessage = (m) => {
        lastHeard = Date.now();
        if (m.data === "pong" || typeof m.data !== "string") return;
        let msg: StreamMessage;
        try {
          msg = JSON.parse(m.data);
        } catch {
          return;
        }
        if (buffer) buffer.push(msg);
        else dispatch({ type: "msg", msg });
      };
      sock.onclose = () => {
        if (ws !== sock) return;
        ws = null;
        if (stopped) return;
        setConn("reconnecting");
        // Keep the board correct while the socket is down, and notice an expired Access session.
        void refetch();
        const delay = Math.min(30_000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
        attempt++;
        retryTimer = setTimeout(connect, delay);
      };
      sock.onerror = () => sock.close();
    }

    const ping = setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastHeard > 70_000) ws.close();
      else ws.send("ping");
    }, 25_000);

    const wake = () => {
      if (stopped || document.visibilityState !== "visible") return;
      if (!ws) {
        clearTimeout(retryTimer);
        attempt = 0;
        connect();
      }
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);

    void refetch();
    connect();
    return () => {
      stop();
      clearInterval(ping);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);

  const loadHistory = async (hubKey: string, before?: number) => {
    const { events } = await api.sessionEvents(hubKey, before);
    dispatch({ type: "history", events });
    return events.length;
  };

  return { model, conn, signedOut, loadError, loadHistory };
}

import { displayName, isOffline, type Device, type Person, type Session, type ShareLevel } from "../shared/types";
import type { Model } from "./store";

export interface SessionView extends Session {
  offline: boolean;
  person: string;
  machine: string | null;
  /** The device's sharing level (null: a relay from before v0.2, metadata). */
  share: ShareLevel | null;
}

export interface RepoGroup {
  repo: string | null;
  sessions: SessionView[];
}

export interface Lane {
  person: Person;
  isMe: boolean;
  online: boolean;
  lastSeenAt: number | null;
  devices: Device[];
  groups: RepoGroup[];
  dormant: SessionView[];
  working: number;
  waiting: number;
  /** Every machine this person connected shares activity only (SPEC.md §8). */
  activityOnly: boolean;
}

export interface BoardView {
  sessions: Record<string, SessionView>;
  waiting: SessionView[];
  lanes: Lane[];
  agentsWorking: number;
  peopleOnline: number;
  hasDevices: boolean;
}

const STATE_RANK: Record<string, number> = { working: 0, waiting: 1, idle: 2, ended: 3 };

export function repoName(repo: string | null): string {
  if (!repo) return "No repo";
  return repo.split("/").pop() ?? repo;
}

export function derive(model: Model, now: number): BoardView {
  const nameOf = new Map(model.people.map((p) => [p.email, p.name]));
  const sessions: Record<string, SessionView> = {};
  for (const s of Object.values(model.sessions)) {
    const device = model.devices[s.deviceId];
    if (!device) continue; // revoked or unknown device
    sessions[s.hubKey] = {
      ...s,
      offline: s.state !== "ended" && isOffline(device, now),
      person: nameOf.get(s.email) ?? displayName(s.email),
      machine: device.machine,
      share: device.share ?? null,
    };
  }
  const all = Object.values(sessions);
  const me = model.me.email;

  const waiting = all
    .filter((s) => s.state === "waiting" && !s.offline)
    .sort((a, b) => Number(b.email === me) - Number(a.email === me) || a.stateSince - b.stateSince);

  const emails = new Set<string>([
    ...model.people.map((p) => p.email),
    ...Object.values(model.devices).map((d) => d.email),
  ]);
  const people = [...emails]
    .map((email) => ({ email, name: nameOf.get(email) ?? displayName(email) }))
    .sort((a, b) => Number(b.email === me) - Number(a.email === me) || a.name.localeCompare(b.name));

  let agentsWorking = 0;
  let peopleOnline = 0;
  const lanes: Lane[] = [];
  for (const person of people) {
    const devices = Object.values(model.devices).filter((d) => d.email === person.email);
    const online = devices.some((d) => !isOffline(d, now));
    if (online) peopleOnline++;
    const lastSeenAt = devices.reduce<number | null>((m, d) => (d.lastSeenAt && d.lastSeenAt > (m ?? 0) ? d.lastSeenAt : m), null);
    const mine = all.filter((s) => s.email === person.email);
    const active = mine
      .filter((s) => s.state !== "ended" && !s.offline)
      .sort((a, b) => STATE_RANK[a.state]! - STATE_RANK[b.state]! || a.startedAt - b.startedAt);
    const dormant = mine
      .filter((s) => s.state === "ended" || s.offline)
      .sort((a, b) => (b.endedAt ?? b.lastEventAt ?? b.updatedAt) - (a.endedAt ?? a.lastEventAt ?? a.updatedAt));
    const byRepo = new Map<string | null, SessionView[]>();
    for (const s of active) {
      const list = byRepo.get(s.repo) ?? [];
      list.push(s);
      byRepo.set(s.repo, list);
    }
    const groups = [...byRepo.entries()]
      .map(([repo, list]) => ({ repo, sessions: list }))
      .sort((a, b) => (a.repo === null ? 1 : b.repo === null ? -1 : repoName(a.repo).localeCompare(repoName(b.repo))));
    let working = 0;
    let waitingCount = 0;
    for (const s of active) {
      if (s.state === "working") {
        working++;
        agentsWorking += s.agents ?? 1;
      } else if (s.state === "waiting") waitingCount++;
    }
    lanes.push({
      person,
      isMe: person.email === me,
      online,
      lastSeenAt,
      devices,
      groups,
      dormant,
      working,
      waiting: waitingCount,
      activityOnly: devices.length > 0 && devices.every((d) => d.share !== "conversation"),
    });
  }

  return {
    sessions,
    waiting,
    lanes,
    agentsWorking,
    peopleOnline,
    hasDevices: Object.keys(model.devices).length > 0 || all.length > 0,
  };
}

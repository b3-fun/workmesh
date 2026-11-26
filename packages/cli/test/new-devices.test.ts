import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hubSyncAcceptSchema } from "@workmesh/protocol";
import type { HubNewDeviceAccepted, HubSyncResponse } from "@workmesh/protocol";
import type { AgentSession, SessionEvent } from "@workmesh/core";
import { CoordClient } from "../src/hub/coord";
import { CoordHooks } from "../src/daemon/coord-hooks";
import { COORD_OPS, runCoordOp } from "../src/daemon/coord-ops";
import type { CoordOpsDeps } from "../src/daemon/coord-ops";
import { NEW_DEVICE_MAX_REMEMBERED, NEW_DEVICE_NOTICE_MS, NewDeviceNotices, agoWords, newDeviceText } from "../src/daemon/new-devices";
import { createDaemonServer } from "../src/daemon/server";
import type { DaemonServerDeps, TeamState } from "../src/daemon/server";
import { newMachineChecks } from "../src/commands/doctor";
import { runStatus } from "../src/commands/status";

/** New machines on a person's account, relay side (docs/SPEC.md §46, §47): told to the person once, never to an agent. */

const TOKEN = `bp_${"e".repeat(64)}`;
const DEV = "dev_01JD0000000000000000000000";
const T = 1_795_545_600_000;
const BOARD = "https://hub.test";
const ME = `${DEV}:claude-code:s1`;
const ROOT = "/w/workmesh";

const LAPTOP: HubNewDeviceAccepted = {
  id: "dev_01JD0000000000000000000002",
  machine: "sams-laptop",
  pairedAt: T - 5 * 60_000,
  where: "Lisbon, Portugal (Example Telecom)",
};
const BOX: HubNewDeviceAccepted = { id: "dev_01JD0000000000000000000003", machine: "sams-box", pairedAt: T - 60_000, where: undefined };

const SYNC: HubSyncResponse = {
  cursor: "c1",
  serverNow: T,
  me: { person: "Sam Lee" },
  leases: [],
  holds: [],
  inbox: [],
  claims: [],
  roster: [],
  notes: [],
  edits: [],
};

describe("new machine notices: the daemon's list", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-newdev-"));
    file = path.join(dir, "state", "new-devices.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const store = (now: () => number = () => T, log: string[] = []) => new NewDeviceNotices({ file, now, log: (m) => log.push(m) });

  it("tells the person about a new machine once, in the words of the notice", () => {
    const log: string[] = [];
    const s = store(() => T, log);
    const told = s.observe([LAPTOP], { board: BOARD });
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ id: LAPTOP.id, machine: "sams-laptop", where: "Lisbon, Portugal (Example Telecom)", pairedAt: LAPTOP.pairedAt, toldAt: T });
    expect(told[0]?.text).toBe(
      "A new machine joined your Workmesh account: sams-laptop, 5 minutes ago, from Lisbon, Portugal (Example Telecom). " +
        "If this wasn't you, remove it on the board: https://hub.test",
    );
    expect(log).toEqual([`hub: ${told[0]?.text} (device ${LAPTOP.id})`]);

    // The hub lists it on every sync for a day: nothing more is said.
    expect(s.observe([LAPTOP], { board: BOARD })).toEqual([]);
    expect(s.observe([LAPTOP, BOX], { board: BOARD }).map((n) => n.machine)).toEqual(["sams-box"]);
    expect(log).toHaveLength(2);
    expect(s.active().map((n) => n.machine)).toEqual(["sams-box", "sams-laptop"]); // newest first
  });

  it("words the notice without a place, a name or a time when the hub gave none", () => {
    expect(newDeviceText({ machine: "sams-box", pairedAt: T - 60_000 }, BOARD, T)).toBe(
      "A new machine joined your Workmesh account: sams-box, 1 minute ago. If this wasn't you, remove it on the board: https://hub.test",
    );
    const s = store();
    const [n] = s.observe([{ id: "d1", machine: "", pairedAt: 0, where: undefined }], { board: BOARD });
    expect(n?.machine).toBe("an unnamed machine");
    expect(n?.text).toBe("A new machine joined your Workmesh account: an unnamed machine, recently. If this wasn't you, remove it on the board: https://hub.test");
    expect([agoWords(T, T), agoWords(T - 59_000, T), agoWords(T - 3_600_000, T), agoWords(T - 47 * 3_600_000, T), agoWords(T - 72 * 3_600_000, T)]).toEqual([
      "just now",
      "just now",
      "1 hour ago",
      "47 hours ago",
      "3 days ago",
    ]);
    // The hub's clock ahead of this one never reads as a time to come.
    expect(agoWords(T + 30_000, T)).toBe("just now");
  });

  it("puts a name and a place from the hub on one line, without escape sequences or invisible characters", () => {
    const esc = String.fromCharCode(27);
    const hidden = String.fromCodePoint(0x202e, 0x200b);
    const s = store();
    const [n] = s.observe(
      [{ id: "d1", machine: `sams${hidden}-laptop\n${esc}[2J`, pairedAt: T, where: `Lisbon\r\n\tPortugal${esc}]0;title${String.fromCharCode(7)}. ` }],
      { board: BOARD },
    );
    expect(n?.machine).toBe("sams-laptop");
    expect(n?.where).toBe("Lisbon Portugal");
    expect(n?.text).toBe(
      "A new machine joined your Workmesh account: sams-laptop, just now, from Lisbon Portugal. " +
        "If this wasn't you, remove it on the board: https://hub.test",
    );
    const [long] = s.observe([{ id: "d2", machine: "m".repeat(500), pairedAt: T, where: "w".repeat(500) }], { board: BOARD });
    expect(long?.machine).toHaveLength(80);
    expect(long?.where).toHaveLength(120);
    expect(long?.text.split("\n")).toHaveLength(1);
  });

  it("never tells a machine about itself", () => {
    const s = store();
    expect(s.observe([{ ...LAPTOP, id: DEV }, BOX], { board: BOARD, self: DEV }).map((n) => n.id)).toEqual([BOX.id]);
  });

  it("survives a daemon restart: saved 0600, not told again, and the notice is still up", () => {
    const log: string[] = [];
    store(() => T, log).observe([LAPTOP], { board: BOARD });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(log).toHaveLength(1);

    const later = T + 60 * 60_000;
    const again = store(() => later, log);
    expect(again.observe([LAPTOP], { board: BOARD })).toEqual([]);
    expect(log).toHaveLength(1);
    expect(again.active(later)).toEqual([
      {
        id: LAPTOP.id,
        machine: "sams-laptop",
        where: "Lisbon, Portugal (Example Telecom)",
        pairedAt: LAPTOP.pairedAt,
        toldAt: T,
        text:
          "A new machine joined your Workmesh account: sams-laptop, 1 hour ago, from Lisbon, Portugal (Example Telecom). " +
          "If this wasn't you, remove it on the board: https://hub.test",
      },
    ]);
  });

  it("a notice stays up for 24 hours, or until it is dismissed; either way the machine is not told again", () => {
    let now = T;
    const s = store(() => now);
    s.observe([LAPTOP, BOX], { board: BOARD });
    expect(s.dismiss("dev_unknown")).toBe(false);
    expect(s.dismiss(LAPTOP.id)).toBe(true);
    expect(s.dismiss(LAPTOP.id)).toBe(false);
    expect(s.active().map((n) => n.id)).toEqual([BOX.id]);
    // Dismissed is saved too.
    expect(store(() => now).active().map((n) => n.id)).toEqual([BOX.id]);

    now = T + NEW_DEVICE_NOTICE_MS - 1;
    expect(s.active().map((n) => n.id)).toEqual([BOX.id]);
    now = T + NEW_DEVICE_NOTICE_MS;
    expect(s.active()).toEqual([]);
    expect(s.observe([LAPTOP, BOX], { board: BOARD })).toEqual([]);
    expect(store(() => now).observe([LAPTOP, BOX], { board: BOARD })).toEqual([]);
  });

  it("a state file from an older daemon still loads: fewer fields, or none of this at all", () => {
    // Entries with only an id, or without the newer fields (no place, no board, no dismissal, no version).
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ devices: [{ id: LAPTOP.id }, { id: BOX.id, machine: "sams-box", toldAt: T - 1000 }, { machine: "no id" }, 7, null] }));
    const log: string[] = [];
    const s = store(() => T, log);
    const third: HubNewDeviceAccepted = { id: "dev_01JD0000000000000000000004", machine: "sams-desktop", pairedAt: T, where: undefined };
    expect(s.observe([LAPTOP, BOX, third], { board: BOARD }).map((n) => n.machine)).toEqual(["sams-desktop"]);
    expect(log).toHaveLength(1);
    // The one without a time was told at some earlier point: remembered, no longer shown.
    expect(s.active().map((n) => n.id)).toEqual([third.id, BOX.id]);
    expect(s.active()[1]?.text).toBe("A new machine joined your Workmesh account: sams-box, recently. If this wasn't you, remove it on the board.");

    // A daemon that never wrote the file, and a file that isn't the list, both start empty and then save.
    for (const content of [undefined, "", "not json", "[]", '{"devices":"none"}', '{"v":9}', "null"]) {
      fs.rmSync(file, { force: true });
      if (content !== undefined) fs.writeFileSync(file, content);
      const fresh = store();
      expect(fresh.active(), String(content)).toEqual([]);
      expect(fresh.observe([LAPTOP], { board: BOARD }), String(content)).toHaveLength(1);
      expect(store().observe([LAPTOP], { board: BOARD }), String(content)).toEqual([]);
    }
  });

  it("remembers at most 200 machines, and never forgets one the hub still lists", () => {
    let now = T;
    const s = store(() => now);
    const dev = (i: number): HubNewDeviceAccepted => ({ id: `d${i}`, machine: `m${i}`, pairedAt: T, where: undefined });
    for (let i = 0; i < NEW_DEVICE_MAX_REMEMBERED + 60; i += 30) {
      now += 1000;
      s.observe(Array.from({ length: 30 }, (_, k) => dev(i + k)), { board: BOARD });
    }
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { devices: Array<{ id: string }> };
    expect(saved.devices).toHaveLength(NEW_DEVICE_MAX_REMEMBERED);
    expect(saved.devices[0]?.id).toBe("d70"); // the oldest went first
    // The newest are still listed by the hub: still remembered, so not told again.
    expect(s.observe([dev(269), dev(240)], { board: BOARD })).toEqual([]);

    // Over the cap with an old one still listed: the old one stays, others go.
    const kept = dev(70);
    const more = Array.from({ length: 30 }, (_, k) => dev(1000 + k));
    expect(s.observe([kept, ...more], { board: BOARD })).toHaveLength(30);
    expect(s.observe([kept], { board: BOARD })).toEqual([]);
  });

  it("works without a file (memory only), and a failed save is logged, not thrown", () => {
    const s = new NewDeviceNotices({ now: () => T });
    expect(s.observe([LAPTOP], { board: BOARD })).toHaveLength(1);
    const log: string[] = [];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "blocker"), "a file where the state directory should be");
    const blocked = new NewDeviceNotices({ file: path.join(dir, "blocker", "new-devices.json"), now: () => T, log: (m) => log.push(m) });
    expect(blocked.observe([LAPTOP], { board: BOARD })).toHaveLength(1);
    expect(log.some((m) => m.startsWith("new machines: could not save the list"))).toBe(true);
  });
});

// ---------------------------------------------------------------- the sync client

function fakeHub(bodies: unknown[]) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify(bodies.shift() ?? SYNC), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("the sync client hands new machines to the notice only", () => {
  it("reads the list off the wire, passes it on with the hub's clock, and keeps it out of the cached state", async () => {
    const seen: Array<{ list: readonly HubNewDeviceAccepted[]; hubNow: number }> = [];
    const hub = fakeHub([{ ...SYNC, serverNow: T + 90_000, newDevices: [LAPTOP, { id: 7 }, BOX] }, SYNC, { ...SYNC, newDevices: [] }]);
    const c = new CoordClient({
      url: BOARD,
      token: TOKEN,
      deviceId: DEV,
      fetchImpl: hub.fetchImpl,
      now: () => T,
      onNewDevices: (list, hubNow) => seen.push({ list, hubNow }),
    });
    await c.sync();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.list.map((d) => d.id)).toEqual([LAPTOP.id, BOX.id]);
    expect(seen[0]?.hubNow).toBe(T + 90_000);
    const state = c.view().state;
    expect(state).toBeDefined();
    expect(state?.newDevices).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain("sams-laptop");
    expect(JSON.stringify(state)).not.toContain("Lisbon");

    // An older hub (no list) and an empty list: nothing to tell.
    await c.sync();
    await c.sync();
    expect(seen).toHaveLength(1);
    c.stop();
  });

  it("a notice that fails never costs the sync", () => {
    const log: string[] = [];
    const c = new CoordClient({
      url: BOARD,
      token: TOKEN,
      deviceId: DEV,
      now: () => T,
      log: (m) => log.push(m),
      onNewDevices: () => {
        throw new Error("disk full");
      },
    });
    c.apply(hubSyncAcceptSchema.parse({ ...SYNC, newDevices: [LAPTOP] }), T);
    expect(c.view()).toMatchObject({ available: true, fetchedAt: T });
    expect(log).toContain("hub: new machine notice failed: disk full");
  });
});

// ---------------------------------------------------------------- never an agent's

/** Words that would give the notice away anywhere an agent reads. */
const MARKS = ["zz-quiet-laptop", "Zzplace", "dev_01JDZZZZZZZZZZZZZZZZZZZZZZ", "new machine", "joined your Workmesh account", "remove it on the board"];
const QUIET: HubNewDeviceAccepted = { id: "dev_01JDZZZZZZZZZZZZZZZZZZZZZZ", machine: "zz-quiet-laptop", pairedAt: T, where: "Zzplace, Example Net" };

const classify = (p: string) => (p === ROOT || p.startsWith(`${ROOT}/`) ? { root: ROOT, repo: "b3-fun/workmesh" } : undefined);
const session = (over: Partial<AgentSession> = {}): AgentSession => ({
  key: "claude-code:s1",
  source: "claude-code",
  sessionId: "s1",
  state: "working",
  agents: 1,
  cwd: ROOT,
  name: "documents-07",
  startedAt: T,
  updatedAt: T,
  stateSince: T,
  ...over,
});

/** The daemon's wiring in small: a sync client whose new machines go to the notice list. */
function daemonParts() {
  const log: string[] = [];
  const notices = new NewDeviceNotices({ now: () => T, log: (m) => log.push(m) });
  const coord = new CoordClient({
    url: BOARD,
    token: TOKEN,
    deviceId: DEV,
    person: "Sam Lee",
    // Every hub call an op makes is answered, so no test reaches a network.
    fetchImpl: (async () => new Response(JSON.stringify({ ok: true, id: "x1" }), { status: 200 })) as typeof fetch,
    now: () => T,
    onNewDevices: (list, hubNow) => {
      notices.observe(list, { board: BOARD, self: DEV, hubNow });
    },
  });
  coord.apply(
    hubSyncAcceptSchema.parse({
      ...SYNC,
      inbox: [{ id: "m1", to: ME, from: { person: "An" }, text: "take the CLI?", ts: T }],
      notes: [{ id: "n1", by: { person: "An" }, text: "deploys freeze at 5pm", ts: T }],
      handoffs: [],
      gates: [],
      approvals: [],
      newDevices: [QUIET],
    }),
    T,
  );
  return { coord, notices, log };
}

describe("a new machine notice is for the person, never for an agent", () => {
  const leaks = (value: unknown): string[] => {
    const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
    return MARKS.filter((m) => text.includes(m));
  };

  it("the person's notice is raised (so the checks below have something to leak)", () => {
    const { notices, log } = daemonParts();
    expect(notices.active().map((n) => n.machine)).toEqual(["zz-quiet-laptop"]);
    expect(log.join("\n")).toContain("zz-quiet-laptop");
  });

  it("no hook answer carries it: every hook event, for a session and for a subagent", () => {
    const { coord } = daemonParts();
    const hooks = new CoordHooks({ coord: () => coord, classify, isShared: () => true, projectName: () => "B3", now: () => T, home: "/home/me" });
    const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStart", "SubagentStop", "Notification", "PreCompact", "SessionEnd"];
    let answered = 0;
    for (const agentId of [undefined, "a1b2c3d4e5f60718"]) {
      for (const hook of events) {
        for (const tool of ["Read", "Edit", "Bash", "mcp__workmesh__inbox"]) {
          const event: SessionEvent = {
            source: "claude-code",
            sessionId: "s1",
            kind: "working",
            cwd: ROOT,
            ts: T,
            detail: { hookEvent: hook, tool, filePath: `${ROOT}/a.ts`, command: "workmesh inbox", ...(agentId ? { agentId } : {}) },
          };
          const answer = hooks.answer(event, hook, hooks.refuse(event, hook));
          if (answer) answered++;
          expect(leaks(answer), `${hook} ${tool} ${agentId ?? "session"}`).toEqual([]);
        }
      }
    }
    // The hooks did answer (guidance, the teammate's message): the check above read real context.
    expect(answered).toBeGreaterThan(0);
  });

  it("no inbox holds it: only the teammate's message waits, for the session it was sent to", () => {
    const { coord } = daemonParts();
    expect(coord.inboxItems().map((i) => i.id)).toEqual(["m1"]);
    expect([...coord.sessionsWithPending()]).toEqual(["claude-code:s1"]);
    expect(coord.pendingFor("claude-code:s1").map((i) => i.text)).toEqual(["take the CLI?"]);
    expect(coord.wakeFor("claude-code:s1").map((i) => i.id)).toEqual(["m1"]);
    expect(leaks(coord.inboxItems())).toEqual([]);
    expect(leaks(coord.view())).toEqual([]);
  });

  it("no call an agent or the CLI can make returns it", async () => {
    const { coord } = daemonParts();
    const sessions = [session()];
    const deps: CoordOpsDeps = {
      coord: () => coord,
      hub: () => ({ url: BOARD, project: { name: "B3" }, person: { name: "Sam Lee" }, deviceId: DEV }),
      getSession: (k) => sessions.find((s) => s.key === k),
      listSessions: () => sessions,
      classify,
      isShared: () => true,
      claudeSessions: () => new Map([["s1", { pid: 4242, sessionId: "s1" }]]),
      now: () => T,
      home: "/home/me",
    };
    const args: Partial<Record<(typeof COORD_OPS)[number], Record<string, unknown>>> = {
      send: { to: "An", text: "ok" },
      claim: { issue: "B3-7237" },
      release: { issue: "B3-7237" },
      lease: { paths: ["README.md"] },
      note: { text: "a note" },
      handoff: { to: "An", task: "a task" },
      ask: { question: "what is new?" },
      remember: { text: "a fact" },
      recall: { query: "machines" },
      forget: { id: "m1" },
    };
    for (const caller of [{ ppid: 4242 }, { client: "cli" }]) {
      for (const op of COORD_OPS) {
        const result = await runCoordOp({ op, args: args[op] ?? {}, caller }, deps);
        expect(leaks(result), `${op} as ${JSON.stringify(caller)}`).toEqual([]);
      }
    }
  });
});

// ---------------------------------------------------------------- the loopback API, status and doctor

function serverDeps(over: Partial<DaemonServerDeps>): DaemonServerDeps {
  return {
    secret: "s".repeat(64),
    applyEvent: () => {},
    getState: () => ({
      snapshot: { sessions: [], working: 0, waiting: 0, idle: 0, total: 0, agentCount: 0, signature: "" },
      formatted: null,
      paused: false,
    }),
    getLastError: () => undefined,
    getOwnership: () => ({ backedOff: false, savedPrior: false, policy: "respect" }),
    pause: async () => {},
    resume: () => {},
    dismiss: () => false,
    getConfig: () => {
      throw new Error("not used");
    },
    setConfig: () => {
      throw new Error("not used");
    },
    ...over,
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("the daemon's loopback API carries the notice for the person", () => {
  let server: http.Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });
  const auth = { authorization: `Bearer ${"s".repeat(64)}` };

  it("GET /team lists the notices, and POST /new-devices/dismiss takes one down", async () => {
    const notices = new NewDeviceNotices({ now: () => T });
    notices.observe([LAPTOP, BOX], { board: BOARD });
    const team = (): TeamState => ({
      enabled: true,
      hubUrl: BOARD,
      boardUrl: BOARD,
      hubName: "B3",
      deviceId: DEV,
      share: "metadata",
      connected: true,
      halted: false,
      available: true,
      pollMs: 60_000,
      newDevices: notices.active(),
    });
    server = createDaemonServer(serverDeps({ getTeam: team, dismissNewDevice: (id) => notices.dismiss(id) }));
    const base = `http://127.0.0.1:${await listen(server)}`;

    const read = async () => ((await (await fetch(`${base}/team`, { headers: auth })).json()) as { newDevices?: Array<{ id: string; text: string }> }).newDevices;
    expect((await read())?.map((n) => n.id)).toEqual([BOX.id, LAPTOP.id]);
    expect((await read())?.[1]?.text).toContain("sams-laptop, 5 minutes ago, from Lisbon, Portugal (Example Telecom)");

    const post = (body: unknown, headers: Record<string, string> = auth) =>
      fetch(`${base}/new-devices/dismiss`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ id: LAPTOP.id }, {})).status).toBe(401); // the daemon's secret, like every other call
    expect((await post({})).status).toBe(400);
    expect((await post({ id: LAPTOP.id, extra: true })).status).toBe(400);
    expect(await (await post({ id: LAPTOP.id })).json()).toEqual({ ok: true, removed: true });
    expect(await (await post({ id: LAPTOP.id })).json()).toEqual({ ok: true, removed: false });
    expect((await read())?.map((n) => n.id)).toEqual([BOX.id]);
  });

  it("a daemon without the list answers 404 to a dismiss", async () => {
    server = createDaemonServer(serverDeps({}));
    const base = `http://127.0.0.1:${await listen(server)}`;
    const res = await fetch(`${base}/new-devices/dismiss`, { method: "POST", headers: auth, body: JSON.stringify({ id: "d1" }) });
    expect(res.status).toBe(404);
  });
});

describe("workmesh status and doctor show the notice", () => {
  let tmp: string;
  let daemon: http.Server;
  let team: unknown;
  const saved: Record<string, string | undefined> = {};
  const text =
    "A new machine joined your Workmesh account: sams-laptop, 5 minutes ago, from Lisbon, Portugal (Example Telecom). " +
    "If this wasn't you, remove it on the board: https://hub.test";

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-newdev-cli-"));
    for (const k of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "WORKMESH_PORT"]) saved[k] = process.env[k];
    process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
    process.env.XDG_STATE_HOME = path.join(tmp, "state");
    // A stand-in daemon on its own port: these tests never reach a real one.
    daemon = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/state") {
        res.end(
          JSON.stringify({
            snapshot: { sessions: [], working: 0, waiting: 0, idle: 0, total: 0, agentCount: 0, signature: "" },
            formatted: null,
            paused: false,
            ownership: { backedOff: false, savedPrior: false, policy: "respect" },
          }),
        );
      } else if (req.url === "/team" && team !== undefined) {
        res.end(JSON.stringify(team));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: "not found" }));
      }
    });
    process.env.WORKMESH_PORT = String(await listen(daemon));
  });

  afterAll(() => {
    daemon.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const status = async (json = false): Promise<string> => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runStatus({ json });
      return out.mock.calls.flat().join("\n");
    } finally {
      out.mockRestore();
    }
  };

  it("status prints one line per notice, first; --json carries the list", async () => {
    team = { enabled: true, newDevices: [{ id: LAPTOP.id, machine: "sams-laptop", pairedAt: LAPTOP.pairedAt, toldAt: T, text }] };
    const printed = await status();
    expect(printed.split("\n")[0]).toBe(text);
    const parsed = JSON.parse(await status(true)) as { ok: boolean; newDevices?: Array<{ id: string; text: string }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.newDevices).toEqual([{ id: LAPTOP.id, machine: "sams-laptop", pairedAt: LAPTOP.pairedAt, toldAt: T, text }]);
  });

  it("status says nothing more when there is no notice, or the daemon predates the list", async () => {
    for (const older of [{ enabled: true, newDevices: [] }, { enabled: true }, { enabled: false }, undefined, { enabled: true, newDevices: "none" }, { enabled: true, newDevices: [{ id: "d1" }, null] }]) {
      team = older;
      const printed = await status();
      expect(printed, JSON.stringify(older)).not.toContain("new machine");
      expect(printed, JSON.stringify(older)).toContain("no live agent sessions");
      expect(JSON.parse(await status(true)), JSON.stringify(older)).not.toHaveProperty("newDevices");
    }
  });

  it("doctor adds one line to look at per notice, and none otherwise", () => {
    expect(newMachineChecks([{ text }, { text: "" }])).toEqual([{ name: "new machine", status: "warn", detail: text }]);
    expect(newMachineChecks([])).toEqual([]);
    expect(newMachineChecks(undefined)).toEqual([]);
  });
});

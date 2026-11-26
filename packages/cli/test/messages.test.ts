import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hubSyncAcceptSchema } from "@workmesh/protocol";
import type { HubSyncResponse } from "@workmesh/protocol";
import type { AgentSession, SessionEvent } from "@workmesh/core";
import { CoordClient } from "../src/hub/coord";
import { CoordHooks } from "../src/daemon/coord-hooks";
import { runCoordOp } from "../src/daemon/coord-ops";
import type { CoordOpRequest, CoordOpsDeps } from "../src/daemon/coord-ops";
import { Delegate } from "../src/daemon/delegate";
import { MessageGate, SENT_KEEP_MS, SENT_MAX, holdsFor, modeLevel, recipientPerson } from "../src/daemon/messages";
import { inboxArgs } from "../src/commands/coord";
import { wakeRuleText } from "../src/commands/wake";
import { configSchema, messageSettings } from "../src/lib/config";
import type { MessageSettings } from "../src/lib/config";

/**
 * Who may reach this machine's sessions (docs/SPEC.md §23): the receiving machine decides who may wake an idle
 * session, and which sessions get a teammate's message only after their person said so, from its own config and from
 * what its sessions sent.
 */

const TOKEN = `bp_${"f".repeat(64)}`;
const DEV = "dev_01JD0000000000000000000000";
const T = 1_795_545_600_000;
const LOCAL = "claude-code:s1";
const OTHER = "claude-code:s2";
const ME = `${DEV}:${LOCAL}`;
const SAM = "dev_01JDSAMSAMSAMSAMSAMSAMSAM00:claude-code:s9";
const ROOT = "/w/demo";

const BASE: HubSyncResponse = {
  cursor: "c1",
  serverNow: T,
  me: { person: "An" },
  leases: [],
  holds: [],
  inbox: [],
  claims: [],
  roster: [
    { person: "Sam", github: "sam-dev", sessions: [{ hubKey: SAM, name: "auth-refactor", state: "working" }] },
    { person: "Bo", sessions: [] },
  ],
  notes: [],
  edits: [],
  handoffs: [],
  gates: [],
  approvals: [],
};

type Message = HubSyncResponse["inbox"][number];
/** A teammate's message that asks to wake its session. */
const message = (over: Partial<Message> = {}): Message => ({
  id: "wm_01",
  to: ME,
  from: { person: "Sam", sessionName: "auth-refactor", sessionKey: SAM },
  text: "Can you rebase?",
  ts: T,
  wake: true,
  ...over,
});

function harness(opts: { settings?: Partial<MessageSettings>; file?: string } = {}) {
  let now = T;
  const settings: MessageSettings = { wake: "replies", hold: "bypass", holdMinutes: 60, ...opts.settings };
  const logs: string[] = [];
  /** What a session's transcript last said its mode was (the forwarder's mirror). */
  const mirror = new Map<string, string>();
  const calls: Array<{ url: string; body?: unknown }> = [];
  const replies: Array<{ status: number; body?: unknown }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined });
    const r = replies.shift() ?? { status: 200, body: { ok: true, id: "wm_sent1" } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
  const sessions = new Map<string, AgentSession>();
  const session = (key: string, state: AgentSession["state"]) =>
    sessions.set(key, { key, source: key.split(":")[0]!, sessionId: key.split(":")[1]!, state, agents: 1, startedAt: T, updatedAt: T, stateSince: T, cwd: ROOT });
  session(LOCAL, "idle");
  session(OTHER, "idle");
  let coord: CoordClient | undefined;
  let d: Delegate | undefined;
  const gate = new MessageGate({ coord: () => coord, settings: () => settings, mirrorMode: (k) => mirror.get(k), file: opts.file, now: () => now, log: (m) => logs.push(m) });
  coord = new CoordClient({
    url: "https://hub.test",
    token: TOKEN,
    deviceId: DEV,
    person: "An",
    fetchImpl,
    now: () => now,
    policy: gate,
    // As the daemon wires it: held messages are looked at first, then wakes.
    onSync: (n, p) => {
      gate.sweep();
      d?.onSync(n, p);
    },
  });
  d = new Delegate({
    coord: () => coord,
    getSession: (k) => sessions.get(k),
    isShared: () => true,
    repoOf: () => undefined,
    settings: () => ({ wake: true, accept: "never", customGates: [] }),
    now: () => now,
  });
  const c = coord;
  const sync = (over: Partial<HubSyncResponse> = {}) => c.apply(hubSyncAcceptSchema.parse({ ...BASE, serverNow: now, ...over }), now);
  const hooks = new CoordHooks({ coord: () => c, classify: () => undefined, isShared: () => true, now: () => now });
  const event = (over: Partial<SessionEvent> = {}): SessionEvent => ({ source: "claude-code", sessionId: "s1", kind: "working", cwd: ROOT, ts: T, ...over });
  /** What the session's next tool boundary puts into its context. The hook names the session's permission mode. */
  const boundary = (sessionId = "s1", permissionMode?: string, agentId?: string) => {
    const e = event({ sessionId, detail: { hookEvent: "PostToolUse", tool: "Read", ...(permissionMode ? { permissionMode } : {}), ...(agentId ? { agentId } : {}) } });
    gate.observe(e);
    return hooks.context(e, "PostToolUse");
  };
  const deps: CoordOpsDeps = {
    coord: () => c,
    hub: () => ({ url: "https://hub.test", project: { name: "Demo" }, person: { name: "An" }, deviceId: DEV }),
    getSession: (k) => sessions.get(k),
    listSessions: () => [...sessions.values()],
    classify: () => undefined,
    isShared: () => true,
    claudeSessions: () => new Map([["s1", { pid: 4242, sessionId: "s1" }]]),
    sent: (key, to, info) => gate.sent(key, to, info),
    held: {
      list: () => gate.heldMessages((k) => sessions.get(k)?.name),
      deliver: (id) => {
        const r = gate.deliver(id);
        if (r.ok) d?.check();
        return r;
      },
      drop: (id) => gate.drop(id),
    },
    now: () => now,
    home: "/home/me",
  };
  const op = (o: CoordOpRequest["op"], args: Record<string, unknown> = {}, caller: CoordOpRequest["caller"] = { ppid: 4242 }) => runCoordOp({ op: o, args, caller }, deps);
  /** The ids this relay acked to the hub so far. */
  const acked = () => calls.filter((k) => k.url.endsWith("/relay/inbox/ack")).flatMap((k) => (k.body as { ids: string[] }).ids);
  return {
    coord: c,
    gate,
    d: d!,
    settings,
    calls,
    replies,
    logs,
    mirror,
    session,
    sync,
    boundary,
    op,
    acked,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

/** The ids a waiter for this session would be woken with. */
const wakes = (x: ReturnType<typeof harness>, key = LOCAL) => x.coord.wakeFor(key).map((i) => i.id);

describe("who may wake an idle session", () => {
  it("by default a teammate's unasked message does not wake; it is delivered at the next tool boundary", async () => {
    const x = harness();
    x.sync({ inbox: [message()] });
    expect(wakes(x)).toEqual([]);
    // A waiter stays armed: nothing starts a turn.
    const gone = new AbortController();
    let answered = false;
    const waiter = x.d.wait(LOCAL, 50_000, gone.signal).then((a) => {
      answered = true;
      return a;
    });
    x.d.check();
    await new Promise((r) => setTimeout(r, 0));
    expect(answered).toBe(false);
    gone.abort();
    expect(await waiter).toEqual({ end: true, reason: "gone" });
    // Not lost: the session gets it, as marked text, when it next runs.
    expect(x.coord.pendingFor(LOCAL).map((i) => i.id)).toEqual(["wm_01"]);
    expect(x.boundary()).toContain('<workmesh-message from="Sam" session="auth-refactor">\n│ Can you rebase?\n</workmesh-message>');
  });

  it("under `team` any teammate's message that asks to wake does", async () => {
    const x = harness({ settings: { wake: "team" } });
    x.sync({ inbox: [message()] });
    expect(wakes(x)).toEqual(["wm_01"]);
    const answer = await x.d.wait(LOCAL, 5000);
    expect(answer.wake).toContain('<workmesh-message from="Sam" session="auth-refactor">\n│ Can you rebase?\n</workmesh-message>');
  });

  it("a reply from a person this session wrote to wakes, from them or from one of their agents", () => {
    const x = harness();
    x.gate.sent(LOCAL, { person: "Sam" }, { id: "wm_sent1" });
    x.sync({
      inbox: [
        message({ id: "wm_agent" }),
        message({ id: "wm_person", from: { person: "sam" } }),
        message({ id: "wm_bo", from: { person: "Bo" } }),
      ],
    });
    expect(wakes(x)).toEqual(["wm_agent", "wm_person"]);
  });

  it("a reply to a message sent to a session or to an agent by name wakes too", () => {
    const x = harness();
    x.gate.sent(LOCAL, { session: SAM }, { id: "wm_sent1" });
    x.sync({ inbox: [message({ id: "wm_same", from: { person: "Someone", sessionKey: `${SAM}/a1b2c3d4e5f60718` } }), message({ id: "wm_bo", from: { person: "Bo" } })] });
    expect(wakes(x)).toEqual(["wm_same"]);
    const y = harness();
    y.gate.sent(LOCAL, { agent: "Auth-Refactor" });
    y.sync({ inbox: [message({ id: "wm_named", from: { person: "Someone", sessionName: "auth-refactor" } })] });
    expect(wakes(y)).toEqual(["wm_named"]);
  });

  it("a message in a thread this session wrote in is a reply, whoever sends it", () => {
    const x = harness();
    x.gate.sent(LOCAL, { person: "Sam" }, { id: "wm_sent1", thread: "t_7" });
    x.sync({
      inbox: [
        message({ id: "wm_opened", from: { person: "Bo" }, thread: "wm_sent1" }),
        message({ id: "wm_carried", from: { person: "Bo" }, thread: "t_7" }),
        message({ id: "wm_other", from: { person: "Bo" }, thread: "t_8" }),
      ],
    });
    expect(wakes(x)).toEqual(["wm_opened", "wm_carried"]);
  });

  it("the reply wakes the session that wrote, not another session of this machine", () => {
    const x = harness();
    x.gate.sent(LOCAL, { person: "Sam" }, { id: "wm_sent1" });
    x.sync({ inbox: [message({ id: "wm_other", to: `${DEV}:${OTHER}` })] });
    expect(wakes(x, OTHER)).toEqual([]);
    // A subagent's send counts for its session.
    x.gate.sent(`${OTHER}/a1b2c3d4e5f60718`, { person: "Sam" });
    expect(wakes(x, OTHER)).toEqual(["wm_other"]);
  });

  it("`send` records who a session wrote to: the person, also for a session or an agent the roster knows", async () => {
    const x = harness();
    x.sync();
    expect((await x.op("send", { to: "Sam", text: "can I take src/api.ts?", thread: "t_7" })).ok).toBe(true);
    expect((await x.op("send", { to: "auth-refactor", text: "ping" })).ok).toBe(true);
    expect(x.gate.records()).toEqual([
      { session: LOCAL, id: "wm_sent1", thread: "t_7", person: "Sam", at: T },
      { session: LOCAL, id: "wm_sent1", person: "Sam", toSession: SAM, at: T },
    ]);
    // What the person sends from a terminal is not a session's message: nothing is recorded.
    await x.op("send", { to: "Bo", text: "hi" }, { cwd: "/nowhere" });
    expect(x.gate.records()).toHaveLength(2);
    // A send the hub refused is not recorded either.
    x.replies.push({ status: 404, body: { ok: false, error: "no such person" } });
    await x.op("send", { to: "Bo", text: "hi" });
    expect(x.gate.records()).toHaveLength(2);
    x.sync({ inbox: [message()] });
    expect(wakes(x)).toEqual(["wm_01"]);
  });

  it("my own messages wake under every rule: my person's, and my other sessions' when they ask", () => {
    for (const wake of ["replies", "team", "self", ["Bo"]] as const) {
      const x = harness({ settings: { wake: wake as MessageSettings["wake"] } });
      x.sync({
        inbox: [
          message({ id: "wm_me", from: { person: "an" }, wake: undefined }),
          message({ id: "wm_mine", from: { person: "An", sessionKey: `${DEV}:codex:t1` } }),
          message({ id: "wm_quiet", from: { person: "An", sessionKey: `${DEV}:codex:t1` }, wake: undefined }),
        ],
      });
      expect(wakes(x), String(wake)).toEqual(["wm_me", "wm_mine"]);
    }
  });

  it("`self` wakes for nobody else, even a reply", () => {
    const x = harness({ settings: { wake: "self" } });
    x.gate.sent(LOCAL, { person: "Sam" }, { id: "wm_sent1" });
    x.sync({ inbox: [message(), message({ id: "wm_thread", from: { person: "Bo" }, thread: "wm_sent1" })] });
    expect(wakes(x)).toEqual([]);
  });

  it("a list of people wakes for them, by name or by GitHub login, and for nobody else", () => {
    const x = harness({ settings: { wake: ["sam-dev"] } });
    x.gate.sent(LOCAL, { person: "Bo" });
    x.sync({ inbox: [message(), message({ id: "wm_bo", from: { person: "Bo" } })] });
    expect(wakes(x)).toEqual(["wm_01"]);
    const y = harness({ settings: { wake: [" SAM "] } });
    y.sync({ inbox: [message()] });
    expect(wakes(y)).toEqual(["wm_01"]);
  });

  it("a message that does not ask to wake never does, whatever the rule", () => {
    const x = harness({ settings: { wake: "team" } });
    x.gate.sent(LOCAL, { person: "Sam" });
    x.sync({ inbox: [message({ id: "wm_agent", wake: undefined }), message({ id: "wm_no", from: { person: "Sam" }, wake: false })] });
    expect(wakes(x)).toEqual([]);
  });

  it("Workmesh's own notices wake as before, under every rule", () => {
    for (const wake of ["replies", "team", "self"] as const) {
      const x = harness({ settings: { wake } });
      x.sync();
      const id = x.coord.notify(LOCAL, "Workmesh: your handoff to Sam is done.");
      x.coord.notify(LOCAL, "Workmesh: Sam accepted your handoff.", { wake: false });
      expect(wakes(x), wake).toEqual([id]);
    }
  });
});

describe("the record of who each session wrote to", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-messages-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("survives a daemon restart, in a file only its owner can read", () => {
    const file = path.join(dir, "state", "messages.json");
    const x = harness({ file });
    x.gate.sent(LOCAL, { person: "Sam" }, { id: "wm_sent1", thread: "t_7" });
    x.gate.flush();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const y = harness({ file });
    expect(y.gate.records()).toEqual([{ session: LOCAL, id: "wm_sent1", thread: "t_7", person: "Sam", at: T }]);
    y.sync({ inbox: [message()] });
    expect(wakes(y)).toEqual(["wm_01"]);
  });

  it("drops a record after 7 days, and keeps at most 500", () => {
    const x = harness();
    x.gate.sent(LOCAL, { person: "Sam" });
    x.sync({ inbox: [message()] });
    x.tick(SENT_KEEP_MS - 1000);
    expect(wakes(x)).toEqual(["wm_01"]);
    x.tick(2000);
    expect(wakes(x)).toEqual([]);
    expect(x.gate.records()).toEqual([]);
    for (let i = 0; i < SENT_MAX + 20; i++) x.gate.sent(LOCAL, { person: `P${i}` });
    expect(x.gate.records()).toHaveLength(SENT_MAX);
    expect(x.gate.records()[0]?.person).toBe("P20");
  });

  it("reads a file it can't make sense of as empty, and skips a record it can't read", () => {
    const file = path.join(dir, "messages.json");
    fs.writeFileSync(file, "not json");
    expect(harness({ file }).gate.records()).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ v: 1, sent: [{ session: LOCAL, person: "Sam", at: T }, { session: 7 }, "x"] }));
    expect(harness({ file }).gate.records()).toEqual([{ session: LOCAL, person: "Sam", at: T }]);
  });

  it("names the person a message goes to, from the roster", () => {
    const roster = hubSyncAcceptSchema.parse(BASE).roster;
    expect(recipientPerson({ person: "Bo" }, roster)).toBe("Bo");
    expect(recipientPerson({ session: `${SAM}/a1b2c3d4e5f60718` }, roster)).toBe("Sam");
    expect(recipientPerson({ agent: "AUTH-refactor" }, roster)).toBe("Sam");
    expect(recipientPerson({ agent: "nobody" }, roster)).toBeUndefined();
    expect(recipientPerson({ session: "dev_x:claude-code:zz" }, undefined)).toBeUndefined();
  });
});

describe("the `messages` config section", () => {
  it("defaults to replies; a rule or a list of people is read; anything else reads as absent", () => {
    expect(messageSettings(configSchema.parse({}))).toEqual({ wake: "replies", hold: "bypass", holdMinutes: 60 });
    expect(messageSettings(configSchema.parse({ messages: { wake: "team" } })).wake).toBe("team");
    expect(messageSettings(configSchema.parse({ messages: { wake: ["Sam Lee", "bo"] } })).wake).toEqual(["Sam Lee", "bo"]);
    expect(messageSettings(configSchema.parse({ messages: { wake: "everyone" } })).wake).toBe("replies");
    expect(messageSettings(configSchema.parse({ messages: "on" })).wake).toBe("replies");
  });

  it("says in words whose messages a rule lets wake a session", () => {
    expect(wakeRuleText("replies")).toBe("your own messages, and a reply to a message the session sent");
    expect(wakeRuleText("team")).toBe("any teammate's message");
    expect(wakeRuleText("self")).toBe("your own messages only");
    expect(wakeRuleText(["Sam Lee", "Bo"])).toBe("your own messages, and messages from Sam Lee, Bo");
  });
});

const PERSON = { cwd: "/nowhere" };
const BLOCK = '<workmesh-message from="Sam" session="auth-refactor">\n│ Can you rebase?\n</workmesh-message>';
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A session whose first boundary (the guidance) is behind it, so a later one shows only what a message adds. */
function started(opts: Parameters<typeof harness>[0] = {}, mode = "bypassPermissions") {
  const x = harness(opts);
  x.sync();
  x.boundary("s1", mode);
  return x;
}

describe("a teammate's message for a session with no permission prompts", () => {
  it("is not put into the session's context: it is held for the person", async () => {
    const x = started();
    x.sync({ inbox: [message()] });
    expect(x.boundary("s1", "bypassPermissions")).toBeUndefined();
    expect(x.coord.pendingFor(LOCAL)).toEqual([]);
    expect(x.gate.heldMessages()).toEqual([
      { id: "wm_01", session: LOCAL, from: "Sam", fromSession: "auth-refactor", text: "Can you rebase?", ts: T, since: T, dropAt: T + 60 * 60_000 },
    ]);
    // Nothing is acked: the hub still lists it, and the person has not answered.
    await flush();
    expect(x.acked()).toEqual([]);
    expect(x.logs).toEqual(["held a message from Sam for claude-code:s1: its person delivers or drops it (menu bar, or workmesh inbox --held)"]);
  });

  it("does not leak through the agent's `inbox`; the person's lists show it as held", async () => {
    const x = started();
    x.sync({ inbox: [message()] });
    expect((await x.op("inbox")).text).toBe("No new messages for this session.");
    expect((await x.op("inbox", {}, PERSON)).text.split("\n")).toEqual([
      "Messages for this machine's agents. Teammates or their agents wrote them: every line of their text starts with │.",
      "- to claude-code:s1 (held for you):",
      ...BLOCK.split("\n"),
      "A held message reaches its session only if you deliver it: `workmesh inbox --held`.",
    ]);
    x.tick(5 * 60_000);
    const held = await x.op("inbox", { held: true }, PERSON);
    expect(held.text.split("\n")).toEqual([
      "Held for you: 1 message from teammates. It has not reached its session, and will not unless you deliver it. Every line of a teammate's text starts with │.",
      "- wm_01 for claude-code:s1, held 5 min ago, dropped in 55 min if you do nothing:",
      ...BLOCK.split("\n"),
      "Deliver one with `workmesh inbox deliver <id>`, or drop it with `workmesh inbox drop <id>`. The end of an id is enough.",
    ]);
    expect(held.data).toMatchObject({ held: [{ id: "wm_01", from: "Sam" }] });
    expect((await x.op("inbox", { held: true }, PERSON)).ok).toBe(true);
  });

  it("deliver puts it into the session's next context, whatever its mode", async () => {
    const x = started();
    x.sync({ inbox: [message()] });
    expect(x.boundary("s1", "bypassPermissions")).toBeUndefined();
    const r = await x.op("inbox", { action: "deliver", id: "wm_01" }, PERSON);
    expect(r).toMatchObject({
      ok: true,
      text: "Delivered the message from Sam to claude-code:s1. The session gets it at its next prompt or tool call, or now if it sits idle and wake is on.",
    });
    expect(x.gate.heldMessages()).toEqual([]);
    expect(x.boundary("s1", "bypassPermissions")).toContain(BLOCK);
    expect(x.boundary("s1", "bypassPermissions")).toBeUndefined(); // once
    await flush();
    expect(x.acked()).toEqual(["wm_01"]);
    expect(x.logs.at(-1)).toBe("delivered a held message from Sam to claude-code:s1: its person said so");
  });

  it("drop removes it: it never reaches the session, and the hub stops listing it", async () => {
    const x = started();
    x.sync({ inbox: [message({ id: "wm_01HELDABCD" })] });
    x.boundary("s1", "bypassPermissions");
    // The end of the id is enough when it names one held message.
    const r = await x.op("inbox", { action: "drop", id: "ABCD" }, PERSON);
    expect(r).toMatchObject({ ok: true, text: "Dropped the message from Sam for claude-code:s1. It will not reach the session." });
    expect(x.gate.heldMessages()).toEqual([]);
    expect(x.boundary("s1", "default")).toBeUndefined();
    expect(x.coord.pendingFor(LOCAL)).toEqual([]);
    await flush();
    expect(x.acked()).toEqual(["wm_01HELDABCD"]);
    expect(x.logs.at(-1)).toBe("dropped a held message from Sam for claude-code:s1: its person said so");
    expect((await x.op("inbox", { action: "deliver", id: "wm_01HELDABCD" }, PERSON)).text).toBe("No held message wm_01HELDABCD (`workmesh inbox --held` lists them).");
  });

  it("a held message nobody answers is dropped after the set time, and the daemon log says so", async () => {
    const x = started({ settings: { holdMinutes: 30 } });
    x.sync({ inbox: [message()] });
    x.tick(30 * 60_000 - 1000);
    x.sync({ inbox: [message()] });
    expect(x.gate.heldMessages().map((m) => m.id)).toEqual(["wm_01"]);
    x.tick(1000);
    x.sync({ inbox: [message()] });
    expect(x.gate.heldMessages()).toEqual([]);
    expect(x.logs.at(-1)).toBe("dropped a held message from Sam for claude-code:s1: nobody delivered it in 30 min");
    expect(x.boundary("s1", "default")).toBeUndefined();
    await flush();
    expect(x.acked()).toEqual(["wm_01"]);
  });

  it("the CLI asks for the held list, a delivery or a drop", async () => {
    const x = started();
    x.sync({ inbox: [message()] });
    expect(inboxArgs(undefined, undefined, undefined)).toEqual({});
    expect((await x.op("inbox", inboxArgs(undefined, undefined, true), PERSON)).text).toContain("Held for you: 1 message from teammates.");
    expect((await x.op("inbox", inboxArgs("deliver", "wm_01", undefined), PERSON)).text).toContain("Delivered the message from Sam");
    expect((await x.op("inbox", inboxArgs(undefined, undefined, true), PERSON)).text).toBe("No held messages.");
  });

  it("an agent can neither read nor deliver nor drop a held message", async () => {
    const x = started();
    x.sync({ inbox: [message()] });
    const refusal = "Held messages are your person's to read, deliver or drop, in the menu bar or in their own terminal, not an agent's.";
    for (const args of [{ held: true }, { action: "deliver", id: "wm_01" }, { action: "drop", id: "wm_01" }]) {
      expect(await x.op("inbox", args), JSON.stringify(args)).toMatchObject({ ok: false, text: refusal });
    }
    expect(x.gate.heldMessages().map((m) => m.id)).toEqual(["wm_01"]);
    expect(x.boundary("s1", "bypassPermissions")).toBeUndefined();
    // The person needs an id, and one that names a held message.
    expect((await x.op("inbox", { action: "deliver" }, PERSON)).text).toBe("`inbox deliver` needs the id of a held message (`workmesh inbox --held` lists them).");
    expect((await x.op("inbox", { action: "read", id: "wm_01" }, PERSON)).ok).toBe(false);
    x.sync({ inbox: [message(), message({ id: "wm_a_9001" }), message({ id: "wm_b_9001" })] });
    expect((await x.op("inbox", { action: "drop", id: "9001" }, PERSON)).text).toBe("Several held messages end in 9001: give the whole id (`workmesh inbox --held` lists them).");
    // Fewer than four characters name nothing.
    expect((await x.op("inbox", { action: "drop", id: "_01" }, PERSON)).text).toBe("No held message _01 (`workmesh inbox --held` lists them).");
  });

  it("a held message does not wake its session; a delivered one does", async () => {
    const x = started({ settings: { wake: "team" } });
    x.sync({ inbox: [message()] });
    expect(wakes(x)).toEqual([]);
    const waiter = x.d.wait(LOCAL, 50_000);
    await flush();
    await x.op("inbox", { action: "deliver", id: "wm_01" }, PERSON);
    expect((await waiter).wake).toContain(BLOCK);
  });

  it("my own messages are never held, and Workmesh's own notices are unaffected", () => {
    const x = started({ settings: { hold: "always" } });
    x.sync({ inbox: [message({ id: "wm_me", from: { person: "An" } }), message({ id: "wm_mine", from: { person: "Someone", sessionKey: `${DEV}:codex:t1` } })] });
    const id = x.coord.notify(LOCAL, "Workmesh: your handoff to Sam is done.");
    expect(x.coord.pendingFor(LOCAL).map((i) => i.id)).toEqual(["wm_me", "wm_mine", id]);
    expect(x.gate.heldMessages()).toEqual([]);
    const ctx = x.boundary("s1", "bypassPermissions")!;
    expect(ctx).toContain("Workmesh: your handoff to Sam is done.");
    expect(ctx).toContain('<workmesh-message from="An">');
  });

  it("holds by the session's mode: only where nobody is asked, unless the rule says more", () => {
    const heldIn = (hold: MessageSettings["hold"], mode: string | undefined) => {
      const x = harness({ settings: { hold } });
      x.sync({ inbox: [message()] });
      x.boundary("s1", mode);
      return x.gate.heldMessages().length === 1;
    };
    for (const mode of ["bypassPermissions", "dontAsk", "full-access"]) expect(heldIn("bypass", mode), mode).toBe(true);
    for (const mode of ["default", "acceptEdits", "plan", "auto", "untrusted", "read-only", undefined]) expect(heldIn("bypass", mode), String(mode)).toBe(false);
    expect(heldIn("unattended", "auto")).toBe(true);
    expect(heldIn("unattended", "bypassPermissions")).toBe(true);
    expect(heldIn("unattended", "default")).toBe(false);
    expect(heldIn("unattended", undefined)).toBe(false);
    for (const mode of ["default", "bypassPermissions", undefined]) {
      expect(heldIn("always", mode), String(mode)).toBe(true);
      expect(heldIn("never", mode), String(mode)).toBe(false);
    }
    expect([modeLevel("dontAsk"), modeLevel("auto"), modeLevel("plan"), modeLevel(undefined)]).toEqual(["bypass", "unattended", "asks", undefined]);
    expect(holdsFor("bypass", undefined)).toBe(false);
  });

  it("reads the mode from the session's transcript when its hooks did not say, and a hook's word comes first", () => {
    const x = harness();
    x.mirror.set(LOCAL, "full-access");
    x.sync({ inbox: [message()] });
    expect(x.gate.modeOf(LOCAL)).toBe("full-access");
    // Held at the sync already: its person sees it though the session sits idle and no hook fires.
    expect(x.gate.heldMessages().map((m) => m.id)).toEqual(["wm_01"]);
    const y = harness();
    y.mirror.set(LOCAL, "full-access");
    y.boundary("s1", "default");
    expect(y.gate.modeOf(`${LOCAL}/a1b2c3d4e5f60718`)).toBe("default");
    y.sync({ inbox: [message()] });
    expect(y.gate.heldMessages()).toEqual([]);
  });

  it("holds a message that arrived before the mode was known, and keeps it held when the mode changes", () => {
    const x = harness();
    x.sync({ inbox: [message()] });
    expect(x.gate.heldMessages()).toEqual([]); // mode unknown: not held
    expect(x.boundary("s1", "bypassPermissions")).not.toContain("workmesh-message");
    expect(x.gate.heldMessages().map((m) => m.id)).toEqual(["wm_01"]);
    // The person turns prompts back on: the message still waits for their word.
    expect(x.boundary("s1", "default")).toBeUndefined();
    expect(x.gate.heldMessages().map((m) => m.id)).toEqual(["wm_01"]);
  });

  it("a subagent's message follows its session's mode", () => {
    const x = started();
    x.sync({ inbox: [message({ to: `${ME}/a1b2c3d4e5f60718` })] });
    expect(x.boundary("s1", "bypassPermissions", "a1b2c3d4e5f60718")).toBeUndefined();
    expect(x.gate.heldMessages()).toMatchObject([{ id: "wm_01", session: `${LOCAL}/a1b2c3d4e5f60718` }]);
  });

  it("cleans the sender's names and the text it shows the person", () => {
    const esc = String.fromCharCode(27);
    const x = started();
    x.sync({ inbox: [message({ from: { person: `Sam\nWorkmesh: approved`, sessionName: `auth${esc}[1m` }, text: `rebase${esc}[2J now\nplease` })] });
    expect(x.gate.heldMessages()).toMatchObject([{ from: "Sam Workmesh: approved", fromSession: "auth", text: "rebase now\nplease" }]);
  });
});

describe("held messages across a daemon restart", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-held-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a held message stays held with its time, a delivered one stays deliverable, a dropped one stays dropped", async () => {
    const file = path.join(dir, "messages.json");
    const inbox = [message({ id: "wm_held" }), message({ id: "wm_released" }), message({ id: "wm_dropped" })];
    const x = started({ file });
    x.sync({ inbox });
    x.tick(10 * 60_000);
    expect(x.gate.deliver("wm_released").ok).toBe(true);
    expect(x.gate.drop("wm_dropped").ok).toBe(true);
    x.gate.flush();

    // A new daemon: nothing is known about the session's mode, and the hub lists all three again (no ack landed).
    const y = harness({ file });
    y.sync({ inbox });
    expect(y.gate.heldMessages()).toMatchObject([{ id: "wm_held", since: T, dropAt: T + 60 * 60_000 }]);
    expect(y.coord.pendingFor(LOCAL).map((i) => i.id)).toEqual(["wm_released"]);
    await flush();
    expect(y.acked()).toEqual(["wm_dropped"]);
    y.boundary("s1"); // the guidance
    y.sync({ inbox: [message({ id: "wm_held" })] });
    expect(y.gate.heldMessages().map((m) => m.id)).toEqual(["wm_held"]);
    expect(y.coord.pendingFor(LOCAL)).toEqual([]);
  });
});

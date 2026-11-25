import { describe, expect, it } from "vitest";
import { hubSyncAcceptSchema } from "@workmesh/protocol";
import type { HubHandoffAccepted, HubSyncResponse } from "@workmesh/protocol";
import type { AgentSession, SessionEvent } from "@workmesh/core";
import { CoordClient } from "../src/hub/coord";
import { Delegate, SELF_HANDOFF_SENDER_DELAY_MS, wakeText } from "../src/daemon/delegate";
import type { DelegateSettings, HandoffRunnerLike } from "../src/daemon/delegate";
import { CoordHooks, guidance, knowledge } from "../src/daemon/coord-hooks";

/** v2 Delegate, relay side (docs/SPEC.md §31): gates, approvals, handoff policy and wake, by fixture. */

const TOKEN = `bp_${"d".repeat(64)}`;
const DEV = "dev_01JD0000000000000000000000";
const OTHER_DEV = "dev_01JDOTHEROTHEROTHEROTHER00";
const T = 1_795_545_600_000;
const LOCAL = "claude-code:s1";
const ME = `${DEV}:${LOCAL}`;
const AN = "dev_01JDANANANANANANANANANANAN:claude-code:s9";
const ROOT = "/Users/dev/b3os-beta";

const BASE: HubSyncResponse = {
  cursor: "c1",
  serverNow: T,
  me: { person: "Sean" },
  leases: [],
  holds: [],
  inbox: [],
  claims: [],
  roster: [{ person: "An", github: "an-b3", sessions: [{ hubKey: AN, name: "b3iq-strategy", state: "working" }] }],
  notes: [],
  edits: [],
  handoffs: [],
  gates: [],
  approvals: [],
};

type Reply = { status: number; body?: unknown } | Error;

function harness(opts: { replies?: Reply[]; settings?: Partial<DelegateSettings>; shared?: boolean; runner?: HandoffRunnerLike } = {}) {
  let now = T;
  const calls: Array<{ url: string; body?: unknown }> = [];
  const replies = [...(opts.replies ?? [])];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined });
    const r = replies.shift() ?? { status: 200, body: { ok: true } };
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
  const sessions = new Map<string, AgentSession>();
  const session = (key: string, state: AgentSession["state"]) =>
    sessions.set(key, { key, source: key.split(":")[0]!, sessionId: key.split(":")[1]!, state, agents: 1, startedAt: T, updatedAt: T, stateSince: T, cwd: ROOT });
  session(LOCAL, "working");
  let d: Delegate | undefined;
  const coord = new CoordClient({
    url: "https://hub.test",
    token: TOKEN,
    deviceId: DEV,
    person: "Sean",
    fetchImpl,
    now: () => now,
    onSync: (n, p) => d?.onSync(n, p),
  });
  const logs: string[] = [];
  d = new Delegate({
    coord: () => coord,
    getSession: (k) => sessions.get(k),
    isShared: () => opts.shared ?? true,
    repoOf: (dir) => (dir.startsWith(ROOT) ? "b3-fun/b3os-beta" : undefined),
    settings: () => ({ wake: true, accept: "auto-self", customGates: [], ...opts.settings }),
    runner: opts.runner,
    now: () => now,
    log: (m) => logs.push(m),
  });
  const sync = (over: Partial<HubSyncResponse> = {}) => coord.apply(hubSyncAcceptSchema.parse({ ...BASE, serverNow: now, ...over }), now);
  return {
    coord,
    d: d!,
    calls,
    logs,
    session,
    sync,
    tick: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

const bash = (command: string, over: Partial<SessionEvent> = {}): SessionEvent => ({
  source: "claude-code",
  sessionId: "s1",
  kind: "working",
  ts: T,
  cwd: ROOT,
  detail: { hookEvent: "PreToolUse", tool: "Bash", command },
  ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("approval gates (SPEC §31)", () => {
  it("nothing is gated until the person opts in, nor on a v1 hub", () => {
    const x = harness();
    x.sync();
    expect(x.d.gateRefusal(bash("gh pr merge 212 --merge"), "PreToolUse")).toBeUndefined();
    const v1 = harness();
    const { handoffs: _h, gates: _g, approvals: _a, ...v1Sync } = BASE;
    v1.coord.apply(hubSyncAcceptSchema.parse(v1Sync), T);
    expect(v1.coord.delegateAvailable()).toBe(false);
    expect(v1.d.gateRefusal(bash("gh pr merge 212 --merge"), "PreToolUse")).toBeUndefined();
  });

  it("a gated merge waits: the ask goes out in the background, the agent is told who decides", async () => {
    const x = harness({
      replies: [{ status: 200, body: { ok: true, approval: { id: "ap_1", sessionKey: ME, owner: "Sean", gate: "merge", detail: "gh pr merge 212 --merge in b3-fun/b3os-beta", status: "pending", ts: T } } }],
    });
    x.sync({ gates: [{ owner: "Sean", actions: ["merge", "deploy"] }] });
    const why = x.d.gateRefusal(bash("npm test && gh pr merge 212 --merge"), "PreToolUse");
    expect(why).toMatch(/^Waiting for Sean's approval to merge \(gh pr merge 212 --merge in b3-fun\/b3os-beta\); you'll get a message when it's decided/);
    await flush();
    expect(x.calls).toEqual([
      { url: "https://hub.test/relay/approvals", body: { action: "request", sessionKey: LOCAL, gate: "merge", detail: "gh pr merge 212 --merge in b3-fun/b3os-beta" } },
    ]);
    // Asked again while pending: still waiting, no second request.
    expect(x.d.gateRefusal(bash("gh pr merge 212 --merge"), "PreToolUse")).toMatch(/^Waiting for Sean's approval/);
    await flush();
    expect(x.calls).toHaveLength(1);
    // Other tools, other hooks, other commands: untouched.
    expect(x.d.gateRefusal(bash("gh pr view 212"), "PreToolUse")).toBeUndefined();
    expect(x.d.gateRefusal(bash("gh pr merge 212 --merge"), "PostToolUse")).toBeUndefined();
    expect(x.d.gateRefusal({ ...bash("x"), detail: { hookEvent: "PreToolUse", tool: "Edit", filePath: `${ROOT}/a.ts` } }, "PreToolUse")).toBeUndefined();
  });

  it("approved: the session is told (waking it), and the same action runs for an hour", async () => {
    const pending = { id: "ap_1", sessionKey: ME, owner: "Sean", gate: "merge" as const, detail: "gh pr merge 212 --merge in b3-fun/b3os-beta", status: "pending" as const, ts: T };
    const x = harness();
    const gates = [{ owner: "Sean", actions: ["merge" as const] }];
    x.sync({ gates, approvals: [pending] });
    expect(x.d.gateRefusal(bash("gh pr merge 212 --merge"), "PreToolUse")).toMatch(/^Waiting/);
    x.tick(30_000);
    x.sync({ gates, approvals: [{ ...pending, status: "approved", decidedAt: x.now(), by: "Sean" }] });
    const notice = x.coord.wakeFor(LOCAL);
    expect(notice).toHaveLength(1);
    expect(notice[0]?.text).toBe("Workmesh: Sean approved: merge gh pr merge 212 --merge in b3-fun/b3os-beta. Run it now (the approval holds for an hour).");
    expect(x.d.gateRefusal(bash("gh pr merge 212 --merge"), "PreToolUse")).toBeUndefined();
    // A different PR is a different approval.
    expect(x.d.gateRefusal(bash("gh pr merge 213 --merge"), "PreToolUse")).toMatch(/^Waiting/);
    x.tick(61 * 60_000);
    x.sync({ gates, approvals: [{ ...pending, status: "approved", decidedAt: T + 30_000, by: "Sean" }] });
    expect(x.d.gateRefusal(bash("gh pr merge 212 --merge"), "PreToolUse")).toMatch(/^Waiting/); // expired: ask again
  });

  it("denied: refused with who and why, and the session hears it", () => {
    const x = harness();
    const gates = [{ owner: "Sean", actions: ["deploy" as const], approvers: ["An"] }];
    const ap = { id: "ap_2", sessionKey: ME, owner: "Sean", gate: "deploy" as const, detail: "wrangler deploy in b3-fun/b3os-beta", status: "pending" as const, ts: T };
    x.sync({ gates, approvals: [ap] });
    expect(x.d.gateRefusal(bash("npx wrangler deploy"), "PreToolUse")).toMatch(/^Waiting for An's approval to deploy/);
    x.sync({ gates, approvals: [{ ...ap, status: "denied", by: "An", note: "deploy freeze until 5pm", decidedAt: T }] });
    expect(x.d.gateRefusal(bash("npx wrangler deploy"), "PreToolUse")).toBe(
      "Workmesh: An denied this deploy (wrangler deploy in b3-fun/b3os-beta): deploy freeze until 5pm Don't run it or work around it. If it should go ahead after all, ask An (`workmesh send An \"…\"` or the workmesh `send` tool).",
    );
    expect(x.coord.wakeFor(LOCAL)[0]?.text).toContain("An denied: deploy wrangler deploy in b3-fun/b3os-beta: deploy freeze until 5pm");
  });

  it("fails open: an ask the hub doesn't take lets the action through, and says so", async () => {
    for (const reply of [{ status: 500 }, { status: 404, body: "no" }, new Error("ECONNREFUSED")] as Reply[]) {
      const x = harness({ replies: [reply] });
      x.sync({ gates: [{ owner: "Sean", actions: ["merge"] }] });
      expect(x.d.gateRefusal(bash("gh pr merge 1"), "PreToolUse")).toMatch(/^Waiting/);
      await flush();
      await flush();
      expect(x.d.gateRefusal(bash("gh pr merge 1"), "PreToolUse")).toBeUndefined();
      expect(x.coord.wakeFor(LOCAL)[0]?.text).toMatch(/^Workmesh couldn't ask for approval to merge \(gh pr merge 1 in b3-fun\/b3os-beta\)/);
    }
  });

  it("fails open: a stale sync, an unshared session, another person's gates gate nothing", () => {
    const x = harness();
    x.sync({ gates: [{ owner: "Sean", actions: ["merge"] }] });
    x.tick(91_000);
    expect(x.d.gateRefusal(bash("gh pr merge 1"), "PreToolUse")).toBeUndefined();
    const y = harness({ shared: false });
    y.sync({ gates: [{ owner: "Sean", actions: ["merge"] }] });
    expect(y.d.gateRefusal(bash("gh pr merge 1"), "PreToolUse")).toBeUndefined();
    const z = harness();
    z.sync({ gates: [{ owner: "An", actions: ["merge"] }] });
    expect(z.d.gateRefusal(bash("gh pr merge 1"), "PreToolUse")).toBeUndefined();
  });
});

describe("wake (SPEC §31)", () => {
  it("a waiter gets a person's message once the session is idle; an agent's message waits for the next turn", async () => {
    const x = harness();
    x.session(LOCAL, "idle");
    x.sync({
      inbox: [
        { id: "m1", to: ME, from: { person: "An", sessionName: "b3iq-strategy", sessionKey: AN }, text: "FYI only", ts: T },
        { id: "m2", to: ME, from: { person: "An" }, text: "can you look at PR 212?", ts: T + 1 },
      ],
    });
    const answer = await x.d.wait(LOCAL, 5000);
    expect(answer.wake).toContain("Workmesh woke this idle session");
    expect(answer.wake).toContain("Message from An: can you look at PR 212?");
    expect(answer.wake).not.toContain("FYI only");
    // Delivered once: acked to the hub, never handed over again.
    expect(x.coord.wakeFor(LOCAL)).toEqual([]);
    expect(x.coord.pendingFor(LOCAL).map((i) => i.id)).toEqual(["m1"]);
  });

  it("holds while the session works, and delivers when it goes idle", async () => {
    const x = harness();
    x.sync({ inbox: [{ id: "m3", to: ME, from: { person: "An" }, text: "ping", ts: T, wake: true }] });
    const p = x.d.wait(LOCAL, 50_000);
    let done = false;
    void p.then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    x.session(LOCAL, "idle");
    x.d.observe({ source: "claude-code", sessionId: "s1", kind: "idle", ts: T });
    expect((await p).wake).toContain("Message from An: ping");
  });

  it("ends for an ended session, a newer waiter, a waiter that went away, an unshared session or wake off", async () => {
    const x = harness();
    x.session(LOCAL, "idle");
    x.sync();
    const first = x.d.wait(LOCAL, 50_000);
    const second = x.d.wait(LOCAL, 50_000);
    expect(await first).toEqual({ end: true, reason: "superseded" });
    x.d.observe({ source: "claude-code", sessionId: "s1", kind: "end", ts: T });
    expect(await second).toEqual({ end: true, reason: "session ended" });
    const ac = new AbortController();
    const y = harness();
    y.session(LOCAL, "idle");
    y.sync({ inbox: [] });
    const gone = y.d.wait(LOCAL, 50_000, ac.signal);
    ac.abort();
    expect(await gone).toEqual({ end: true, reason: "gone" });
    // A message arriving after the waiter went away stays for the next boundary.
    y.sync({ inbox: [{ id: "m9", to: ME, from: { person: "An" }, text: "later", ts: T }] });
    expect(y.coord.pendingFor(LOCAL).map((i) => i.id)).toEqual(["m9"]);
    expect(await harness({ shared: false }).d.wait(LOCAL, 1000)).toMatchObject({ end: true });
    const off = harness({ settings: { wake: false } });
    off.sync();
    expect(await off.d.wait(LOCAL, 1000)).toMatchObject({ end: true });
  });

  it("Codex: an idle thread's waking message goes through codex queue, once; a failure leaves it for the next turn", async () => {
    const x = harness();
    const tried: Array<[string, string]> = [];
    let ok = false;
    const d = new Delegate({
      coord: () => x.coord,
      getSession: (k) => (k === "codex:t-0123456789" ? { key: k, source: "codex", sessionId: "t-0123456789", state: "idle", agents: 1, startedAt: T, updatedAt: T, stateSince: T } : undefined),
      isShared: () => true,
      repoOf: () => undefined,
      settings: () => ({ wake: true, accept: "auto-self", customGates: [] }),
      codexWake: async (id, text) => {
        tried.push([id, text]);
        return ok;
      },
      now: () => T,
    });
    x.coord.apply(hubSyncAcceptSchema.parse({ ...BASE, inbox: [{ id: "c1", to: `${DEV}:codex:t-0123456789`, from: { person: "An" }, text: "hello codex", ts: T }] }), T);
    d.check();
    await flush();
    expect(tried).toHaveLength(1);
    expect(tried[0]?.[0]).toBe("t-0123456789");
    expect(x.coord.pendingFor("codex:t-0123456789")).toHaveLength(1); // not delivered: next tool boundary
    d.check();
    await flush();
    expect(tried).toHaveLength(1); // tried once
    ok = true;
    x.coord.apply(hubSyncAcceptSchema.parse({ ...BASE, inbox: [{ id: "c2", to: `${DEV}:codex:t-0123456789`, from: { person: "An" }, text: "again", ts: T + 1 }] }), T);
    d.check();
    await flush();
    expect(x.coord.pendingFor("codex:t-0123456789").map((i) => i.id)).not.toContain("c2");
  });

  it("wakeText frames the daemon's own notices as they are", () => {
    const x = harness();
    x.coord.notify(LOCAL, "Workmesh: Sean approved: merge x.");
    const t = wakeText(x.coord.pendingFor(LOCAL));
    expect(t?.text.split("\n").at(-1)).toBe("Workmesh: Sean approved: merge x.");
    expect(t?.text).not.toContain("Message from");
  });
});

class FakeRunner implements HandoffRunnerLike {
  ran: string[] = [];
  cant: string | undefined;
  room = true;
  private readonly ids = new Set<string>();
  running(): ReadonlySet<string> {
    return this.ids;
  }
  hasRoom(): boolean {
    return this.room;
  }
  cannotRun(): string | undefined {
    return this.cant;
  }
  run(h: HubHandoffAccepted): void {
    this.ran.push(h.id);
    this.ids.add(h.id);
  }
}

type Handoffs = NonNullable<HubSyncResponse["handoffs"]>;

const handoff = (over: Record<string, unknown> = {}) => ({
  id: "h_1",
  from: { person: "Sean", sessionKey: `${OTHER_DEV}:claude-code:z1`, sessionName: "laptop-agent" },
  to: { person: "Sean" },
  task: "Port the KEK rotation to the new runner",
  repo: "b3-fun/b3os-beta",
  status: "offered",
  createdAt: T,
  ...over,
});

describe("handoffs (SPEC §31)", () => {
  it("auto-self: a handoff the person sent from another machine is accepted here and started", async () => {
    const runner = new FakeRunner();
    const x = harness({ runner, replies: [{ status: 200, body: { ok: true, handoff: handoff({ status: "accepted", device: DEV }) } }] });
    x.sync({ handoffs: [handoff()] as unknown as Handoffs });
    await flush();
    expect(x.calls[0]).toEqual({ url: "https://hub.test/relay/handoffs", body: { action: "accept", id: "h_1" } });
    expect(runner.ran).toEqual(["h_1"]);
  });

  it("the sending machine gives the person's other machines 20 s first", async () => {
    const runner = new FakeRunner();
    const x = harness({ runner, replies: [{ status: 200, body: { ok: true, handoff: handoff({ status: "accepted", device: DEV }) } }] });
    const fromHere = handoff({ from: { person: "Sean", sessionKey: ME } }) as unknown as Handoffs[number];
    x.sync({ handoffs: [fromHere] });
    await flush();
    expect(x.calls).toEqual([]);
    x.tick(SELF_HANDOFF_SENDER_DELAY_MS + 1);
    x.sync({ handoffs: [fromHere] });
    await flush();
    expect(x.calls.map((c) => (c.body as { action: string }).action)).toEqual(["accept"]);
  });

  it("someone else's handoff waits for the person; ask and never policies; another device's accept", async () => {
    const runner = new FakeRunner();
    const x = harness({ runner });
    x.sync({ handoffs: [handoff({ from: { person: "An", sessionKey: AN } })] as unknown as Handoffs });
    const ask = harness({ runner, settings: { accept: "ask" } });
    ask.sync({ handoffs: [handoff()] as unknown as Handoffs });
    await flush();
    expect(x.calls).toEqual([]);
    expect(ask.calls).toEqual([]);
    // Accepted on the board (no device): this machine may start it; on another device: not here.
    x.sync({ handoffs: [handoff({ status: "accepted", from: { person: "An", sessionKey: AN } })] as unknown as Handoffs });
    expect(runner.ran).toEqual(["h_1"]);
    const r2 = new FakeRunner();
    const y = harness({ runner: r2 });
    y.sync({ handoffs: [handoff({ status: "accepted", device: OTHER_DEV })] as unknown as Handoffs });
    expect(r2.ran).toEqual([]);
    const r3 = new FakeRunner();
    const never = harness({ runner: r3, settings: { accept: "never" } });
    never.sync({ handoffs: [handoff({ status: "accepted" })] as unknown as Handoffs });
    expect(r3.ran).toEqual([]);
  });

  it("accepted for this machine but it can't run it: says so on the hub, once", async () => {
    const runner = new FakeRunner();
    runner.cant = "no checkout of b3-fun/b3os-beta here";
    const x = harness({ runner });
    const h = handoff({ status: "accepted", device: DEV }) as unknown as Handoffs[number];
    x.sync({ handoffs: [h] });
    x.sync({ handoffs: [h] });
    await flush();
    expect(x.calls).toEqual([
      { url: "https://hub.test/relay/handoffs", body: { action: "fail", id: "h_1", note: "Couldn't start on this machine: no checkout of b3-fun/b3os-beta here" } },
    ]);
    expect(runner.ran).toEqual([]);
  });

  it("the sending session hears how its handoff went (not what was already so at start)", () => {
    const x = harness({ runner: new FakeRunner() });
    const mine = (status: string, note?: string) =>
      handoff({ to: { person: "An" }, from: { person: "Sean", sessionKey: ME, sessionName: "orch" }, status, ...(note ? { note } : {}) }) as unknown as Handoffs[number];
    x.sync({ handoffs: [mine("accepted")] });
    expect(x.coord.pendingFor(LOCAL)).toEqual([]);
    x.sync({ handoffs: [mine("started")] });
    x.sync({ handoffs: [mine("done", "PR 214 is up")] });
    const texts = x.coord.pendingFor(LOCAL).map((i) => i.text);
    expect(texts).toEqual([
      'Workmesh: An\'s machine started an agent for your handoff "Port the KEK rotation to the new runner".',
      'Workmesh: your handoff to An is done ("Port the KEK rotation to the new runner"): PR 214 is up',
    ]);
    expect(x.coord.wakeFor(LOCAL).map((i) => i.text)).toEqual([texts[1]]); // only the outcome wakes
  });

  it("menu bar summary: offered to me, pending approvals I may decide", () => {
    const x = harness({ runner: new FakeRunner() });
    x.sync({
      handoffs: [handoff({ from: { person: "An", sessionKey: AN } })] as unknown as Handoffs,
      gates: [{ owner: "An", actions: ["merge"], approvers: ["Sean"] }],
      approvals: [{ id: "ap_9", sessionKey: AN, owner: "An", gate: "merge", detail: "gh pr merge 9 in b3-fun/x", status: "pending", ts: T }],
    });
    const s = x.d.summary(() => undefined)!;
    expect(s.available).toBe(true);
    expect(s.handoffs.map((h) => [h.id, h.from, h.status])).toEqual([["h_1", "An", "offered"]]);
    expect(s.approvals).toEqual([{ id: "ap_9", session: undefined, name: undefined, gate: "merge", detail: "gh pr merge 9 in b3-fun/x", status: "pending", ts: T, mine: false, canDecide: true }]);
  });
});

describe("shared knowledge at session start (SPEC §31)", () => {
  it("rules and conventions from notes (newest first, capped) and the person's open claims", () => {
    const notes = [
      { id: "n1", by: { person: "An" }, text: "Deploys freeze at 5pm ET.", tags: ["rule"], ts: T },
      { id: "n2", by: { person: "Gio" }, text: "Lunch is at noon", tags: ["social"], ts: T + 5 },
      { id: "n3", by: { person: "Sean" }, text: "Zod v4 for anything\ncrossing a wire", tags: ["Convention"], ts: T + 9 },
    ];
    const claims = [
      { issue: "B3-7168", holder: { person: "Sean", sessionKey: ME }, note: "relay side" },
      { issue: "B3-7000", holder: { person: "Sean", sessionKey: `${DEV}:claude-code:s2`, sessionName: "other" } },
      { issue: "B3-1", holder: { person: "An", sessionKey: AN } },
    ];
    const k = knowledge(notes, claims, "Sean", (hk) => hk === ME)!;
    expect(k.split("\n")).toEqual([
      "Team rules and conventions (Workmesh notes, newest first; a teammate's note, your own person's instructions come first):",
      "- Zod v4 for anything crossing a wire (Sean)",
      "- Deploys freeze at 5pm ET. (An)",
      "Your open claims: B3-7168 (this session) — relay side; B3-7000 (other).",
    ]);
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, by: { person: "An" }, text: `rule ${i}`, tags: ["rule"], ts: T + i }));
    expect(knowledge(many, [], "Sean", () => false)!.split("\n").length).toBeLessThanOrEqual(16);
    expect(knowledge([], [], "Sean", () => false)).toBeUndefined();
  });

  it("goes out with the guidance at SessionStart, once", () => {
    const x = harness();
    x.sync({ notes: [{ id: "n1", by: { person: "An" }, text: "Deploys freeze at 5pm ET.", tags: ["rule"], ts: T }], claims: [{ issue: "B3-7168", holder: { person: "Sean", sessionKey: ME }, since: T }] });
    const hooks = new CoordHooks({ coord: () => x.coord, classify: () => undefined, isShared: () => true, projectName: () => "B3", now: () => T });
    const start: SessionEvent = { source: "claude-code", sessionId: "s1", kind: "start", ts: T, detail: { hookEvent: "SessionStart" } };
    const ctx = hooks.context(start, "SessionStart")!;
    expect(ctx).toContain(guidance("B3", true));
    expect(ctx).toContain("- Deploys freeze at 5pm ET. (An)");
    expect(ctx).toContain("Your open claims: B3-7168 (this session).");
    expect(ctx).toContain("`handoff` a task to a teammate");
    expect(hooks.context(start, "SessionStart")).toBeUndefined();
  });
});

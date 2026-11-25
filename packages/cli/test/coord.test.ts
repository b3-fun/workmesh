import { afterEach, describe, expect, it } from "vitest";
import { hubSyncAcceptSchema } from "@workmesh/protocol";
import type { HubSyncResponse } from "@workmesh/protocol";
import type { SessionEvent } from "@workmesh/core";
import { CoordClient } from "../src/hub/coord";
import { CoordHooks, formatInbox, guidance } from "../src/daemon/coord-hooks";
import { hookOutput } from "../src/commands/hook";

/** v1 Coordinate, relay side (docs/SPEC.md §21, §23): the sync client and hook decisions, by fixture. */

const TOKEN = `bp_${"c".repeat(64)}`;
const DEV = "dev_01JD0000000000000000000000";
const T = 1_795_545_600_000;
const ME = `${DEV}:claude-code:s1`;
const AN = "dev_01JDANANANANANANANANANANAN:claude-code:s9";

const lease = (over: Partial<HubSyncResponse["leases"][number]> = {}): HubSyncResponse["leases"][number] => ({
  id: "ls_1",
  repo: "b3-fun/workmesh",
  paths: ["packages/cli/src/hub/**"],
  holder: { person: "An", sessionKey: AN, sessionName: "b3iq-strategy" },
  since: T,
  expiresAt: T + 23 * 60_000,
  reason: "reworking the forwarder",
  ...over,
});

const SYNC: HubSyncResponse = {
  cursor: "c1",
  serverNow: T,
  me: { person: "Sean" },
  leases: [lease()],
  holds: [],
  inbox: [],
  claims: [],
  roster: [{ person: "An", sessions: [{ hubKey: AN, name: "b3iq-strategy", state: "working", repo: "b3-fun/workmesh" }] }],
  notes: [],
  edits: [],
};

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

function fakeHub(replies: Reply[] = []) {
  const calls: Array<{ url: string; method: string; auth?: string; body?: unknown }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
      body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
    });
    const r = replies.shift() ?? { status: 200, body: SYNC };
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function client(opts: { now?: () => number; replies?: Reply[]; active?: () => boolean } = {}) {
  const hub = fakeHub(opts.replies);
  const c = new CoordClient({
    url: "https://hub.test/",
    token: TOKEN,
    deviceId: DEV,
    person: "Sean",
    fetchImpl: hub.fetchImpl,
    now: opts.now ?? (() => T),
    active: opts.active,
  });
  return { c, hub };
}

const accept = (s: HubSyncResponse) => hubSyncAcceptSchema.parse(s);

describe("CoordClient sync", () => {
  let c: CoordClient | undefined;
  afterEach(() => c?.stop());

  it("reads /relay/sync with the device token, sends the cursor back, keeps the last good state", async () => {
    const x = client({ replies: [{ status: 200, body: SYNC }, new Error("ECONNRESET"), { status: 200, body: { ...SYNC, cursor: "c2" } }] });
    c = x.c;
    await c.sync();
    expect(x.hub.calls[0]).toMatchObject({ url: "https://hub.test/relay/sync", auth: `Bearer ${TOKEN}` });
    expect(c.view()).toMatchObject({ available: true, fetchedAt: T, state: { cursor: "c1" } });
    await c.sync();
    expect(c.view().error).toContain("hub unreachable");
    expect(c.view().state?.leases).toHaveLength(1); // still the last good answer
    await c.sync();
    expect(x.hub.calls[2]?.url).toBe("https://hub.test/relay/sync?cursor=c1");
  });

  it("polls every 5 s while a shared session is live, 60 s otherwise; backs off on errors; honours 429", async () => {
    let active = true;
    let now = T;
    const x = client({ now: () => now, active: () => active, replies: [{ status: 200, body: SYNC }, { status: 500 }, { status: 500 }, { status: 429, headers: { "retry-after": "120" } }] });
    c = x.c;
    await c.sync();
    expect(c.pollMs()).toBe(5000);
    active = false;
    expect(c.pollMs()).toBe(60_000);
    await c.sync();
    expect(c.pollMs()).toBe(10_000);
    await c.sync();
    expect(c.pollMs()).toBe(20_000);
    await c.sync();
    expect(c.pollMs()).toBe(120_000);
    now += 121_000;
    expect(c.pollMs()).toBe(20_000); // the earlier failures still count until a good sync
  });

  it("an older hub (404): coordination off, asked again in 10 min, calls answer 'unavailable', nothing is ever held", async () => {
    const x = client({ replies: [{ status: 200, body: { ...SYNC, holds: [{ sessionKey: ME, by: "An", since: T }] } }, { status: 404, body: "not found" }] });
    c = x.c;
    await c.sync();
    expect(c.holdFor("claude-code:s1")).toBeDefined();
    await c.sync();
    expect(c.view()).toMatchObject({ available: false, pollMs: 600_000 });
    expect(c.holdFor("claude-code:s1")).toBeUndefined();
    const r = await c.lease({ action: "acquire", sessionKey: "claude-code:s1", repo: "b3-fun/workmesh", paths: ["a"] });
    expect(r).toMatchObject({ ok: false, unavailable: true });
    expect(x.hub.calls).toHaveLength(2); // no request was made
  });

  it("a rejected token (401) stops syncing and lifts holds (fail open)", async () => {
    const x = client({ replies: [{ status: 200, body: { ...SYNC, holds: [{ sessionKey: ME, by: "An", since: T }] } }, { status: 401 }] });
    c = x.c;
    await c.sync();
    await c.sync();
    expect(c.view()).toMatchObject({ halted: true, error: expect.stringContaining("401") });
    expect(c.holdFor("claude-code:s1")).toBeUndefined();
  });
});

describe("CoordClient state for hooks", () => {
  it("a hold covers the session and its subagents; it lasts 30 min without a newer sync, and a sync without it lifts it", () => {
    let now = T;
    const { c } = client({ now: () => now });
    c.apply(accept({ ...SYNC, holds: [{ sessionKey: ME, by: "An", reason: "reworking the cell layout", since: T }] }), now);
    expect(c.holdFor("claude-code:s1")?.by).toBe("An");
    expect(c.holdFor("claude-code:s1/a1234567890abcdef")?.by).toBe("An");
    expect(c.holdFor("claude-code:s2")).toBeUndefined();
    now += 29 * 60_000;
    expect(c.holdFor("claude-code:s1")).toBeDefined(); // the hub is unreachable meanwhile: a known hold stays
    now += 2 * 60_000;
    expect(c.holdFor("claude-code:s1")).toBeUndefined(); // 30 min without confirmation: fail open
    c.apply(accept({ ...SYNC, holds: [{ sessionKey: ME, by: "An", since: T }] }), now);
    expect(c.holdFor("claude-code:s1")).toBeDefined();
    c.apply(accept(SYNC), now);
    expect(c.holdFor("claude-code:s1")).toBeUndefined();
  });

  it("leases: another session's (the same person's too) count; this session's and its subagents' don't; expired or stale don't", () => {
    let now = T;
    const { c } = client({ now: () => now });
    const mineOther = lease({ id: "ls_2", paths: ["README.md"], holder: { person: "Sean", sessionKey: `${DEV}:codex:t7`, sessionName: "codex-2" } });
    const mine = lease({ id: "ls_3", paths: ["docs/**"], holder: { person: "Sean", sessionKey: ME } });
    const mySub = lease({ id: "ls_4", paths: ["app/**"], holder: { person: "Sean", sessionKey: `${ME}/a1b2c3d4e5f60718` } });
    c.apply(accept({ ...SYNC, leases: [lease(), mineOther, mine, mySub, lease({ id: "ls_5", paths: ["old.ts"], expiresAt: T - 1 })] }), now);
    expect(c.leasesCovering("b3-fun/workmesh", "packages/cli/src/hub/forwarder.ts", "claude-code:s1").map((h) => h.lease.id)).toEqual(["ls_1"]);
    expect(c.leasesCovering("b3-fun/workmesh", "packages/cli/src/hub/forwarder.ts", "claude-code:s1")[0]?.entries).toEqual(["packages/cli/src/hub/**"]);
    expect(c.leasesCovering("b3-fun/other", "packages/cli/src/hub/forwarder.ts", "claude-code:s1")).toEqual([]);
    expect(c.leasesCovering("b3-fun/workmesh", "README.md", "claude-code:s1").map((h) => h.lease.id)).toEqual(["ls_2"]);
    expect(c.leasesCovering("b3-fun/workmesh", "docs/a.md", "claude-code:s1")).toEqual([]);
    expect(c.leasesCovering("b3-fun/workmesh", "docs/a.md", "claude-code:s1/a99")).toEqual([]);
    expect(c.leasesCovering("b3-fun/workmesh", "app/x.ts", "claude-code:s1")).toEqual([]);
    expect(c.leasesCovering("b3-fun/workmesh", "docs/a.md", "codex:t7").map((h) => h.lease.id)).toEqual(["ls_3"]);
    expect(c.leasesCovering("b3-fun/workmesh", "old.ts", "claude-code:s1")).toEqual([]);
    expect(c.leasesCovering("b3-fun/workmesh", "packages/cli/src/hub/*.ts", "claude-code:s1").map((h) => h.lease.id)).toEqual(["ls_1"]);
    now += 91_000;
    expect(c.leasesCovering("b3-fun/workmesh", "packages/cli/src/hub/forwarder.ts", "claude-code:s1")).toEqual([]); // stale: fail open
  });

  it("recent edits: other people's, from the last 10 minutes, newest first", () => {
    const { c } = client();
    const edit = (person: string, sessionKey: string, ts: number, p = "src/a.ts") => ({ repo: "b3-fun/workmesh", path: p, person, sessionKey, ts });
    c.apply(
      accept({
        ...SYNC,
        edits: [edit("An", AN, T - 60_000), edit("An", AN, T - 11 * 60_000), edit("Gio", "dev_G:codex:x", T - 30_000), edit("Sean", `${DEV}:codex:t7`, T), edit("Sean", "dev_OTHERMAC:claude-code:q", T)],
      }),
      T,
    );
    expect(c.recentEditsByOthers("b3-fun/workmesh", "src/a.ts").map((e) => e.person)).toEqual(["Gio", "An"]);
    expect(c.recentEditsByOthers("b3-fun/workmesh", "src/b.ts")).toEqual([]);
  });

  it("inbox: handed over once, acked, re-acked while the hub still lists it; kept a while by an incremental hub", async () => {
    const x = client();
    const c = x.c;
    const msg = (id: string, to = ME) => ({ id, to, from: { person: "An", sessionName: "b3iq-strategy" }, text: `hello ${id}`, ts: T });
    c.apply(accept({ ...SYNC, inbox: [msg("m1"), msg("m2", `${DEV}:codex:t7`), msg("m3", AN)] }), T);
    expect(c.pendingFor("claude-code:s1").map((m) => m.id)).toEqual(["m1"]);
    expect(c.pendingFor("codex:t7").map((m) => m.id)).toEqual(["m2"]);
    c.markDelivered(["m1"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(x.hub.calls.at(-1)).toMatchObject({ url: "https://hub.test/relay/inbox/ack", method: "POST", body: { ids: ["m1"] } });
    expect(c.pendingFor("claude-code:s1")).toEqual([]);
    // The ack hasn't landed yet: the hub lists m1 again. It is not handed over again, and it is acked again.
    c.apply(accept({ ...SYNC, inbox: [msg("m1")] }), T + 5000);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.pendingFor("claude-code:s1")).toEqual([]);
    expect(x.hub.calls.filter((k) => k.url.endsWith("/inbox/ack"))).toHaveLength(2);
    // A hub that lists each item once (cursor-incremental): m2, never delivered, is kept.
    c.apply(accept({ ...SYNC, inbox: [] }), T + 10_000);
    expect(c.pendingFor("codex:t7").map((m) => m.id)).toEqual(["m2"]);
    expect(c.inboxItems().map((m) => m.id)).toEqual(["m2"]); // m1 was delivered and is gone
  });

  it("hub calls: strict bodies, conflicts read from a 409, bad requests refused before sending", async () => {
    const conflict = { ok: false, conflicts: [{ leaseId: "ls_1", holder: { person: "An", sessionKey: AN, sessionName: "b3iq-strategy" }, paths: ["packages/cli/src/hub/**"], expiresAt: T + 60_000 }] };
    const x = client({ replies: [{ status: 409, body: conflict }, { status: 404, body: { ok: false, error: "no such person: Bob" } }] });
    const r = await x.c.lease({ action: "acquire", sessionKey: "claude-code:s1", repo: "b3-fun/workmesh", paths: ["packages/cli/src/hub/forwarder.ts"], ttlSec: 1800 });
    expect(x.hub.calls[0]).toMatchObject({ url: "https://hub.test/relay/leases", body: { action: "acquire", paths: ["packages/cli/src/hub/forwarder.ts"] } });
    expect(r).toMatchObject({ ok: true, status: 409, body: { ok: false, conflicts: [{ leaseId: "ls_1" }] } });
    const m = await x.c.message({ from: "claude-code:s1", to: { person: "Bob" }, text: "hi" });
    expect(m).toMatchObject({ ok: true, status: 404, body: { ok: false, error: "no such person: Bob" } });
    expect(x.c.view().available).not.toBe(false); // a 404 with a body is an answer, not an old hub
    const bad = await x.c.lease({ action: "acquire", sessionKey: "claude-code:s1", repo: "b3-fun/workmesh", paths: ["/etc/passwd"] });
    expect(bad).toMatchObject({ ok: false });
    expect(x.hub.calls).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ hook decisions

const ROOT = "/w/workmesh";
const classify = (p: string) => (p === ROOT || p.startsWith(`${ROOT}/`) ? { root: ROOT, repo: "b3-fun/workmesh" } : undefined);

function hooks(c: CoordClient | undefined, opts: { shared?: boolean; now?: () => number } = {}) {
  return new CoordHooks({
    coord: () => c,
    classify,
    isShared: () => opts.shared ?? true,
    projectName: () => "B3",
    now: opts.now ?? (() => T),
    home: "/home/me",
  });
}

const ev = (over: Partial<SessionEvent> & { detail?: SessionEvent["detail"] }): SessionEvent => ({
  source: "claude-code",
  sessionId: "s1",
  kind: "working",
  cwd: ROOT,
  ts: T,
  ...over,
});
const edit = (tool: string, filePath: string, extra: Partial<NonNullable<SessionEvent["detail"]>> = {}) =>
  ev({ detail: { hookEvent: "PreToolUse", tool, filePath, ...extra } });

describe("hook decisions", () => {
  it("a hold refuses every tool call of the session and its subagents, naming who and why", () => {
    const { c } = client();
    c.apply(accept({ ...SYNC, holds: [{ sessionKey: ME, by: "An", reason: "reworking the cell layout", since: T }] }), T);
    const h = hooks(c);
    const deny = h.refuse(ev({ detail: { hookEvent: "PreToolUse", tool: "Read", filePath: `${ROOT}/a.ts` } }), "PreToolUse");
    expect(deny).toMatch(/^Held by An: reworking the cell layout\. /);
    expect(deny).toContain("`workmesh send An \"…\"`");
    expect(h.refuse(ev({ detail: { hookEvent: "PreToolUse", tool: "Bash", command: "ls", agentId: "a1b2c3d4e5f60718" } }), "PreToolUse")).toContain("Held by An");
    expect(h.refuse(ev({ sessionId: "s2", detail: { hookEvent: "PreToolUse", tool: "Read" } }), "PreToolUse")).toBeUndefined();
    expect(h.refuse(ev({ detail: { hookEvent: "PostToolUse", tool: "Read" } }), "PostToolUse")).toBeUndefined();
  });

  it("an edit to another session's leased file is refused with the holder, entries, expiry and how to ask", () => {
    const { c } = client();
    c.apply(accept(SYNC), T);
    const h = hooks(c);
    const deny = h.refuse(edit("Edit", `${ROOT}/packages/cli/src/hub/forwarder.ts`), "PreToolUse")!;
    expect(deny).toContain("packages/cli/src/hub/forwarder.ts in b3-fun/workmesh is leased to An's agent b3iq-strategy");
    expect(deny).toContain("for 23 more min");
    expect(deny).toContain('("reworking the forwarder")');
    expect(deny).toContain("(lease on packages/cli/src/hub/**)");
    expect(deny).toContain("Don't edit it.");
    expect(deny).toContain('`workmesh send An "…"`');
    expect(deny).toContain("to: b3iq-strategy");
    for (const tool of ["Write", "MultiEdit", "NotebookEdit"]) {
      expect(h.refuse(edit(tool, `${ROOT}/packages/cli/src/hub/git.ts`), "PreToolUse"), tool).toBeDefined();
    }
    // Codex apply_patch: several files, one leased.
    expect(
      h.refuse(ev({ source: "codex", sessionId: "t1", detail: { hookEvent: "PreToolUse", tool: "apply_patch", filePath: `${ROOT}/README.md`, filePaths: [`${ROOT}/README.md`, `${ROOT}/packages/cli/src/hub/team.ts`] } }), "PreToolUse"),
    ).toContain("packages/cli/src/hub/team.ts");
    // Shell commands that clearly write a leased path; Codex's `cd <workdir> &&` included.
    expect(h.refuse(ev({ detail: { hookEvent: "PreToolUse", tool: "Bash", command: "rm packages/cli/src/hub/rules.ts" } }), "PreToolUse")).toContain("rules.ts");
    expect(h.refuse(ev({ cwd: "/tmp", detail: { hookEvent: "PreToolUse", tool: "exec_command", command: `cd ${ROOT}/packages/cli && sed -i '' 's/a/b/' src/hub/git.ts` } }), "PreToolUse")).toContain("git.ts");
    expect(h.refuse(ev({ detail: { hookEvent: "PreToolUse", tool: "Bash", command: "cat packages/cli/src/hub/rules.ts" } }), "PreToolUse")).toBeUndefined();
    // Reads, other files, unshared paths.
    expect(h.refuse(edit("Read", `${ROOT}/packages/cli/src/hub/forwarder.ts`), "PreToolUse")).toBeUndefined();
    expect(h.refuse(edit("Edit", `${ROOT}/packages/cli/src/index.ts`), "PreToolUse")).toBeUndefined();
    expect(h.refuse(edit("Edit", "/elsewhere/packages/cli/src/hub/x.ts"), "PreToolUse")).toBeUndefined();
  });

  it("the same person's other session is named as such", () => {
    const { c } = client();
    c.apply(accept({ ...SYNC, leases: [lease({ holder: { person: "Sean", sessionKey: `${DEV}:codex:t7`, sessionName: "codex-2" } })] }), T);
    const deny = hooks(c).refuse(edit("Edit", `${ROOT}/packages/cli/src/hub/forwarder.ts`), "PreToolUse")!;
    expect(deny).toContain("leased to your own other session codex-2");
    expect(deny).toContain("`unlease`");
  });

  it("fails open: no coordination, a stale sync, an older hub, or an error means no answer", () => {
    expect(hooks(undefined).refuse(edit("Edit", `${ROOT}/packages/cli/src/hub/forwarder.ts`), "PreToolUse")).toBeUndefined();
    let now = T;
    const { c } = client({ now: () => now });
    c.apply(accept(SYNC), T);
    now += 5 * 60_000;
    expect(hooks(c, { now: () => now }).refuse(edit("Edit", `${ROOT}/packages/cli/src/hub/forwarder.ts`), "PreToolUse")).toBeUndefined();
    const broken = new CoordHooks({ coord: () => c, classify: () => { throw new Error("boom"); }, isShared: () => true, now: () => T });
    expect(broken.answer(edit("Edit", `${ROOT}/x.ts`), "PreToolUse", undefined)).toBeUndefined();
  });

  it("warns, once per 10 min, before an edit to a file another person's agent edited recently", () => {
    let now = T;
    const { c } = client({ now: () => now });
    c.apply(accept({ ...SYNC, leases: [], edits: [{ repo: "b3-fun/workmesh", path: "src/a.ts", person: "An", sessionKey: AN, sessionName: "b3iq-strategy", ts: T - 3 * 60_000 }] }), T);
    const h = hooks(c, { now: () => now });
    const e = edit("Edit", `${ROOT}/src/a.ts`);
    expect(h.refuse(e, "PreToolUse")).toBeUndefined(); // allowed
    const ctx = h.context(e, "PreToolUse");
    expect(ctx).toContain("heads up, An's agent b3iq-strategy edited src/a.ts (b3-fun/workmesh) 3 min ago");
    expect(h.context(e, "PreToolUse")).toBeUndefined();
    now += 11 * 60_000;
    c.apply(accept({ ...SYNC, serverNow: now, leases: [], edits: [{ repo: "b3-fun/workmesh", path: "src/a.ts", person: "An", sessionKey: AN, ts: now - 60_000 }] }), now);
    expect(h.context(e, "PreToolUse")).toContain("1 min ago");
  });

  it("guidance once per shared session, at its start or first boundary, only while the hub coordinates", () => {
    const { c } = client();
    const h = hooks(c);
    expect(h.context(ev({ kind: "start" }), "SessionStart")).toBeUndefined(); // not synced yet
    c.apply(accept(SYNC), T);
    const g = h.context(ev({ kind: "start" }), "SessionStart")!;
    expect(g).toBe(guidance("B3"));
    expect(g.split("\n").length).toBeLessThanOrEqual(8);
    expect(h.context(ev({}), "UserPromptSubmit")).toBeUndefined();
    expect(hooks(c, { shared: false }).context(ev({ kind: "start" }), "SessionStart")).toBeUndefined();
    // Not shared at start (an orchestrator): given at the first boundary after it becomes shared.
    let shared = false;
    const h2 = new CoordHooks({ coord: () => c, classify, isShared: () => shared, now: () => T });
    expect(h2.context(ev({ sessionId: "o1" }), "SessionStart")).toBeUndefined();
    shared = true;
    expect(h2.context(ev({ sessionId: "o1", detail: { hookEvent: "PostToolUse", tool: "Edit" } }), "PostToolUse")).toContain("Workmesh: this session is on your team's board");
  });

  it("inbox messages reach the agent at the next tool boundary or prompt, once, then are acked", async () => {
    const x = client();
    const c = x.c;
    c.apply(
      accept({
        ...SYNC,
        inbox: [
          { id: "m1", to: ME, from: { person: "An", sessionName: "b3iq-strategy" }, text: "I have the forwarder; take the CLI?", ts: T },
          { id: "m2", to: `${ME}/a1b2c3d4e5f60718`, from: { person: "Gio" }, text: "for the subagent", ts: T + 1 },
        ],
      }),
      T,
    );
    const h = hooks(c);
    h.context(ev({ kind: "start" }), "SessionStart"); // guidance out of the way
    expect(h.context(edit("Read", `${ROOT}/x`), "PreToolUse")).toBeUndefined(); // not at PreToolUse
    const ctx = h.context(ev({ detail: { hookEvent: "PostToolUse", tool: "Read" } }), "PostToolUse")!;
    expect(ctx).toContain("Message from An (b3iq-strategy): I have the forwarder; take the CLI?");
    expect(ctx).not.toContain("for the subagent");
    expect(h.context(ev({ detail: { hookEvent: "PostToolUse", tool: "Read" } }), "PostToolUse")).toBeUndefined();
    const sub = h.context(ev({ detail: { hookEvent: "PostToolUse", tool: "Read", agentId: "a1b2c3d4e5f60718" } }), "PostToolUse")!;
    expect(sub).toContain("Message from Gio: for the subagent");
    await new Promise((r) => setTimeout(r, 0));
    const acks = x.hub.calls.filter((k) => k.url.endsWith("/relay/inbox/ack")).flatMap((k) => (k.body as { ids: string[] }).ids);
    expect(acks.sort()).toEqual(["m1", "m2"]);
  });

  it("formats messages within the context budget", () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ id: `m${i}`, to: ME, from: { person: "An", sessionName: undefined, sessionKey: undefined }, text: "x".repeat(3000), ts: T + i, thread: undefined }));
    const block = formatInbox(items, 4000)!;
    expect(block.text.length).toBeLessThanOrEqual(4000);
    expect(block.items.length).toBeGreaterThanOrEqual(1);
    expect(formatInbox([], 4000)).toBeUndefined();
  });
});

describe("hook output (Claude Code and Codex PreToolUse/PostToolUse JSON)", () => {
  it("a refusal is permissionDecision deny with the reason; context is additionalContext; never allow", () => {
    expect(JSON.parse(hookOutput("PreToolUse", { deny: "Held by An", context: "note" })!)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Held by An", additionalContext: "note" },
    });
    expect(JSON.parse(hookOutput("PreToolUse", { context: "heads up" })!)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "heads up" } });
    for (const e of ["PostToolUse", "UserPromptSubmit", "SessionStart"]) {
      expect(JSON.parse(hookOutput(e, { context: "msg" })!)).toEqual({ hookSpecificOutput: { hookEventName: e, additionalContext: "msg" } });
      expect(hookOutput(e, { deny: "x" })).toBeUndefined(); // only PreToolUse refuses
    }
    expect(hookOutput("Stop", { context: "x" })).toBeUndefined();
    expect(hookOutput("PreToolUse", undefined)).toBeUndefined();
    expect(hookOutput(undefined, { deny: "x" })).toBeUndefined();
    expect(hookOutput("PreToolUse", { deny: "x" })).not.toContain('"allow"');
  });
});

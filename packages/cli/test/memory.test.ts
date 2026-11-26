import { describe, expect, it } from "vitest";
import { hubMemoryBriefResponseAcceptSchema, hubSyncAcceptSchema } from "@workmesh/protocol";
import type { HubMemoryBriefResponse, HubSyncResponse } from "@workmesh/protocol";
import type { AgentSession, SessionEvent } from "@workmesh/core";
import { CoordClient } from "../src/hub/coord";
import { CoordHooks, guidance, knowledge } from "../src/daemon/coord-hooks";
import { runCoordOp } from "../src/daemon/coord-ops";
import type { CoordOpRequest, CoordOpsDeps } from "../src/daemon/coord-ops";
import {
  MEMORY_HEADING,
  branchIssues,
  branchWords,
  firstSentence,
  wordStem,
  memoryLine,
  selectMemories,
} from "../src/daemon/memory";
import type { BriefMemory, MemoryContext } from "../src/daemon/memory";
import { NO_MEMORY_READ, NO_MEMORY_WRITE, agoText, memoryId, memoryKind, resolveMemoryScope } from "../src/daemon/memory-ops";
import { MCP_TOOLS } from "../src/mcp/server";

/** v3 Memory, relay side (docs/SPEC.md §36): selection, the brief, session start, the ops, by fixture. */

const TOKEN = `bp_${"e".repeat(64)}`;
const DEV = "dev_01JD0000000000000000000000";
const AN = "dev_01JDANANANANANANANANANANAN:claude-code:s9";
const T = 1_795_545_600_000;
const DAY = 24 * 60 * 60_000;
const LOCAL = "claude-code:s1";
const ME = `${DEV}:${LOCAL}`;
const ROOT = "/w/workmesh";
const REPO = "b3-fun/workmesh";
const classify = (p: string) =>
  p === ROOT || p.startsWith(`${ROOT}/`) ? { root: ROOT, repo: REPO, branch: "sean/b3-7203-memory-relay" } : undefined;

// ------------------------------------------------------------------ fixtures

const BRIEF: HubMemoryBriefResponse = {
  ok: true,
  rev: "r7",
  memories: [
    {
      id: "m21",
      kind: "rule",
      title: "Never edit a live checkout",
      body: "Teammates' hooks run the live checkout's dist build; work in a worktree. Ask before touching it.",
      scope: { repo: REPO },
      by: { person: "Sean" },
      updatedAt: T - 2 * DAY,
    },
    {
      id: "m19",
      kind: "convention",
      title: "Commit messages end with the Co-Authored-By line of the model that wrote them",
      body: "",
      by: { person: "Sean" },
      updatedAt: T - 3 * DAY,
    },
    {
      id: "m18",
      kind: "gotcha",
      title: "launchd bootstrap fails with error 5 when the daemon is re-run",
      body: "Boot out the old service first; `workmesh setup` does this since 0.11.0.",
      scope: { repo: REPO, paths: ["packages/cli/src/lib/service.ts"] },
      issues: ["B3-7168"],
      by: { person: "An" },
      updatedAt: T - 5 * DAY,
    },
    {
      id: "m17",
      kind: "decision",
      title: "Session start picks memories on the machine from a cached brief",
      body: "No network call in the hook path: hooks answer from the daemon's cache. Decided on B3-7203.",
      scope: { repo: REPO, paths: ["packages/cli/src/daemon/**"] },
      issues: ["B3-7203"],
      by: { person: "Sean" },
      updatedAt: T - DAY,
    },
    {
      id: "m16",
      kind: "fact",
      title: "The hub's brief carries at most 500 memories",
      body: "Bodies are cut to 600 characters there.",
      by: { person: "Gio" },
      updatedAt: T - 4 * DAY,
    },
    {
      id: "m15",
      kind: "gotcha",
      title: "wrangler deploys to the B3 account by default",
      body: "Pin the account id for personal deploys.",
      scope: { repo: "b3-fun/workmesh-cloud" },
      by: { person: "An" },
      updatedAt: T,
    },
    {
      id: "m14",
      kind: "rule",
      title: "Hub internals stay out of the public repo",
      body: "",
      scope: { repo: "b3-fun/workmesh-cloud" },
      by: { person: "An" },
      updatedAt: T,
    },
  ],
};
const brief = (b: HubMemoryBriefResponse = BRIEF): BriefMemory[] => hubMemoryBriefResponseAcceptSchema.parse(b).memories;
const HERE: MemoryContext = { repo: REPO, dir: "packages/cli", branch: "sean/b3-7203-memory-relay", issues: ["B3-7203"] };

const mem = (over: Partial<BriefMemory> & { id: string }): BriefMemory => ({
  kind: "fact",
  title: `memory ${over.id}`,
  body: "",
  by: { person: "An" },
  updatedAt: T,
  ...over,
});

const SYNC: HubSyncResponse = {
  cursor: "c1",
  serverNow: T,
  me: { person: "Sean" },
  leases: [],
  holds: [],
  inbox: [],
  claims: [{ issue: "B3-7203", holder: { person: "Sean", sessionKey: ME }, since: T }],
  roster: [{ person: "An", sessions: [{ hubKey: AN, name: "b3iq-strategy", state: "working", repo: REPO }] }],
  // A memory hub lists accepted memories as notes too (SPEC §35), for 0.11 relays.
  notes: [{ id: "m21", by: { person: "Sean" }, text: "Never edit a live checkout", tags: ["rule"], ts: T - 2 * DAY }],
  edits: [],
  memory: { rev: "r7" },
};
const OLD_SYNC: HubSyncResponse = { ...SYNC, memory: undefined };

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A stand-in hub: replies by `METHOD /path`, else the defaults (sync, brief, an accepted remember). */
function fakeHub(routes: Record<string, Reply[]> = {}, defaults: Record<string, Reply> = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const base: Record<string, Reply> = {
    "GET /relay/sync": { status: 200, body: SYNC },
    "GET /relay/memories": { status: 200, body: BRIEF },
    "POST /relay/memories": { status: 200, body: { ok: true } },
    "POST /relay/recall": { status: 200, body: { ok: true, memories: [] } },
    "POST /relay/notes": { status: 200, body: { ok: true, id: "n9" } },
    ...defaults,
  };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const key = `${method} ${u.pathname}`;
    calls.push({ method, path: u.pathname, body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined });
    const r = routes[key]?.shift() ?? base[key] ?? { status: 404, body: "not found" };
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function client(opts: { routes?: Record<string, Reply[]>; defaults?: Record<string, Reply>; now?: () => number } = {}) {
  const hub = fakeHub(opts.routes, opts.defaults);
  const c = new CoordClient({ url: "https://hub.test", token: TOKEN, deviceId: DEV, person: "Sean", fetchImpl: hub.fetchImpl, now: opts.now ?? (() => T) });
  return { c, hub };
}

/** Lets the background brief fetch (and a `used` report) finish. */
const settle = async (c?: CoordClient): Promise<void> => {
  await new Promise((r) => setImmediate(r));
  if (c) await c.memoryReady(Number.MAX_SAFE_INTEGER);
  await new Promise((r) => setImmediate(r));
};

// ------------------------------------------------------------------ selection

describe("session-start selection (SPEC §36)", () => {
  it("picks what matters here: rules first, then decisions and gotchas by relevance; never other repos", () => {
    const sel = selectMemories(brief(), HERE)!;
    expect(sel.text.split("\n")).toEqual([
      MEMORY_HEADING,
      "- [m21] rule: Never edit a live checkout — Teammates' hooks run the live checkout's dist build; work in a worktree. (Sean)",
      "- [m19] convention: Commit messages end with the Co-Authored-By line of the model that wrote them (Sean)",
      "- [m17] decision: Session start picks memories on the machine from a cached brief — No network call in the hook path: hooks answer from the daemon's cache. (Sean)",
      "- [m18] gotcha: launchd bootstrap fails with error 5 when the daemon is re-run — Boot out the old service first; `workmesh setup` does this since 0.11.0. (An)",
    ]);
    expect(sel.ids).toEqual(["m21", "m19", "m17", "m18"]);
    expect(sel.more).toBe(0);
    // m16 (project-wide fact, nothing linking it here) scores 0; m15 and m14 are another repo's.
    expect(sel.text).not.toMatch(/m16|m15|m14/);
  });

  it("an empty brief, or nothing that applies, injects nothing", () => {
    expect(selectMemories([], HERE)).toBeUndefined();
    expect(selectMemories([mem({ id: "m1", scope: { repo: "b3-fun/other" }, kind: "rule" })], HERE)).toBeUndefined();
    expect(selectMemories([mem({ id: "m1", kind: "fact" })], HERE)).toBeUndefined(); // project-wide, score 0
  });

  it("outside every shared repo: project-wide memories only", () => {
    const b = [
      mem({ id: "m1", kind: "rule", title: "project rule" }),
      mem({ id: "m2", kind: "rule", title: "repo rule", scope: { repo: REPO } }),
      mem({ id: "m3", kind: "decision", title: "linked", issues: ["B3-7203"] }),
      mem({ id: "m4", kind: "decision", title: "repo decision", scope: { repo: REPO }, issues: ["B3-7203"] }),
    ];
    expect(selectMemories(b, { issues: ["B3-7203"] })!.ids).toEqual(["m1", "m3"]);
  });

  it("rules and conventions: paths here, then this repo, the project, paths elsewhere; rule before convention; newest first", () => {
    const b = [
      mem({ id: "m1", kind: "rule", title: "elsewhere", scope: { repo: REPO, paths: ["apps/menubar/**"] }, updatedAt: T + 9 }),
      mem({ id: "m2", kind: "convention", title: "project convention", updatedAt: T + 8 }),
      mem({ id: "m3", kind: "rule", title: "project rule", updatedAt: T + 1 }),
      mem({ id: "m4", kind: "convention", title: "repo convention", scope: { repo: REPO }, updatedAt: T + 2 }),
      mem({ id: "m5", kind: "rule", title: "repo rule old", scope: { repo: REPO }, updatedAt: T }),
      mem({ id: "m6", kind: "rule", title: "repo rule new", scope: { repo: REPO }, updatedAt: T + 3 }),
      mem({ id: "m7", kind: "convention", title: "here", scope: { repo: REPO, paths: ["packages/cli/src/**"] }, updatedAt: T }),
      mem({ id: "m8", kind: "rule", title: "covers the dir", scope: { repo: REPO, paths: ["packages"] }, updatedAt: T }),
    ];
    expect(selectMemories(b, HERE)!.ids).toEqual(["m8", "m7", "m6", "m5", "m4", "m3", "m2", "m1"]);
    // At the checkout's top every path is here.
    expect(selectMemories(b, { ...HERE, dir: "" })!.ids.slice(0, 3)).toEqual(["m1", "m8", "m7"]);
  });

  it("scores decisions, gotchas and facts: issue +3, repo +2, paths here +1 / elsewhere −1, branch words and ids +1 each (max 2)", () => {
    const ctx: MemoryContext = { repo: REPO, dir: "apps/menubar", branch: "sean/b3-7300-tray-icon", issues: [] };
    const b = [
      mem({ id: "m1", title: "project fact" }), // 0
      mem({ id: "m2", title: "repo fact", scope: { repo: REPO } }), // 2
      mem({ id: "m3", title: "cli fact", scope: { repo: REPO, paths: ["packages/cli/**"] } }), // 2 − 1 = 1
      mem({ id: "m4", title: "cli fact about the tray icon", scope: { repo: REPO, paths: ["packages/cli/**"] } }), // 1 + 2
      mem({ id: "m5", title: "menubar fact", scope: { repo: REPO, paths: ["apps/menubar/Sources/**"] } }), // 3
      mem({ id: "m6", title: "project gotcha", kind: "gotcha", issues: ["B3-7300"] }), // 3 (branch issue)
      mem({ id: "m7", title: "project decision on tray icons", kind: "decision", body: "See B3-7300." }), // tray, icon(s), B3-7300: capped at 2
    ];
    // 3s first, then 2s (equal times: the brief's order); m1 (0) and m3 (1) stay out.
    expect(selectMemories(b, ctx)!.ids).toEqual(["m4", "m5", "m6", "m2", "m7"]);
    // A claimed issue counts like a branch's.
    expect(selectMemories([mem({ id: "m9", title: "linked", issues: ["B3-1"] })], { issues: ["b3-1"] })!.ids).toEqual(["m9"]);
  });

  it("best first, newer first on a tie", () => {
    const b = [
      mem({ id: "m1", kind: "gotcha", scope: { repo: REPO }, updatedAt: T - DAY }),
      mem({ id: "m2", kind: "gotcha", scope: { repo: REPO }, updatedAt: T }),
      mem({ id: "m3", kind: "gotcha", scope: { repo: REPO }, issues: ["B3-7203"], updatedAt: T - 9 * DAY }),
    ];
    expect(selectMemories(b, HERE)!.ids).toEqual(["m3", "m2", "m1"]);
  });

  it("caps: 10 rules, 8 others, 20 lines with the heading and one '…and N more' line", () => {
    const b = [
      ...Array.from({ length: 12 }, (_, i) => mem({ id: `m${i + 1}`, kind: "rule", updatedAt: T + i })),
      ...Array.from({ length: 12 }, (_, i) => mem({ id: `m${i + 101}`, kind: "gotcha", scope: { repo: REPO }, updatedAt: T + i })),
    ];
    const sel = selectMemories(b, HERE)!;
    const lines = sel.text.split("\n");
    expect(lines).toHaveLength(20);
    expect(lines.filter((l) => l.includes("] rule:"))).toHaveLength(10);
    expect(lines.filter((l) => l.includes("] gotcha:"))).toHaveLength(8);
    expect(lines.at(-1)).toBe("- …and 6 more: `recall` searches them.");
    expect(sel.more).toBe(6);
    expect(sel.ids[0]).toBe("m12"); // newest rule first
  });

  it("each line: id, kind, title, the body's first sentence, the person; at most 240 characters", () => {
    expect(memoryLine(mem({ id: "m3", kind: "gotcha", title: "Short", body: "First one, e.g. this. Second one." }))).toBe(
      "- [m3] gotcha: Short — First one, e.g. this. (An)",
    );
    expect(memoryLine(mem({ id: "m3", title: "Same as body.", body: "Same as body. More." }))).toBe("- [m3] fact: Same as body. (An)");
    expect(memoryLine(mem({ id: "m3", title: "Lists", body: "\n- use zod v4\n- strict to send" }))).toBe("- [m3] fact: Lists — use zod v4 (An)");
    const long = memoryLine(mem({ id: "m3", title: "t".repeat(120), body: "b".repeat(600), by: { person: "An Le" } }));
    expect(long.length).toBe(240);
    expect(long).toMatch(/…\s?\(An Le\)$/);
    expect(firstSentence("No end")).toBe("No end");
    expect(firstSentence("v0.11.0 shipped. Then more.")).toBe("v0.11.0 shipped.");
  });

  it("reads issue ids and words from a branch name", () => {
    expect(branchIssues("sean/b3-7201-memory")).toEqual(["B3-7201"]);
    expect(branchIssues("B3-1-and-ENG-22")).toEqual(["B3-1", "ENG-22"]);
    expect(branchIssues(undefined)).toEqual([]);
    expect(branchWords("sean/b3-7201-memory-relay")).toEqual(["memory", "relay"]);
    expect(branchWords("memory-relay")).toEqual(["memory", "relay"]);
    expect(branchWords("feat/fix-the-tray-icon")).toEqual(["tray", "icon"]);
    expect(branchWords("main")).toEqual([]);
    expect(["memory", "hooks", "relay", "class", "key"].map(wordStem)).toEqual(["memor", "hook", "relay", "class", "key"]);
    // A branch word finds its plural: `memory` → "memories".
    expect(selectMemories([mem({ id: "m1", title: "how memories reach agents" })], { branch: "sean/memory-ranking", issues: [] })).toBeUndefined(); // project-wide: +1 only
    expect(selectMemories([mem({ id: "m1", title: "how memories rank", scope: { repo: REPO, paths: ["apps/**"] } })], { repo: REPO, dir: "packages/cli", branch: "sean/memory-ranking" })!.ids).toEqual(["m1"]); // 2 − 1 + 1 (memory)
  });
});

// ------------------------------------------------------------------ the brief (CoordClient)

describe("the brief (CoordClient, SPEC §36)", () => {
  it("fetched when a sync's memory.rev moves, never otherwise; at most every 10 s", async () => {
    let now = T;
    const x = client({
      now: () => now,
      routes: { "GET /relay/sync": [{ status: 200, body: SYNC }, { status: 200, body: SYNC }, { status: 200, body: { ...SYNC, memory: { rev: "r8" } } }] },
      defaults: { "GET /relay/memories": { status: 200, body: { ...BRIEF, rev: "r8" } } },
    });
    const briefs = () => x.hub.calls.filter((k) => k.path === "/relay/memories" && k.method === "GET").length;
    await x.c.sync();
    await settle(x.c);
    expect(briefs()).toBe(1);
    expect(x.c.memoryAvailable()).toBe(true);
    // The hub answered with a newer rev than the sync named: kept, and not fetched again for the older one.
    expect(x.c.briefInfo()).toMatchObject({ rev: "r8", count: 7 });
    expect(x.c.brief()?.map((m) => m.id)).toEqual(["m15", "m14", "m17", "m21", "m19", "m16", "m18"]); // newest first
    await x.c.sync(); // r7 again: the brief is current for it
    await x.c.sync(); // r8: what the brief already is
    await settle(x.c);
    expect(briefs()).toBe(1);
    // r9 within 10 s of the last fetch: throttled; after it, fetched.
    now = T + 5000;
    x.c.apply(hubSyncAcceptSchema.parse({ ...SYNC, memory: { rev: "r9" } }), now);
    await settle(x.c);
    expect(briefs()).toBe(1);
    now = T + 11_000;
    x.c.apply(hubSyncAcceptSchema.parse({ ...SYNC, memory: { rev: "r9" } }), now);
    await settle(x.c);
    expect(briefs()).toBe(2);
  });

  it("a hub without memory: no brief, no memory, no calls", async () => {
    const x = client({ defaults: { "GET /relay/sync": { status: 200, body: OLD_SYNC } } });
    await x.c.sync();
    await settle(x.c);
    expect(x.c.memoryAvailable()).toBe(false);
    expect(x.c.brief()).toBeUndefined();
    expect(x.hub.calls.map((k) => k.path)).toEqual(["/relay/sync"]);
  });

  it("errors back off (10 s doubling); a 404 turns memory off for 10 min without touching coordination", async () => {
    let now = T;
    const x = client({
      now: () => now,
      routes: { "GET /relay/memories": [{ status: 500 }, { status: 404, body: "not found" }] },
    });
    const sync = async (rev: string) => {
      x.c.apply(hubSyncAcceptSchema.parse({ ...SYNC, memory: { rev } }), now);
      await settle(x.c);
    };
    await sync("r1");
    expect(x.c.brief()).toBeUndefined();
    now += 5000; // inside the 10 s backoff: not asked
    await sync("r1");
    now += 5500; // past it: asked again
    await sync("r1");
    const gets = () => x.hub.calls.filter((k) => k.path === "/relay/memories").length;
    expect(gets()).toBe(2); // the retry after 10 s: a 404
    expect(x.c.memoryAvailable()).toBe(false);
    expect(x.c.view().available).toBe(true);
    // Memory calls answer "no memory" without asking the hub; v1 calls still go.
    const r = await x.c.memory({ action: "remember", kind: "fact", title: "x" });
    expect(r).toMatchObject({ ok: false, unavailable: true, status: 404 });
    expect(gets()).toBe(2);
    now += 5 * 60_000;
    await sync("r1");
    expect(gets()).toBe(2);
    now += 6 * 60_000; // 10 min on: asked again
    await sync("r1");
    expect(gets()).toBe(3);
    expect(x.c.memoryAvailable()).toBe(true);
    expect(x.c.brief()).toHaveLength(7);
  });

  it("a 404 from POST /relay/memories with no answer: memory off; one with an answer (no such memory) is an answer", async () => {
    const x = client({
      routes: {
        "POST /relay/memories": [
          { status: 404, body: { ok: false, error: "no such memory: m99" } },
          { status: 404, body: "Not Found" },
        ],
      },
    });
    await x.c.sync();
    await settle(x.c);
    const no = await x.c.memory({ action: "forget", id: "m99" });
    expect(no).toMatchObject({ ok: true, status: 404, body: { ok: false, error: "no such memory: m99" } });
    expect(x.c.memoryAvailable()).toBe(true);
    const off = await x.c.memory({ action: "forget", id: "m1" });
    expect(off).toMatchObject({ ok: false, unavailable: true });
    expect(x.c.memoryAvailable()).toBe(false);
    expect(x.c.view().available).toBe(true); // v1 untouched
  });
});

// ------------------------------------------------------------------ session start (CoordHooks)

const start = (over: Partial<SessionEvent> = {}): SessionEvent => ({
  source: "claude-code",
  sessionId: "s1",
  kind: "start",
  cwd: `${ROOT}/packages/cli`,
  ts: T,
  detail: { hookEvent: "SessionStart" },
  ...over,
});

function hooksFor(c: CoordClient, used: Array<{ key: string; ids: string[] }> = []) {
  return new CoordHooks({
    coord: () => c,
    classify,
    isShared: () => true,
    projectName: () => "B3",
    now: () => T,
    memoriesUsed: (key, ids) => used.push({ key, ids }),
  });
}

describe("session start on a hub with memory (SPEC §36)", () => {
  it("the note carries the memories that matter here and the open claims, not the notes; `used` goes after, in the background", async () => {
    const x = client();
    await x.c.sync();
    await settle(x.c);
    const used: Array<{ key: string; ids: string[] }> = [];
    const ctx = hooksFor(x.c, used).context(start(), "SessionStart")!;
    expect(ctx).toContain(guidance("B3", false, true));
    expect(ctx).toContain("- `recall` the team's memory before you decide; `remember` a decision, convention or gotcha");
    expect(ctx).toContain(selectMemories(x.c.brief()!, { ...HERE, issues: ["B3-7203"] })!.text);
    expect(ctx).toContain("Your open claims: B3-7203 (this session).");
    expect(ctx).not.toContain("Team rules and conventions (Workmesh notes");
    expect(used).toEqual([]); // not in the hook's path
    await settle();
    expect(used).toEqual([{ key: LOCAL, ids: ["m21", "m19", "m17", "m18"] }]);
  });

  it("an empty brief: guidance and claims only, nothing reported", async () => {
    const x = client({ defaults: { "GET /relay/memories": { status: 200, body: { ok: true, rev: "r7", memories: [] } } } });
    await x.c.sync();
    await settle(x.c);
    const used: Array<{ key: string; ids: string[] }> = [];
    const ctx = hooksFor(x.c, used).context(start(), "SessionStart")!;
    expect(ctx).not.toContain(MEMORY_HEADING);
    expect(ctx).not.toContain("Team rules and conventions");
    expect(ctx).toContain("Your open claims: B3-7203");
    await settle();
    expect(used).toEqual([]);
  });

  it("a hub without memory keeps the notes block exactly as before", async () => {
    const x = client({ defaults: { "GET /relay/sync": { status: 200, body: OLD_SYNC } } });
    await x.c.sync();
    const ctx = hooksFor(x.c).context(start(), "SessionStart")!;
    const st = x.c.view().state!;
    expect(ctx).toBe([guidance("B3", false, false), knowledge(st.notes, st.claims, "Sean", (hk) => hk === ME)].join("\n\n"));
    expect(ctx).not.toContain("recall");
  });

  it("before the first brief (or after its 404), the notes stand in", async () => {
    const x = client({ routes: { "GET /relay/memories": [{ status: 404, body: "Not Found" }] } });
    await x.c.sync();
    await settle(x.c);
    const ctx = hooksFor(x.c).context(start(), "SessionStart")!;
    expect(ctx).toContain("- Never edit a live checkout (Sean)");
    expect(ctx).not.toContain(MEMORY_HEADING);
  });

  it("the branch and the directory come from the session's cwd", async () => {
    const x = client();
    await x.c.sync();
    await settle(x.c);
    // At the top of another checkout of nothing shared: project-wide only (m19).
    const outside = hooksFor(x.c).context(start({ sessionId: "s2", cwd: "/tmp/elsewhere" }), "SessionStart")!;
    expect(outside).toContain("[m19]");
    expect(outside).not.toContain("[m21]");
  });
});

// ------------------------------------------------------------------ ops (POST /coord/op)

const session = (over: Partial<AgentSession> = {}): AgentSession => ({
  key: LOCAL,
  source: "claude-code",
  sessionId: "s1",
  state: "working",
  agents: 1,
  cwd: `${ROOT}/packages/cli`,
  name: "workmesh-memory",
  startedAt: T,
  updatedAt: T,
  stateSince: T,
  ...over,
});

async function opsHarness(opts: { sync?: HubSyncResponse; routes?: Record<string, Reply[]>; cwd?: string } = {}) {
  const x = client({ routes: opts.routes, defaults: { "GET /relay/sync": { status: 200, body: opts.sync ?? SYNC } } });
  await x.c.sync();
  await settle(x.c);
  const sessions = [session(opts.cwd ? { cwd: opts.cwd } : {})];
  const deps: CoordOpsDeps = {
    coord: () => x.c,
    hub: () => ({ url: "https://hub.test", project: { name: "B3" }, person: { name: "Sean" }, deviceId: DEV }),
    getSession: (k) => sessions.find((s) => s.key === k),
    listSessions: () => sessions,
    classify,
    isShared: () => true,
    claudeSessions: () => new Map([["s1", { pid: 4242, sessionId: "s1" }]]),
    now: () => T,
    home: "/home/me",
  };
  const agent = { ppid: 4242 };
  const person = { cwd: "/home/me" };
  const op = (o: CoordOpRequest["op"], args: Record<string, unknown> = {}, caller: CoordOpRequest["caller"] = agent) =>
    runCoordOp({ op: o, args, caller }, deps);
  const posted = (path: string) => x.hub.calls.filter((k) => k.method === "POST" && k.path === path).map((k) => k.body);
  return { ...x, op, posted, person, agent };
}

const accepted = (over: Record<string, unknown> = {}) => ({
  id: "m30",
  kind: "gotcha",
  title: "t",
  body: "",
  by: { person: "Sean" },
  status: "accepted",
  createdAt: T,
  updatedAt: T,
  ...over,
});

describe("memory ops (SPEC §36)", () => {
  it("remember from an agent: this repo by default, redacted, proposed; the answer says who reviews it", async () => {
    const secret = `ghp_${"A1b2C3d4".repeat(5)}`;
    const h = await opsHarness({
      routes: { "POST /relay/memories": [{ status: 200, body: { ok: true, memory: accepted({ status: "proposed", title: "Rotate the token after a leak", scope: { repo: REPO } }) } }] },
    });
    const r = await h.op("remember", {
      kind: "Gotcha",
      title: "Rotate the token\nafter a leak",
      body: `The old one was ${secret} in /home/me/.env.`,
      issues: ["b3-7203"],
      prs: ["#31", "b3-fun/workmesh-cloud#12"],
      tags: ["tokens", "bad tag!"],
    });
    expect(h.posted("/relay/memories")[0]).toEqual({
      action: "remember",
      sessionKey: LOCAL,
      kind: "gotcha",
      title: "Rotate the token after a leak",
      body: "The old one was [redacted] in ~/.env.",
      scope: { repo: REPO },
      links: { issues: ["B3-7203"], prs: ["https://github.com/b3-fun/workmesh/pull/31", "https://github.com/b3-fun/workmesh-cloud/pull/12"] },
      tags: ["tokens"],
    });
    expect(r).toMatchObject({
      ok: true,
      text: "Proposed m30 for the team: Rotate the token after a leak. A person reviews it on the board (Needs you) before other agents see it.",
    });
  });

  it("remember from a terminal: no session, the project when outside a repo; an older hub's accepted answer is read", async () => {
    const h = await opsHarness({
      routes: { "POST /relay/memories": [{ status: 200, body: { ok: true, memory: accepted({ kind: "rule", title: "Deploys freeze at 5pm ET." }) } }] },
    });
    const r = await h.op("remember", { kind: "rule", title: "Deploys freeze at 5pm ET." }, h.person);
    expect(h.posted("/relay/memories")[0]).toEqual({ action: "remember", kind: "rule", title: "Deploys freeze at 5pm ET." });
    expect(r.text).toBe(
      "Remembered m30 (accepted, project-wide): Deploys freeze at 5pm ET. Your team's agents get it where it applies, and through `recall`.",
    );
  });

  it("scope and paths: project, a named repo, absolute paths made relative, repo-relative ones as given; refusals", () => {
    const ctx = { cwd: `${ROOT}/packages/cli`, classify, home: "/home/me" };
    expect(resolveMemoryScope(undefined, undefined, ctx)).toEqual({ scope: { repo: REPO } });
    expect(resolveMemoryScope("project", undefined, ctx)).toEqual({ scope: undefined });
    expect(resolveMemoryScope("b3-fun/other", ["src/**"], ctx)).toEqual({ scope: { repo: "b3-fun/other", paths: ["src/**"] } });
    expect(resolveMemoryScope(undefined, [`${ROOT}/packages/cli/src/daemon/memory.ts`, "docs/SPEC.md", `${ROOT}/apps/*/README.md`], ctx)).toEqual({
      scope: { repo: REPO, paths: ["packages/cli/src/daemon/memory.ts", "docs/SPEC.md", "apps/*/README.md"] },
    });
    expect(resolveMemoryScope(undefined, [ROOT], ctx)).toEqual({ scope: { repo: REPO } }); // the whole repo
    // Outside a repo, an absolute path picks the repo; a relative one can't.
    expect(resolveMemoryScope(undefined, [`${ROOT}/README.md`], { ...ctx, cwd: "/tmp" })).toEqual({ scope: { repo: REPO, paths: ["README.md"] } });
    expect(resolveMemoryScope(undefined, ["README.md"], { ...ctx, cwd: "/tmp" })).toMatchObject({ error: expect.stringContaining("repo-relative") });
    expect(resolveMemoryScope("repo", undefined, { ...ctx, cwd: "/tmp" })).toMatchObject({ error: expect.stringContaining("isn't in a repo") });
    expect(resolveMemoryScope("project", ["a.ts"], ctx)).toMatchObject({ error: expect.stringContaining("Paths belong to a repo") });
    expect(resolveMemoryScope(undefined, ["../x"], ctx)).toMatchObject({ error: expect.stringContaining("isn't a repo-relative") });
    expect(resolveMemoryScope(undefined, ["/etc/passwd"], ctx)).toMatchObject({ error: expect.stringContaining("isn't in a repo") });
    expect(resolveMemoryScope("nope", undefined, ctx)).toMatchObject({ error: expect.any(String) });
    expect(resolveMemoryScope(undefined, Array.from({ length: 21 }, (_, i) => `f${i}.ts`), ctx)).toMatchObject({ error: "At most 20 paths per memory." });
  });

  it("remember refuses what the hub would: no kind, no title, bad issues, PRs, ids; a long title goes whole into the body", async () => {
    const h = await opsHarness();
    expect((await h.op("remember", { title: "x" })).text).toContain("`remember` needs `kind`: one of decision, convention, gotcha, rule, fact.");
    expect((await h.op("remember", { kind: "fact" })).text).toContain("needs `title`");
    expect((await h.op("remember", { kind: "fact", title: "x", issues: ["nope"] })).text).toContain("Not an issue id: NOPE");
    expect((await h.op("remember", { kind: "fact", title: "x", prs: ["https://example.com/1"] })).text).toContain("Not a PR");
    expect((await h.op("remember", { kind: "fact", title: "x", supersedes: "x1" })).text).toContain("`supersedes` is a memory id");
    expect(h.posted("/relay/memories")).toHaveLength(0);
    const long = `${"word ".repeat(40)}end`;
    await h.op("remember", { kind: "fact", title: long, supersedes: "M3" });
    const body = h.posted("/relay/memories")[0] as { title: string; body: string; supersedes: string };
    expect(body.title).toHaveLength(120);
    expect(body.title.endsWith("…")).toBe(true);
    expect(body.body).toBe(long);
    expect(body.supersedes).toBe("m3");
  });

  it("recall: the session's repo and directory go along; hits read [id] kind · scope · who, when; title; body", async () => {
    const hit = accepted({
      id: "m18",
      title: "launchd bootstrap fails with error 5 when the daemon is re-run",
      body: `Boot out the old service first. ${"x".repeat(700)}`,
      scope: { repo: REPO, paths: ["packages/cli/src/lib/service.ts"] },
      links: { issues: ["B3-7168"] },
      by: { person: "An" },
      updatedAt: T - 3 * DAY,
      score: 4.2,
    });
    const h = await opsHarness({ routes: { "POST /relay/recall": [{ status: 200, body: { ok: true, memories: [hit, accepted({ id: "m2", title: "Second", updatedAt: T - 60_000 })] } }] } });
    const r = await h.op("recall", { query: `launchd error token=${"Zx9".repeat(8)}`, kinds: ["gotchas"], limit: 50 });
    expect(h.posted("/relay/recall")[0]).toEqual({
      sessionKey: LOCAL,
      query: "launchd error token=[redacted]",
      repo: REPO,
      paths: ["packages/cli"],
      kinds: ["gotcha"],
      limit: 20,
    });
    const [first, second] = r.text.split("\n\n");
    expect(first!.split("\n").slice(0, 2)).toEqual([
      "[m18] gotcha · b3-fun/workmesh: packages/cli/src/lib/service.ts · An, 3 days ago",
      "│ launchd bootstrap fails with error 5 when the daemon is re-run",
    ]);
    // The body, cut at 600, behind the mark.
    expect(first!.split("\n")[2]).toMatch(/^│ Boot out the old service first\. x+…$/);
    expect(first!.split("\n")[2]).toHaveLength(602);
    expect(first!.split("\n")[3]).toBe("Links: B3-7168");
    expect(second).toBe("[m2] gotcha · project-wide · Sean, 1 min ago\n│ Second");
    expect((await h.op("recall", {})).text).toContain("`recall` needs `query`");
    expect((await h.op("recall", { query: "x", kinds: ["nope"] })).ok).toBe(false);
  });

  it("forget: an id (m12, M12, 12), a redacted reason; the answer says retired, withdrawn or proposed", async () => {
    const h = await opsHarness({
      routes: {
        "POST /relay/memories": [
          { status: 200, body: { ok: true, memory: accepted({ id: "m12", title: "Old way", retire: { by: { person: "Sean" }, ts: T } }) } },
          { status: 200, body: { ok: true, memory: accepted({ id: "m13", title: "Mine", status: "rejected" }) } },
          { status: 200, body: { ok: true, memory: accepted({ id: "m14", title: "Gone", status: "retired" }) } },
          { status: 404, body: { ok: false, error: "no such memory" } },
        ],
      },
    });
    expect((await h.op("forget", { id: "twelve" })).text).toContain("`forget` needs `id`");
    const p = await h.op("forget", { id: "M12", reason: `superseded; key sk-ant-api03-${"B".repeat(40)}` });
    expect(h.posted("/relay/memories")[0]).toEqual({ action: "forget", sessionKey: LOCAL, id: "m12", reason: "superseded; key [redacted]" });
    expect(p.text).toBe("Proposed retiring m12: Old way. A person reviews it on the board (Needs you); agents keep getting it until then.");
    expect((await h.op("forget", { id: "13" })).text).toBe("Withdrew m13, a proposal: Mine.");
    expect((await h.op("forget", { id: "m14" }, h.person)).text).toBe("Retired m14: Gone. Agents no longer get it.");
    expect(h.posted("/relay/memories")[2]).toEqual({ action: "forget", id: "m14" });
    expect(await h.op("forget", { id: "m99" })).toMatchObject({ ok: false, text: expect.stringContaining("No memory m99") });
  });

  it("memories lists the brief, newest first; kind, tag and repo filter it", async () => {
    const h = await opsHarness();
    const r = await h.op("memories");
    const lines = r.text.split("\n");
    expect(lines[0]).toBe("- [m15] gotcha · b3-fun/workmesh-cloud · An, just now: wrangler deploys to the B3 account by default — Pin the account id for personal deploys.");
    expect(lines).toHaveLength(7);
    expect((await h.op("memories", { kind: "rule" })).text.split("\n").map((l) => l.slice(0, 7))).toEqual(["- [m14]", "- [m21]"]);
    expect((await h.op("memories", { repo: "project" })).text).toContain("[m19]");
    expect((await h.op("memories", { tag: "nothing" })).text).toBe("No team memories tagged nothing.");
  });

  it("memories shows a write at once, before the next sync and brief (0.12.1)", async () => {
    // The hub took each write; its sync and brief still say r7 (no new brief until the throttle and rev allow).
    const h = await opsHarness({
      routes: {
        "POST /relay/memories": [
          { status: 200, body: { ok: true, memory: accepted({ id: "m30", kind: "rule", title: "Deploys freeze at 5pm ET.", updatedAt: T + 1 }) } },
          { status: 200, body: { ok: true, memory: accepted({ id: "m31", kind: "convention", title: "Replaces m14", supersedes: "m14", updatedAt: T + 2 }) } },
          { status: 200, body: { ok: true, memory: accepted({ id: "m15", title: "Gone", status: "retired" }) } },
          { status: 200, body: { ok: true, memory: accepted({ id: "m32", title: "An agent's idea", status: "proposed" }) } },
          { status: 200, body: { ok: true, memory: accepted({ id: "m16", title: "Pending retire", retire: { by: { person: "An" }, ts: T }, updatedAt: T - 4 * DAY }) } },
        ],
      },
    });
    const ids = async () => (await h.op("memories", {}, h.person)).text.split("\n").map((l) => l.slice(3, 6));
    expect(await ids()).toEqual(["m15", "m14", "m17", "m21", "m19", "m16", "m18"]);
    await h.op("remember", { kind: "rule", title: "Deploys freeze at 5pm ET." }, h.person);
    expect((await ids())[0]).toBe("m30");
    expect((await h.op("memories", { kind: "rule" }, h.person)).text.split("\n").map((l) => l.slice(0, 7))).toEqual(["- [m30]", "- [m14]", "- [m21]"]);
    // Accepted with supersedes: the old one leaves the list.
    await h.op("remember", { kind: "convention", title: "Replaces m14", supersedes: "m14" }, h.person);
    expect(await ids()).toEqual(["m31", "m30", "m15", "m17", "m21", "m19", "m16", "m18"]);
    // Retired at once: gone. A proposal (an agent's) and a pending retire change nothing an agent sees.
    await h.op("forget", { id: "m15" }, h.person);
    await h.op("remember", { kind: "fact", title: "An agent's idea" });
    await h.op("forget", { id: "m16" });
    expect(await ids()).toEqual(["m31", "m30", "m17", "m21", "m19", "m16", "m18"]);
    expect(h.hub.calls.filter((k) => k.method === "GET" && k.path === "/relay/memories")).toHaveLength(1);
  });

  it("a brief asked for before a write keeps the write; one asked for after it is the hub's word", async () => {
    let now = T;
    let releaseBrief: (() => void) | undefined;
    const gate = new Promise<void>((r) => (releaseBrief = r));
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const key = `${init?.method ?? "GET"} ${u.pathname}`;
      calls.push(key);
      if (key === "GET /relay/sync") return Response.json({ ...SYNC, memory: { rev: now > T ? "r8" : "r7" } });
      if (key === "POST /relay/memories") return Response.json({ ok: true, memory: accepted({ id: "m40", title: "New", updatedAt: T + 50 }) });
      if (key === "GET /relay/memories") {
        // The first brief (r7) is slow: it was asked for before the write and comes back after it.
        if (calls.filter((c) => c === key).length === 1) {
          await gate;
          return Response.json(BRIEF);
        }
        return Response.json({ ...BRIEF, rev: "r8", memories: [{ id: "m40", kind: "gotcha", title: "New (hub)", body: "", by: { person: "Sean" }, updatedAt: T + 50 }] });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const c = new CoordClient({ url: "https://hub.test", token: TOKEN, deviceId: DEV, person: "Sean", fetchImpl, now: () => now });
    await c.sync(); // r7: brief fetch in flight
    await new Promise((r) => setImmediate(r));
    now = T + 1;
    await c.memory({ action: "remember", kind: "gotcha", title: "New" });
    releaseBrief!();
    await settle(c);
    expect(c.brief()?.map((m) => m.id)).toEqual(["m40", "m15", "m14", "m17", "m21", "m19", "m16", "m18"]);
    // The next brief (asked for after the write) carries the hub's own copy; nothing local is laid over it.
    now = T + 20_000;
    await c.sync();
    await settle(c);
    expect(c.brief()?.map((m) => [m.id, m.title])).toEqual([["m40", "New (hub)"]]);
  });

  it("note on a memory hub is a remember (project-wide; kind from a tag; first line the title); notes lists the brief", async () => {
    const h = await opsHarness({ routes: { "POST /relay/memories": [{ status: 200, body: { ok: true, memory: accepted({ kind: "rule", title: "Deploys freeze at 5pm ET", status: "proposed" }) } }] } });
    const r = await h.op("note", { text: "Deploys freeze at 5pm ET\nAsk in #eng before.", tags: ["Rules", "deploy"] });
    expect(h.posted("/relay/notes")).toHaveLength(0);
    expect(h.posted("/relay/memories")[0]).toEqual({
      action: "remember",
      sessionKey: LOCAL,
      kind: "rule",
      title: "Deploys freeze at 5pm ET",
      body: "Ask in #eng before.",
      tags: ["deploy"],
    });
    expect(r.text).toContain("Proposed m30 for the team");
    await h.op("note", { text: "lunch is at noon" }, h.person);
    expect(h.posted("/relay/memories")[1]).toEqual({ action: "remember", kind: "fact", title: "lunch is at noon" });
    // notes: the brief, `tag` matching a kind or a tag.
    expect((await h.op("notes", { tag: "rule" })).text.split("\n").map((l) => l.slice(0, 7))).toEqual(["- [m14]", "- [m21]"]);
  });

  it("on a hub without memory: note and notes as before; remember, recall, forget, memories say so plainly", async () => {
    const h = await opsHarness({ sync: OLD_SYNC });
    expect(await h.op("note", { text: "deploys freeze at 5pm", tags: ["rule"] })).toMatchObject({ ok: true, text: "Noted for the team (note n9)." });
    expect(h.posted("/relay/notes")).toEqual([{ sessionKey: LOCAL, text: "deploys freeze at 5pm", tags: ["rule"] }]);
    expect((await h.op("notes")).text).toContain("Sean, ");
    expect(await h.op("remember", { kind: "fact", title: "x" })).toEqual({ ok: false, text: NO_MEMORY_WRITE, data: undefined });
    expect(await h.op("recall", { query: "x" })).toMatchObject({ ok: true, text: NO_MEMORY_READ });
    expect(await h.op("memories")).toMatchObject({ ok: true, text: NO_MEMORY_READ });
    expect((await h.op("forget", { id: "m1" })).text).toContain("no memory yet");
    expect(h.posted("/relay/memories")).toHaveLength(0);
    expect(h.posted("/relay/recall")).toHaveLength(0);
  });

  it("notes on a memory hub whose brief can't be fetched yet: the sync's notes stand in", async () => {
    const h = await opsHarness({ routes: { "GET /relay/memories": [{ status: 500 }, { status: 500 }] } });
    expect(h.c.memoryAvailable()).toBe(true);
    expect(h.c.brief()).toBeUndefined();
    expect((await h.op("notes")).text).toBe("- Sean, 48 h ago [rule]:\n│ Never edit a live checkout");
  });

  it("a note whose hub turns out to have no memory (404) goes as a v1 note", async () => {
    const h = await opsHarness({ routes: { "POST /relay/memories": [{ status: 404, body: "Not Found" }] } });
    const r = await h.op("note", { text: "deploys freeze at 5pm" });
    expect(r.text).toBe("Noted for the team (note n9).");
    expect(h.c.memoryAvailable()).toBe(false);
  });

  it("small readers", () => {
    expect(memoryKind("Rules")).toBe("rule");
    expect(memoryKind("idea")).toBeUndefined();
    expect(memoryId("#7")).toBe("m7");
    expect(memoryId("m7x")).toBeUndefined();
    expect([0, 59_000, 5 * 60_000, 3 * 3600_000, 30 * 3600_000, 3 * DAY, 20 * DAY, 90 * DAY].map(agoText)).toEqual([
      "just now",
      "just now",
      "5 min ago",
      "3 h ago",
      "yesterday",
      "3 days ago",
      "2 weeks ago",
      "3 months ago",
    ]);
  });
});

// ------------------------------------------------------------------ MCP tools and holds

describe("memory tools and holds", () => {
  it("MCP: remember needs kind and title, recall a query, forget an id", () => {
    const tool = (n: string) => MCP_TOOLS.find((t) => t.name === n)!;
    expect(tool("remember").inputSchema.required).toEqual(["kind", "title"]);
    expect(tool("recall").inputSchema.required).toEqual(["query"]);
    expect(tool("forget").inputSchema.required).toEqual(["id"]);
    expect(tool("memories").inputSchema.required).toBeUndefined();
  });

  it("a held session can still read the team's memory (recall, memories), not write it", () => {
    const x = client();
    x.c.apply(hubSyncAcceptSchema.parse({ ...SYNC, holds: [{ sessionKey: ME, by: "An", since: T }] }), T);
    const h = hooksFor(x.c);
    const ev = (detail: SessionEvent["detail"]): SessionEvent => ({ source: "claude-code", sessionId: "s1", kind: "working", cwd: ROOT, ts: T, detail });
    const mcp = (tool: string) => h.refuse(ev({ hookEvent: "PreToolUse", tool }), "PreToolUse");
    const bash = (command: string) => h.refuse(ev({ hookEvent: "PreToolUse", tool: "Bash", command }), "PreToolUse");
    expect(mcp("mcp__workmesh__recall")).toBeUndefined();
    expect(mcp("mcp__workmesh__memories")).toBeUndefined();
    expect(mcp("mcp__workmesh__notes")).toBeUndefined();
    expect(mcp("mcp__workmesh__remember")).toMatch(/^Held by An/);
    expect(mcp("mcp__workmesh__forget")).toMatch(/^Held by An/);
    expect(bash('workmesh recall "launchd error"')).toBeUndefined();
    expect(bash("workmesh memories --kind rule")).toBeUndefined();
    expect(bash("workmesh remember --kind fact x")).toMatch(/^Held by An/);
    expect(bash("workmesh forget m3")).toMatch(/^Held by An/);
    expect(bash("workmesh recall x; rm -rf y")).toMatch(/^Held by An/);
  });
});

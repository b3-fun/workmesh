import { describe, expect, it } from "vitest";
import {
  HUB_MEMORY_BODY_MAX,
  HUB_MEMORY_BRIEF_BODY_MAX,
  HUB_MEMORY_TITLE_MAX,
  HUB_RECALL_MAX,
  hubMemoryBriefResponseAcceptSchema,
  hubMemoryBriefResponseSchema,
  hubMemoryRequestAcceptSchema,
  hubMemoryRequestSchema,
  hubMemoryResponseAcceptSchema,
  hubMemoryResponseSchema,
  hubRecallRequestAcceptSchema,
  hubRecallRequestSchema,
  hubRecallResponseAcceptSchema,
  hubRecallResponseSchema,
  hubSyncAcceptSchema,
  hubSyncResponseSchema,
  prLink,
} from "../src";

const T = 1_795_545_600_000;

const memory = {
  id: "m12",
  kind: "gotcha",
  title: "launchd bootstrap fails with error 5 when the daemon is re-run",
  body: "Boot out the old service first; `workmesh setup` does this since 0.11.0.",
  scope: { repo: "b3-fun/workmesh", paths: ["packages/cli/src/lib/service.ts"] },
  links: {
    issues: ["B3-7168"],
    prs: ["https://github.com/b3-fun/workmesh/pull/26"],
    sessions: ["dev_S:claude-code:s1"],
  },
  tags: ["launchd"],
  by: { person: "Sean", sessionKey: "dev_S:claude-code:s1", sessionName: "workmesh-delegate" },
  origin: "agent",
  status: "accepted",
  createdAt: T,
  updatedAt: T + 1000,
  usedAt: T + 2000,
  uses: 3,
} as const;

const v1Sync = { cursor: "c_1", leases: [], holds: [], inbox: [], claims: [], roster: [] };

describe("memories (SPEC §35)", () => {
  it("every request builds strictly and reads unchanged on the hub", () => {
    const bodies = [
      {
        action: "remember",
        sessionKey: "claude-code:s1",
        kind: "decision",
        title: "Hub deploys from CI on merge",
        body: "Never deploy the hub from a laptop unless CI is down.",
        scope: { repo: "b3-fun/workmesh-cloud" },
        links: { issues: ["B3-7165"], prs: ["https://github.com/b3-fun/workmesh-cloud/pull/10"] },
        tags: ["deploy"],
        supersedes: "m3",
      },
      { action: "remember", kind: "fact", title: "From a terminal" },
      { action: "remember", kind: "rule", title: "Paths", scope: { repo: "b3-fun/workmesh", paths: ["packages/**", "docs/SPEC.md"] } },
      { action: "forget", sessionKey: "claude-code:s1", id: "m12", reason: "fixed in 0.11.1" },
      { action: "forget", id: "m7" },
      { action: "used", sessionKey: "claude-code:s1", ids: ["m1", "m2"], how: "start" },
    ];
    for (const b of bodies) {
      expect(hubMemoryRequestSchema.safeParse(b).success, JSON.stringify(b)).toBe(true);
      expect(hubMemoryRequestAcceptSchema.parse(b)).toEqual(b);
    }
  });

  it("the strict side refuses what a relay must not send", () => {
    const bad = [
      { action: "remember", kind: "opinion", title: "x" },
      { action: "remember", kind: "fact", title: "" },
      { action: "remember", kind: "fact", title: "x".repeat(HUB_MEMORY_TITLE_MAX + 1) },
      { action: "remember", kind: "fact", title: "x", body: "y".repeat(HUB_MEMORY_BODY_MAX + 1) },
      { action: "remember", kind: "fact", title: "x", scope: { paths: ["a"] } },
      { action: "remember", kind: "fact", title: "x", scope: { repo: "b3-fun/w", paths: ["/abs"] } },
      { action: "remember", kind: "fact", title: "x", scope: { repo: "b3-fun/w", paths: ["../up"] } },
      { action: "remember", kind: "fact", title: "x", links: { prs: ["https://example.com/pull/1"] } },
      { action: "remember", kind: "fact", title: "x", links: { sessions: ["dev:x"] } },
      { action: "remember", kind: "fact", title: "x", supersedes: "M-12" },
      { action: "remember", kind: "fact", title: "x", extra: 1 },
      { action: "forget", id: "12" },
      { action: "used", sessionKey: "claude-code:s1", ids: [], how: "start" },
      { action: "used", sessionKey: "claude-code:s1", ids: ["m1", "m1"], how: "start" },
      { action: "used", ids: ["m1"], how: "start" },
    ];
    for (const b of bad) expect(hubMemoryRequestSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it("the hub's reading cuts and cleans rather than failing", () => {
    const r = hubMemoryRequestAcceptSchema.parse({
      action: "remember",
      sessionKey: null,
      kind: "gotcha",
      title: `  two\n  lines ${"x".repeat(200)}`,
      body: "b".repeat(HUB_MEMORY_BODY_MAX + 50),
      scope: { repo: "b3-fun/w", paths: ["ok/**", "/bad", "ok/**"] },
      links: { issues: ["b3-7", "nope", "B3-7"], prs: ["https://github.com/b3-fun/w/pull/2", "x"] },
      tags: ["a", "a", "bad tag"],
      supersedes: "nope",
      unknown: true,
    });
    expect(r.action).toBe("remember");
    if (r.action !== "remember") return;
    expect(r.sessionKey).toBeUndefined();
    expect(r.title.startsWith("two lines")).toBe(true);
    expect(r.title.length).toBeLessThanOrEqual(HUB_MEMORY_TITLE_MAX);
    expect(r.body).toHaveLength(HUB_MEMORY_BODY_MAX);
    expect(r.scope).toEqual({ repo: "b3-fun/w", paths: ["ok/**"] });
    expect(r.links).toEqual({ issues: ["B3-7"], prs: ["https://github.com/b3-fun/w/pull/2"] });
    expect(r.tags).toEqual(["a"]);
    expect(r.supersedes).toBeUndefined();
    // A scope whose repo is unreadable reads as project-wide; a `used` with no readable id fails.
    const p = hubMemoryRequestAcceptSchema.parse({ action: "remember", kind: "fact", title: "x", scope: { repo: "nope" } });
    expect(p.action === "remember" && p.scope).toBeUndefined();
    expect(hubMemoryRequestAcceptSchema.safeParse({ action: "used", sessionKey: "k", ids: ["x"], how: "start" }).success).toBe(false);
  });

  it("answers build strictly and read back", () => {
    for (const b of [{ ok: true, memory }, { ok: true }, { ok: false, error: "no memory m99" }]) {
      expect(hubMemoryResponseSchema.safeParse(b).success, JSON.stringify(b)).toBe(true);
      expect(hubMemoryResponseAcceptSchema.parse(b)).toEqual(b);
    }
    const retiring = { ...memory, retire: { by: { person: "An", sessionKey: "dev_A:codex:t1" }, reason: "fixed", ts: T } };
    expect(hubMemoryResponseSchema.safeParse({ ok: true, memory: retiring }).success).toBe(true);
    expect(hubMemoryResponseAcceptSchema.parse({ ok: true, memory: retiring })).toEqual({ ok: true, memory: retiring });
  });

  it("a relay reads a newer hub's memory: unknown fields dropped, bad optional ones absent", () => {
    const r = hubMemoryResponseAcceptSchema.parse({
      ok: true,
      memory: { ...memory, origin: "telepathy", scope: { repo: "x" }, links: { issues: ["B3-1", "?"] }, future: 1 },
    });
    expect(r.ok && r.memory?.origin).toBeUndefined();
    expect(r.ok && r.memory?.scope).toBeUndefined();
    expect(r.ok && r.memory?.links).toEqual({ issues: ["B3-1"] });
    // An unknown kind or status drops the memory, never misreads it.
    const odd = hubMemoryResponseAcceptSchema.parse({ ok: true, memory: { ...memory, status: "archived" } });
    expect(odd.ok && odd.memory).toBeUndefined();
  });
});

describe("recall (SPEC §35)", () => {
  it("requests build strictly and read unchanged", () => {
    const bodies = [
      { query: "launchd error 5", sessionKey: "claude-code:s1", repo: "b3-fun/workmesh", paths: ["packages/cli"], kinds: ["gotcha"], limit: 5 },
      { query: "how do we deploy" },
    ];
    for (const b of bodies) {
      expect(hubRecallRequestSchema.safeParse(b).success, JSON.stringify(b)).toBe(true);
      expect(hubRecallRequestAcceptSchema.parse(b)).toEqual(b);
    }
    for (const b of [{ query: "" }, { query: "x", limit: 0 }, { query: "x", limit: HUB_RECALL_MAX + 1 }, { query: "x", kinds: [] }, { query: "x", paths: ["/a"] }]) {
      expect(hubRecallRequestSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
    }
  });

  it("the hub clamps a limit and drops what it can't read", () => {
    const r = hubRecallRequestAcceptSchema.parse({ query: "  deploy  ", limit: 99, kinds: ["rule", "mood"], paths: ["a/**", "/b"], repo: "bad" });
    expect(r).toEqual({ query: "deploy", limit: HUB_RECALL_MAX, kinds: ["rule"], paths: ["a/**"] });
    expect(hubRecallRequestAcceptSchema.parse({ query: "x", kinds: ["mood"] }).kinds).toBeUndefined();
  });

  it("answers build strictly and read back, keeping what parses", () => {
    const b = { ok: true, memories: [{ ...memory, score: 3.5 }] };
    expect(hubRecallResponseSchema.safeParse(b).success).toBe(true);
    expect(hubRecallResponseAcceptSchema.parse(b)).toEqual(b);
    const mixed = hubRecallResponseAcceptSchema.parse({ ok: true, memories: [{ ...memory, score: 1 }, { id: "bad" }] });
    expect(mixed.memories).toHaveLength(1);
  });
});

describe("the brief and sync (SPEC §35)", () => {
  const item = {
    id: "m3",
    kind: "rule",
    title: "Never print a secret",
    body: "Tokens stay out of logs, Slack, Linear and PRs.",
    scope: { repo: "b3-fun/workmesh-cloud" },
    issues: ["B3-7165"],
    by: { person: "Sean" },
    updatedAt: T,
  };

  it("a brief builds strictly and reads back; a long body is cut by the reader", () => {
    const b = { ok: true, rev: "m_4", memories: [item, { ...item, id: "m4", scope: undefined, issues: undefined }].map((m) => JSON.parse(JSON.stringify(m))) };
    expect(hubMemoryBriefResponseSchema.safeParse(b).success).toBe(true);
    expect(hubMemoryBriefResponseAcceptSchema.parse(b)).toEqual(b);
    const long = hubMemoryBriefResponseAcceptSchema.parse({ ok: true, rev: "m_5", memories: [{ ...item, body: "x".repeat(5000) }, { nope: 1 }] });
    expect(long.memories).toHaveLength(1);
    expect(long.memories[0]!.body).toHaveLength(HUB_MEMORY_BRIEF_BODY_MAX);
  });

  it("sync carries memory.rev when the hub has memory; absent reads as no memory", () => {
    const withMemory = { ...v1Sync, memory: { rev: "m_4" } };
    expect(hubSyncResponseSchema.safeParse(withMemory).success).toBe(true);
    expect(hubSyncAcceptSchema.parse(withMemory).memory).toEqual({ rev: "m_4" });
    expect(hubSyncAcceptSchema.parse(v1Sync).memory).toBeUndefined();
    expect(hubSyncAcceptSchema.parse({ ...v1Sync, memory: { rev: 4 } }).memory).toBeUndefined();
  });
});

describe("prLink", () => {
  it("reads owner/name#N and PR URLs", () => {
    expect(prLink("b3-fun/workmesh#26")).toBe("https://github.com/b3-fun/workmesh/pull/26");
    expect(prLink(" https://github.com/b3-fun/workmesh/pull/26 ")).toBe("https://github.com/b3-fun/workmesh/pull/26");
    expect(prLink("https://github.com/b3-fun/workmesh/issues/26")).toBeUndefined();
    expect(prLink("#26")).toBeUndefined();
  });
});

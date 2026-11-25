import { describe, expect, it } from "vitest";
import {
  HUB_DEVICE_TOKEN_RE,
  HUB_MAX_LINKS,
  HUB_TITLE_ACCEPT_MAX,
  HUB_TITLE_MAX,
  hubTeamAcceptSchema,
  hubTeamResponseSchema,
  isSafeLinkUrl,
  HUB_MAX_SESSIONS_PER_REQUEST,
  HUB_TEXT_ACCEPT_MAX,
  HUB_TEXT_MAX,
  hubActivityEventAcceptSchema,
  hubActivityEventSchema,
  hubIngestAcceptSchema,
  hubIngestRequestSchema,
  hubPairApproveRequestSchema,
  hubPairCodeSchema,
  hubPairPollRequestSchema,
  hubPairStartRequestSchema,
  hubProjectRuleSchema,
  hubSessionUpsertAcceptSchema,
  hubSessionUpsertSchema,
  isRepoRelativePath,
} from "../src";

const session = {
  key: "claude-code:s1",
  source: "claude-code",
  name: "documents-07",
  state: "working",
  activity: "editing vm.rs",
  background: false,
  agents: 3,
  phase: "review",
  orchestrator: "claude-code:s0",
  repo: "b3-fun/workmesh",
  branch: "monorepo",
  issues: ["B3-7166"],
  startedAt: 1_795_545_600_000,
  updatedAt: 1_795_545_601_000,
  stateSince: 1_795_545_600_500,
} as const;

const toolEvent = {
  id: "boot-1",
  key: "claude-code:s1",
  ts: 1_795_545_601_000,
  kind: "tool",
  tool: "Bash",
  label: "running commands",
  path: "packages/protocol/src/index.ts",
  cmd: "npm test",
  repo: "b3-fun/workmesh",
  branch: "monorepo",
  issues: ["B3-7166"],
  pr: "https://github.com/b3-fun/workmesh/pull/12",
  ok: true,
  desc: "Run the protocol tests",
} as const;

const body = {
  v: 1,
  sentAt: 1_795_545_602_000,
  share: "conversation",
  full: true,
  sessions: [session],
  events: [
    toolEvent,
    { id: "boot-2", key: "claude-code:s1", ts: 1_795_545_602_000, kind: "message", text: "done", truncated: false },
    { id: "boot-3", key: "claude-code:s1", ts: 1_795_545_602_000, kind: "turn", durationMs: 94_000 },
  ],
} as const;

describe("one protocol, two readings", () => {
  it("the hub takes every body a relay may send, unchanged", () => {
    const sent = hubIngestRequestSchema.parse(body);
    expect(hubIngestAcceptSchema.parse(sent)).toEqual(sent);
    const minimal = hubIngestRequestSchema.parse({ v: 1, sentAt: 1, full: false, sessions: [], events: [] });
    expect(hubIngestAcceptSchema.parse(minimal)).toEqual(minimal);
  });

  it("both readings name the same fields", () => {
    expect(Object.keys(hubSessionUpsertAcceptSchema.shape).sort()).toEqual(Object.keys(hubSessionUpsertSchema.shape).sort());
    expect(Object.keys(hubActivityEventAcceptSchema.shape).sort()).toEqual(Object.keys(hubActivityEventSchema.shape).sort());
    expect(Object.keys(hubIngestAcceptSchema.shape).sort()).toEqual(Object.keys(hubIngestRequestSchema.shape).sort());
  });

  it("a relay can't send what the hub only tolerates", () => {
    expect(hubActivityEventSchema.safeParse({ ...toolEvent, extra: "x" }).success).toBe(false);
    expect(hubActivityEventSchema.safeParse({ ...toolEvent, branch: null }).success).toBe(false);
    expect(hubActivityEventSchema.safeParse({ ...toolEvent, ts: 1.5 }).success).toBe(false);
    expect(hubActivityEventSchema.safeParse({ ...toolEvent, cmd: "gh pr create" }).success).toBe(false);
    expect(hubIngestRequestSchema.safeParse({ v: 1, sentAt: 1 }).success).toBe(false);
  });

  it("the hub drops unknown keys, reads null as absent, rounds ms, fills defaults", () => {
    const got = hubIngestAcceptSchema.parse({ v: 1, sentAt: 10.6, events: [{ ...toolEvent, ts: 1.4, branch: null, extra: "x" }] });
    expect(got).toMatchObject({ sentAt: 11, full: false, sessions: [] });
    expect(got.events[0]).toMatchObject({ ts: 1, branch: null });
    expect(got.events[0]).not.toHaveProperty("extra");
    expect(hubActivityEventAcceptSchema.parse({ ...toolEvent, cmd: "gh pr create" }).cmd).toBe("gh pr create");
  });

  it("the hub still refuses what no relay may send", () => {
    const bad = [
      { ...toolEvent, path: "/Users/sean/x.ts" },
      { ...toolEvent, path: "~/x.ts" },
      { ...toolEvent, path: "C:\\x.ts" },
      { ...toolEvent, path: "src/../../etc/passwd" },
      { ...toolEvent, cmd: "rm -rf /" },
      { ...toolEvent, repo: "workmesh" },
      { ...toolEvent, pr: "https://example.com/pull/1" },
      { ...toolEvent, issues: ["not an id"] },
      { ...toolEvent, tool: "Bash; rm" },
      { ...toolEvent, kind: "secret" },
      { ...toolEvent, text: "a".repeat(HUB_TEXT_ACCEPT_MAX + 1) },
    ];
    for (const e of bad) expect(hubActivityEventAcceptSchema.safeParse(e).success, JSON.stringify(e).slice(0, 80)).toBe(false);
    const many = Array.from({ length: HUB_MAX_SESSIONS_PER_REQUEST + 1 }, () => session);
    expect(hubIngestAcceptSchema.safeParse({ v: 1, sentAt: 1, sessions: many }).success).toBe(false);
    expect(hubIngestAcceptSchema.safeParse({ v: 2, sentAt: 1 }).success).toBe(false);
  });

  it("repo-relative paths only", () => {
    expect(isRepoRelativePath("src/a.ts")).toBe(true);
    expect(isRepoRelativePath("a..b/c.ts")).toBe(true);
    for (const p of ["", "/a", "~/a", "\\a", "D:/a", "a/../../b", ".."]) expect(isRepoRelativePath(p)).toBe(false);
  });
});

describe("hub wire v0.2 (SPEC §10)", () => {
  const base = { id: "x-1", key: "claude-code:s1", ts: 1 };

  it("accepts message and turn events with the new optional fields", () => {
    expect(hubActivityEventSchema.safeParse({ ...base, kind: "message", text: "done", truncated: false }).success).toBe(true);
    expect(hubActivityEventSchema.safeParse({ ...base, kind: "turn", durationMs: 94_000 }).success).toBe(true);
    expect(hubActivityEventSchema.safeParse({ ...base, kind: "tool", tool: "Bash", desc: "Run the tests" }).success).toBe(true);
  });

  it("caps text at 4,000 and desc at 200, and rejects fractional or negative durations", () => {
    expect(hubActivityEventSchema.safeParse({ ...base, kind: "prompt", text: "a".repeat(HUB_TEXT_MAX) }).success).toBe(true);
    expect(hubActivityEventSchema.safeParse({ ...base, kind: "prompt", text: "a".repeat(HUB_TEXT_MAX + 1) }).success).toBe(false);
    expect(hubActivityEventSchema.safeParse({ ...base, kind: "tool", desc: "d".repeat(201) }).success).toBe(false);
    expect(hubActivityEventSchema.safeParse({ ...base, kind: "turn", durationMs: -1 }).success).toBe(false);
    expect(hubActivityEventSchema.safeParse({ ...base, kind: "turn", durationMs: 1.5 }).success).toBe(false);
  });

  it("the hub takes text over the cap (it cuts it after redacting) up to the accept limit", () => {
    expect(hubActivityEventAcceptSchema.safeParse({ ...base, kind: "prompt", text: "a".repeat(HUB_TEXT_MAX + 1) }).success).toBe(true);
    expect(hubActivityEventAcceptSchema.safeParse({ ...base, kind: "tool", desc: "d".repeat(201) }).success).toBe(true);
    expect(hubActivityEventAcceptSchema.parse({ ...base, kind: "turn", durationMs: 1.5 }).durationMs).toBe(2);
  });

  it("carries the device's share level on the body; unknown levels fail", () => {
    const b = { v: 1, sentAt: 1, full: false, sessions: [], events: [] };
    expect(hubIngestRequestSchema.safeParse({ ...b, share: "conversation" }).success).toBe(true);
    expect(hubIngestRequestSchema.safeParse({ ...b, share: "metadata" }).success).toBe(true);
    expect(hubIngestRequestSchema.safeParse(b).success).toBe(true); // optional: old relays keep working
    expect(hubIngestRequestSchema.safeParse({ ...b, share: "everything" }).success).toBe(false);
    expect(hubIngestAcceptSchema.safeParse({ ...b, share: "everything" }).success).toBe(false);
  });

  it("reads the project's defaultShare and treats an unknown value as absent", () => {
    const rule = { id: "b3", name: "B3", include: { remotes: [], dirs: [] }, issueKeys: [] };
    expect(hubProjectRuleSchema.parse({ ...rule, defaultShare: "conversation" }).defaultShare).toBe("conversation");
    expect(hubProjectRuleSchema.parse({ ...rule, defaultShare: "all" }).defaultShare).toBeUndefined();
    expect(hubProjectRuleSchema.parse(rule).defaultShare).toBeUndefined();
  });
});

describe("pairing (SPEC §3.1)", () => {
  it("normalizes a typed code and refuses other shapes", () => {
    expect(hubPairCodeSchema.parse(" abcd-1234 ")).toBe("ABCD-1234");
    expect(hubPairApproveRequestSchema.parse({ code: "rbfg-5310" })).toEqual({ code: "RBFG-5310" });
    for (const c of ["ABCD1234", "ABC-1234", "ABCD-12345", ""]) expect(hubPairCodeSchema.safeParse(c).success).toBe(false);
  });

  it("trims the machine and client, and takes an optional share", () => {
    expect(hubPairStartRequestSchema.parse({ machine: " seans-mac-studio ", client: "workmesh/0.8.0" })).toEqual({
      machine: "seans-mac-studio",
      client: "workmesh/0.8.0",
    });
    expect(hubPairStartRequestSchema.parse({ machine: "m", client: "c", share: "metadata" }).share).toBe("metadata");
    expect(hubPairStartRequestSchema.safeParse({ machine: " ", client: "c" }).success).toBe(false);
  });

  it("checks the poll's device id and secret shapes, and the token shape", () => {
    const ok = { deviceId: `dev_${"0".repeat(26)}`, pollSecret: "ab".repeat(16) };
    expect(hubPairPollRequestSchema.safeParse(ok).success).toBe(true);
    expect(hubPairPollRequestSchema.safeParse({ ...ok, deviceId: "dev_x" }).success).toBe(false);
    expect(hubPairPollRequestSchema.safeParse({ ...ok, pollSecret: "AB".repeat(16) }).success).toBe(false);
    expect(HUB_DEVICE_TOKEN_RE.test(`bp_${"ab".repeat(32)}`)).toBe(true);
    expect(HUB_DEVICE_TOKEN_RE.test(`bp_${"AB".repeat(32)}`)).toBe(false);
  });
});

describe("hub wire v0.6 (SPEC §15)", () => {
  const sub = {
    ...session,
    key: "claude-code:s1/agent-a1b2",
    parent: "claude-code:s1",
    role: "subagent",
    agentType: "general-purpose",
    title: "Polling PR 164 CI checks",
    model: "claude-opus-5-5",
    tokensIn: 120_000,
    tokensOut: 4_200,
    costUsd: 0.42,
    statusLine: "waiting on 1 shell",
  } as const;
  const msg = {
    id: "am-1",
    key: "claude-code:s1",
    ts: 1_795_545_603_000,
    kind: "agent_message",
    from: "claude-code:s1",
    to: "hub-agent",
    channel: "claude-session",
    text: "protocol PR merged",
    links: [
      { type: "github_pr", id: "b3-fun/workmesh#2", url: "https://github.com/b3-fun/workmesh/pull/2" },
      { type: "linear", id: "B3-7166", url: "https://linear.app/npclabs/issue/B3-7166" },
      { type: "slack", id: "C0123ABC/1795545603.000100", url: "https://b3.slack.com/archives/C0123ABC/p1795545603000100", label: "#workmesh" },
    ],
  } as const;
  const v06 = { v: 1, sentAt: 1, share: "conversation", person: { github: "seangeng" }, full: false, sessions: [sub], events: [msg] } as const;

  it("a relay can send subagent sessions, agent messages, links and the person's GitHub login", () => {
    expect(hubSessionUpsertSchema.safeParse(sub).success).toBe(true);
    expect(hubActivityEventSchema.safeParse(msg).success).toBe(true);
    const sent = hubIngestRequestSchema.parse(v06);
    expect(hubIngestAcceptSchema.parse(sent)).toEqual(sent);
  });

  it("every field is optional: v0.5 bodies stay valid", () => {
    expect(hubSessionUpsertSchema.safeParse(session).success).toBe(true);
    expect(hubIngestRequestSchema.safeParse({ ...v06, person: {} }).success).toBe(true);
  });

  it("caps and shapes on the strict side", () => {
    const bad = [
      { ...sub, role: "boss" },
      { ...sub, agentType: "a".repeat(65) },
      { ...sub, title: "t".repeat(HUB_TITLE_MAX + 1) },
      { ...sub, model: "m".repeat(81) },
      { ...sub, tokensIn: 1.5 },
      { ...sub, tokensOut: -1 },
      { ...sub, costUsd: -0.01 },
      { ...sub, statusLine: "s".repeat(121) },
      { ...sub, parent: "" },
    ];
    for (const s of bad) expect(hubSessionUpsertSchema.safeParse(s).success, JSON.stringify(s).slice(0, 60)).toBe(false);
    const badEvents = [
      { ...msg, channel: "email" },
      { ...msg, to: "x".repeat(201) },
      { ...msg, links: Array.from({ length: HUB_MAX_LINKS + 1 }, () => msg.links[0]) },
      { ...msg, links: [{ type: "url" }] },
      { ...msg, links: [{ type: "url", url: "http://example.com" }] },
      { ...msg, links: [{ type: "url", url: "https://user:pw@example.com/x" }] },
      { ...msg, links: [{ type: "linear", id: "has spaces in it" }] },
      { ...msg, links: [{ type: "linear", id: "B3-1", extra: 1 }] },
    ];
    for (const e of badEvents) expect(hubActivityEventSchema.safeParse(e).success, JSON.stringify(e).slice(0, 60)).toBe(false);
    for (const g of ["-sean", "sean-", "se--an", "a".repeat(40), "sean geng", "sean@x"]) {
      expect(hubIngestRequestSchema.safeParse({ ...v06, person: { github: g } }).success, g).toBe(false);
    }
    expect(hubIngestRequestSchema.safeParse({ ...v06, person: { github: "sean", email: "x" } }).success).toBe(false);
  });

  it("the hub reads newer or broken v0.6 fields as absent instead of failing the batch", () => {
    const got = hubIngestAcceptSchema.parse({
      v: 1,
      sentAt: 1,
      person: { github: "not a login" },
      sessions: [{ ...sub, role: "overseer", tokensIn: 10.4 }],
      events: [
        { ...msg, channel: "pigeon", links: [{ type: "jira", id: "X-1" }, ...msg.links, { type: "url", url: "javascript:alert(1)" }] },
      ],
    });
    expect(got.person).toEqual({ github: undefined });
    expect(got.sessions[0]?.role).toBeUndefined();
    expect(got.sessions[0]?.tokensIn).toBe(10);
    expect(got.events[0]?.channel).toBeUndefined();
    expect(got.events[0]?.links).toEqual(msg.links);
    const many = Array.from({ length: 15 }, (_, i) => ({ type: "linear", id: `B3-${i}` }));
    expect(hubActivityEventAcceptSchema.parse({ ...msg, links: many }).links).toHaveLength(HUB_MAX_LINKS);
    expect(hubIngestAcceptSchema.parse({ v: 1, sentAt: 1, person: "seangeng" }).person).toBeUndefined();
  });

  it("the hub still refuses what no relay may send (v0.6)", () => {
    expect(hubSessionUpsertAcceptSchema.safeParse({ ...sub, title: "t".repeat(HUB_TITLE_ACCEPT_MAX + 1) }).success).toBe(false);
    expect(hubSessionUpsertAcceptSchema.safeParse({ ...sub, costUsd: -1 }).success).toBe(false);
    expect(hubActivityEventAcceptSchema.safeParse({ ...msg, from: "f".repeat(201) }).success).toBe(false);
  });

  it("link urls: https only, no credentials", () => {
    expect(isSafeLinkUrl("https://github.com/b3-fun/workmesh/pull/2")).toBe(true);
    for (const u of ["http://x.com", "https://", "https://a b.com", "https://u:p@x.com", "https://u@x.com", "ftp://x", "javascript:alert(1)"]) {
      expect(isSafeLinkUrl(u), u).toBe(false);
    }
  });
});

describe("team (v0.5, SPEC §15)", () => {
  const team = {
    me: { name: "Sean", email: "sean@npclabs.org", github: "seangeng" },
    people: [
      { name: "Sean", github: "seangeng", online: true, counts: { working: 2, waiting: 1, idle: 0 } },
      { name: "An", online: false, counts: { working: 0, waiting: 0, idle: 1 } },
    ],
    needsMe: [{ session: "dev_X:claude-code:s1", reason: "Approve the deploy", since: 1_795_545_600_000, name: "documents-07", source: "claude-code" }],
    sessions: [
      { key: "dev_X:claude-code:s1", owner: "Sean", name: "documents-07", source: "claude-code", state: "waiting", now: "Approve the deploy", repo: "b3-fun/workmesh", branch: "main", subagents: 2 },
      { owner: "An", name: "codex-1", source: "codex", state: "offline", subagents: 0 },
    ],
    serverNow: 1_795_545_700_000,
  } as const;

  it("what the hub builds, the relay reads unchanged", () => {
    const built = hubTeamResponseSchema.parse(team);
    expect(hubTeamAcceptSchema.parse(built)).toEqual(built);
  });

  it("the relay keeps what it can use from a hub that sends something else", () => {
    const got = hubTeamAcceptSchema.parse({
      me: "sean",
      people: [{ name: "Gio", online: "yes", counts: null }, { online: true }, ...team.people],
      needsMe: [{ reason: "no session" }, { ...team.needsMe[0], reason: "r".repeat(500), extra: 1 }],
      sessions: [{ ...team.sessions[0], state: "thinking", subagents: [{}, {}, {}] }, { name: "no owner" }],
    });
    expect(got.me).toEqual({ name: "", email: undefined, github: undefined });
    expect(got.people.map((p) => p.name)).toEqual(["Gio", "Sean", "An"]);
    expect(got.people[0]).toMatchObject({ online: false, counts: { working: 0, waiting: 0, idle: 0 } });
    expect(got.needsMe).toHaveLength(1);
    expect(got.needsMe[0]?.reason).toHaveLength(200);
    expect(got.sessions).toHaveLength(1);
    expect(got.sessions[0]).toMatchObject({ state: "idle", subagents: 3 });
    expect(got.serverNow).toBeUndefined();
    expect(hubTeamAcceptSchema.parse({})).toEqual({ me: { name: "", email: undefined, github: undefined }, people: [], needsMe: [], sessions: [], serverNow: undefined });
  });
});

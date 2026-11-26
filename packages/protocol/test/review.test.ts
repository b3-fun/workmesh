import { describe, expect, it } from "vitest";
import {
  HUB_REVIEW_FINDINGS_MAX,
  HUB_REVIEW_ROUNDS_MAX,
  hubHandoffResponseAcceptSchema,
  hubHandoffResponseSchema,
  hubReviewRequestAcceptSchema,
  hubReviewRequestSchema,
  hubReviewResponseAcceptSchema,
  hubReviewResponseSchema,
  hubReviewResultAcceptSchema,
  hubReviewResultSchema,
  hubSyncAcceptSchema,
  hubSyncResponseSchema,
  reviewOutcome,
  reviewVerdict,
} from "../src";

const T = 1_795_545_600_000;

const result = {
  verdict: "changes_suggested",
  summary: "The retry loop can spin forever when the token is revoked.",
  findings: [
    { file: "src/vault/retry.ts", line: 42, endLine: 48, severity: "high", summary: "No cap on retries after a 401.", suggestion: "Stop after 3 and surface the error." },
    { severity: "nit", summary: "Typo in the log line." },
  ],
  headSha: "0123abc",
  agent: "codex",
  model: "gpt-5.5",
  tests: "passed",
} as const;

const reviewHandoff = {
  id: "h_r1",
  from: { person: "Sean", email: "sean@example.com", sessionKey: "dev_S:claude-code:s1", sessionName: "vault retry" },
  to: { person: "An", email: "an@example.com" },
  task: "Review PR #212 in b3-fun/b3os-beta (round 1 of 3)",
  repo: "b3-fun/b3os-beta",
  status: "offered",
  createdAt: T,
  kind: "review",
  review: { pr: 212, round: 1, rounds: 3, focus: "the retry logic", headSha: "0123abc", why: "codeowner", authorAgent: "claude" },
} as const;

describe("review requests (SPEC §52)", () => {
  it("every action builds strictly and reads unchanged on the hub", () => {
    const bodies = [
      { action: "request", from: "claude-code:s1", repo: "b3-fun/b3os-beta", pr: 212 },
      {
        action: "request",
        from: "claude-code:s1",
        repo: "b3-fun/b3os-beta",
        pr: 212,
        focus: "retry logic",
        reviewers: [{ person: "An", email: "an@example.com" }],
        count: 2,
        auto: true,
        agent: "claude",
        model: "claude-opus-5-5",
        headSha: "0123abcdef",
        paths: ["src/vault/retry.ts", "README.md"],
        owners: ["@an", "@b3-fun/infra", "an@example.com"],
      },
      { action: "policy", accept: "auto", agent: "codex", model: "gpt-5.5", post: false },
      { action: "policy", accept: "never", post: true },
      { action: "report", id: "h_r1", sessionKey: "codex:t1", result },
      { action: "result", id: "h_r1" },
    ];
    for (const b of bodies) {
      const strict = hubReviewRequestSchema.parse(b);
      expect(hubReviewRequestAcceptSchema.parse(strict), JSON.stringify(b)).toEqual(strict);
    }
  });

  it("the strict side refuses what the contract doesn't allow", () => {
    const bad = [
      { action: "request", repo: "b3-fun/x" },
      { action: "request", repo: "not a repo", pr: 1 },
      { action: "request", repo: "b3-fun/x", pr: 0 },
      { action: "request", repo: "b3-fun/x", pr: 1, reviewers: [] },
      { action: "request", repo: "b3-fun/x", pr: 1, reviewers: [{ person: "a" }, { person: "b" }, { person: "c" }] },
      { action: "request", repo: "b3-fun/x", pr: 1, count: 3 },
      { action: "request", repo: "b3-fun/x", pr: 1, paths: ["/Users/sean/x.ts"] },
      { action: "request", repo: "b3-fun/x", pr: 1, paths: ["../x.ts"] },
      { action: "request", repo: "b3-fun/x", pr: 1, paths: ["a.ts", "a.ts"] },
      { action: "request", repo: "b3-fun/x", pr: 1, owners: ["not an owner"] },
      { action: "request", repo: "b3-fun/x", pr: 1, auto: false },
      { action: "request", repo: "b3-fun/x", pr: 1, diff: "+ secret" },
      { action: "policy", accept: "always", post: false },
      { action: "policy", accept: "auto" },
      { action: "report", id: "h_r1", result: { ...result, verdict: "approve" } },
      { action: "report", id: "h_r1", result: { ...result, findings: [{ severity: "blocker", summary: "x" }] } },
      { action: "report", id: "h_r1", result: { ...result, findings: Array.from({ length: HUB_REVIEW_FINDINGS_MAX + 1 }, () => ({ severity: "nit", summary: "x" })) } },
      { action: "approve", id: "h_r1" },
    ];
    for (const b of bad) expect(hubReviewRequestSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it("no verdict means approve: the vocabulary has no approval in it", () => {
    expect(hubReviewResultSchema.safeParse({ ...result, verdict: "approved" }).success).toBe(false);
    expect(hubReviewResultSchema.safeParse({ ...result, verdict: "approve" }).success).toBe(false);
    // A reader takes an unknown verdict as a comment, never as anything stronger.
    expect(hubReviewResultAcceptSchema.parse({ ...result, verdict: "approve" }).verdict).toBe("comments");
  });

  it("the hub's reading cuts long text, keeps the findings it can read and drops unknown keys", () => {
    const r = hubReviewRequestAcceptSchema.parse({
      action: "report",
      id: "h_r1",
      result: {
        verdict: "comments",
        summary: "s".repeat(5000),
        findings: [
          { severity: "high", summary: "kept", file: "/abs/path.ts", line: -1 },
          { severity: "critical", summary: "unknown severity reads as low" },
          { summary: "" },
          "not a finding",
        ],
        extra: true,
      },
    });
    if (r.action !== "report") throw new Error("report");
    expect(r.result.summary).toHaveLength(2000);
    expect(r.result.findings).toEqual([
      { severity: "high", summary: "kept" },
      { severity: "low", summary: "unknown severity reads as low" },
    ]);
    expect("extra" in r.result).toBe(false);
    const q = hubReviewRequestAcceptSchema.parse({
      action: "request",
      repo: "b3-fun/x",
      pr: 5,
      paths: ["a.ts", "a.ts", "/etc/passwd", "b.ts"],
      owners: ["@an", "nope nope"],
      auto: "yes",
      count: 9,
    });
    if (q.action !== "request") throw new Error("request");
    expect(q.paths).toEqual(["a.ts", "b.ts"]);
    expect(q.owners).toEqual(["@an"]);
    expect(q.auto).toBeUndefined();
    expect(q.count).toBeUndefined();
  });

  it("answers: reviewers and rounds, a refusal with the round, the whole result", () => {
    const bodies = [
      { ok: true, round: 1, rounds: 3, reviewers: [{ id: "h_r1", to: { person: "An", email: "an@example.com" }, why: "codeowner", agent: "codex" }] },
      { ok: true },
      { ok: true, result },
      { ok: false, error: "PR #212 had its 3 rounds of agent review", round: 3 },
      { ok: false, error: "two people are called Sam", candidates: [{ person: "Sam", email: "sam@example.com" }, { person: "Sam" }] },
    ];
    for (const b of bodies) {
      const strict = hubReviewResponseSchema.parse(b);
      expect(hubReviewResponseAcceptSchema.parse(strict), JSON.stringify(b)).toEqual(strict);
    }
    expect(hubReviewResponseAcceptSchema.parse({ ok: false, error: 4 })).toEqual({ ok: false, error: "" });
  });

  it("the verdict and the outcome follow from the findings", () => {
    expect(reviewVerdict([])).toBe("no_issues");
    expect(reviewVerdict([{ severity: "nit" }, { severity: "low" }])).toBe("comments");
    expect(reviewVerdict([{ severity: "low" }, { severity: "medium" }])).toBe("changes_suggested");
    expect(reviewOutcome({ ...result, posted: true })).toEqual({ verdict: "changes_suggested", high: 1, medium: 0, low: 0, nit: 1, posted: true });
  });
});

describe("review handoffs on the wire (SPEC §30, §52)", () => {
  it("a review handoff round-trips with its PR, round and outcome", () => {
    const done = { ...reviewHandoff, status: "done", review: { ...reviewHandoff.review, outcome: reviewOutcome(result) } };
    for (const h of [reviewHandoff, done]) {
      const body = hubHandoffResponseSchema.parse({ ok: true, handoff: h });
      expect(hubHandoffResponseAcceptSchema.parse(body)).toEqual(body);
    }
  });

  it("a relay drops a handoff of a kind it doesn't know, and a review without its PR", () => {
    const sync = hubSyncAcceptSchema.parse({
      cursor: "c",
      leases: [],
      holds: [],
      inbox: [],
      claims: [],
      roster: [],
      handoffs: [
        reviewHandoff,
        { ...reviewHandoff, id: "h_x", kind: "ask" },
        { ...reviewHandoff, id: "h_y", review: undefined },
        { ...reviewHandoff, id: "h_z", review: { pr: "212", round: 1 } },
        { ...reviewHandoff, id: "h_w", review: { pr: 212, round: HUB_REVIEW_ROUNDS_MAX + 1 } },
        { ...reviewHandoff, id: "h_t", kind: undefined, review: undefined },
      ],
    });
    expect(sync.handoffs?.map((h) => h.id)).toEqual(["h_r1", "h_t"]);
    expect(sync.handoffs?.[1]?.kind).toBeUndefined();
  });

  it("sync carries the review settings; absent means no review exchange on this hub", () => {
    const v1 = { cursor: "c", leases: [], holds: [], inbox: [], claims: [], roster: [] };
    expect(hubSyncAcceptSchema.parse(v1).reviews).toBeUndefined();
    const withReviews = hubSyncResponseSchema.parse({ ...v1, reviews: { auto: true, autoRepos: ["b3-fun/b3os-beta"] } });
    expect(hubSyncAcceptSchema.parse(withReviews).reviews).toEqual({ auto: true, autoRepos: ["b3-fun/b3os-beta"] });
    expect(hubSyncAcceptSchema.parse({ ...v1, reviews: { auto: "yes", autoRepos: ["nope", "b3-fun/x"] } }).reviews).toEqual({ auto: false, autoRepos: ["b3-fun/x"] });
    expect(hubSyncAcceptSchema.parse({ ...v1, reviews: 3 }).reviews).toBeUndefined();
  });
});

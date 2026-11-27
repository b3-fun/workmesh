import { describe, expect, it } from "vitest";
import {
  HUB_APPROVAL_DETAIL_MAX,
  HUB_DECISION_VIAS,
  HUB_GATE_ACTIONS,
  HUB_HANDOFF_TEXT_MAX,
  hubApprovalRequestAcceptSchema,
  hubApprovalRequestSchema,
  hubApprovalResponseAcceptSchema,
  hubApprovalResponseSchema,
  hubGatesRequestAcceptSchema,
  hubGatesRequestSchema,
  hubGatesResponseAcceptSchema,
  hubGatesResponseSchema,
  hubHandoffRequestAcceptSchema,
  hubHandoffRequestSchema,
  hubHandoffResponseAcceptSchema,
  hubHandoffResponseSchema,
  hubInboxItemSchema,
  hubMessageRequestAcceptSchema,
  hubMessageRequestSchema,
  hubSyncAcceptSchema,
  hubSyncResponseSchema,
} from "../src";

const T = 1_795_545_600_000;

const handoff = {
  id: "h_1",
  from: { person: "Sean", sessionKey: "dev_S:claude-code:s1", sessionName: "b3os-orch" },
  to: { person: "An" },
  task: "Port the vault KEK rotation to the new runner",
  repo: "b3-fun/b3os-beta",
  issue: "B3-7168",
  context: "Start from PR 212; the tests in vault/ are the spec.",
  status: "offered",
  createdAt: T,
} as const;

const approval = {
  id: "ap_1",
  sessionKey: "dev_S:claude-code:s1",
  owner: "Sean",
  gate: "merge",
  detail: "gh pr merge 212 --merge in b3-fun/b3os-beta",
  status: "pending",
  ts: T,
} as const;

const v1Sync = { cursor: "c_1", leases: [], holds: [], inbox: [], claims: [], roster: [] };

describe("handoffs (SPEC §30)", () => {
  it("create and every move build strictly and read unchanged on the hub", () => {
    const bodies = [
      { action: "create", from: "claude-code:s1", to: { person: "An" }, task: "do x", repo: "b3-fun/workmesh", issue: "B3-7168", context: "see PR" },
      { action: "create", to: { person: "Sean" }, task: "from a terminal" },
      { action: "accept", id: "h_1" },
      { action: "decline", id: "h_1", note: "not this week" },
      { action: "start", id: "h_1", sessionKey: "claude-code:new" },
      { action: "done", id: "h_1", sessionKey: "claude-code:new", note: "PR 213" },
      { action: "fail", id: "h_1", note: "no checkout" },
    ];
    for (const b of bodies) {
      const strict = hubHandoffRequestSchema.parse(b);
      expect(hubHandoffRequestAcceptSchema.parse(strict), JSON.stringify(b)).toEqual(strict);
    }
  });

  it("the strict side refuses what the contract doesn't allow", () => {
    const bad = [
      { action: "create", to: { person: "An" }, task: "" },
      { action: "create", to: { person: "An" }, task: "x".repeat(HUB_HANDOFF_TEXT_MAX + 1) },
      { action: "create", to: { person: "An", device: "dev_A" }, task: "x" },
      { action: "create", to: { person: "An" }, task: "x", repo: "not a repo" },
      { action: "create", to: { person: "An" }, task: "x", cwd: "/Users/sean" },
      { action: "accept" },
      { action: "start", id: "h_1", extra: 1 },
      { action: "cancel", id: "h_1" },
    ];
    for (const b of bad) expect(hubHandoffRequestSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it("the hub's reading cuts long text, upper-cases issues and drops unknown keys", () => {
    const r = hubHandoffRequestAcceptSchema.parse({
      action: "create",
      to: { person: "An", extra: true },
      task: "y".repeat(HUB_HANDOFF_TEXT_MAX + 50),
      issue: "b3-7168",
      repo: null,
      extra: 1,
    });
    expect(r).toMatchObject({ action: "create", issue: "B3-7168", to: { person: "An" } });
    if (r.action !== "create") throw new Error("create");
    expect(r.task).toHaveLength(HUB_HANDOFF_TEXT_MAX);
    expect(r.repo).toBeUndefined();
    expect("extra" in r).toBe(false);
  });

  it("responses: ok with the handoff, or a refusal that may carry it", () => {
    const ok = hubHandoffResponseSchema.parse({ ok: true, handoff });
    expect(hubHandoffResponseAcceptSchema.parse(ok)).toEqual(ok);
    const lost = { ok: false, error: "another device started it", handoff: { ...handoff, status: "started", device: "dev_B" } };
    expect(hubHandoffResponseAcceptSchema.parse(hubHandoffResponseSchema.parse(lost))).toEqual(lost);
    expect(hubHandoffResponseAcceptSchema.parse({ ok: false, error: 3 })).toEqual({ ok: false, error: "" });
  });
});

describe("approvals and gates (SPEC §30)", () => {
  it("request, approve and deny build strictly and read unchanged", () => {
    for (const b of [
      { action: "request", sessionKey: "claude-code:s1", gate: "merge", detail: approval.detail },
      { action: "request", sessionKey: "claude-code:s1", gate: "merge", detail: approval.detail, renew: true },
      { action: "approve", id: "ap_1" },
      { action: "deny", id: "ap_1", note: "wait for the freeze to lift" },
    ]) {
      const strict = hubApprovalRequestSchema.parse(b);
      expect(hubApprovalRequestAcceptSchema.parse(strict)).toEqual(strict);
    }
    for (const b of [
      { action: "request", sessionKey: "claude-code:s1", gate: "rm_rf", detail: "x" },
      { action: "request", sessionKey: "claude-code:s1", gate: "merge", detail: "" },
      { action: "request", sessionKey: "claude-code:s1", gate: "merge", detail: "x".repeat(HUB_APPROVAL_DETAIL_MAX + 1) },
      { action: "request", sessionKey: "claude-code:s1", gate: "merge", detail: "x", command: "gh pr merge" },
      { action: "request", sessionKey: "claude-code:s1", gate: "merge", detail: "x", renew: false },
    ]) {
      expect(hubApprovalRequestSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
    }
    // A hub reads a malformed `renew` as absent (ask as before), never as a reason to drop the request.
    const odd = hubApprovalRequestAcceptSchema.parse({ action: "request", sessionKey: "claude-code:s1", gate: "merge", detail: "x", renew: "yes" });
    expect(odd).toMatchObject({ action: "request", detail: "x" });
    expect((odd as { renew?: boolean }).renew).toBeUndefined();
    const renewed = hubApprovalRequestAcceptSchema.parse({ action: "request", sessionKey: "claude-code:s1", gate: "merge", detail: "x", renew: true });
    expect((renewed as { renew?: boolean }).renew).toBe(true);
  });

  it("an approval round-trips; a decided one carries who and why", () => {
    const decided = { ...approval, status: "denied", decidedAt: T + 60_000, by: "Sean", note: "not during the freeze" };
    for (const a of [approval, decided, { ...decided, status: "approved", via: "menubar" }]) {
      const body = hubApprovalResponseSchema.parse({ ok: true, approval: a });
      expect(hubApprovalResponseAcceptSchema.parse(body)).toEqual(body);
    }
  });

  it("where a decision was made (0.12.1): the relay names its own place, the reader drops one it doesn't know", () => {
    expect(HUB_DECISION_VIAS).toEqual(["board", "menubar", "cli"]);
    for (const via of ["menubar", "cli"] as const) {
      const strict = hubApprovalRequestSchema.parse({ action: "approve", id: "ap_1", via });
      expect(hubApprovalRequestAcceptSchema.parse(strict)).toEqual(strict);
    }
    // A relay never claims the board; an unknown place from a newer relay reads as none.
    expect(hubApprovalRequestSchema.safeParse({ action: "approve", id: "ap_1", via: "board" }).success).toBe(false);
    expect(hubApprovalRequestAcceptSchema.parse({ action: "deny", id: "ap_1", via: "watch" })).toEqual({ action: "deny", id: "ap_1" });
    const read = hubApprovalResponseAcceptSchema.parse({
      ok: true,
      approval: { ...approval, status: "approved", decidedAt: T + 1, by: "Sean", via: "smoke-signal" },
    });
    expect(read.ok && read.approval.via).toBeUndefined();
    expect(read.ok && read.approval.status).toBe("approved");
  });

  it("gates: every action is known, the relay drops one it doesn't know", () => {
    expect(HUB_GATE_ACTIONS).toEqual(["merge", "deploy", "publish", "force_push", "spend", "custom"]);
    const req = hubGatesRequestSchema.parse({ actions: ["merge", "deploy"] });
    expect(hubGatesRequestAcceptSchema.parse(req)).toEqual(req);
    expect(hubGatesRequestSchema.safeParse({ actions: ["merge", "merge"] }).success).toBe(false);
    expect(hubGatesRequestSchema.parse({ actions: [] })).toEqual({ actions: [] });
    const res = hubGatesResponseSchema.parse({ ok: true, gates: { owner: "Sean", actions: ["merge"] } });
    expect(hubGatesResponseAcceptSchema.parse(res)).toEqual(res);
    expect(
      hubGatesResponseAcceptSchema.parse({ ok: true, gates: { owner: "Sean", actions: ["merge", "launch_missiles"] } }),
    ).toEqual({ ok: true, gates: { owner: "Sean", actions: ["merge"] } });
  });
});

describe("sync additions (SPEC §30)", () => {
  it("a v1 sync reads with the v2 lists absent (no gates, no handoffs)", () => {
    const s = hubSyncAcceptSchema.parse(v1Sync);
    expect(s.handoffs).toBeUndefined();
    expect(s.gates).toBeUndefined();
    expect(s.approvals).toBeUndefined();
  });

  it("a v2 sync built strictly reads unchanged", () => {
    const body = hubSyncResponseSchema.parse({
      ...v1Sync,
      handoffs: [handoff, { ...handoff, id: "h_2", status: "accepted", device: "dev_A", updatedAt: T + 1 }],
      gates: [{ owner: "Sean", actions: ["merge", "deploy"] }, { owner: "An", actions: [], approvers: ["Sean"] }],
      approvals: [approval],
    });
    const read = hubSyncAcceptSchema.parse(body);
    expect(read.handoffs).toEqual(body.handoffs);
    expect(read.gates).toEqual(body.gates);
    expect(read.approvals).toEqual(body.approvals);
  });

  it("keeps the items it can read and drops the rest one by one", () => {
    const read = hubSyncAcceptSchema.parse({
      ...v1Sync,
      handoffs: [handoff, { ...handoff, id: "h_3", status: "cancelled" }, { id: "h_4" }],
      gates: [{ owner: "Sean", actions: ["merge", "nope"] }, "junk"],
      approvals: [approval, { ...approval, id: "ap_2", gate: "nope" }, { ...approval, id: "ap_3", detail: "d".repeat(900) }],
    });
    expect(read.handoffs?.map((h) => h.id)).toEqual(["h_1"]);
    expect(read.gates).toEqual([{ owner: "Sean", actions: ["merge"] }]);
    expect(read.approvals?.map((a) => a.id)).toEqual(["ap_1", "ap_3"]);
    expect(read.approvals?.[1]?.detail).toHaveLength(HUB_APPROVAL_DETAIL_MAX);
    // A list that isn't a list reads as empty (the hub has v2 but sent junk), null as absent.
    expect(hubSyncAcceptSchema.parse({ ...v1Sync, gates: "x", handoffs: null }).gates).toEqual([]);
    expect(hubSyncAcceptSchema.parse({ ...v1Sync, handoffs: null }).handoffs).toBeUndefined();
  });

  it("wake rides on inbox items and message requests", () => {
    const item = { id: "m_1", to: "dev_S:claude-code:s1", from: { person: "An" }, text: "ping", ts: T, wake: true };
    expect(hubInboxItemSchema.parse(item)).toEqual(item);
    const read = hubSyncAcceptSchema.parse({ ...v1Sync, inbox: [item, { ...item, id: "m_2", wake: "yes" }] });
    expect(read.inbox.map((i) => [i.id, i.wake])).toEqual([
      ["m_1", true],
      ["m_2", undefined],
    ]);
    const msg = hubMessageRequestSchema.parse({ to: { person: "An" }, text: "hi", wake: false });
    expect(hubMessageRequestAcceptSchema.parse(msg)).toEqual(msg);
    expect(hubMessageRequestAcceptSchema.parse({ to: { person: "An" }, text: "hi", wake: "no" }).wake).toBeUndefined();
  });
});

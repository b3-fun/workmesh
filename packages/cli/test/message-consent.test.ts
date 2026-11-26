import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hubSyncAcceptSchema } from "@workmesh/protocol";
import type { HubApproval, HubSyncResponse } from "@workmesh/protocol";
import { CoordClient } from "../src/hub/coord";
import { CoordHooks } from "../src/daemon/coord-hooks";
import { actionDigest, CONSENT_UNAVAILABLE, MessageConsent, needsMessageConsent } from "../src/daemon/message-consent";
import { hookMeta, hookOutput } from "../src/commands/hook";

const deviceId = "dev_01JD0000000000000000000000";
const local = "claude-code:test";
const owner = "owner@example.org";
const input = { tool_name: "Read", session_id: "test", cwd: "/demo", tool_input: { file_path: "sample.txt", limit: 2 } };
const digest = actionDigest(input)!;
const own = { person: "Owner", email: owner };
const sender = { person: "Sam", email: "sam@example.org" };

let root: string;
let now: number;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wm-action-"));
  now = 1_795_545_600_000;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture() {
  const consent = new MessageConsent(root, () => now);
  const guard = vi.fn((key: string, who: string) => consent.arm(key, deviceId, who));
  const c = new CoordClient({ deviceId, personEmail: owner, url: "https://hub.test", token: "test",
    fetchImpl: async () => new Response(JSON.stringify({ ok: true })), now: () => now, beforeExternalDelivery: guard });
  const request = vi.spyOn(c, "approval").mockResolvedValue({ ok: false, status: 503, error: "queued" });
  function sync(over: Partial<HubSyncResponse> = {}) {
    c.apply(hubSyncAcceptSchema.parse({ leases: [], holds: [], inbox: [], claims: [], notes: [], roster: [], edits: [],
      serverNow: now, me: own, ...over }), now);
  }
  sync();
  function decision(over: Partial<HubApproval> = {}) {
    const req = request.mock.lastCall![0];
    if (req.action !== "request") throw Error("expected an approval request");
    sync({ approvals: [{ id: "ap_01", sessionKey: c.hubKey(local), gate: "custom", detail: req.detail,
      status: "approved", ts: now, decidedAt: now, byEmail: owner, ownerEmail: owner, via: "board", ...over }] });
  }
  return { consent, c, guard, request, sync, decision };
}

describe("optional tool approvals after reading a teammate's message", () => {
  it("binds the original input before activity truncation, including the child and working directory", () => {
    expect(hookMeta("PreToolUse", input).actionDigest).toBe(digest);
    expect(hookMeta("PostToolUse", input).actionDigest).toBeUndefined();
    expect(actionDigest({ tool_name: "Read" })).toBeUndefined();
    expect(actionDigest({ ...input, tool_input: { limit: 2, file_path: "sample.txt" } })).toBe(digest);
    for (const change of [{ agent_id: "child" }, { session_id: "other" }, { cwd: "/other" }, { tool_name: "Other" },
      { tool_input: { ...input.tool_input, limit: 3 } }, { tool_input: { data: "x".repeat(5000) } }]) {
      expect(actionDigest({ ...input, ...change })).not.toBe(digest);
    }
  });

  it("marks only external deliveries before the text leaves and leaves the item pending if the marker cannot be saved", () => {
    const { c, guard, sync } = fixture();
    const hooks = new CoordHooks({ coord: () => c, classify: () => undefined, isShared: () => false });
    const boundary = () => hooks.answer({ source: "claude-code", sessionId: "test", ts: now, kind: "working" }, "PostToolUse", undefined);
    const msg = { id: "m1", from: sender, to: c.hubKey(local), ts: now, text: "The sample is blue." };
    sync({ inbox: [{ ...msg, release: "own", from: own }, { ...msg, id: "m2", release: "requested" }] });
    expect(boundary()?.context).toContain("│ The sample is blue.");
    expect(guard).not.toHaveBeenCalled();
    sync({ inbox: [{ ...msg, id: "m3", release: "accepted" }] });
    guard.mockImplementationOnce(() => { throw Error("disk unavailable"); });
    expect(boundary()?.context).toBeUndefined();
    expect(c.pendingFor(local).map(i => i.id)).toEqual(["m3"]);
    expect(boundary()?.context).toContain("│ The sample is blue.");
    expect(needsMessageConsent(local + "/child", root)).toBe(true);
    expect(needsMessageConsent("claude-code:other", root)).toBe(false);
    expect(c.pendingFor(local)).toEqual([]);
  });

  it("notifies on the first tool in the family when another child stopped after external delivery", () => {
    const { c, sync } = fixture();
    sync({ inbox: [{ id: "m4", release: "accepted", from: sender, to: c.hubKey(local), ts: now, text: "Blue." }] });
    c.markDelivered(["m4"]);
    const hooks = new CoordHooks({ coord: () => c, classify: () => undefined, isShared: () => false });
    const event = { source: "claude-code" as const, sessionId: "test", ts: now, kind: "working" as const };
    hooks.answer({ ...event, detail: { agentId: "first" } }, "SubagentStop", undefined);
    expect(hooks.answer({ ...event, detail: { agentId: "second", tool: "Read" } }, "PreToolUse", undefined)?.systemMessage).toContain("Sam");
    expect(c.takeMessageSender(local)).toBeUndefined();
  });

  it("holds on restart, missing inputs, wrong accounts, delegated decisions and approvals from the CLI", () => {
    const { consent, c, request, decision } = fixture();
    consent.arm(local + "/child", deviceId, sender.person);
    expect(consent.check(local, "Read", undefined, c)?.deny).toBe(CONSENT_UNAVAILABLE);
    expect(consent.check(local, "Read", digest, undefined)?.deny).toBe(CONSENT_UNAVAILABLE);
    expect(consent.check(local, "Read", digest, c)?.deny).toContain("held");
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(request.mock.calls)).not.toContain("sample.txt");
    const resumed = new MessageConsent(root, () => now);
    for (const over of [{ byEmail: sender.email }, { ownerEmail: sender.email }, { status: "denied" as const },
      { via: "cli" as const }, { via: undefined }, { sessionKey: "dev_other:claude-code:test" }]) {
      decision(over);
      expect(resumed.check(local, "Read", digest, c)?.deny).toBeTruthy();
    }
    decision({});
    expect(resumed.check(local, "Read", actionDigest({ ...input, agent_id: "child" }), c)?.deny).toContain("different tool call");
    expect(resumed.check(local, "Read", digest, c)?.systemMessage).toContain("authorized one Read call");
    expect(consent.check(local, "Read", digest, c)?.deny).toContain("held");
    expect(request).toHaveBeenCalledTimes(3);
    expect(consent.check("claude-code:other", "Read", digest, c)).toBeUndefined();
  });

  it("expires old decisions and rejects calls when the hub cannot be verified", () => {
    const { consent, c, decision, request } = fixture();
    consent.arm(local, deviceId, sender.person);
    consent.check(local, "Read", digest, c);
    decision();
    now += 5 * 60_000;
    expect(consent.check(local, "Read", digest, c)?.deny).toBe(CONSENT_UNAVAILABLE);
    decision();
    expect(consent.check(local, "Read", digest, c)?.deny).toContain("held");
    expect(request.mock.calls[0]).not.toEqual(request.mock.calls[1]);
    consent.arm(local, "different-device", sender.person);
    expect(consent.check(local, "Read", digest, c)?.deny).toBe(CONSENT_UNAVAILABLE);
    const encoded = hookOutput("PreToolUse", { consentChecked: true, deny: CONSENT_UNAVAILABLE }, "codex");
    expect(JSON.parse(encoded!).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(encoded).not.toContain("consentChecked");
  });
});

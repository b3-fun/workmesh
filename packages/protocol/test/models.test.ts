import { describe, expect, it } from "vitest";
import {
  HUB_EFFORTS,
  hubHandoffRequestAcceptSchema,
  hubHandoffRequestSchema,
  hubHandoffResponseAcceptSchema,
  hubHandoffResponseSchema,
  hubModelSuggestionAcceptSchema,
  hubReviewRequestAcceptSchema,
  hubReviewRequestSchema,
  hubSyncAcceptSchema,
  hubSyncResponseSchema,
} from "../src";

const T = 1_795_545_600_000;

const handoff = {
  id: "h_1",
  from: { person: "Allie", email: "allie@example.com" },
  to: { person: "An", email: "an@example.com" },
  task: "Fix the typo on the pricing page",
  repo: "b3-fun/web",
  status: "offered",
  createdAt: T,
  request: { id: "rq_1", size: "small" },
  suggest: { agent: "claude", model: "sonnet", effort: "low", source: "project" },
} as const;

describe("model choice on the wire (SPEC §66)", () => {
  it("a create's ask and a start's run build strictly and read unchanged on the hub", () => {
    const bodies = [
      { action: "create", to: { person: "An" }, task: "do x", suggest: { agent: "codex", model: "gpt-5.5", effort: "high" } },
      { action: "create", to: { person: "An" }, task: "do x", suggest: { effort: "max" } },
      { action: "start", id: "h_1", sessionKey: "claude-code:new", run: { agent: "claude", model: "sonnet", effort: "high", lowered: true } },
      { action: "start", id: "h_1", run: { agent: "codex", followed: false } },
    ];
    for (const b of bodies) {
      const strict = hubHandoffRequestSchema.parse(b);
      expect(hubHandoffRequestAcceptSchema.parse(strict), JSON.stringify(b)).toEqual(strict);
    }
  });

  it("the strict side refuses an empty ask, an unknown agent or effort, a source, and a bad model name", () => {
    const bad = [
      { action: "create", to: { person: "An" }, task: "x", suggest: {} },
      { action: "create", to: { person: "An" }, task: "x", suggest: { agent: "gemini" } },
      { action: "create", to: { person: "An" }, task: "x", suggest: { effort: "ultra" } },
      { action: "create", to: { person: "An" }, task: "x", suggest: { model: "sonnet", source: "project" } },
      { action: "create", to: { person: "An" }, task: "x", suggest: { model: "rm -rf /" } },
      { action: "start", id: "h_1", run: { model: "sonnet" } },
      { action: "start", id: "h_1", run: { agent: "claude", lowered: false } },
    ];
    for (const b of bad) expect(hubHandoffRequestSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it("the hub reads a malformed ask or run as none, and keeps the body", () => {
    const create = hubHandoffRequestAcceptSchema.parse({ action: "create", to: { person: "An" }, task: "x", suggest: { agent: "gemini", model: "$(x)" } });
    expect(create).toMatchObject({ action: "create", task: "x" });
    expect(create.action === "create" && create.suggest).toBeUndefined();
    const part = hubHandoffRequestAcceptSchema.parse({ action: "create", to: { person: "An" }, task: "x", suggest: { agent: "gemini", effort: "high" } });
    expect(part.action === "create" && part.suggest).toEqual({ agent: undefined, model: undefined, effort: "high" });
    const start = hubHandoffRequestAcceptSchema.parse({ action: "start", id: "h_1", run: { agent: "gemini" } });
    expect(start).toMatchObject({ action: "start", id: "h_1" });
    expect(start.action !== "create" && start.run).toBeUndefined();
  });

  it("a handoff's suggestion builds strictly and a relay reads it; an unreadable one reads as none and keeps the handoff", () => {
    const ok = hubHandoffResponseSchema.parse({ ok: true, handoff });
    expect(hubHandoffResponseAcceptSchema.parse(ok)).toEqual(ok);
    const odd = hubHandoffResponseAcceptSchema.parse({ ok: true, handoff: { ...handoff, suggest: { agent: "gemini", source: "boss" } } });
    expect(odd.ok && odd.handoff.id).toBe("h_1");
    expect(odd.ok && odd.handoff.suggest).toBeUndefined();
    const some = hubModelSuggestionAcceptSchema.parse({ model: "opus", effort: "turbo", source: "sender" });
    expect(some).toEqual({ agent: undefined, model: "opus", effort: undefined, source: "sender" });
    expect(() => hubHandoffResponseSchema.parse({ ok: true, handoff: { ...handoff, suggest: { source: "project" } } })).toThrow();
  });

  it("an older relay's reading of a sync keeps the handoff with its suggestion", () => {
    const body = hubSyncResponseSchema.parse({ cursor: "c_1", leases: [], holds: [], inbox: [], claims: [], roster: [], handoffs: [handoff] });
    const read = hubSyncAcceptSchema.parse(body);
    expect(read.handoffs?.[0]?.suggest).toEqual(handoff.suggest);
  });

  it("a review request may suggest the reviewer's run", () => {
    const b = { action: "request", repo: "b3-fun/web", pr: 212, agent: "claude", suggest: { agent: "codex", effort: "medium" } } as const;
    const strict = hubReviewRequestSchema.parse(b);
    expect(hubReviewRequestAcceptSchema.parse(strict)).toEqual(strict);
    const odd = hubReviewRequestAcceptSchema.parse({ ...b, suggest: { agent: "gemini" } });
    expect(odd.action === "request" && odd.suggest).toBeUndefined();
  });

  it("efforts are ordered lowest first", () => {
    expect(HUB_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

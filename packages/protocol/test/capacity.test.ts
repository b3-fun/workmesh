import { describe, expect, it } from "vitest";
import {
  HUB_WIRE_VERSION,
  hubCapacityReportAcceptSchema,
  hubCapacityReportSchema,
  hubHandoffRequestAcceptSchema,
  hubHandoffRequestSchema,
  hubIngestAcceptSchema,
  hubIngestRequestSchema,
} from "../src/index.js";

describe("capacity & pool wire schemas", () => {
  it("round-trips a strict capacity report through ingest accept unchanged", () => {
    const body = {
      v: HUB_WIRE_VERSION,
      sentAt: 1795821360000,
      full: true,
      sessions: [],
      events: [],
      capacity: {
        share: "detailed" as const,
        updatedAt: 1795821359000,
        todayUsd: 2136.45,
        sevenDayUsd: 14319.65,
        providers: [
          {
            id: "codex" as const,
            bucket: "abundant" as const,
            headroomPct: 59,
            resetsInSec: 900,
            expiringCredits: 3,
            acceptsPool: ["readonly" as const, "worktree" as const],
            quotaMode: "live" as const,
          },
          {
            id: "opencode" as const,
            bucket: "abundant" as const,
            headroomPct: 93.6,
            acceptsPool: ["readonly" as const, "worktree" as const],
            quotaMode: "budget" as const,
          },
        ],
      },
    };
    const strict = hubIngestRequestSchema.parse(body);
    const accepted = hubIngestAcceptSchema.parse(strict);
    expect(accepted.capacity).toEqual(strict.capacity);
  });

  it("drops malformed capacity entries without rejecting the ingest batch", () => {
    const accepted = hubIngestAcceptSchema.parse({
      v: HUB_WIRE_VERSION,
      sentAt: 1795821360000,
      full: true,
      sessions: [],
      events: [],
      capacity: {
        share: "availability",
        updatedAt: 1795821359000,
        providers: [
          { id: "codex", bucket: "abundant", acceptsPool: ["worktree", "bogus"] },
          { id: "unknown-vendor", bucket: "abundant" },
        ],
      },
    });
    expect(accepted.capacity?.providers).toHaveLength(1);
    expect(accepted.capacity?.providers[0]?.acceptsPool).toEqual(["worktree"]);
  });

  it("rejects unknown fields on strict capacity reports", () => {
    expect(
      hubCapacityReportSchema.safeParse({
        share: "availability",
        updatedAt: 1795821359000,
        providers: [{ id: "claude", bucket: "tight", email: "leak@example.com" }],
      }).success,
    ).toBe(false);
    expect(hubCapacityReportAcceptSchema.safeParse({ share: "availability", updatedAt: 1, providers: [] }).success).toBe(true);
  });

  it("round-trips multi-provider and pool handoff create + accept", () => {
    const create = hubHandoffRequestSchema.parse({
      action: "create",
      to: { person: "pool" },
      task: "Write unit tests for auth",
      repo: "b3-fun/workmesh",
      preferredAgent: "opencode",
      taskKind: "coding",
      mode: "worktree",
      pool: true,
    });
    expect(hubHandoffRequestAcceptSchema.parse(create)).toEqual(create);

    const accept = hubHandoffRequestSchema.parse({
      action: "accept",
      id: "h_12345",
      acceptedBy: "pool",
      rule: "team on codex, opencode (worktree, >=30% free)",
    });
    expect(hubHandoffRequestAcceptSchema.parse(accept)).toEqual(accept);
  });
});

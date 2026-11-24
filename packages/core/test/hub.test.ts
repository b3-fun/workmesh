import { describe, expect, it } from "vitest";
import {
  HUB_TEXT_MAX,
  hubActivityEventSchema,
  hubIngestRequestSchema,
  hubProjectRuleSchema,
  sessionEventDetailSchema,
  truncateHead,
} from "../src";

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

  it("carries the device's share level on the body; unknown levels fail", () => {
    const body = { v: 1, sentAt: 1, full: false, sessions: [], events: [] };
    expect(hubIngestRequestSchema.safeParse({ ...body, share: "conversation" }).success).toBe(true);
    expect(hubIngestRequestSchema.safeParse({ ...body, share: "metadata" }).success).toBe(true);
    expect(hubIngestRequestSchema.safeParse(body).success).toBe(true); // optional: old relays keep working
    expect(hubIngestRequestSchema.safeParse({ ...body, share: "everything" }).success).toBe(false);
  });

  it("reads the project's defaultShare and treats an unknown value as absent", () => {
    const rule = { id: "b3", name: "B3", include: { remotes: [], dirs: [] }, issueKeys: [] };
    expect(hubProjectRuleSchema.parse({ ...rule, defaultShare: "conversation" }).defaultShare).toBe("conversation");
    expect(hubProjectRuleSchema.parse({ ...rule, defaultShare: "all" }).defaultShare).toBeUndefined();
    expect(hubProjectRuleSchema.parse(rule).defaultShare).toBeUndefined();
  });

  it("keeps the local-only detail fields the tailer needs", () => {
    const d = sessionEventDetailSchema.parse({ transcriptPath: "/t.jsonl", desc: "Run tests", lastAssistantMessage: "ok" });
    expect(d).toEqual({ transcriptPath: "/t.jsonl", desc: "Run tests", lastAssistantMessage: "ok" });
  });

  it("truncateHead keeps the start and never splits a surrogate pair", () => {
    expect(truncateHead("abcdef", 3)).toBe("abc");
    expect(truncateHead("ab", 3)).toBe("ab");
    expect(truncateHead("a\u{1F600}b", 2)).toBe("a");
  });
});

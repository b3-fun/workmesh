import { describe, expect, it } from "vitest";
import { sessionEventDetailSchema, truncateHead } from "../src";

// The hub wire schemas moved to @workmesh/protocol (packages/protocol/test). What stays here is core's own:
// the local-only detail the forwarder reads, and the truncation helper.
describe("hub forward helpers in core", () => {
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

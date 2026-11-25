import { describe, expect, it } from "vitest";
import { parseSticky, stickySummary } from "../src/commands/hub";
import { hubConfigSchema, hubShareLevel, hubStickyShare } from "../src/lib/config";

const HUB = {
  url: "https://hub.test",
  deviceId: "d1",
  deviceToken: `bp_${"a".repeat(64)}`,
  project: { id: "b3", name: "B3", include: { remotes: ["github.com/b3-fun/"], dirs: [] }, issueKeys: [] },
};

describe("hub sharing defaults", () => {
  it("an absent share level reads as conversation, as the comments now say", () => {
    expect(hubShareLevel(hubConfigSchema.parse(HUB))).toBe("conversation");
    expect(hubShareLevel(hubConfigSchema.parse({ ...HUB, share: "metadata" }))).toBe("metadata");
  });

  it("sharing is sticky unless the person turned it off", () => {
    expect(hubStickyShare(hubConfigSchema.parse(HUB))).toBe(true);
    expect(hubStickyShare(hubConfigSchema.parse({ ...HUB, stickyShare: false }))).toBe(false);
    expect(hubStickyShare(hubConfigSchema.parse({ ...HUB, stickyShare: "junk" }))).toBe(true);
  });

  it("parses on/off and says what each means", () => {
    expect(parseSticky("on")).toBe(true);
    expect(parseSticky(" OFF ")).toBe(false);
    expect(() => parseSticky("maybe")).toThrow(/use on or off/);
    expect(stickySummary(true)).toContain("including later work outside shared repos");
    expect(stickySummary(false)).toContain("turns that touch a shared repo");
  });
});

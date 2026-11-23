import { describe, expect, it } from "vitest";
import { pauseRequestSchema, resolvePauseUntil, snoozeUntil } from "../src/lib/snooze";

// Local-time dates: "tomorrow" is defined in the machine's own timezone.
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);

describe("snoozeUntil", () => {
  it("adds 30 minutes or an hour", () => {
    expect(snoozeUntil("30m", at(23, 16)) - at(23, 16).getTime()).toBe(30 * 60_000);
    expect(snoozeUntil("1h", at(23, 16)) - at(23, 16).getTime()).toBe(60 * 60_000);
  });

  it("'tomorrow' is 9 AM the next day", () => {
    expect(snoozeUntil("tomorrow", at(23, 16, 30))).toBe(at(24, 9).getTime());
    expect(snoozeUntil("tomorrow", at(23, 9, 30))).toBe(at(24, 9).getTime());
    expect(snoozeUntil("tomorrow", at(23, 23, 59))).toBe(at(24, 9).getTime());
  });

  it("'tomorrow' in the small hours is 9 AM the same day", () => {
    expect(snoozeUntil("tomorrow", at(24, 1, 30))).toBe(at(24, 9).getTime());
  });

  it("'tomorrow' rolls over the month", () => {
    expect(snoozeUntil("tomorrow", at(30, 18))).toBe(new Date(2026, 11, 1, 9).getTime());
  });
});

describe("resolvePauseUntil", () => {
  const now = at(23, 16).getTime();
  it("is undefined for an open-ended pause", () => {
    expect(resolvePauseUntil(pauseRequestSchema.parse({}), now)).toBeUndefined();
  });
  it("resolves presets and explicit times", () => {
    expect(resolvePauseUntil({ for: "1h" }, now)).toBe(now + 3_600_000);
    expect(resolvePauseUntil({ until: now + 5000 }, now)).toBe(now + 5000);
  });
  it("rejects past or far-future times", () => {
    expect(() => resolvePauseUntil({ until: now - 1 }, now)).toThrow(/future/);
    expect(() => resolvePauseUntil({ until: now + 8 * 24 * 3_600_000 }, now)).toThrow(/7 days/);
  });
});

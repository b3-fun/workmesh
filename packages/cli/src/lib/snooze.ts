import { z } from "zod";

/** Snooze lengths offered by the menu bar app and `agentblip pause --for`. */
export const SNOOZE_PRESETS = ["30m", "1h", "tomorrow"] as const;
export type SnoozePreset = (typeof SNOOZE_PRESETS)[number];

/** Local hour "until tomorrow" resumes at. */
export const SNOOZE_TOMORROW_HOUR = 9;
/** Before this local hour, "tomorrow morning" means later today. */
const SAME_NIGHT_BEFORE_HOUR = 4;
/** Longest accepted snooze; anything longer is a pause. */
const MAX_SNOOZE_MS = 7 * 24 * 60 * 60_000;

/**
 * When a snooze preset ends (epoch ms). "tomorrow" is 9:00 local time the
 * next morning: the next calendar day, or today when it's still the small
 * hours (snoozing at 1 AM resumes at 9 AM, not 32 hours later).
 */
export function snoozeUntil(preset: SnoozePreset, now = new Date()): number {
  switch (preset) {
    case "30m":
      return now.getTime() + 30 * 60_000;
    case "1h":
      return now.getTime() + 60 * 60_000;
    case "tomorrow": {
      const d = new Date(now);
      if (now.getHours() >= SAME_NIGHT_BEFORE_HOUR) d.setDate(d.getDate() + 1);
      d.setHours(SNOOZE_TOMORROW_HOUR, 0, 0, 0);
      return d.getTime();
    }
  }
}

/**
 * POST /pause body. Empty = pause until resumed (the original behaviour);
 * `for` = a preset snooze; `until` = an explicit end (epoch ms).
 */
export const pauseRequestSchema = z
  .object({
    for: z.enum(SNOOZE_PRESETS).optional(),
    until: z.number().int().positive().optional(),
  })
  .strict()
  .refine((b) => !(b.for && b.until), { message: "give either `for` or `until`, not both" });
export type PauseRequest = z.infer<typeof pauseRequestSchema>;

/** Resolves a pause request to its end time; undefined = until resumed. Throws on a bad `until`. */
export function resolvePauseUntil(req: PauseRequest, now = Date.now()): number | undefined {
  if (req.for) return snoozeUntil(req.for, new Date(now));
  if (req.until === undefined) return undefined;
  if (req.until <= now) throw new Error("until: must be in the future");
  if (req.until - now > MAX_SNOOZE_MS) throw new Error("until: at most 7 days ahead");
  return req.until;
}

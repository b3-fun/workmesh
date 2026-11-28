import { z } from "zod";

/**
 * Opt-in fleet capacity reporting and delegation pool types (SPEC §61–62).
 *
 * Strictly secret-free: never carries emails, account numbers, org UUIDs, or credentials.
 * Devices opt in locally (`capacity.share: "off" | "availability" | "detailed"`); `"off"`
 * sends nothing on the wire.
 */

export const HUB_CAPACITY_PROVIDERS = [
  "claude",
  "codex",
  "opencode",
  "gemini",
  "antigravity",
  "grok",
  "cursor",
  "copilot",
  "windsurf",
  "amp",
  "aider",
  "cline",
] as const;
export const hubCapacityProviderSchema = z.enum(HUB_CAPACITY_PROVIDERS);
export type HubCapacityProvider = z.infer<typeof hubCapacityProviderSchema>;

export const HUB_HANDOFF_AGENTS = [
  "claude",
  "codex",
  "opencode",
  "gemini",
  "antigravity",
  "grok",
  "cursor",
  "copilot",
  "windsurf",
  "amp",
  "aider",
  "cline",
  "harness",
] as const;
export const hubHandoffAgentSchema = z.enum(HUB_HANDOFF_AGENTS);
export type HubHandoffAgent = z.infer<typeof hubHandoffAgentSchema>;

export const HUB_TASK_KINDS = ["coding", "review", "long_context", "research", "bulk"] as const;
export const hubTaskKindSchema = z.enum(HUB_TASK_KINDS);
export type HubTaskKind = z.infer<typeof hubTaskKindSchema>;

export const HUB_POOL_MODES = ["readonly", "worktree"] as const;
export const hubPoolModeSchema = z.enum(HUB_POOL_MODES);
export type HubPoolMode = z.infer<typeof hubPoolModeSchema>;

export const HUB_CAPACITY_BUCKETS = ["abundant", "moderate", "tight", "exhausted", "unavailable"] as const;
export const hubCapacityBucketSchema = z.enum(HUB_CAPACITY_BUCKETS);
export type HubCapacityBucket = z.infer<typeof hubCapacityBucketSchema>;

export const HUB_CAPACITY_SHARE_LEVELS = ["off", "availability", "detailed"] as const;
export const hubCapacityShareSchema = z.enum(HUB_CAPACITY_SHARE_LEVELS);
export type HubCapacityShareLevel = z.infer<typeof hubCapacityShareSchema>;

export const HUB_QUOTA_MODES = ["live", "budget", "inferred", "headers"] as const;
export const hubQuotaModeSchema = z.enum(HUB_QUOTA_MODES);
export type HubQuotaMode = z.infer<typeof hubQuotaModeSchema>;

const epochMs = z.number().int().nonnegative().max(8.64e15);
const epochMsAccept = z.number().min(0).max(8.64e15).transform((n) => Math.round(n));
const pct = z.number().min(0).max(100);
const usd = z.number().min(0).max(1e7);
const soft = <T extends z.ZodType>(t: T) =>
  t
    .nullish()
    .catch(undefined)
    .transform((v) => v ?? undefined);

export const hubProviderCapacitySchema = z.strictObject({
  id: hubCapacityProviderSchema,
  bucket: hubCapacityBucketSchema,
  /** Only populated when `share === "detailed"`. */
  headroomPct: pct.optional(),
  resetsInSec: z.number().int().nonnegative().max(366 * 86400).optional(),
  expiringCredits: z.number().int().nonnegative().max(1000).optional(),
  /** Execution modes this machine's local pool policy accepts for this provider. */
  acceptsPool: z.array(hubPoolModeSchema).max(HUB_POOL_MODES.length).optional(),
  quotaMode: hubQuotaModeSchema.optional(),
});
export type HubProviderCapacity = z.infer<typeof hubProviderCapacitySchema>;

export const hubProviderCapacityAcceptSchema = z.object({
  id: hubCapacityProviderSchema,
  bucket: hubCapacityBucketSchema.catch("unavailable"),
  headroomPct: soft(pct),
  resetsInSec: soft(z.number().min(0).max(366 * 86400).transform((n) => Math.round(n))),
  expiringCredits: soft(z.number().min(0).max(1000).transform((n) => Math.round(n))),
  acceptsPool: soft(
    z.array(z.unknown()).transform((items) => {
      const out: HubPoolMode[] = [];
      for (const it of items) {
        const r = hubPoolModeSchema.safeParse(it);
        if (r.success && !out.includes(r.data)) out.push(r.data);
      }
      return out;
    }),
  ),
  quotaMode: soft(hubQuotaModeSchema),
});
export type HubProviderCapacityAccepted = z.infer<typeof hubProviderCapacityAcceptSchema>;

export const hubCapacityReportSchema = z.strictObject({
  share: z.enum(["availability", "detailed"]),
  updatedAt: epochMs,
  /** Only populated when `share === "detailed"`. */
  todayUsd: usd.optional(),
  sevenDayUsd: usd.optional(),
  providers: z.array(hubProviderCapacitySchema).max(16),
});
export type HubCapacityReport = z.infer<typeof hubCapacityReportSchema>;

export const hubCapacityReportAcceptSchema = z.object({
  share: z.enum(["availability", "detailed"]),
  updatedAt: epochMsAccept.catch(0),
  todayUsd: soft(usd),
  sevenDayUsd: soft(usd),
  providers: z
    .array(z.unknown())
    .max(32)
    .catch([])
    .transform((items) => {
      const out: HubProviderCapacityAccepted[] = [];
      for (const it of items) {
        const r = hubProviderCapacityAcceptSchema.safeParse(it);
        if (r.success && out.length < 16 && !out.some((p) => p.id === r.data.id)) out.push(r.data);
      }
      return out;
    }),
});
export type HubCapacityReportAccepted = z.infer<typeof hubCapacityReportAcceptSchema>;

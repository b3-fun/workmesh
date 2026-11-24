import { z } from "zod";

/**
 * Relay → hub wire format v1 (Bullpen SPEC §3). The hub forwarder builds every
 * outgoing body from these strict schemas, so a field that is not in the
 * contract can't leave the machine: an unknown key fails validation and the
 * batch is dropped instead of sent.
 */

export const HUB_WIRE_VERSION = 1;
/** Max events in one ingest request. */
export const HUB_MAX_EVENTS_PER_REQUEST = 500;
/** Max ingest body size the hub accepts. */
export const HUB_MAX_BODY_BYTES = 256 * 1024;
/** Hub device tokens: bp_ + 64 lowercase hex, shown once. */
export const HUB_DEVICE_TOKEN_RE = /^bp_[0-9a-f]{64}$/;

export const hubSessionStateSchema = z.enum(["working", "waiting", "idle", "ended"]);
export type HubSessionState = z.infer<typeof hubSessionStateSchema>;

export const hubEventKindSchema = z.enum(["start", "prompt", "tool", "waiting", "idle", "end"]);
export type HubEventKind = z.infer<typeof hubEventKindSchema>;

const epochMs = z.number().int().nonnegative();
const issueList = z.array(z.string().min(1).max(40)).max(20);

export const hubSessionUpsertSchema = z.strictObject({
  key: z.string().min(1).max(200),
  source: z.string().min(1).max(64),
  name: z.string().max(120).optional(),
  state: hubSessionStateSchema,
  activity: z.string().max(200).optional(),
  background: z.boolean().optional(),
  agents: z.number().int().min(1).max(999).optional(),
  phase: z.string().max(60).optional(),
  orchestrator: z.string().max(200).optional(),
  repo: z.string().max(200).optional(),
  branch: z.string().max(200).optional(),
  issues: issueList.optional(),
  startedAt: epochMs,
  updatedAt: epochMs,
  stateSince: epochMs,
});
export type HubSessionUpsert = z.infer<typeof hubSessionUpsertSchema>;

export const hubActivityEventSchema = z.strictObject({
  id: z.string().min(1).max(40),
  key: z.string().min(1).max(200),
  ts: epochMs,
  kind: hubEventKindSchema,
  tool: z.string().max(64).optional(),
  label: z.string().max(200).optional(),
  path: z.string().max(400).optional(),
  cmd: z.string().max(60).optional(),
  repo: z.string().max(200).optional(),
  branch: z.string().max(200).optional(),
  issues: issueList.optional(),
  pr: z.string().max(300).optional(),
  ok: z.boolean().optional(),
});
export type HubActivityEvent = z.infer<typeof hubActivityEventSchema>;

export const hubIngestRequestSchema = z.strictObject({
  v: z.literal(HUB_WIRE_VERSION),
  sentAt: epochMs,
  full: z.boolean(),
  sessions: z.array(hubSessionUpsertSchema),
  events: z.array(hubActivityEventSchema).max(HUB_MAX_EVENTS_PER_REQUEST),
});
export type HubIngestRequest = z.infer<typeof hubIngestRequestSchema>;

/** A project's sharing rule, sent to the relay at pairing. */
export const hubProjectRuleSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  include: z.object({
    remotes: z.array(z.string().min(1).max(200)).default([]),
    dirs: z.array(z.string().min(1).max(1024)).default([]),
  }),
  issueKeys: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,9}$/)).default([]),
});
export type HubProjectRule = z.infer<typeof hubProjectRuleSchema>;

/** POST /relay/pair/start — request. */
export const hubPairStartRequestSchema = z.object({
  machine: z.string().min(1).max(120),
  client: z.string().min(1).max(64),
});

/** POST /relay/pair/start — response. */
export const hubPairStartResponseSchema = z.object({
  code: z.string().min(1),
  deviceId: z.string().min(1),
  pollSecret: z.string().min(1),
  verifyUrl: z.string().min(1),
  expiresInSec: z.number().int().positive(),
});
export type HubPairStartResponse = z.infer<typeof hubPairStartResponseSchema>;

/** POST /relay/pair/poll — response. deviceToken comes once, on the first `complete`. */
export const hubPairPollResponseSchema = z.object({
  status: z.enum(["pending", "complete", "expired"]),
  deviceToken: z.string().optional(),
  person: z.object({ email: z.string(), name: z.string() }).optional(),
  project: hubProjectRuleSchema.optional(),
});
export type HubPairPollResponse = z.infer<typeof hubPairPollResponseSchema>;

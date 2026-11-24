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
/** Max session upserts in one ingest request. */
export const HUB_MAX_SESSIONS_PER_REQUEST = 1000;
/** Max ingest body size the hub accepts. */
export const HUB_MAX_BODY_BYTES = 256 * 1024;
/** Hub device tokens: bp_ + 64 lowercase hex, shown once. */
export const HUB_DEVICE_TOKEN_RE = /^bp_[0-9a-f]{64}$/;
/** Max chars of prompt or agent-message text on one event (SPEC §9). */
export const HUB_TEXT_MAX = 4000;
/** Max chars of a tool call's one-line description (SPEC §9). */
export const HUB_DESC_MAX = 200;
/** Longest turn the relay reports (30 days); a bigger value is a clock error. */
export const HUB_MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * What a device shares beyond §3.3 metadata (SPEC §8): `metadata` is v0 (no
 * text at all); `conversation` adds prompt text, the agent's text messages, a
 * one-line description per tool call, and turn ends with their duration.
 */
export const hubShareLevelSchema = z.enum(["metadata", "conversation"]);
export type HubShareLevel = z.infer<typeof hubShareLevelSchema>;

export const hubSessionStateSchema = z.enum(["working", "waiting", "idle", "ended"]);
export type HubSessionState = z.infer<typeof hubSessionStateSchema>;

export const hubEventKindSchema = z.enum([
  "start",
  "prompt",
  "tool",
  "waiting",
  "idle",
  "end",
  // v0.2 (SPEC §10), conversation level only:
  "message", // one assistant text block
  "turn", // a turn ended; carries durationMs
]);
export type HubEventKind = z.infer<typeof hubEventKindSchema>;

/** Program plus at most one subcommand word (the hub enforces the same pattern). */
export const HUB_CMD_RE = /^[a-z0-9][a-z0-9._-]{0,30}( [a-z][a-z0-9:-]{0,24})?$/;
export const HUB_ISSUE_RE = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,6}$/;
export const HUB_REPO_RE = /^[\w.-]+\/[\w.-]+$/;
export const HUB_PR_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
export const HUB_TOOL_RE = /^[\w.:-]+$/;

/** Repo-relative only: never absolute, home-relative, or escaping the repo. */
export function isRepoRelativePath(p: string): boolean {
  return (
    p.length > 0 &&
    !p.startsWith("/") &&
    !p.startsWith("~") &&
    !p.startsWith("\\") &&
    !/^[A-Za-z]:[\\/]/.test(p) &&
    !p.split(/[\\/]/).includes("..")
  );
}

const epochMs = z.number().int().nonnegative();
const issueList = z.array(z.string().max(24).regex(HUB_ISSUE_RE)).max(20);
const repoName = z.string().max(200).regex(HUB_REPO_RE);

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
  repo: repoName.optional(),
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
  tool: z.string().max(64).regex(HUB_TOOL_RE).optional(),
  label: z.string().max(200).optional(),
  path: z.string().max(400).refine(isRepoRelativePath, "path must be repo-relative").optional(),
  cmd: z.string().max(60).regex(HUB_CMD_RE).optional(),
  repo: repoName.optional(),
  branch: z.string().max(200).optional(),
  issues: issueList.optional(),
  pr: z.string().max(300).regex(HUB_PR_RE).optional(),
  ok: z.boolean().optional(),
  // v0.2 (SPEC §10). Text is redacted on the machine before it is queued.
  /** Prompt or agent-message text (kinds `prompt` and `message`). */
  text: z.string().max(HUB_TEXT_MAX).optional(),
  /** `text` was cut to HUB_TEXT_MAX. */
  truncated: z.boolean().optional(),
  /** One-line description of a tool call. */
  desc: z.string().max(HUB_DESC_MAX).optional(),
  /** Turn length (kind `turn`). */
  durationMs: z.number().int().nonnegative().max(HUB_MAX_DURATION_MS).optional(),
});
export type HubActivityEvent = z.infer<typeof hubActivityEventSchema>;

export const hubIngestRequestSchema = z.strictObject({
  v: z.literal(HUB_WIRE_VERSION),
  sentAt: epochMs,
  /** This device's sharing level (SPEC §8); the hub drops text from `metadata` devices. */
  share: hubShareLevelSchema.optional(),
  full: z.boolean(),
  sessions: z.array(hubSessionUpsertSchema).max(HUB_MAX_SESSIONS_PER_REQUEST),
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
  /**
   * The level `hub connect` suggests (SPEC §8). Never applied without the
   * person's choice; an unknown value reads as absent.
   */
  defaultShare: hubShareLevelSchema.optional().catch(undefined),
});
export type HubProjectRule = z.infer<typeof hubProjectRuleSchema>;

/** POST /relay/pair/start — request. */
export const hubPairStartRequestSchema = z.object({
  machine: z.string().min(1).max(120),
  client: z.string().min(1).max(64),
  /** The level this machine will share, when known before pairing, so the approve page can name it. */
  share: hubShareLevelSchema.optional(),
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

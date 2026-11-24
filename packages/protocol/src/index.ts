import { z } from "zod";

/**
 * Workmesh relay ↔ hub wire protocol, v1 (docs/SPEC.md §3 and §8–10).
 *
 * Both sides validate against this file:
 * - The relay (packages/cli, the hub forwarder) builds every body it sends from the strict schemas
 *   (`hubSessionUpsertSchema`, `hubActivityEventSchema`, `hubIngestRequestSchema`). An unknown key fails validation,
 *   so a field outside the contract can't leave the machine.
 * - The hub (apps/hub) reads every body with the accept schemas (`hub…AcceptSchema`): the same fields and rules,
 *   read tolerantly so relays older or newer than the hub keep working. Unknown keys are dropped (never stored),
 *   `null` reads as absent, fractional epoch ms are rounded, and conversation text somewhat over its cap is taken
 *   for the hub to cut after its own redaction pass.
 *
 * A body the strict schemas accept, the accept schemas take unchanged (test/protocol.test.ts holds both to that).
 * Change a field here and both sides move together.
 */

// ------------------------------------------------------------------ limits

export const HUB_WIRE_VERSION = 1;
/** Max events in one ingest request. */
export const HUB_MAX_EVENTS_PER_REQUEST = 500;
/** Max session upserts in one ingest request. */
export const HUB_MAX_SESSIONS_PER_REQUEST = 1000;
/** Max body size of any /relay/* request (413 past it). */
export const HUB_MAX_BODY_BYTES = 256 * 1024;
/** Max chars (UTF-16 code units) of prompt or agent-message text on one event (SPEC §10). */
export const HUB_TEXT_MAX = 4000;
/** Max chars of a tool call's one-line description (SPEC §10). */
export const HUB_DESC_MAX = 200;
/**
 * What the hub still accepts and cuts down to HUB_TEXT_MAX / HUB_DESC_MAX, marking `truncated` (a relay's redaction
 * can lengthen text after its own cap). Longer is a schema error.
 */
export const HUB_TEXT_ACCEPT_MAX = 4 * HUB_TEXT_MAX;
export const HUB_DESC_ACCEPT_MAX = 5 * HUB_DESC_MAX;
/** Longest turn a relay reports (30 days); a bigger value is a clock error. */
export const HUB_MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
/** Largest epoch-ms value (the end of the JS Date range). */
export const HUB_MAX_EPOCH_MS = 8.64e15;

// ------------------------------------------------------------------ identifiers

/** Hub device tokens: `bp_` + 64 lowercase hex, shown once. The prefix dates from the hub's first name. */
export const HUB_DEVICE_TOKEN_RE = /^bp_[0-9a-f]{64}$/;
/** `dev_` + a ULID. */
export const HUB_DEVICE_ID_RE = /^dev_[0-9A-Z]{26}$/;
/** 16 random bytes as hex. */
export const HUB_POLL_SECRET_RE = /^[0-9a-f]{32}$/;
/** Pairing codes: `ABCD-1234`. */
export const HUB_PAIR_CODE_RE = /^[A-Z]{4}-\d{4}$/;

// ------------------------------------------------------------------ field rules (SPEC §3.2, §3.3)

/** What a relay sends as `cmd`: a program plus at most one subcommand word (SPEC §3.3 rule 5). */
export const HUB_CMD_RE = /^[a-z0-9][a-z0-9._-]{0,30}( [a-z][a-z0-9:-]{0,24})?$/;
/** What the hub accepts as `cmd`: a program plus at most two subcommand words, so `gh pr create` passes (SPEC §3.2). */
export const HUB_CMD_ACCEPT_RE = /^[a-z0-9][a-z0-9._-]{0,30}( [a-z][a-z0-9:-]{0,24}){0,2}$/;
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

// ------------------------------------------------------------------ vocabularies

/**
 * What a device shares beyond §3.3 metadata (SPEC §8): `metadata` is v0 (no text at all); `conversation` adds prompt
 * text, the agent's text messages, a one-line description per tool call, and turn ends with their duration.
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

// Field validators shared by both readings.
const sessionKey = z.string().min(1).max(200);
const repoName = z.string().max(200).regex(HUB_REPO_RE, "repo must be owner/name");
const branchName = z.string().max(200);
const issueList = z.array(z.string().max(24).regex(HUB_ISSUE_RE, "not an issue id")).max(20);
const repoPath = z.string().max(400).refine(isRepoRelativePath, "path must be repo-relative and stay inside the repo");
const toolName = z.string().max(64).regex(HUB_TOOL_RE, "tool must be a tool name");
const prUrl = z.string().max(300).regex(HUB_PR_RE, "pr must be a GitHub pull request URL");

// ------------------------------------------------------------------ ingest, as a relay sends it (strict)

const epochMs = z.number().int().nonnegative().max(HUB_MAX_EPOCH_MS);

export const hubSessionUpsertSchema = z.strictObject({
  key: sessionKey,
  source: z.string().min(1).max(64),
  name: z.string().max(120).optional(),
  state: hubSessionStateSchema,
  activity: z.string().max(200).optional(),
  background: z.boolean().optional(),
  agents: z.number().int().min(1).max(999).optional(),
  phase: z.string().max(60).optional(),
  orchestrator: z.string().max(200).optional(),
  repo: repoName.optional(),
  branch: branchName.optional(),
  issues: issueList.optional(),
  startedAt: epochMs,
  updatedAt: epochMs,
  stateSince: epochMs,
});
export type HubSessionUpsert = z.infer<typeof hubSessionUpsertSchema>;

export const hubActivityEventSchema = z.strictObject({
  id: z.string().min(1).max(40),
  key: sessionKey,
  ts: epochMs,
  kind: hubEventKindSchema,
  tool: toolName.optional(),
  label: z.string().max(200).optional(),
  path: repoPath.optional(),
  cmd: z.string().max(60).regex(HUB_CMD_RE).optional(),
  repo: repoName.optional(),
  branch: branchName.optional(),
  issues: issueList.optional(),
  pr: prUrl.optional(),
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
  /** Heartbeat: `sessions` is the complete shared set for this device. */
  full: z.boolean(),
  sessions: z.array(hubSessionUpsertSchema).max(HUB_MAX_SESSIONS_PER_REQUEST),
  events: z.array(hubActivityEventSchema).max(HUB_MAX_EVENTS_PER_REQUEST),
});
export type HubIngestRequest = z.infer<typeof hubIngestRequestSchema>;

// ------------------------------------------------------------------ ingest, as the hub reads it (tolerant)

/** Epoch ms; fractional values are rounded rather than rejected. */
const epochMsAccept = z.number().min(0).max(HUB_MAX_EPOCH_MS).transform((n) => Math.round(n));
/** Optional fields may be omitted or `null` (SPEC §3.2). */
const opt = <T extends z.ZodType>(t: T) => t.nullish();

export const hubSessionUpsertAcceptSchema = z.object({
  key: sessionKey,
  source: z.string().min(1).max(64),
  name: opt(z.string().max(120)),
  state: hubSessionStateSchema,
  activity: opt(z.string().max(200)),
  background: opt(z.boolean()),
  agents: opt(z.number().int().min(1).max(999)),
  phase: opt(z.string().max(60)),
  orchestrator: opt(z.string().max(200)),
  repo: opt(repoName),
  branch: opt(branchName),
  issues: opt(issueList),
  startedAt: epochMsAccept,
  updatedAt: epochMsAccept,
  stateSince: epochMsAccept,
});
export type HubSessionUpsertAccepted = z.infer<typeof hubSessionUpsertAcceptSchema>;

export const hubActivityEventAcceptSchema = z.object({
  id: z.string().min(1).max(40),
  key: sessionKey,
  ts: epochMsAccept,
  kind: hubEventKindSchema,
  tool: opt(toolName),
  label: opt(z.string().max(200)),
  path: opt(repoPath),
  cmd: opt(z.string().max(60).regex(HUB_CMD_ACCEPT_RE, "cmd must be a program and its subcommand")),
  repo: opt(repoName),
  branch: opt(branchName),
  issues: opt(issueList),
  pr: opt(prUrl),
  ok: opt(z.boolean()),
  text: opt(z.string().max(HUB_TEXT_ACCEPT_MAX)),
  truncated: opt(z.boolean()),
  desc: opt(z.string().max(HUB_DESC_ACCEPT_MAX)),
  durationMs: opt(z.number().min(0).max(HUB_MAX_DURATION_MS).transform((n) => Math.round(n))),
});
export type HubActivityEventAccepted = z.infer<typeof hubActivityEventAcceptSchema>;

export const hubIngestAcceptSchema = z.object({
  v: z.literal(HUB_WIRE_VERSION),
  sentAt: epochMsAccept,
  /** Absent (relays before v0.2) means metadata. */
  share: opt(hubShareLevelSchema),
  full: z.boolean().default(false),
  sessions: z.array(hubSessionUpsertAcceptSchema).max(HUB_MAX_SESSIONS_PER_REQUEST).default([]),
  events: z.array(hubActivityEventAcceptSchema).max(HUB_MAX_EVENTS_PER_REQUEST).default([]),
});
export type HubIngestAccepted = z.infer<typeof hubIngestAcceptSchema>;

/** `POST /relay/ingest` → 200. */
export const hubIngestResponseSchema = z.object({ ok: z.literal(true), accepted: z.number().int().nonnegative() });
export type HubIngestResponse = z.infer<typeof hubIngestResponseSchema>;

// ------------------------------------------------------------------ pairing (SPEC §3.1)

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
   * The level `hub connect` suggests (SPEC §8). Never applied without the person's choice; an unknown value reads as
   * absent.
   */
  defaultShare: hubShareLevelSchema.optional().catch(undefined),
});
export type HubProjectRule = z.infer<typeof hubProjectRuleSchema>;

/** `POST /relay/pair/start` request. */
export const hubPairStartRequestSchema = z.object({
  machine: z.string().trim().min(1).max(120),
  client: z.string().trim().min(1).max(64),
  /** The level this machine will share, when known before pairing, so the approve page can name it. */
  share: opt(hubShareLevelSchema),
});
export type HubPairStartRequest = z.input<typeof hubPairStartRequestSchema>;

/** `POST /relay/pair/start` → 200. */
export const hubPairStartResponseSchema = z.object({
  code: z.string().min(1),
  deviceId: z.string().min(1),
  pollSecret: z.string().min(1),
  verifyUrl: z.string().min(1),
  expiresInSec: z.number().int().positive(),
});
export type HubPairStartResponse = z.infer<typeof hubPairStartResponseSchema>;

/** `POST /relay/pair/poll` request. */
export const hubPairPollRequestSchema = z.object({
  deviceId: z.string().regex(HUB_DEVICE_ID_RE),
  pollSecret: z.string().regex(HUB_POLL_SECRET_RE),
});
export type HubPairPollRequest = z.infer<typeof hubPairPollRequestSchema>;

/** `POST /relay/pair/poll` → 200. `deviceToken` comes once, on the first `complete`. */
export const hubPairPollResponseSchema = z.object({
  status: z.enum(["pending", "complete", "expired"]),
  deviceToken: z.string().optional(),
  person: z.object({ email: z.string(), name: z.string() }).optional(),
  project: hubProjectRuleSchema.optional(),
});
export type HubPairPollResponse = z.infer<typeof hubPairPollResponseSchema>;

/** A pairing code as typed or pasted: trimmed and upper-cased before the check. */
export const hubPairCodeSchema = z.string().trim().toUpperCase().regex(HUB_PAIR_CODE_RE);

/** `POST /api/pair/approve` (the board, behind Access). */
export const hubPairApproveRequestSchema = z.object({ code: hubPairCodeSchema });

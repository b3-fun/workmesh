import { z } from "zod";
import { SLACK_STATUS_MAX_LEN } from "./constants";

/**
 * Wire contracts shared by the CLI daemon, its adapters, and the relay Worker.
 * The daemon is the only thing that sees raw session data; the relay only ever
 * receives a pre-formatted SlackStatus (or null to clear).
 */

export const sessionStateSchema = z.enum(["working", "waiting", "idle"]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const eventKindSchema = z.enum([
  "start", // session opened (not yet working)
  "working", // agent is actively doing something
  "waiting", // agent blocked on the human (permission prompt, question)
  "idle", // turn finished, session still open
  "heartbeat", // refresh liveness without changing state
  "end", // session closed
]);
export type EventKind = z.infer<typeof eventKindSchema>;

/**
 * Caps for the local-only `detail` block. Hook mappers truncate to these so a
 * hook → daemon body stays well under the daemon's 64 KB limit.
 */
export const DETAIL_LIMITS = {
  hookEvent: 40,
  tool: 64,
  filePath: 1024,
  filePaths: 10,
  command: 4000,
  prompt: 8000,
  toolResponseText: 8000,
} as const;

/**
 * Raw facts about one hook call, filled by the Claude Code and Codex hook
 * mappers. LOCAL ONLY: it travels hook → daemon over loopback and is never
 * stored on a session, formatted into a Slack status, or sent to the
 * agentblip relay. The hub forwarder reduces it to the hub's metadata fields
 * (tool name, repo-relative path, allow-listed command, issue ids, PR URL).
 */
export const sessionEventDetailSchema = z.object({
  /** Hook that produced the event, e.g. "PreToolUse", "UserPromptSubmit". */
  hookEvent: z.string().max(DETAIL_LIMITS.hookEvent).optional(),
  /** Tool name as the agent reports it: "Edit", "Bash", "apply_patch". */
  tool: z.string().max(DETAIL_LIMITS.tool).optional(),
  /** Absolute path the tool touched (first file, for multi-file patches). */
  filePath: z.string().max(DETAIL_LIMITS.filePath).optional(),
  /** Every absolute path a multi-file tool touched (apply_patch). */
  filePaths: z.array(z.string().max(DETAIL_LIMITS.filePath)).max(DETAIL_LIMITS.filePaths).optional(),
  /** Raw shell command, truncated. */
  command: z.string().max(DETAIL_LIMITS.command).optional(),
  /** Raw prompt text, truncated. */
  prompt: z.string().max(DETAIL_LIMITS.prompt).optional(),
  /** Tool output text (shell stdout/stderr), truncated. */
  toolResponseText: z.string().max(DETAIL_LIMITS.toolResponseText).optional(),
  /** The tool call succeeded, when the agent reports it. */
  ok: z.boolean().optional(),
});
export type SessionEventDetail = z.infer<typeof sessionEventDetailSchema>;

export const sessionEventSchema = z.object({
  source: z.string().min(1).max(64), // "claude-code" | "codex" | any custom id
  sessionId: z.string().min(1).max(128),
  kind: eventKindSchema,
  activity: z.string().max(200).optional(), // short label, e.g. "editing format.ts"
  project: z.string().max(120).optional(), // usually basename of cwd
  ts: z.number().int().positive().optional(), // epoch ms; defaults to receipt time
  /**
   * How many concurrent agents this one session represents. Default 1. An
   * orchestrator (an ultracode workflow, a CI fan-out) sets this so "N agents
   * working" reflects real parallelism, not just the number of top-level
   * sessions. Hooks can't see subagent count, so it must be self-reported.
   */
  agents: z.number().int().min(1).max(999).optional(),
  /** Optional phase label from an orchestrator, e.g. "verify" or "2/4". */
  phase: z.string().max(60).optional(),
  /**
   * Session key (`source:sessionId`) of the parent this session's agents are
   * *already* accounted for by. The workflow watcher sets it to the Claude Code
   * session that launched the workflow, so the orchestrator isn't double-counted
   * on top of its own fleet. Ignored when the referenced session isn't present.
   */
  orchestrator: z.string().max(200).optional(),
  /**
   * The session is only waiting on its own background work (shells, subagents)
   * and resumes by itself. Meaningful with kind "working"; cleared by the next
   * working event that doesn't set it.
   */
  background: z.boolean().optional(),
  /**
   * Full working directory. Stays on this machine: local clients (menu bar app)
   * use it to reveal the folder; it is never sent to Slack or the relay.
   */
  cwd: z.string().max(1024).optional(),
  /** Human session name, e.g. Claude Code's "documents-07". Local only, like cwd. */
  name: z.string().max(120).optional(),
  /** Raw hook facts for the hub forwarder. Local only — see sessionEventDetailSchema. */
  detail: sessionEventDetailSchema.optional(),
});
export type SessionEvent = z.infer<typeof sessionEventSchema>;

/**
 * Shortens text to at most `max` characters, keeping its start and end (a
 * command's program and a shell output's last line both matter).
 */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = "\n…\n";
  const room = Math.max(0, max - marker.length);
  const head = Math.floor(room / 4);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (room - head))}`;
}

export const slackStatusSchema = z.object({
  text: z.string().max(SLACK_STATUS_MAX_LEN),
  emoji: z.string().max(64), // ":robot_face:" form
  expirationSec: z.number().int().nonnegative(), // epoch seconds; 0 = never expires
});
export type SlackStatus = z.infer<typeof slackStatusSchema>;

/** POST /api/status — body. `status: null` clears the Slack status. */
export const statusUpdateRequestSchema = z.object({
  status: slackStatusSchema.nullable(),
});
export type StatusUpdateRequest = z.infer<typeof statusUpdateRequestSchema>;

/**
 * GET /api/slack/status — response. `readable: false` means the stored token
 * lacks the users.profile:read scope (pre-ownership pairing) — callers fall
 * back to legacy blind pushes. `status: null` = profile has no status set.
 */
export const statusReadResponseSchema = z.object({
  readable: z.boolean(),
  status: slackStatusSchema.nullable(),
  /**
   * Why a read was not usable. "missing_scope": token lacks users.profile:read
   * (re-pair to fix). "unsupported": sink has no real profile to read (console
   * dry-run) — nothing is at risk, so callers must not warn about overwrites.
   */
  reason: z.enum(["missing_scope", "unsupported"]).optional(),
});
export type StatusReadResponse = z.infer<typeof statusReadResponseSchema>;

// --- Pairing (device-code flow) ---

/** POST /api/pair/start — response. */
export const pairStartResponseSchema = z.object({
  code: z.string(), // short human code the user confirms in the browser
  deviceId: z.string(),
  pollSecret: z.string(),
  verifyUrl: z.string(), // https://agentblip.com/pair?code=XXXX
  expiresInSec: z.number().int().positive(),
});
export type PairStartResponse = z.infer<typeof pairStartResponseSchema>;

/** POST /api/pair/poll — request. */
export const pairPollRequestSchema = z.object({
  deviceId: z.string().min(1),
  pollSecret: z.string().min(1),
});
export type PairPollRequest = z.infer<typeof pairPollRequestSchema>;

/** POST /api/pair/poll — response. deviceToken present only once, on `complete`. */
export const pairPollResponseSchema = z.object({
  status: z.enum(["pending", "complete", "expired"]),
  deviceToken: z.string().optional(),
  team: z.string().optional(), // Slack workspace name, for a friendly confirmation
});
export type PairPollResponse = z.infer<typeof pairPollResponseSchema>;

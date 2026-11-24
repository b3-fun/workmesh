import { z } from "zod";
import { MAX_DESC_CHARS, MAX_TEXT_CHARS } from "../shared/types";

// Wire format v1 (SPEC.md §3). Unknown fields are stripped, so nothing outside these fields is ever stored.

/** Epoch ms; fractional values are rounded rather than rejected. */
const epochMs = z.number().min(0).max(8.64e15).transform((n) => Math.round(n));
const opt = <T extends z.ZodType>(t: T) => t.nullish();

/** Repo-relative only: never absolute, never home-relative, never escaping the repo. */
const relPath = z
  .string()
  .min(1)
  .max(400)
  .refine((p) => !p.startsWith("/") && !p.startsWith("~") && !/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith("\\"), {
    message: "path must be repo-relative",
  })
  .refine((p) => !p.split(/[\\/]/).includes(".."), { message: "path must stay inside the repo" });

/** Program plus at most two subcommand words, e.g. `cargo test`, `gh pr create` (SPEC.md §3.3 rule 5). */
const cmd = z
  .string()
  .max(60)
  .regex(/^[a-z0-9][a-z0-9._-]{0,30}( [a-z][a-z0-9:-]{0,24}){0,2}$/, "cmd must be a program and its subcommand");

const issueId = z.string().max(24).regex(/^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,6}$/, "not an issue id");
const issues = z.array(issueId).max(20);
const repo = z.string().max(200).regex(/^[\w.-]+\/[\w.-]+$/, "repo must be owner/name");
const prUrl = z
  .string()
  .max(300)
  .regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/, "pr must be a GitHub pull request URL");

export const SessionStateSchema = z.enum(["working", "waiting", "idle", "ended"]);
export const EventKindSchema = z.enum(["start", "prompt", "tool", "waiting", "idle", "end", "message", "turn"]);
export const ShareSchema = z.enum(["metadata", "conversation"]);

/**
 * Conversation text (SPEC.md §10). Text over the cap is cut and marked `truncated` instead of failing the whole batch
 * (a relay's redaction can lengthen text after its own cap); far over it is still a schema error.
 */
const HARD_TEXT_CHARS = 4 * MAX_TEXT_CHARS;
const HARD_DESC_CHARS = 5 * MAX_DESC_CHARS;

export const SessionUpsertSchema = z.object({
  key: z.string().min(1).max(200),
  source: z.string().min(1).max(64),
  name: opt(z.string().max(120)),
  state: SessionStateSchema,
  activity: opt(z.string().max(200)),
  background: opt(z.boolean()),
  agents: opt(z.number().int().min(1).max(999)),
  phase: opt(z.string().max(60)),
  orchestrator: opt(z.string().max(200)),
  repo: opt(repo),
  branch: opt(z.string().max(200)),
  issues: opt(issues),
  startedAt: epochMs,
  updatedAt: epochMs,
  stateSince: epochMs,
});

export const ActivityEventSchema = z.object({
  id: z.string().min(1).max(40),
  key: z.string().min(1).max(200),
  ts: epochMs,
  kind: EventKindSchema,
  tool: opt(z.string().max(64).regex(/^[\w.:-]+$/, "tool must be a tool name")),
  label: opt(z.string().max(200)),
  path: opt(relPath),
  cmd: opt(cmd),
  repo: opt(repo),
  branch: opt(z.string().max(200)),
  issues: opt(issues),
  pr: opt(prUrl),
  ok: opt(z.boolean()),
  text: opt(z.string().max(HARD_TEXT_CHARS)),
  truncated: opt(z.boolean()),
  desc: opt(z.string().max(HARD_DESC_CHARS)),
  durationMs: opt(z.number().min(0).max(30 * 24 * 3600_000).transform((n) => Math.round(n))),
});

export const IngestSchema = z.object({
  v: z.literal(1),
  sentAt: epochMs,
  /** Absent (relays before v0.2) means metadata. */
  share: opt(ShareSchema),
  full: z.boolean().default(false),
  sessions: z.array(SessionUpsertSchema).max(1000).default([]),
  events: z.array(ActivityEventSchema).max(500).default([]),
});

export const PairStartSchema = z.object({
  machine: z.string().trim().min(1).max(120),
  client: z.string().trim().min(1).max(64),
  /** What the relay will share, so the approve page can say so (SPEC.md §8). */
  share: opt(ShareSchema),
});

export const PairPollSchema = z.object({
  deviceId: z.string().regex(/^dev_[0-9A-Z]{26}$/),
  pollSecret: z.string().regex(/^[0-9a-f]{32}$/),
});

export const PairCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{4}-\d{4}$/);

export const PairApproveSchema = z.object({ code: PairCodeSchema });

export type SessionUpsert = z.infer<typeof SessionUpsertSchema>;
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
export type IngestPayload = z.infer<typeof IngestSchema>;

/** Field paths and issue codes only: never echo values back or into logs. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

// ------------------------------------------------------------------ conversation text (SPEC.md §8–10)

/**
 * A second guard behind the relay's redaction (SPEC.md §9): obvious credentials never reach storage or a model.
 * The relay's list is the real one; this catches a relay that missed one.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\blin_api_[A-Za-z0-9]{20,}/g,
  /\bbp_[0-9a-f]{64}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  // Credentials embedded in URLs: keep the scheme and host.
  return out.replace(/\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1[redacted]@");
}

/** Cuts to `max` characters without splitting a surrogate pair. */
export function cut(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
}

export interface ConversationFields {
  text: string | null;
  truncated: boolean;
  desc: string | null;
}

/**
 * What the hub stores of an event's conversation fields. Metadata devices keep none (SPEC.md §8); `text` belongs to
 * prompts and messages only.
 */
export function conversationFields(e: ActivityEvent, share: "metadata" | "conversation"): ConversationFields {
  if (share !== "conversation") return { text: null, truncated: false, desc: null };
  let text: string | null = null;
  let truncated = false;
  if ((e.kind === "prompt" || e.kind === "message") && e.text) {
    const c = cut(scrubSecrets(e.text), MAX_TEXT_CHARS);
    text = c.text;
    truncated = c.cut || e.truncated === true;
  }
  const desc = e.desc ? cut(scrubSecrets(e.desc).replace(/\s+/g, " ").trim(), MAX_DESC_CHARS).text || null : null;
  return { text, truncated, desc };
}

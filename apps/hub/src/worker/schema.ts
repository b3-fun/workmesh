import { z } from "zod";

// Wire format v1 (SPEC.md §3). Unknown fields are stripped, so nothing outside these fields is ever stored.

const epochMs = z.number().int().min(0).max(8.64e15);
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

/** Program plus at most one allow-listed subcommand word (SPEC.md §3.3 rule 5). */
const cmd = z
  .string()
  .max(60)
  .regex(/^[a-z0-9][a-z0-9._-]{0,30}( [a-z][a-z0-9:-]{0,24})?$/, "cmd must be a program and one subcommand");

const issueId = z.string().max(24).regex(/^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,6}$/, "not an issue id");
const issues = z.array(issueId).max(20);
const repo = z.string().max(200).regex(/^[\w.-]+\/[\w.-]+$/, "repo must be owner/name");
const prUrl = z
  .string()
  .max(300)
  .regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/, "pr must be a GitHub pull request URL");

export const SessionStateSchema = z.enum(["working", "waiting", "idle", "ended"]);
export const EventKindSchema = z.enum(["start", "prompt", "tool", "waiting", "idle", "end"]);

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
});

export const IngestSchema = z.object({
  v: z.literal(1),
  sentAt: epochMs,
  full: z.boolean().default(false),
  sessions: z.array(SessionUpsertSchema).max(1000).default([]),
  events: z.array(ActivityEventSchema).max(500).default([]),
});

export const PairStartSchema = z.object({
  machine: z.string().trim().min(1).max(120),
  client: z.string().trim().min(1).max(64),
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

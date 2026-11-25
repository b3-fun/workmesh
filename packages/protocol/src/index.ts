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
/** v0.6 (SPEC §15): a subagent's task description (conversation level only). Hub accepts up to 5× and cuts. */
export const HUB_TITLE_MAX = 200;
export const HUB_TITLE_ACCEPT_MAX = 5 * HUB_TITLE_MAX;
/** v0.6: a session's one-line status, from the relay's vocabulary ("waiting on 1 shell"). */
export const HUB_STATUS_LINE_MAX = 120;
/** v0.6: links on one event. */
export const HUB_MAX_LINKS = 10;
/** v0.7 (SPEC §19): shared repos an orchestrator session names as the ones it works across. */
export const HUB_MAX_REPOS = 10;
/** v0.6: token counts and cost a relay reports for one session (a larger value is a parse error, not a real run). */
export const HUB_MAX_TOKENS = 1e13;
export const HUB_MAX_COST_USD = 1e7;

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
/** A GitHub login: 1–39 alphanumerics or single hyphens, not starting with a hyphen (SPEC §15). */
export const HUB_GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** A link id: issue keys, `owner/repo#12`, Slack `C0123/1712345678.123456`. No spaces, no URLs. */
export const HUB_LINK_ID_RE = /^[\w.:#/-]+$/;

/** A link URL: https, no credentials in the authority, no whitespace (SPEC §15). */
export function isSafeLinkUrl(u: string): boolean {
  if (!/^https:\/\/[^\s]+$/.test(u)) return false;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

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
  // v0.6 (SPEC §15):
  "agent_message", // one agent wrote to another (from, to, channel; text at conversation level)
]);
export type HubEventKind = z.infer<typeof hubEventKindSchema>;

/** v0.6: what a session is to its parent (SPEC §15). Absent = a top-level session the person started. */
export const hubSessionRoleSchema = z.enum(["main", "subagent", "workflow", "background"]);
export type HubSessionRole = z.infer<typeof hubSessionRoleSchema>;

/** v0.6: how an `agent_message` travelled. */
export const hubAgentChannelSchema = z.enum(["claude-session", "codex-mail", "workmesh"]);
export type HubAgentChannel = z.infer<typeof hubAgentChannelSchema>;

/** v0.6: what a link points at. */
export const hubLinkTypeSchema = z.enum(["linear", "slack", "github_pr", "github_issue", "url"]);
export type HubLinkType = z.infer<typeof hubLinkTypeSchema>;

// Field validators shared by both readings.
const sessionKey = z.string().min(1).max(200);
const repoName = z.string().max(200).regex(HUB_REPO_RE, "repo must be owner/name");
const branchName = z.string().max(200);
const issueList = z.array(z.string().max(24).regex(HUB_ISSUE_RE, "not an issue id")).max(20);
const repoPath = z.string().max(400).refine(isRepoRelativePath, "path must be repo-relative and stay inside the repo");
const toolName = z.string().max(64).regex(HUB_TOOL_RE, "tool must be a tool name");
const prUrl = z.string().max(300).regex(HUB_PR_RE, "pr must be a GitHub pull request URL");
const agentName = z.string().min(1).max(64);
const modelName = z.string().min(1).max(80);
const statusLine = z.string().max(HUB_STATUS_LINE_MAX);
const tokenCount = z.number().int().nonnegative().max(HUB_MAX_TOKENS);
const costUsd = z.number().nonnegative().max(HUB_MAX_COST_USD);
const peer = z.string().min(1).max(200);
const githubLogin = z.string().max(40).regex(HUB_GITHUB_LOGIN_RE, "github must be a GitHub login");
const linkId = z.string().min(1).max(200).regex(HUB_LINK_ID_RE, "link id must be an id, not text");
const linkUrl = z.string().max(500).refine(isSafeLinkUrl, "link url must be https without credentials");
const linkLabel = z.string().min(1).max(120);

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
  // v0.6 (SPEC §15): structure and usage.
  /** `key` of the session this one runs under (a subagent's or workflow agent's parent). */
  parent: sessionKey.optional(),
  role: hubSessionRoleSchema.optional(),
  /** The agent's type, e.g. Claude Code's `general-purpose`, `Explore`. */
  agentType: agentName.optional(),
  /** A subagent's task description. Conversation level only; redacted on the machine. */
  title: z.string().max(HUB_TITLE_MAX).optional(),
  model: modelName.optional(),
  tokensIn: tokenCount.optional(),
  tokensOut: tokenCount.optional(),
  costUsd: costUsd.optional(),
  /** One line from the relay's vocabulary: "waiting on 1 shell", "running commands". */
  statusLine: statusLine.optional(),
  // v0.7 (SPEC §19).
  /**
   * Only for a session whose cwd is outside every shared repo (§3.3 rule 4: an orchestrator): the shared repos it has
   * touched, most recent first. Its `repo` is the first of them.
   */
  repos: z
    .array(repoName)
    .min(1)
    .max(HUB_MAX_REPOS)
    .refine((r) => new Set(r).size === r.length, "repos must not repeat")
    .optional(),
});
export type HubSessionUpsert = z.infer<typeof hubSessionUpsertSchema>;

/** v0.6: a link on an event (a Linear issue, a Slack message, a PR). At least one of `id` and `url`. */
export const hubLinkSchema = z
  .strictObject({
    type: hubLinkTypeSchema,
    id: linkId.optional(),
    url: linkUrl.optional(),
    label: linkLabel.optional(),
  })
  .refine((l) => l.id !== undefined || l.url !== undefined, "a link needs an id or a url");
export type HubLink = z.infer<typeof hubLinkSchema>;

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
  // v0.6 (SPEC §15).
  /** `agent_message`: who wrote it and to whom (agent names or session keys, never people's handles). */
  from: peer.optional(),
  to: peer.optional(),
  channel: hubAgentChannelSchema.optional(),
  /** Linear issues, Slack messages, PRs and issues this event touched. */
  links: z.array(hubLinkSchema).max(HUB_MAX_LINKS).optional(),
});
export type HubActivityEvent = z.infer<typeof hubActivityEventSchema>;

/** v0.6: who the device's person is beyond the hub's own identity (an avatar for the board and menu bar). */
export const hubPersonSchema = z.strictObject({
  github: githubLogin.optional(),
});
export type HubPerson = z.infer<typeof hubPersonSchema>;

export const hubIngestRequestSchema = z.strictObject({
  v: z.literal(HUB_WIRE_VERSION),
  sentAt: epochMs,
  /** This device's sharing level (SPEC §8); the hub drops text from `metadata` devices. */
  share: hubShareLevelSchema.optional(),
  /** v0.6: the person's GitHub login, read from the local `gh` CLI. */
  person: hubPersonSchema.optional(),
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
/** Token counts; fractional values are rounded. */
const tokenCountAccept = z.number().min(0).max(HUB_MAX_TOKENS).transform((n) => Math.round(n));

/**
 * v0.6 links, read tolerantly: a link this hub can't read (unknown type, a bad url) is dropped on its own instead of
 * failing the batch; more than HUB_MAX_LINKS keeps the first ones.
 */
const linkAccept = z
  .object({
    type: hubLinkTypeSchema,
    id: opt(linkId),
    url: opt(linkUrl),
    label: opt(z.string().max(HUB_TITLE_ACCEPT_MAX)),
  })
  .refine((l) => l.id != null || l.url != null);
export type HubLinkAccepted = z.infer<typeof linkAccept>;
const linksAccept = z
  .array(z.unknown())
  .max(10 * HUB_MAX_LINKS)
  .transform((items) => {
    const out: HubLinkAccepted[] = [];
    for (const item of items) {
      const r = linkAccept.safeParse(item);
      if (r.success && out.length < HUB_MAX_LINKS) out.push(r.data);
    }
    return out;
  });

/** v0.7 repos, read tolerantly: a bad entry is dropped, not a schema error; duplicates once; an empty list is absent. */
const reposAccept = z
  .array(z.unknown())
  .max(10 * HUB_MAX_REPOS)
  .transform((items) => {
    const out: string[] = [];
    for (const item of items) {
      const r = repoName.safeParse(item);
      if (r.success && !out.includes(r.data) && out.length < HUB_MAX_REPOS) out.push(r.data);
    }
    return out.length ? out : undefined;
  });

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
  parent: opt(sessionKey),
  /** A role newer than this hub reads as absent. */
  role: opt(hubSessionRoleSchema).catch(undefined),
  agentType: opt(agentName),
  title: opt(z.string().max(HUB_TITLE_ACCEPT_MAX)),
  model: opt(modelName),
  tokensIn: opt(tokenCountAccept),
  tokensOut: opt(tokenCountAccept),
  costUsd: opt(costUsd),
  statusLine: opt(statusLine),
  /** v0.7: entries that aren't `owner/name` are dropped on their own; past HUB_MAX_REPOS the first ones are kept. */
  repos: opt(reposAccept),
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
  from: opt(peer),
  to: opt(peer),
  /** A channel newer than this hub reads as absent. */
  channel: opt(hubAgentChannelSchema).catch(undefined),
  links: opt(linksAccept),
});
export type HubActivityEventAccepted = z.infer<typeof hubActivityEventAcceptSchema>;

export const hubIngestAcceptSchema = z.object({
  v: z.literal(HUB_WIRE_VERSION),
  sentAt: epochMsAccept,
  /** Absent (relays before v0.2) means metadata. */
  share: opt(hubShareLevelSchema),
  /** A malformed person reads as absent: an avatar is never worth a 400. */
  person: opt(
    z.object({
      github: opt(githubLogin).catch(undefined),
    }),
  ).catch(undefined),
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

// ------------------------------------------------------------------ team (v0.5, SPEC §15)

/**
 * `GET /relay/team` (device token) → the team as the device's person sees it, for the menu bar. Two readings like
 * ingest: the hub builds `HubTeamResponse` (`hubTeamResponseSchema`); the relay reads it with `hubTeamAcceptSchema`,
 * which keeps what it can use (a malformed person or session is dropped on its own, unknown keys are ignored), so a
 * hub newer or older than the relay never blanks the menu bar.
 */
export const hubTeamSessionStateSchema = z.enum(["working", "waiting", "idle", "ended", "offline"]);
export type HubTeamSessionState = z.infer<typeof hubTeamSessionStateSchema>;

const teamName = z.string().min(1).max(120);
const teamCount = z.number().int().nonnegative().max(100_000);
/** A hub session key, `<deviceId>:<source>:<sessionId>` (SPEC §2). */
const hubKey = z.string().min(1).max(300);

export const hubTeamCountsSchema = z.object({ working: teamCount, waiting: teamCount, idle: teamCount });
export type HubTeamCounts = z.infer<typeof hubTeamCountsSchema>;

export const hubTeamPersonSchema = z.object({
  name: teamName,
  email: z.string().max(200).optional(),
  github: githubLogin.optional(),
  /** A device of theirs reached the hub in the last 2 minutes. */
  online: z.boolean(),
  /** Their open sessions by state (offline devices' sessions not counted). */
  counts: hubTeamCountsSchema,
});
export type HubTeamPerson = z.infer<typeof hubTeamPersonSchema>;

export const hubTeamNeedsMeSchema = z.object({
  /** The waiting session's hub key. */
  session: hubKey,
  /** The waiting reason (hub summary), else the relay's activity label. */
  reason: z.string().max(200),
  /** When the wait began (epoch ms). */
  since: epochMs,
  /** Display fields so a client needn't look the session up: its name, agent and repo. */
  name: z.string().max(120).optional(),
  source: z.string().max(64).optional(),
  repo: repoName.optional(),
  /** Whose agent it is (always the viewer today; asks addressed to the viewer later). */
  owner: teamName.optional(),
});
export type HubTeamNeedsMe = z.infer<typeof hubTeamNeedsMeSchema>;

export const hubTeamSessionSchema = z.object({
  key: hubKey.optional(),
  /** The owner's display name, as in `people[].name`. */
  owner: teamName,
  name: z.string().max(120),
  source: z.string().min(1).max(64),
  state: hubTeamSessionStateSchema,
  /** Now line (hub summary), else waiting reason, else the relay's activity label. */
  now: z.string().max(200).optional(),
  repo: repoName.optional(),
  branch: branchName.optional(),
  /** Live subagents under it. */
  subagents: teamCount,
  stateSince: epochMs.optional(),
});
export type HubTeamSession = z.infer<typeof hubTeamSessionSchema>;

export const hubTeamResponseSchema = z.object({
  me: z.object({ name: teamName, email: z.string().max(200).optional(), github: githubLogin.optional() }),
  people: z.array(hubTeamPersonSchema).max(1000),
  needsMe: z.array(hubTeamNeedsMeSchema).max(1000),
  sessions: z.array(hubTeamSessionSchema).max(5000),
  /** The hub's clock, so a client can age `since` without trusting its own. */
  serverNow: epochMs.optional(),
});
export type HubTeamResponse = z.infer<typeof hubTeamResponseSchema>;

/** Keep the items of a list that parse; drop the rest. */
const keepValid = <T extends z.ZodType>(item: T, max: number) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((items) => {
      const out: z.infer<T>[] = [];
      for (const it of items) {
        const r = item.safeParse(it);
        if (r.success && out.length < max) out.push(r.data);
      }
      return out;
    });

const teamCountAccept = z.number().min(0).transform((n) => Math.min(100_000, Math.round(n))).catch(0);
const teamTextAccept = (max: number) =>
  z
    .string()
    .transform((t) => t.slice(0, max))
    .nullish()
    .catch(undefined)
    .transform((v) => v ?? undefined);

export const hubTeamAcceptSchema = z.object({
  me: z
    .object({
      name: z.string().max(200).catch(""),
      email: teamTextAccept(200),
      github: githubLogin.nullish().catch(undefined).transform((v) => v ?? undefined),
    })
    .catch({ name: "", email: undefined, github: undefined }),
  people: keepValid(
    z.object({
      name: teamName,
      email: teamTextAccept(200),
      github: githubLogin.nullish().catch(undefined).transform((v) => v ?? undefined),
      online: z.boolean().catch(false),
      counts: z
        .object({ working: teamCountAccept, waiting: teamCountAccept, idle: teamCountAccept })
        .catch({ working: 0, waiting: 0, idle: 0 }),
    }),
    1000,
  ),
  needsMe: keepValid(
    z.object({
      session: hubKey,
      reason: z.string().catch("").transform((t) => t.slice(0, 200)),
      since: epochMsAccept,
      name: teamTextAccept(120),
      source: teamTextAccept(64),
      repo: teamTextAccept(200),
      owner: teamTextAccept(120),
    }),
    1000,
  ),
  sessions: keepValid(
    z.object({
      key: teamTextAccept(300),
      owner: teamName,
      name: z.string().catch("").transform((t) => t.slice(0, 120)),
      source: z.string().min(1).max(64),
      state: hubTeamSessionStateSchema.catch("idle"),
      now: teamTextAccept(200),
      repo: teamTextAccept(200),
      branch: teamTextAccept(200),
      /** A count; a list (a hub that sends the subagents themselves) counts its items. */
      subagents: z
        .union([z.number(), z.array(z.unknown())])
        .transform((v) => (Array.isArray(v) ? v.length : v))
        .pipe(teamCountAccept)
        .catch(0),
      stateSince: epochMsAccept.nullish().catch(undefined).transform((v) => v ?? undefined),
    }),
    5000,
  ),
  serverNow: epochMsAccept.nullish().catch(undefined).transform((v) => v ?? undefined),
});
export type HubTeamAccepted = z.infer<typeof hubTeamAcceptSchema>;

// v0.7: system-injected content in agent text (zod-free; also importable alone as `@workmesh/protocol/injected`).
export * from "./injected";

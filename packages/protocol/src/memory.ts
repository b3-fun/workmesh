import { z } from "zod";
import { HUB_ISSUE_RE, HUB_REPO_RE, hubPersonEmailAcceptSchema, hubPersonEmailSchema } from "./fields.js";
import { isLeasePath, LEASE_PATH_MAX } from "./lease-paths.js";

/**
 * v3 Memory (docs/SPEC.md §35): the team's shared knowledge base. Decisions, conventions, gotchas, rules and facts that
 * people and their agents write down for everyone's agents, with a person in the loop: a relay's write is a proposal,
 * a person accepts it on the board, and only accepted memories reach other agents.
 *
 * Additive to v1 and v2: new endpoints beside the coordination ones and one optional field on `GET /relay/sync`
 * (`memory.rev`). An older hub answers `404` and sends no `memory`; a relay then keeps v1's notes.
 *
 * Two readings per body, as everywhere (§14): the relay builds requests from the strict schemas and reads answers with
 * the accept schemas (a malformed item is dropped on its own); the hub reads requests with the request accept schemas
 * and builds answers from the response schemas (test/memory.test.ts).
 */

// ------------------------------------------------------------------ limits

export const HUB_MEMORY_KINDS = ["decision", "convention", "gotcha", "rule", "fact"] as const;
export const HUB_MEMORY_STATUSES = ["proposed", "accepted", "rejected", "superseded", "retired"] as const;
/** How a memory came to be: an agent's `remember`, a person (board, CLI, Ask), the hub's reading of a finished session, a v1 note. */
export const HUB_MEMORY_ORIGINS = ["agent", "person", "session", "note"] as const;

export const HUB_MEMORY_TITLE_MAX = 120;
export const HUB_MEMORY_BODY_MAX = 2000;
/** Why a memory should be retired, or a person's note on a decision. */
export const HUB_MEMORY_REASON_MAX = 500;
/** Path globs in one scope (lease-path syntax, §21). */
export const HUB_MEMORY_MAX_PATHS = 20;
/** Issues, PRs and sessions a memory links to, each. */
export const HUB_MEMORY_MAX_LINKS = 10;
export const HUB_MEMORY_MAX_TAGS = 10;
/** Short ids a person or an agent can cite: `m12`. */
export const HUB_MEMORY_ID_RE = /^m\d{1,9}$/;
/** A PR link: `https://github.com/owner/name/pull/123`. */
export const HUB_PR_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d{1,7}$/;
export const HUB_RECALL_QUERY_MAX = 500;
/** Results one recall returns at most (default 8). */
export const HUB_RECALL_MAX = 20;
export const HUB_RECALL_DEFAULT = 8;
/** Memories one brief carries (`GET /relay/memories`), and each one's body there. */
export const HUB_MEMORY_BRIEF_MAX = 500;
export const HUB_MEMORY_BRIEF_BODY_MAX = 600;
/** Memories one `used` report names. */
export const HUB_MEMORY_USED_MAX = 50;
/** Tags, as notes have them (§21). */
const TAG_RE = /^[\w.:-]{1,32}$/;

// ------------------------------------------------------------------ fields

const sessionKey = z.string().min(1).max(200);
const hubKey = z.string().min(1).max(300);
const repoName = z.string().max(200).regex(HUB_REPO_RE, "repo must be owner/name");
const issueId = z.string().max(24).regex(HUB_ISSUE_RE, "not an issue id");
const memoryId = z.string().max(10).regex(HUB_MEMORY_ID_RE, "a memory id is m<number>");
const personName = z.string().min(1).max(120);
/** A person's email beside their display name (§48): optional everywhere; a reader takes a malformed one as absent. */
const personEmail = hubPersonEmailSchema.optional();
const personEmailAccept = hubPersonEmailAcceptSchema;
const sessionName = z.string().max(120);
const prUrl = z.string().max(300).regex(HUB_PR_URL_RE, "a PR link is https://github.com/owner/name/pull/N");
const scopePath = z.string().max(LEASE_PATH_MAX).refine(isLeasePath, "scope paths are repo-relative paths or globs");
const tag = z.string().regex(TAG_RE, "a tag is a word");
const epochMs = z.number().int().nonnegative().max(8.64e15);
const epochMsAccept = z.number().min(0).max(8.64e15).transform((n) => Math.round(n));
const title = z.string().min(1).max(HUB_MEMORY_TITLE_MAX);
const body = z.string().max(HUB_MEMORY_BODY_MAX);
const reason = z.string().max(HUB_MEMORY_REASON_MAX);

const opt = <T extends z.ZodType>(t: T) => t.nullish().transform((v) => v ?? undefined);
/** Optional and tolerant: a malformed value reads as absent. */
const soft = <T extends z.ZodType>(t: T) =>
  t
    .nullish()
    .catch(undefined)
    .transform((v) => v ?? undefined);
const cut = (max: number) => z.string().transform((s) => s.slice(0, max));
/** Text over a cap is cut by the reader rather than failing (a relay's redaction can lengthen it). */
const textAccept = (max: number, min = 1) =>
  z
    .string()
    .min(min)
    .max(4 * max)
    .transform((s) => s.slice(0, max));

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

const unique = (a: readonly string[]): boolean => new Set(a).size === a.length;
const uniq = <T,>(a: readonly T[]): T[] => [...new Set(a)];

export const hubMemoryKindSchema = z.enum(HUB_MEMORY_KINDS);
export type HubMemoryKind = z.infer<typeof hubMemoryKindSchema>;
export const hubMemoryStatusSchema = z.enum(HUB_MEMORY_STATUSES);
export type HubMemoryStatus = z.infer<typeof hubMemoryStatusSchema>;
export const hubMemoryOriginSchema = z.enum(HUB_MEMORY_ORIGINS);
export type HubMemoryOrigin = z.infer<typeof hubMemoryOriginSchema>;

// ------------------------------------------------------------------ shapes

/**
 * Where a memory applies. Absent: the whole project. `repo` alone: that repo. `repo` with `paths`: those files,
 * directories or globs in it (lease-path syntax, §21: `packages/cli/**`, `apps/hub/src/worker/project.ts`).
 */
export const hubMemoryScopeSchema = z.strictObject({
  repo: repoName,
  paths: z.array(scopePath).min(1).max(HUB_MEMORY_MAX_PATHS).refine(unique, "paths must not repeat").optional(),
});
export type HubMemoryScope = z.infer<typeof hubMemoryScopeSchema>;
const scopeAccept = z.object({
  repo: repoName,
  paths: soft(keepValid(scopePath, HUB_MEMORY_MAX_PATHS).transform((p) => (p.length ? uniq(p) : undefined))),
});

/** What a memory links to: Linear issues, GitHub PRs, and (filled in by the hub) the sessions it came from. */
export const hubMemoryLinksSchema = z.object({
  issues: z.array(issueId).max(HUB_MEMORY_MAX_LINKS).optional(),
  prs: z.array(prUrl).max(HUB_MEMORY_MAX_LINKS).optional(),
  sessions: z.array(hubKey).max(HUB_MEMORY_MAX_LINKS).optional(),
});
export type HubMemoryLinks = z.infer<typeof hubMemoryLinksSchema>;
const linksAccept = z.object({
  issues: soft(keepValid(issueId.transform((s) => s.toUpperCase()), HUB_MEMORY_MAX_LINKS).transform(uniq)),
  prs: soft(keepValid(prUrl, HUB_MEMORY_MAX_LINKS).transform(uniq)),
  sessions: soft(keepValid(hubKey, HUB_MEMORY_MAX_LINKS)),
});

/** Who wrote a memory (or proposed retiring one): the person, and the agent session when an agent did. */
export const hubMemoryAuthorSchema = z.object({
  person: personName,
  email: personEmail,
  sessionKey: hubKey.optional(),
  sessionName: sessionName.optional(),
});
export type HubMemoryAuthor = z.infer<typeof hubMemoryAuthorSchema>;
const authorAccept = z.object({
  person: z.string().catch("someone").transform((s) => s.slice(0, 120) || "someone"),
  email: personEmailAccept,
  sessionKey: soft(hubKey),
  sessionName: soft(cut(120)),
});

/** A pending `forget`: someone proposed retiring this accepted memory. */
export const hubMemoryRetireSchema = z.object({
  by: hubMemoryAuthorSchema,
  reason: reason.optional(),
  ts: epochMs,
});
const retireAccept = z.object({
  by: authorAccept,
  reason: soft(cut(HUB_MEMORY_REASON_MAX)),
  ts: epochMsAccept.catch(0),
});

/**
 * One memory. `status`: `proposed` → `accepted` | `rejected`; an accepted one becomes `superseded` when a memory that
 * names it in `supersedes` is accepted (`supersededBy`), or `retired` when a person retires it on the board (`retire`
 * holds a pending retire, which a `forget` sets). Only accepted memories reach agents (session start, recall, the
 * brief).
 */
export const hubMemorySchema = z.object({
  id: memoryId,
  kind: hubMemoryKindSchema,
  title,
  body,
  scope: hubMemoryScopeSchema.optional(),
  links: hubMemoryLinksSchema.optional(),
  tags: z.array(tag).max(HUB_MEMORY_MAX_TAGS).optional(),
  by: hubMemoryAuthorSchema,
  origin: hubMemoryOriginSchema.optional(),
  status: hubMemoryStatusSchema,
  supersedes: memoryId.optional(),
  supersededBy: memoryId.optional(),
  retire: hubMemoryRetireSchema.optional(),
  createdAt: epochMs,
  updatedAt: epochMs,
  /** When an agent last had it (session start or recall), and how many times. */
  usedAt: epochMs.optional(),
  uses: z.number().int().nonnegative().optional(),
});
export type HubMemory = z.infer<typeof hubMemorySchema>;
const memoryAccept = z.object({
  id: memoryId,
  kind: hubMemoryKindSchema,
  title: z.string().min(1).transform((s) => s.slice(0, HUB_MEMORY_TITLE_MAX)),
  body: z.string().catch("").transform((s) => s.slice(0, HUB_MEMORY_BODY_MAX)),
  scope: soft(scopeAccept),
  links: soft(linksAccept),
  tags: soft(keepValid(tag, HUB_MEMORY_MAX_TAGS)),
  by: authorAccept,
  origin: soft(hubMemoryOriginSchema),
  status: hubMemoryStatusSchema,
  supersedes: soft(memoryId),
  supersededBy: soft(memoryId),
  retire: soft(retireAccept),
  createdAt: epochMsAccept.catch(0),
  updatedAt: epochMsAccept.catch(0),
  usedAt: soft(epochMsAccept),
  uses: soft(z.number().int().nonnegative()),
});
export type HubMemoryAccepted = z.infer<typeof memoryAccept>;

// ------------------------------------------------------------------ POST /relay/memories

/**
 * `remember`: a session (or, with no `sessionKey`, a terminal on the device) writes a memory. It is `proposed` either
 * way, and no hub setting accepts it: a person accepts it on the board (§35, "Who decides").
 * `forget`: propose retiring an accepted memory (`reason` says why), which stays accepted until a person retires it on
 * the board; or withdraw a proposal of one's own person.
 * `used`: the relay put these accepted memories in a session's context at its start (the board shows which sessions
 * used a memory).
 */
export const hubMemoryRequestSchema = z.union([
  z.strictObject({
    action: z.literal("remember"),
    sessionKey: sessionKey.optional(),
    kind: hubMemoryKindSchema,
    title,
    body: body.optional(),
    scope: hubMemoryScopeSchema.optional(),
    links: z
      .strictObject({
        issues: z.array(issueId).max(HUB_MEMORY_MAX_LINKS).refine(unique, "issues must not repeat").optional(),
        prs: z.array(prUrl).max(HUB_MEMORY_MAX_LINKS).refine(unique, "prs must not repeat").optional(),
      })
      .optional(),
    tags: z.array(tag).max(HUB_MEMORY_MAX_TAGS).refine(unique, "tags must not repeat").optional(),
    /** An accepted memory this one replaces once it is accepted. */
    supersedes: memoryId.optional(),
  }),
  z.strictObject({
    action: z.literal("forget"),
    sessionKey: sessionKey.optional(),
    id: memoryId,
    reason: reason.optional(),
  }),
  z.strictObject({
    action: z.literal("used"),
    sessionKey,
    ids: z.array(memoryId).min(1).max(HUB_MEMORY_USED_MAX).refine(unique, "ids must not repeat"),
    how: z.literal("start"),
  }),
]);
export type HubMemoryRequest = z.infer<typeof hubMemoryRequestSchema>;

/** The hub's reading: unknown keys dropped, null as absent, text over a cap cut, repeats once, bad links dropped. */
export const hubMemoryRequestAcceptSchema = z.union([
  z.object({
    action: z.literal("remember"),
    sessionKey: opt(sessionKey),
    kind: hubMemoryKindSchema,
    title: textAccept(HUB_MEMORY_TITLE_MAX).transform((s) => s.replace(/\s+/g, " ").trim()).pipe(z.string().min(1)),
    body: opt(textAccept(HUB_MEMORY_BODY_MAX, 0)),
    scope: soft(scopeAccept),
    links: soft(
      z.object({
        issues: soft(keepValid(issueId.transform((s) => s.toUpperCase()), HUB_MEMORY_MAX_LINKS).transform(uniq)),
        prs: soft(keepValid(prUrl, HUB_MEMORY_MAX_LINKS).transform(uniq)),
      }),
    ),
    tags: soft(keepValid(tag, HUB_MEMORY_MAX_TAGS).transform(uniq)),
    supersedes: soft(memoryId),
  }),
  z.object({
    action: z.literal("forget"),
    sessionKey: opt(sessionKey),
    id: memoryId,
    reason: opt(cut(HUB_MEMORY_REASON_MAX)),
  }),
  z.object({
    action: z.literal("used"),
    sessionKey,
    ids: keepValid(memoryId, HUB_MEMORY_USED_MAX)
      .transform(uniq)
      .refine((a) => a.length > 0, "no memory ids"),
    how: z.literal("start").catch("start"),
  }),
]);
export type HubMemoryRequestAccepted = z.infer<typeof hubMemoryRequestAcceptSchema>;

/** 200 `{ ok: true, memory }` (remember, forget) or `{ ok: true }` (used); 404/409 `{ ok: false, error }`. */
export const hubMemoryResponseSchema = z.union([
  z.object({ ok: z.literal(true), memory: hubMemorySchema.optional() }),
  z.object({ ok: z.literal(false), error: z.string().max(300) }),
]);
export type HubMemoryResponse = z.infer<typeof hubMemoryResponseSchema>;
export const hubMemoryResponseAcceptSchema = z.union([
  z.object({ ok: z.literal(true), memory: soft(memoryAccept) }),
  z.object({ ok: z.literal(false), error: z.string().catch("").transform((s) => s.slice(0, 300)) }),
]);
export type HubMemoryResponseAccepted = z.infer<typeof hubMemoryResponseAcceptSchema>;

// ------------------------------------------------------------------ POST /relay/recall

/**
 * Search the team's accepted memories. `repo` and `paths` are where the asking session works (its repo and
 * repo-relative paths: its directory, the files it touches); memories scoped there rank first, project-wide ones next,
 * other repos' last. `kinds` narrows the search.
 */
export const hubRecallRequestSchema = z.strictObject({
  sessionKey: sessionKey.optional(),
  query: z.string().min(1).max(HUB_RECALL_QUERY_MAX),
  repo: repoName.optional(),
  paths: z.array(scopePath).max(HUB_MEMORY_MAX_PATHS).refine(unique, "paths must not repeat").optional(),
  kinds: z.array(hubMemoryKindSchema).min(1).max(HUB_MEMORY_KINDS.length).refine(unique, "kinds must not repeat").optional(),
  limit: z.number().int().min(1).max(HUB_RECALL_MAX).optional(),
});
export type HubRecallRequest = z.infer<typeof hubRecallRequestSchema>;
export const hubRecallRequestAcceptSchema = z.object({
  sessionKey: opt(sessionKey),
  query: z.string().trim().min(1).max(4 * HUB_RECALL_QUERY_MAX).transform((s) => s.slice(0, HUB_RECALL_QUERY_MAX)),
  repo: soft(repoName),
  paths: soft(keepValid(scopePath, HUB_MEMORY_MAX_PATHS).transform(uniq)),
  kinds: soft(keepValid(hubMemoryKindSchema, HUB_MEMORY_KINDS.length).transform((k) => (k.length ? uniq(k) : undefined))),
  limit: soft(z.number().transform((n) => Math.min(HUB_RECALL_MAX, Math.max(1, Math.round(n))))),
});
export type HubRecallRequestAccepted = z.infer<typeof hubRecallRequestAcceptSchema>;

/** A recall hit: the memory and how well it matched (higher is better; comparable within one answer only). */
export const hubRecallHitSchema = hubMemorySchema.extend({ score: z.number().nonnegative().max(1e9) });
export type HubRecallHit = z.infer<typeof hubRecallHitSchema>;

/** 200 `{ ok: true, memories }`, best first. */
export const hubRecallResponseSchema = z.object({
  ok: z.literal(true),
  memories: z.array(hubRecallHitSchema).max(HUB_RECALL_MAX),
});
export type HubRecallResponse = z.infer<typeof hubRecallResponseSchema>;
export const hubRecallResponseAcceptSchema = z.object({
  ok: z.literal(true),
  memories: keepValid(memoryAccept.extend({ score: z.number().catch(0) }), HUB_RECALL_MAX),
});
export type HubRecallResponseAccepted = z.infer<typeof hubRecallResponseAcceptSchema>;

// ------------------------------------------------------------------ GET /relay/memories

/**
 * The brief: every accepted memory (newest first, at most 500), each body cut to 600 characters, for a relay to pick
 * what a new session should know without a network call in the hook path. A relay fetches it when `memory.rev` on
 * `GET /relay/sync` moves.
 */
export const hubMemoryBriefItemSchema = z.object({
  id: memoryId,
  kind: hubMemoryKindSchema,
  title,
  body: z.string().max(HUB_MEMORY_BRIEF_BODY_MAX),
  scope: hubMemoryScopeSchema.optional(),
  issues: z.array(issueId).max(HUB_MEMORY_MAX_LINKS).optional(),
  tags: z.array(tag).max(HUB_MEMORY_MAX_TAGS).optional(),
  by: z.object({ person: personName, email: personEmail }),
  updatedAt: epochMs,
});
export type HubMemoryBriefItem = z.infer<typeof hubMemoryBriefItemSchema>;
const briefItemAccept = z.object({
  id: memoryId,
  kind: hubMemoryKindSchema,
  title: z.string().min(1).transform((s) => s.slice(0, HUB_MEMORY_TITLE_MAX)),
  body: z.string().catch("").transform((s) => s.slice(0, HUB_MEMORY_BRIEF_BODY_MAX)),
  scope: soft(scopeAccept),
  issues: soft(keepValid(issueId.transform((s) => s.toUpperCase()), HUB_MEMORY_MAX_LINKS)),
  tags: soft(keepValid(tag, HUB_MEMORY_MAX_TAGS)),
  by: z.object({ person: z.string().catch("someone").transform((s) => s.slice(0, 120) || "someone"), email: personEmailAccept }),
  updatedAt: epochMsAccept.catch(0),
});
export type HubMemoryBriefItemAccepted = z.infer<typeof briefItemAccept>;

export const hubMemoryBriefResponseSchema = z.object({
  ok: z.literal(true),
  /** The same `rev` as `memory.rev` on sync: what this brief is current as of. */
  rev: z.string().min(1).max(64),
  memories: z.array(hubMemoryBriefItemSchema).max(HUB_MEMORY_BRIEF_MAX),
});
export type HubMemoryBriefResponse = z.infer<typeof hubMemoryBriefResponseSchema>;
export const hubMemoryBriefResponseAcceptSchema = z.object({
  ok: z.literal(true),
  rev: cut(64),
  memories: keepValid(briefItemAccept, HUB_MEMORY_BRIEF_MAX),
});
export type HubMemoryBriefResponseAccepted = z.infer<typeof hubMemoryBriefResponseAcceptSchema>;

// ------------------------------------------------------------------ GET /relay/sync

/** v3 on sync: `memory.rev` moves whenever the accepted set changes (an accept, an edit, a retire). */
export const hubSyncMemorySchema = z.object({
  memory: z.object({ rev: z.string().min(1).max(64) }).optional(),
});
export type HubSyncMemory = z.infer<typeof hubSyncMemorySchema>;
/** The relay's reading: absent (or unreadable) = this hub has no memory. */
export const hubSyncMemoryAcceptSchema = z.object({
  memory: soft(z.object({ rev: z.string().min(1).transform((s) => s.slice(0, 64)) })),
});
export type HubSyncMemoryAccepted = z.infer<typeof hubSyncMemoryAcceptSchema>;

// ------------------------------------------------------------------ helpers (both sides)

/** `owner/name#123` or a PR URL → the PR URL; anything else → undefined. */
export function prLink(raw: string): string | undefined {
  const s = raw.trim();
  if (HUB_PR_URL_RE.test(s)) return s;
  const m = /^([\w.-]+\/[\w.-]+)#(\d{1,7})$/.exec(s);
  return m ? `https://github.com/${m[1]}/pull/${m[2]}` : undefined;
}

/** The kinds as people read them, in the order the board and session start list them. */
export const HUB_MEMORY_KIND_ORDER: readonly HubMemoryKind[] = ["rule", "convention", "decision", "gotcha", "fact"];

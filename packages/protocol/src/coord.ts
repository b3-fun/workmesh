import { z } from "zod";
import { HUB_ISSUE_RE, HUB_REPO_RE } from "./fields.js";
import { isLeasePath, LEASE_PATH_MAX } from "./lease-paths.js";

/**
 * v1 Coordinate (docs/SPEC.md §21): leases, claims, messages, notes, holds, and the one read that carries them all
 * (`GET /relay/sync`). Every endpoint takes the device token; the hub fills in the person from it, never from a body.
 *
 * Two readings per body, as for ingest (§14): the relay builds requests from the strict schemas and reads responses
 * with the accept schemas (a malformed item is dropped on its own, so a hub newer or older than the relay never
 * blanks its view); the hub reads requests with the request accept schemas and builds responses from the response
 * schemas. A body the strict side builds, the other side reads unchanged (test/coord.test.ts).
 */

// ------------------------------------------------------------------ limits

/** Paths (or globs) in one lease. */
export const HUB_LEASE_MAX_PATHS = 50;
export const HUB_LEASE_TTL_MIN_SEC = 60;
export const HUB_LEASE_TTL_MAX_SEC = 4 * 60 * 60;
export const HUB_LEASE_TTL_DEFAULT_SEC = 30 * 60;
/** A lease's or a hold's reason. */
export const HUB_REASON_MAX = 200;
/** A claim's note. */
export const HUB_CLAIM_NOTE_MAX = 500;
/** A message's or a note's text (redacted on the machine, §9). */
export const HUB_COORD_TEXT_MAX = 4000;
export const HUB_NOTE_MAX_TAGS = 10;
/** Notes a sync carries (newest first). */
export const HUB_SYNC_MAX_NOTES = 50;
/** Messages one ack can name. */
export const HUB_ACK_MAX_IDS = 200;
/** How long a file another person's session edited counts as "being worked on" (`edits`, §21). */
export const HUB_RECENT_EDIT_MS = 10 * 60_000;

// ------------------------------------------------------------------ fields

/** The session's ingest key (`<source>:<sessionId>`, §3.2) in a request; the hub prefixes the device id. */
const sessionKey = z.string().min(1).max(200);
/** A hub session key, `<deviceId>:<source>:<sessionId>` (§2), in a response. */
const hubKey = z.string().min(1).max(300);
const repoName = z.string().max(200).regex(HUB_REPO_RE, "repo must be owner/name");
const leasePath = z.string().max(LEASE_PATH_MAX).refine(isLeasePath, "lease paths are repo-relative paths or globs");
const issueId = z.string().max(24).regex(HUB_ISSUE_RE, "not an issue id");
const recordId = z.string().min(1).max(64);
const personName = z.string().min(1).max(120);
const sessionName = z.string().max(120);
const reason = z.string().max(HUB_REASON_MAX);
const epochMs = z.number().int().nonnegative().max(8.64e15);
const epochMsAccept = z.number().min(0).max(8.64e15).transform((n) => Math.round(n));
const coordText = z.string().min(1).max(HUB_COORD_TEXT_MAX);
/** Note tags: `deploy`, `b3os.vault`, `B3-7167`. */
export const HUB_NOTE_TAG_RE = /^[\w.:-]{1,32}$/;
const noteTag = z.string().regex(HUB_NOTE_TAG_RE, "a tag is a word");
const thread = z.string().min(1).max(64);
const cursor = z.string().max(512);

const opt = <T extends z.ZodType>(t: T) => t.nullish().transform((v) => v ?? undefined);
/** Optional and tolerant: a malformed value reads as absent. */
const soft = <T extends z.ZodType>(t: T) =>
  t
    .nullish()
    .catch(undefined)
    .transform((v) => v ?? undefined);

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

const unique = (a: readonly string[]): boolean => new Set(a).size === a.length;

// ------------------------------------------------------------------ shared shapes (responses)

/** Who holds a lease or a claim: the person (display name, as in `/relay/team`) and the session. */
export const hubHolderSchema = z.object({
  person: personName,
  sessionKey: hubKey,
  sessionName: sessionName.optional(),
});
export type HubHolder = z.infer<typeof hubHolderSchema>;
const holderAccept = z.object({
  person: personName,
  sessionKey: hubKey,
  sessionName: soft(z.string().transform((s) => s.slice(0, 120))),
});

export const hubLeaseSchema = z.object({
  id: recordId,
  repo: repoName,
  paths: z.array(leasePath).min(1).max(HUB_LEASE_MAX_PATHS),
  holder: hubHolderSchema,
  /** When it was acquired. */
  since: epochMs.optional(),
  expiresAt: epochMs,
  reason: reason.optional(),
});
export type HubLease = z.infer<typeof hubLeaseSchema>;
const leaseAccept = z.object({
  id: recordId,
  repo: repoName,
  /** A path this relay can't read is dropped; a lease with none left is dropped. */
  paths: keepValid(leasePath, HUB_LEASE_MAX_PATHS).refine((p) => p.length > 0),
  holder: holderAccept,
  since: soft(epochMsAccept),
  expiresAt: epochMsAccept,
  reason: soft(z.string().transform((s) => s.slice(0, HUB_REASON_MAX))),
});
export type HubLeaseAccepted = z.infer<typeof leaseAccept>;

/** A lease that blocked an acquire: whose it is, which of its paths, until when. */
export const hubLeaseConflictSchema = z.object({
  leaseId: recordId,
  holder: hubHolderSchema,
  paths: z.array(leasePath).min(1).max(HUB_LEASE_MAX_PATHS),
  expiresAt: epochMs,
  reason: reason.optional(),
});
export type HubLeaseConflict = z.infer<typeof hubLeaseConflictSchema>;
const conflictAccept = z.object({
  leaseId: recordId,
  holder: holderAccept,
  paths: keepValid(leasePath, HUB_LEASE_MAX_PATHS),
  expiresAt: epochMsAccept,
  reason: soft(z.string().transform((s) => s.slice(0, HUB_REASON_MAX))),
});

export const hubClaimSchema = z.object({
  issue: issueId,
  holder: hubHolderSchema,
  since: epochMs,
  note: z.string().max(HUB_CLAIM_NOTE_MAX).optional(),
});
export type HubClaim = z.infer<typeof hubClaimSchema>;
const claimAccept = z.object({
  issue: issueId,
  holder: holderAccept,
  since: epochMsAccept.catch(0),
  note: soft(z.string().transform((s) => s.slice(0, HUB_CLAIM_NOTE_MAX))),
});
export type HubClaimAccepted = z.infer<typeof claimAccept>;

export const hubNoteSchema = z.object({
  id: recordId,
  by: z.object({ person: personName, sessionKey: hubKey.optional(), sessionName: sessionName.optional() }),
  text: coordText,
  tags: z.array(noteTag).max(HUB_NOTE_MAX_TAGS).optional(),
  ts: epochMs,
});
export type HubNote = z.infer<typeof hubNoteSchema>;
const noteAccept = z.object({
  id: recordId,
  by: z.object({
    person: personName,
    sessionKey: soft(hubKey),
    sessionName: soft(z.string().transform((s) => s.slice(0, 120))),
  }),
  text: z.string().transform((s) => s.slice(0, HUB_COORD_TEXT_MAX)),
  tags: soft(keepValid(noteTag, HUB_NOTE_MAX_TAGS)),
  ts: epochMsAccept,
});
export type HubNoteAccepted = z.infer<typeof noteAccept>;

// ------------------------------------------------------------------ POST /relay/leases

export const hubLeaseActionSchema = z.enum(["acquire", "release", "renew"]);
export type HubLeaseAction = z.infer<typeof hubLeaseActionSchema>;

/**
 * `acquire` takes 1–50 paths; `release` and `renew` name the session's leases in `repo` by `leaseId`, or by `paths`
 * (the session's leases with any of them), or, with neither, all of the session's leases in that repo.
 */
export const hubLeaseRequestSchema = z
  .strictObject({
    action: hubLeaseActionSchema,
    sessionKey,
    repo: repoName,
    paths: z.array(leasePath).max(HUB_LEASE_MAX_PATHS).refine(unique, "paths must not repeat"),
    ttlSec: z.number().int().min(HUB_LEASE_TTL_MIN_SEC).max(HUB_LEASE_TTL_MAX_SEC).optional(),
    reason: reason.optional(),
    leaseId: recordId.optional(),
  })
  .refine((r) => r.action !== "acquire" || r.paths.length > 0, "acquire needs at least one path");
export type HubLeaseRequest = z.infer<typeof hubLeaseRequestSchema>;

/** The hub's reading: unknown keys dropped, null as absent, repeats once, a ttl outside 60..14400 clamped into it. */
export const hubLeaseRequestAcceptSchema = z
  .object({
    action: hubLeaseActionSchema,
    sessionKey,
    repo: repoName,
    paths: z
      .array(leasePath)
      .max(HUB_LEASE_MAX_PATHS)
      .nullish()
      .transform((p) => [...new Set(p ?? [])]),
    ttlSec: opt(
      z
        .number()
        .transform((n) => Math.min(HUB_LEASE_TTL_MAX_SEC, Math.max(HUB_LEASE_TTL_MIN_SEC, Math.round(n)))),
    ),
    reason: opt(z.string().transform((s) => s.slice(0, HUB_REASON_MAX))),
    leaseId: opt(recordId),
  })
  .refine((r) => r.action !== "acquire" || r.paths.length > 0, "acquire needs at least one path");
export type HubLeaseRequestAccepted = z.infer<typeof hubLeaseRequestAcceptSchema>;

/** 200 `{ ok: true, lease }` (acquire, renew) or `{ ok: true, released }`; 409 (or 200) `{ ok: false, conflicts }`. */
export const hubLeaseResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    lease: hubLeaseSchema.optional(),
    released: z.number().int().nonnegative().optional(),
  }),
  z.object({ ok: z.literal(false), conflicts: z.array(hubLeaseConflictSchema).max(100) }),
]);
export type HubLeaseResponse = z.infer<typeof hubLeaseResponseSchema>;
export const hubLeaseResponseAcceptSchema = z.union([
  z.object({
    ok: z.literal(true),
    lease: soft(leaseAccept),
    released: soft(z.number().int().nonnegative()),
  }),
  z.object({ ok: z.literal(false), conflicts: keepValid(conflictAccept, 100) }),
]);
export type HubLeaseResponseAccepted = z.infer<typeof hubLeaseResponseAcceptSchema>;

// ------------------------------------------------------------------ POST /relay/claims

export const hubClaimActionSchema = z.enum(["claim", "release"]);
export type HubClaimAction = z.infer<typeof hubClaimActionSchema>;

export const hubClaimRequestSchema = z.strictObject({
  action: hubClaimActionSchema,
  sessionKey,
  issue: issueId,
  note: z.string().max(HUB_CLAIM_NOTE_MAX).optional(),
});
export type HubClaimRequest = z.infer<typeof hubClaimRequestSchema>;
export const hubClaimRequestAcceptSchema = z.object({
  action: hubClaimActionSchema,
  sessionKey,
  /** Issue keys read case-insensitively: `b3-7167` is `B3-7167`. */
  issue: issueId.transform((s) => s.toUpperCase()),
  note: opt(z.string().transform((s) => s.slice(0, HUB_CLAIM_NOTE_MAX))),
});
export type HubClaimRequestAccepted = z.infer<typeof hubClaimRequestAcceptSchema>;

/** 200 `{ ok: true, claim }` (release: no claim); 409 (or 200) `{ ok: false, holder }` = someone else claimed it. */
export const hubClaimResponseSchema = z.union([
  z.object({ ok: z.literal(true), claim: hubClaimSchema.optional() }),
  z.object({ ok: z.literal(false), holder: hubHolderSchema, since: epochMs.optional() }),
]);
export type HubClaimResponse = z.infer<typeof hubClaimResponseSchema>;
export const hubClaimResponseAcceptSchema = z.union([
  z.object({ ok: z.literal(true), claim: soft(claimAccept) }),
  z.object({ ok: z.literal(false), holder: holderAccept, since: soft(epochMsAccept) }),
]);
export type HubClaimResponseAccepted = z.infer<typeof hubClaimResponseAcceptSchema>;

// ------------------------------------------------------------------ POST /relay/messages

/**
 * Exactly one recipient: a person (display name, email or GitHub login, as the roster shows them; the hub picks which
 * of their sessions gets it), one session (its hub key), or an agent by its session name.
 */
export const hubMessageToSchema = z.union([
  z.strictObject({ person: z.string().min(1).max(200) }),
  z.strictObject({ session: hubKey }),
  z.strictObject({ agent: z.string().min(1).max(120) }),
]);
export type HubMessageTo = z.infer<typeof hubMessageToSchema>;

/** `from` absent = the person wrote it themselves (the CLI outside any agent session). */
export const hubMessageRequestSchema = z.strictObject({
  from: sessionKey.optional(),
  to: hubMessageToSchema,
  text: coordText,
  thread: thread.optional(),
});
export type HubMessageRequest = z.infer<typeof hubMessageRequestSchema>;
export const hubMessageRequestAcceptSchema = z.object({
  from: opt(sessionKey),
  to: z
    .object({
      person: opt(z.string().min(1).max(200)),
      session: opt(hubKey),
      agent: opt(z.string().min(1).max(120)),
    })
    .refine((t) => [t.person, t.session, t.agent].filter((v) => v !== undefined).length === 1, "one recipient"),
  /** The hub cuts text over the cap rather than failing (a relay's redaction can lengthen it). */
  text: z
    .string()
    .min(1)
    .max(4 * HUB_COORD_TEXT_MAX)
    .transform((s) => s.slice(0, HUB_COORD_TEXT_MAX)),
  thread: opt(thread),
});
export type HubMessageRequestAccepted = z.infer<typeof hubMessageRequestAcceptSchema>;

/** 200 `{ ok: true, id }`; 404 `{ ok: false, error }` when no such person, session or agent. */
export const hubIdResponseSchema = z.union([
  z.object({ ok: z.literal(true), id: recordId }),
  z.object({ ok: z.literal(false), error: z.string().max(300) }),
]);
export type HubIdResponse = z.infer<typeof hubIdResponseSchema>;
export const hubIdResponseAcceptSchema = z.union([
  z.object({ ok: z.literal(true), id: recordId }),
  z.object({ ok: z.literal(false), error: z.string().catch("").transform((s) => s.slice(0, 300)) }),
]);

// ------------------------------------------------------------------ POST /relay/notes

/** `sessionKey` absent = the person wrote it themselves. */
export const hubNoteRequestSchema = z.strictObject({
  sessionKey: sessionKey.optional(),
  text: coordText,
  tags: z.array(noteTag).max(HUB_NOTE_MAX_TAGS).refine(unique, "tags must not repeat").optional(),
});
export type HubNoteRequest = z.infer<typeof hubNoteRequestSchema>;
export const hubNoteRequestAcceptSchema = z.object({
  sessionKey: opt(sessionKey),
  text: z
    .string()
    .min(1)
    .max(4 * HUB_COORD_TEXT_MAX)
    .transform((s) => s.slice(0, HUB_COORD_TEXT_MAX)),
  tags: opt(keepValid(noteTag, HUB_NOTE_MAX_TAGS).transform((t) => [...new Set(t)])),
});
export type HubNoteRequestAccepted = z.infer<typeof hubNoteRequestAcceptSchema>;

// ------------------------------------------------------------------ POST /relay/inbox/ack

export const hubInboxAckRequestSchema = z.strictObject({
  ids: z.array(recordId).min(1).max(HUB_ACK_MAX_IDS),
});
export type HubInboxAckRequest = z.infer<typeof hubInboxAckRequestSchema>;
export const hubInboxAckRequestAcceptSchema = z.object({
  ids: z.array(recordId).min(1).max(HUB_ACK_MAX_IDS),
});

// ------------------------------------------------------------------ GET /relay/sync

/** A hold a person put on a session (board or Linear comment): every tool call of that session is refused. */
export const hubHoldSchema = z.object({
  sessionKey: hubKey,
  /** Who put it on. */
  by: personName,
  reason: reason.optional(),
  since: epochMs,
});
export type HubHold = z.infer<typeof hubHoldSchema>;

/** A message waiting for one of this device's sessions. */
export const hubInboxItemSchema = z.object({
  id: recordId,
  /** The recipient session's hub key (one of this device's). */
  to: hubKey,
  from: z.object({ person: personName, sessionName: sessionName.optional(), sessionKey: hubKey.optional() }),
  text: coordText,
  ts: epochMs,
  thread: thread.optional(),
});
export type HubInboxItem = z.infer<typeof hubInboxItemSchema>;

export const hubRosterSessionSchema = z.object({
  hubKey,
  name: sessionName,
  state: z.enum(["working", "waiting", "idle", "ended", "offline"]),
  repo: repoName.optional(),
});
export const hubRosterEntrySchema = z.object({
  person: personName,
  github: z.string().max(40).optional(),
  sessions: z.array(hubRosterSessionSchema).max(500),
});
export type HubRosterEntry = z.infer<typeof hubRosterEntrySchema>;

/** A file a session edited recently (the last HUB_RECENT_EDIT_MS), for "someone is working there" warnings. */
export const hubRecentEditSchema = z.object({
  repo: repoName,
  path: leasePath,
  person: personName,
  sessionKey: hubKey,
  sessionName: sessionName.optional(),
  ts: epochMs,
});
export type HubRecentEdit = z.infer<typeof hubRecentEditSchema>;

export const hubSyncResponseSchema = z.object({
  /** Opaque; the relay sends it back on its next sync. */
  cursor,
  /** The hub's clock, so a relay can age expiries without trusting its own. */
  serverNow: epochMs.optional(),
  /** The device's person, as the other lists name people. */
  me: z.object({ person: personName }).optional(),
  /** Every active lease in the project. */
  leases: z.array(hubLeaseSchema).max(5000),
  /** Holds on any session in the project (a relay acts on its own). */
  holds: z.array(hubHoldSchema).max(1000),
  /** Messages waiting for this device's sessions, oldest first, until acked. */
  inbox: z.array(hubInboxItemSchema).max(500),
  /** Active claims. */
  claims: z.array(hubClaimSchema).max(5000),
  roster: z.array(hubRosterEntrySchema).max(1000),
  /** The newest project notes. */
  notes: z.array(hubNoteSchema).max(HUB_SYNC_MAX_NOTES).optional(),
  /** Files sessions edited in the last 10 minutes (one row per session and path, newest). */
  edits: z.array(hubRecentEditSchema).max(2000).optional(),
});
export type HubSyncResponse = z.infer<typeof hubSyncResponseSchema>;

const rosterStateAccept = z.enum(["working", "waiting", "idle", "ended", "offline"]).catch("idle");

/** The relay's reading: every list keeps the items it can read; a missing list is empty. */
export const hubSyncAcceptSchema = z.object({
  cursor: soft(z.string().transform((s) => s.slice(0, 512))),
  serverNow: soft(epochMsAccept),
  me: soft(z.object({ person: personName })),
  leases: keepValid(leaseAccept, 5000),
  holds: keepValid(
    z.object({
      sessionKey: hubKey,
      by: z.string().catch("someone").transform((s) => s.slice(0, 120) || "someone"),
      reason: soft(z.string().transform((s) => s.slice(0, HUB_REASON_MAX))),
      since: epochMsAccept.catch(0),
    }),
    1000,
  ),
  inbox: keepValid(
    z.object({
      id: recordId,
      to: hubKey,
      from: z.object({
        person: z.string().catch("someone").transform((s) => s.slice(0, 120) || "someone"),
        sessionName: soft(z.string().transform((s) => s.slice(0, 120))),
        sessionKey: soft(hubKey),
      }),
      text: z
        .string()
        .min(1)
        .transform((s) => s.slice(0, HUB_COORD_TEXT_MAX)),
      ts: epochMsAccept.catch(0),
      thread: soft(thread),
    }),
    500,
  ),
  claims: keepValid(claimAccept, 5000),
  roster: keepValid(
    z.object({
      person: personName,
      github: soft(z.string().max(40)),
      sessions: keepValid(
        z.object({
          hubKey,
          name: z.string().catch("").transform((s) => s.slice(0, 120)),
          state: rosterStateAccept,
          repo: soft(repoName),
        }),
        500,
      ),
    }),
    1000,
  ),
  notes: keepValid(noteAccept, HUB_SYNC_MAX_NOTES),
  edits: keepValid(
    z.object({
      repo: repoName,
      path: leasePath,
      person: personName,
      sessionKey: hubKey,
      sessionName: soft(z.string().transform((s) => s.slice(0, 120))),
      ts: epochMsAccept,
    }),
    2000,
  ),
});
export type HubSyncAccepted = z.infer<typeof hubSyncAcceptSchema>;

/** `POST /relay/inbox/ack` → 200 `{ ok: true }`. */
export const hubOkResponseSchema = z.object({ ok: z.literal(true) });

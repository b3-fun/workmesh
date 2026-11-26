import { z } from "zod";
import { HUB_ISSUE_RE, HUB_REPO_RE, hubPersonEmailAcceptSchema, hubPersonEmailSchema } from "./fields.js";
import { hubHandoffKindSchema, hubHandoffReviewAcceptSchema, hubHandoffReviewSchema } from "./review.js";

/**
 * v2 Delegate (docs/SPEC.md §30): handoffs to a person's runner, approval gates on an agent's risky actions, and
 * waking an idle session for a message. Additive to v1 (§21): new endpoints beside the coordination ones, and optional
 * lists on `GET /relay/sync`. An older hub answers `404` and a relay carries on without them (nothing is gated,
 * nothing is handed off).
 *
 * Two readings per body, as for v1 (§14, coord.ts): the relay builds requests from the strict schemas and reads
 * responses with the accept schemas (a malformed item is dropped on its own); the hub reads requests with the request
 * accept schemas and builds responses from the response schemas (test/delegate.test.ts).
 */

// ------------------------------------------------------------------ limits

/** A handoff's task and context text (redacted on the machine, §9). */
export const HUB_HANDOFF_TEXT_MAX = 4000;
/** A note on a handoff's or an approval's change (why it was declined, failed, denied; what was done). */
export const HUB_DELEGATE_NOTE_MAX = 500;
/** What an approval asks for, e.g. "gh pr merge 212 --merge in b3-fun/b3os-beta". */
export const HUB_APPROVAL_DETAIL_MAX = 500;
/** Handoffs and approvals one sync carries. */
export const HUB_SYNC_MAX_HANDOFFS = 200;
export const HUB_SYNC_MAX_APPROVALS = 500;

// ------------------------------------------------------------------ fields

const sessionKey = z.string().min(1).max(200);
const hubKey = z.string().min(1).max(300);
const repoName = z.string().max(200).regex(HUB_REPO_RE, "repo must be owner/name");
const issueId = z.string().max(24).regex(HUB_ISSUE_RE, "not an issue id");
const recordId = z.string().min(1).max(64);
const personName = z.string().min(1).max(120);
/** A person's email beside their display name (§48): optional everywhere; a reader takes a malformed one as absent. */
const personEmail = hubPersonEmailSchema.optional();
const personEmailAccept = hubPersonEmailAcceptSchema;
const deviceId = z.string().min(1).max(64);
const epochMs = z.number().int().nonnegative().max(8.64e15);
const epochMsAccept = z.number().min(0).max(8.64e15).transform((n) => Math.round(n));
const handoffText = z.string().min(1).max(HUB_HANDOFF_TEXT_MAX);
const note = z.string().max(HUB_DELEGATE_NOTE_MAX);
const detail = z.string().min(1).max(HUB_APPROVAL_DETAIL_MAX);

const opt = <T extends z.ZodType>(t: T) => t.nullish().transform((v) => v ?? undefined);
const soft = <T extends z.ZodType>(t: T) =>
  t
    .nullish()
    .catch(undefined)
    .transform((v) => v ?? undefined);
const cut = (max: number) => z.string().transform((s) => s.slice(0, max));

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

/** Text over a cap is cut by the reader rather than failing (a relay's redaction can lengthen it). */
const textAccept = (max: number) =>
  z
    .string()
    .min(1)
    .max(4 * max)
    .transform((s) => s.slice(0, max));

// ------------------------------------------------------------------ gates

/**
 * The risky actions a person can gate for their own agents: `merge` (a PR), `deploy`, `publish` (a package or
 * release), `force_push`, `spend` (paid API or infra), `custom` (anything else the relay's matcher or the person
 * names).
 */
export const HUB_GATE_ACTIONS = ["merge", "deploy", "publish", "force_push", "spend", "custom"] as const;
export const hubGateActionSchema = z.enum(HUB_GATE_ACTIONS);
export type HubGateAction = z.infer<typeof hubGateActionSchema>;

/**
 * One person's gates: which of their agents' actions need an approval, and whose (absent = the owner's own).
 * `ownerEmail` and `approverEmails` (§48) are the same people's emails: `approverEmails` has one entry per approver,
 * in the order of `approvers`.
 */
export const hubGatePolicySchema = z.object({
  owner: personName,
  ownerEmail: personEmail,
  actions: z.array(hubGateActionSchema).max(HUB_GATE_ACTIONS.length),
  approvers: z.array(personName).max(20).optional(),
  approverEmails: z.array(hubPersonEmailSchema).max(20).optional(),
});
export type HubGatePolicy = z.infer<typeof hubGatePolicySchema>;
const gatePolicyAccept = z
  .object({
    owner: personName,
    ownerEmail: personEmailAccept,
    /** An action this relay doesn't know is dropped on its own. */
    actions: keepValid(hubGateActionSchema, HUB_GATE_ACTIONS.length),
    approvers: soft(keepValid(personName, 20)),
    approverEmails: z.array(hubPersonEmailSchema).max(20).optional().catch(undefined),
  })
  // The emails are read only when they line up with the names: every entry an email, one per approver kept. Otherwise
  // the list reads as absent, and a reader matches the approvers by display name.
  .transform((g) =>
    g.approverEmails !== undefined && g.approverEmails.length !== (g.approvers?.length ?? 0) ? { ...g, approverEmails: undefined } : g,
  );
export type HubGatePolicyAccepted = z.infer<typeof gatePolicyAccept>;

/** `POST /relay/gates`: set this device's person's own gates (an empty list turns them all off). */
export const hubGatesRequestSchema = z.strictObject({
  actions: z.array(hubGateActionSchema).max(HUB_GATE_ACTIONS.length).refine(unique, "actions must not repeat"),
});
export type HubGatesRequest = z.infer<typeof hubGatesRequestSchema>;
export const hubGatesRequestAcceptSchema = z.object({
  actions: keepValid(hubGateActionSchema, HUB_GATE_ACTIONS.length).transform((a) => [...new Set(a)]),
});
export type HubGatesRequestAccepted = z.infer<typeof hubGatesRequestAcceptSchema>;

/** 200 `{ ok: true, gates }`. */
export const hubGatesResponseSchema = z.object({ ok: z.literal(true), gates: hubGatePolicySchema });
export const hubGatesResponseAcceptSchema = z.union([
  z.object({ ok: z.literal(true), gates: soft(gatePolicyAccept) }),
  z.object({ ok: z.literal(false), error: z.string().catch("").transform((s) => s.slice(0, 300)) }),
]);
export type HubGatesResponseAccepted = z.infer<typeof hubGatesResponseAcceptSchema>;

// ------------------------------------------------------------------ approvals

export const hubApprovalStatusSchema = z.enum(["pending", "approved", "denied"]);
export type HubApprovalStatus = z.infer<typeof hubApprovalStatusSchema>;

/**
 * Where a person decided an approval (0.12.1, SPEC §30): on the team board, in their menu bar app, or in their terminal
 * (`workmesh approvals approve|deny`). The relay says which of its own two it was; the hub records `board` for the
 * board's. Absent on a decision from an older hub or relay: the notice then names no place.
 */
export const HUB_DECISION_VIAS = ["board", "menubar", "cli"] as const;
export const hubDecisionViaSchema = z.enum(HUB_DECISION_VIAS);
export type HubDecisionVia = z.infer<typeof hubDecisionViaSchema>;

/** An agent's request to take a gated action, and its decision. */
export const hubApprovalSchema = z.object({
  id: recordId,
  /** The session that asked (hub key). */
  sessionKey: hubKey,
  /** Whose agent asked (the gate's owner). */
  owner: personName.optional(),
  ownerEmail: personEmail,
  gate: hubGateActionSchema,
  detail,
  status: hubApprovalStatusSchema,
  /** When it was asked. */
  ts: epochMs,
  decidedAt: epochMs.optional(),
  /** Who decided. */
  by: personName.optional(),
  byEmail: personEmail,
  /** Where they decided it (0.12.1). */
  via: hubDecisionViaSchema.optional(),
  note: note.optional(),
});
export type HubApproval = z.infer<typeof hubApprovalSchema>;
const approvalAccept = z.object({
  id: recordId,
  sessionKey: hubKey,
  owner: soft(personName),
  ownerEmail: personEmailAccept,
  gate: hubGateActionSchema,
  detail: z.string().min(1).transform((s) => s.slice(0, HUB_APPROVAL_DETAIL_MAX)),
  status: hubApprovalStatusSchema,
  ts: epochMsAccept.catch(0),
  decidedAt: soft(epochMsAccept),
  by: soft(cut(120)),
  byEmail: personEmailAccept,
  via: soft(hubDecisionViaSchema),
  note: soft(cut(HUB_DELEGATE_NOTE_MAX)),
});
export type HubApprovalAccepted = z.infer<typeof approvalAccept>;

/**
 * `POST /relay/approvals`. `request`: a session asks to take a gated action (one pending request per session, gate
 * and detail: asking again returns the same approval, or a decision made a few minutes ago). `renew: true` (§31: the
 * relay used the last approval for its one run) asks anew: only a pending one is returned, never a decision.
 * `approve` / `deny`: a person decides one they may decide (the gate's owner or one of its approvers) from a relay,
 * as on the board.
 */
export const hubApprovalRequestSchema = z.union([
  z.strictObject({
    action: z.literal("request"),
    sessionKey,
    gate: hubGateActionSchema,
    detail,
    renew: z.literal(true).optional(),
  }),
  z.strictObject({
    action: z.enum(["approve", "deny"]),
    id: recordId,
    note: note.optional(),
    /** 0.12.1: where on this machine the person decided (a relay never says `board`). */
    via: z.enum(["menubar", "cli"]).optional(),
  }),
]);
export type HubApprovalRequest = z.infer<typeof hubApprovalRequestSchema>;
export const hubApprovalRequestAcceptSchema = z.union([
  z.object({
    action: z.literal("request"),
    sessionKey,
    gate: hubGateActionSchema,
    detail: textAccept(HUB_APPROVAL_DETAIL_MAX),
    renew: z.boolean().nullish().catch(undefined).transform((v) => v === true || undefined),
  }),
  z.object({
    action: z.enum(["approve", "deny"]),
    id: recordId,
    note: opt(cut(HUB_DELEGATE_NOTE_MAX)),
    /** Anything else (an older relay sends none) reads as absent; the hub then records no place. */
    via: soft(z.enum(["menubar", "cli"])),
  }),
]);
export type HubApprovalRequestAccepted = z.infer<typeof hubApprovalRequestAcceptSchema>;

/** 200 `{ ok: true, approval }`; 403/404/409 `{ ok: false, error }` (not yours to decide, no such approval, decided). */
export const hubApprovalResponseSchema = z.union([
  z.object({ ok: z.literal(true), approval: hubApprovalSchema }),
  z.object({ ok: z.literal(false), error: z.string().max(300) }),
]);
export type HubApprovalResponse = z.infer<typeof hubApprovalResponseSchema>;
export const hubApprovalResponseAcceptSchema = z.union([
  z.object({ ok: z.literal(true), approval: approvalAccept }),
  z.object({ ok: z.literal(false), error: z.string().catch("").transform((s) => s.slice(0, 300)) }),
]);
export type HubApprovalResponseAccepted = z.infer<typeof hubApprovalResponseAcceptSchema>;

// ------------------------------------------------------------------ handoffs

/**
 * `offered` → `accepted` (by the person it went to: on the board, in the menu bar or in their own terminal, never by
 * an agent of theirs; or by their relay's policy for one they sent themselves) → `started` (a relay started a
 * session for it) → `done` | `failed`; or `offered` → `declined`.
 */
export const hubHandoffStatusSchema = z.enum(["offered", "accepted", "declined", "started", "done", "failed"]);
export type HubHandoffStatus = z.infer<typeof hubHandoffStatusSchema>;

export const hubHandoffSchema = z.object({
  id: recordId,
  from: z.object({ person: personName, email: personEmail, sessionKey: hubKey.optional(), sessionName: z.string().max(120).optional() }),
  to: z.object({ person: personName, email: personEmail }),
  task: handoffText,
  repo: repoName.optional(),
  issue: issueId.optional(),
  context: handoffText.optional(),
  status: hubHandoffStatusSchema,
  createdAt: epochMs,
  updatedAt: epochMs.optional(),
  /**
   * The device that runs it: the one that accepted it, or that started it. Absent while accepted = any of the
   * recipient's devices may start it, and the first `start` wins (the hub answers the others 409).
   */
  device: deviceId.optional(),
  /** The session started for it (hub key), once a relay sent it. */
  sessionKey: hubKey.optional(),
  /** Why it was declined or failed, or what was done. */
  note: note.optional(),
  /** `review` (§52): a read-only PR review, run from `review`, never from `task`. Absent: a task. */
  kind: hubHandoffKindSchema.optional(),
  /** A review handoff's PR, round and outcome (§52). */
  review: hubHandoffReviewSchema.optional(),
});
export type HubHandoff = z.infer<typeof hubHandoffSchema>;
const handoffAccept = z.object({
  id: recordId,
  from: z.object({
    person: personName,
    email: personEmailAccept,
    sessionKey: soft(hubKey),
    sessionName: soft(cut(120)),
  }),
  to: z.object({ person: personName, email: personEmailAccept }),
  task: z.string().min(1).transform((s) => s.slice(0, HUB_HANDOFF_TEXT_MAX)),
  repo: soft(repoName),
  issue: soft(issueId),
  context: soft(z.string().min(1).transform((s) => s.slice(0, HUB_HANDOFF_TEXT_MAX))),
  /** A status this relay doesn't know drops the item (a relay never acts on a state it can't read). */
  status: hubHandoffStatusSchema,
  createdAt: epochMsAccept.catch(0),
  updatedAt: soft(epochMsAccept),
  device: soft(deviceId),
  sessionKey: soft(hubKey),
  note: soft(cut(HUB_DELEGATE_NOTE_MAX)),
  /**
   * A kind this relay doesn't know drops the item, like an unknown status: a relay never runs as a task what was
   * sent as something else (§52).
   */
  kind: hubHandoffKindSchema
    .nullish()
    .transform((v) => v ?? undefined)
    .optional(),
  review: soft(hubHandoffReviewAcceptSchema).optional(),
})
  // A review handoff without a readable `review` is dropped too: the relay builds a review's prompt from it.
  .refine((h) => h.kind !== "review" || h.review !== undefined, "a review handoff names its PR");
export type HubHandoffAccepted = z.infer<typeof handoffAccept>;

export const hubHandoffUpdateActionSchema = z.enum(["accept", "decline", "start", "done", "fail"]);
export type HubHandoffUpdateAction = z.infer<typeof hubHandoffUpdateActionSchema>;

/**
 * `POST /relay/handoffs`. `create`: hand a task to a person (yourself included: another of your machines). `from`
 * absent = the person wrote it themselves. `to.email` (§48) goes beside `to.person` when the relay resolved the name
 * to one roster person who has one. The others move one handoff on: `accept` / `decline` (its recipient;
 * `accept` from a relay makes that device the runner), `start` (the runner, with the session it started when it
 * knows it; a second `start` from the same device only adds `sessionKey`), `done` / `fail` (the runner).
 */
export const hubHandoffRequestSchema = z.union([
  z.strictObject({
    action: z.literal("create"),
    from: sessionKey.optional(),
    to: z.strictObject({ person: z.string().min(1).max(200), email: personEmail }),
    task: handoffText,
    repo: repoName.optional(),
    issue: issueId.optional(),
    context: handoffText.optional(),
  }),
  z.strictObject({
    action: hubHandoffUpdateActionSchema,
    id: recordId,
    sessionKey: sessionKey.optional(),
    note: note.optional(),
  }),
]);
export type HubHandoffRequest = z.infer<typeof hubHandoffRequestSchema>;
export const hubHandoffRequestAcceptSchema = z.union([
  z.object({
    action: z.literal("create"),
    from: opt(sessionKey),
    to: z.object({ person: z.string().min(1).max(200), email: personEmailAccept }),
    task: textAccept(HUB_HANDOFF_TEXT_MAX),
    repo: opt(repoName),
    /** Issue keys read case-insensitively. */
    issue: opt(issueId.transform((s) => s.toUpperCase())),
    context: opt(textAccept(HUB_HANDOFF_TEXT_MAX)),
  }),
  z.object({
    action: hubHandoffUpdateActionSchema,
    id: recordId,
    sessionKey: opt(sessionKey),
    note: opt(cut(HUB_DELEGATE_NOTE_MAX)),
  }),
]);
export type HubHandoffRequestAccepted = z.infer<typeof hubHandoffRequestAcceptSchema>;

/**
 * 200 `{ ok: true, handoff }`; 404 `{ ok: false, error }` for no such person or handoff; 409 `{ ok: false, error,
 * handoff? }` for a move its state doesn't allow (a `start` another device won, an accept after a decline).
 */
export const hubHandoffResponseSchema = z.union([
  z.object({ ok: z.literal(true), handoff: hubHandoffSchema }),
  z.object({ ok: z.literal(false), error: z.string().max(300), handoff: hubHandoffSchema.optional() }),
]);
export type HubHandoffResponse = z.infer<typeof hubHandoffResponseSchema>;
export const hubHandoffResponseAcceptSchema = z.union([
  z.object({ ok: z.literal(true), handoff: handoffAccept }),
  z.object({
    ok: z.literal(false),
    error: z.string().catch("").transform((s) => s.slice(0, 300)),
    handoff: soft(handoffAccept),
  }),
]);
export type HubHandoffResponseAccepted = z.infer<typeof hubHandoffResponseAcceptSchema>;

// ------------------------------------------------------------------ sync additions

/**
 * What v2 adds to `GET /relay/sync` (§21), all optional: a v1 hub sends none of them, and a relay reads their absence
 * as "this hub has no v2" (no gates enforced, no handoffs).
 */
export const hubSyncDelegateSchema = z.object({
  /** Handoffs offered to this device's person, sent by them, and recently finished (newest first). */
  handoffs: z.array(hubHandoffSchema).max(HUB_SYNC_MAX_HANDOFFS).optional(),
  /** Every member's gates (a relay enforces its own person's). */
  gates: z.array(hubGatePolicySchema).max(1000).optional(),
  /** Approvals asked by this device's sessions, and pending ones its person may decide (newest first). */
  approvals: z.array(hubApprovalSchema).max(HUB_SYNC_MAX_APPROVALS).optional(),
});
export type HubSyncDelegate = z.infer<typeof hubSyncDelegateSchema>;

/** The relay's reading: a missing list stays absent (no v2), a present one keeps the items it can read. */
export const hubSyncDelegateAcceptSchema = z.object({
  handoffs: soft(keepValid(handoffAccept, HUB_SYNC_MAX_HANDOFFS)),
  gates: soft(keepValid(gatePolicyAccept, 1000)),
  approvals: soft(keepValid(approvalAccept, HUB_SYNC_MAX_APPROVALS)),
});
export type HubSyncDelegateAccepted = z.infer<typeof hubSyncDelegateAcceptSchema>;

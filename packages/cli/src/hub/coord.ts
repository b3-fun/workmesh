import {
  HUB_MEMORY_BRIEF_BODY_MAX,
  HUB_RECENT_EDIT_MS,
  hubApprovalRequestSchema,
  hubApprovalResponseAcceptSchema,
  hubAskRequestSchema,
  hubAskResponseAcceptSchema,
  hubGatesRequestSchema,
  hubGatesResponseAcceptSchema,
  hubHandoffRequestSchema,
  hubHandoffResponseAcceptSchema,
  hubClaimRequestSchema,
  hubClaimResponseAcceptSchema,
  hubIdResponseAcceptSchema,
  hubInboxAckRequestSchema,
  hubLeaseRequestSchema,
  hubLeaseResponseAcceptSchema,
  hubMemoryBriefResponseAcceptSchema,
  hubMemoryRequestSchema,
  hubMemoryResponseAcceptSchema,
  hubMessageRequestSchema,
  hubNoteRequestSchema,
  hubRecallRequestSchema,
  hubRecallResponseAcceptSchema,
  hubSyncAcceptSchema,
  isLeaseGlob,
  leaseEntriesCovering,
  leasePathsOverlap,
} from "@workmesh/protocol";
import type {
  HubApprovalRequest,
  HubApprovalResponseAccepted,
  HubAskRequest,
  HubAskResponseAccepted,
  HubGatesRequest,
  HubGatesResponseAccepted,
  HubHandoffRequest,
  HubHandoffResponseAccepted,
  HubClaimRequest,
  HubClaimResponseAccepted,
  HubLeaseAccepted,
  HubLeaseRequest,
  HubLeaseResponseAccepted,
  HubMemoryAccepted,
  HubMemoryBriefItemAccepted,
  HubMemoryRequest,
  HubMemoryResponseAccepted,
  HubMessageRequest,
  HubNoteRequest,
  HubRecallRequest,
  HubRecallResponseAccepted,
  HubSyncAccepted,
} from "@workmesh/protocol";
import type { z } from "zod";
import { cleanText, label, oneLine } from "../lib/untrusted";
import { parseRetryAfter } from "./forwarder";

/**
 * v1 Coordinate, the relay side (docs/SPEC.md §21, §23): the daemon's view of the team's leases, holds, claims,
 * roster, notes and this device's inbox, polled from `GET <hub>/relay/sync`, and the hub calls the MCP server and CLI
 * make through the daemon (the device token never leaves it).
 *
 * Everything here fails open. Hooks read only the cached state (no network in the hook path); a lease is enforced
 * only while the last good sync is fresh, and a hold only while a sync in the last 30 minutes still carried it, so an
 * unreachable hub never blocks anyone's tool calls for long, and never blocks them at all unless a hold was known.
 */

export type HubSyncHold = HubSyncAccepted["holds"][number];
export type HubSyncInboxItem = HubSyncAccepted["inbox"][number];
export type HubSyncEdit = HubSyncAccepted["edits"][number];

export interface CoordView {
  /** null: not asked yet; false: this hub has no coordination (404, older than v1). */
  available: boolean | null;
  /** The hub rejected the device token. */
  halted: boolean;
  /** Epoch ms of the last good sync. */
  fetchedAt?: number;
  error?: string;
  pollMs: number;
  /** The last good sync, if any. */
  state?: HubSyncAccepted;
}

/**
 * Who may reach this machine's sessions (SPEC §23), decided on this machine (`daemon/messages.ts`). The hub's flags
 * and a sender's wishes are a request. Without a policy every message is taken as the hub sent it.
 */
export interface InboxPolicy {
  /** This message may start a turn in its idle session. Asked for a hub message and for the daemon's own notices. */
  wakes(item: HubSyncInboxItem, localKey: string): boolean;
  /**
   * This message is not to be handed to its session: it waits for the person, who delivers or drops it. Asked each
   * time a hub message could be handed over, so the answer follows the session's permission mode as it is then.
   */
  holds(item: HubSyncInboxItem, localKey: string): boolean;
}

export interface CoordClientOptions {
  url: string;
  token: string;
  /** This device's id: hub keys of its sessions start with `<deviceId>:`. */
  deviceId: string;
  /** The person's display name from pairing (`me` in a sync answer wins). */
  person?: string;
  /** True while any shared session is live: poll fast. */
  active?: () => boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
  fastMs?: number;
  slowMs?: number;
  /** After a 404, ask again this much later. */
  absentRetryMs?: number;
  maxBackoffMs?: number;
  timeoutMs?: number;
  /** A hold seen in a sync keeps refusing tool calls this long without a newer sync. */
  holdGraceMs?: number;
  /** Leases and recent edits count only while the last good sync is this fresh. */
  staleMs?: number;
  /** v2 (SPEC §31): after each good sync, with the one before (handoffs, approvals and wake checks diff them). */
  onSync?: (next: HubSyncAccepted, previous: HubSyncAccepted | undefined) => void;
  /** v3 (SPEC §36): the brief is fetched at most this often (default 10 s). */
  briefMinMs?: number;
  /** Who may reach this machine's sessions (SPEC §23). Absent: every message as the hub sent it. */
  policy?: InboxPolicy;
}

/** v3 Memory (SPEC §35): one accepted memory as the brief carries it. */
export type MemoryBriefItem = HubMemoryBriefItemAccepted;

/** What a memory call answers when this hub has no memory (a 404, or a sync without `memory`). */
export const NO_MEMORY = "this team's hub has no memory yet (it predates Workmesh v3)";

/** What a hub call answered: the parsed body, or why there is none. */
export type CoordResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status?: number; error: string; unavailable?: boolean; retryAfterMs?: number };

/** Ask (SPEC §29): how long one question may take (the hub's model may take a few rounds). */
export const ASK_TIMEOUT_MS = 90_000;
/** After a 404 or 503 to `/relay/ask`, this hub is taken to have no Ask for this long. */
const ASK_ABSENT_MS = 10 * 60_000;

const MAX_DELIVERED = 2000;
/**
 * Ids of notices the daemon writes itself (an approval decided, a handoff finished): never acked to the hub. Not
 * `wm_`: the hub's own message ids are `wm_<ULID>`, and a teammate's message must never read as the daemon's notice.
 * Only `notify` writes this prefix: a sync item that carries it is refused (`withoutLocalIds`).
 */
const LOCAL_ID_PREFIX = "wmn_";

/** A notice this daemon wrote itself (SPEC §31), not a message from the hub. */
export function isLocalNotice(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX);
}
const MAX_LOCAL = 500;
/** Refused sync items are logged once each, for at most this many ids. */
const MAX_REFUSED_LOGGED = 200;
/** An undelivered message the hub stopped listing is kept this long (its session may come back). */
const INBOX_KEEP_MS = 24 * 60 * 60_000;

export class CoordClient {
  readonly deviceId: string;
  private readonly url: string;
  private readonly token: string;
  private readonly pairedPerson: string | undefined;
  private readonly active: () => boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly fastMs: number;
  private readonly slowMs: number;
  private readonly absentRetryMs: number;
  private readonly maxBackoffMs: number;
  private readonly timeoutMs: number;
  private readonly holdGraceMs: number;
  private readonly staleMs: number;

  private available: boolean | null = null;
  private halted = false;
  private state: HubSyncAccepted | undefined;
  private fetchedAt: number | undefined;
  /** hub clock − local clock at the last sync. */
  private skew = 0;
  private error: string | undefined;
  private cursor: string | undefined;
  private failures = 0;
  private retryAt = 0;
  private lastAttemptAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private nextAt = 0;
  private running = false;
  private inFlight: Promise<void> | undefined;
  /** Holds as last seen, with when a sync last carried each (fail-open after holdGraceMs). */
  private holds = new Map<string, { hold: HubSyncHold; seenAt: number }>();
  /** Inbox items not yet acked by the hub, by id, with when a sync last listed each. */
  private readonly inbox = new Map<string, { item: HubSyncInboxItem; seenAt: number }>();
  /** Ids handed to an agent (or read through `inbox`); never delivered twice. */
  private readonly delivered = new Set<string>();
  private readonly ackQueue = new Set<string>();
  private acking: Promise<void> | undefined;
  /** v2: notices for this device's sessions that the daemon wrote itself, by id. */
  private readonly local = new Map<string, HubSyncInboxItem>();
  private localSeq = 0;
  /** Ids of sync items refused for carrying the daemon's own notice prefix (each is logged once). */
  private readonly refusedIds = new Set<string>();
  private readonly onSync: CoordClientOptions["onSync"];
  private readonly policy: InboxPolicy | undefined;
  /** v2 endpoints this hub answered 404 to, and until when that is remembered. */
  private readonly v2Absent = new Map<string, number>();
  /** Teammates' messages handed to this device's sessions, newest last, for telling a reply from new chatter. */
  private readonly received: Array<{ to: string; id: string; thread?: string; fromKey?: string; fromName?: string; fromPerson: string; at: number }> = [];
  /** Ask (SPEC §29): questions being answered, by asker (a session's key, or `person`). */
  private readonly asking = new Set<string>();
  /** Ask is off on this hub (404, 503), or rate-limited (429), until then, and why. */
  private askBlocked: { until: number; status: number; error: string } | undefined;
  /** v3 (SPEC §36): the last good brief (every accepted memory), and the sync `rev` it was fetched for. */
  private memBrief: { rev: string; forRev: string; memories: MemoryBriefItem[]; fetchedAt: number } | undefined;
  /** A memory endpoint answered 404: this hub has no memory until then. */
  private memoryOffUntil = 0;
  private readonly briefMinMs: number;
  private briefAttemptAt = 0;
  private briefFailures = 0;
  private briefRetryAt = 0;
  private briefInFlight: Promise<void> | undefined;
  /** When the brief fetch in flight was sent (a brief sent before a write can't carry it). */
  private briefSentAt = 0;
  /**
   * 0.12.1: memory writes the hub took, applied to the cached brief at once (as #31 did for claims and leases), so
   * `memories` shows them before the next sync and brief. Each is applied again to a brief that was asked for before
   * the hub answered the write, and dropped once a brief asked for after it arrives (that one carries it).
   */
  private memWrites: Array<{ at: number; apply: (list: MemoryBriefItem[]) => MemoryBriefItem[] }> = [];

  constructor(opts: CoordClientOptions) {
    this.url = opts.url.replace(/\/+$/, "");
    this.token = opts.token;
    this.deviceId = opts.deviceId;
    this.pairedPerson = opts.person;
    this.active = opts.active ?? (() => false);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.fastMs = opts.fastMs ?? 5000;
    this.slowMs = opts.slowMs ?? 60_000;
    this.absentRetryMs = opts.absentRetryMs ?? 10 * 60_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 5 * 60_000;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.holdGraceMs = opts.holdGraceMs ?? 30 * 60_000;
    this.staleMs = opts.staleMs ?? 90_000;
    this.onSync = opts.onSync;
    this.policy = opts.policy;
    this.briefMinMs = opts.briefMinMs ?? 10_000;
  }

  // --- lifecycle ---------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The cadence right now. */
  pollMs(now = this.now()): number {
    if (this.available === false) return this.absentRetryMs;
    if (this.retryAt > now) return this.retryAt - now;
    if (this.failures > 0) return Math.min(this.maxBackoffMs, this.fastMs * 2 ** Math.min(this.failures, 10));
    return this.active() ? this.fastMs : this.slowMs;
  }

  /** A shared session did something: if the poller is on its slow cadence, sync soon. */
  poke(now = this.now()): void {
    if (!this.running || this.halted || this.available === false || this.failures > 0 || this.retryAt > now) return;
    const due = this.lastAttemptAt + this.fastMs;
    const at = Math.max(now, due);
    if (at < this.nextAt) this.schedule(at - now);
  }

  view(): CoordView {
    return {
      available: this.available,
      halted: this.halted,
      fetchedAt: this.fetchedAt,
      error: this.error,
      pollMs: this.pollMs(),
      state: this.state,
    };
  }

  private schedule(delayMs: number): void {
    if (!this.running || this.halted) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextAt = this.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sync().finally(() => this.schedule(this.pollMs()));
    }, delayMs);
    this.timer.unref?.();
  }

  // --- who and when ----------------------------------------------------------------

  /** The device's person as the hub names people. */
  me(): string | undefined {
    return this.state?.me?.person ?? this.pairedPerson;
  }

  /** The hub's clock, as best known. */
  hubNow(now = this.now()): number {
    return now + this.skew;
  }

  /** The hub key of one of this device's sessions (`<source>:<id>` → `<deviceId>:<source>:<id>`). */
  hubKey(localKey: string): string {
    return `${this.deviceId}:${localKey}`;
  }

  /** A hub key of this device's → its local key; undefined for another device's. */
  localKey(hubKey: string): string | undefined {
    const prefix = `${this.deviceId}:`;
    return hubKey.startsWith(prefix) ? hubKey.slice(prefix.length) : undefined;
  }

  /** The top-level session a key belongs to (a subagent `<key>/<agentId>` belongs to `<key>`). */
  static family(key: string): string {
    const i = key.indexOf("/");
    return i === -1 ? key : key.slice(0, i);
  }

  /** The last good sync is recent enough to act on (leases, edits, gates). */
  fresh(now = this.now()): boolean {
    return this.fetchedAt !== undefined && now - this.fetchedAt <= this.staleMs;
  }

  /**
   * v2 (SPEC §30): this hub sends handoffs, gates or approvals on sync. A v1 hub sends none of the lists, and a relay
   * then gates nothing and runs no handoffs.
   */
  delegateAvailable(): boolean {
    const s = this.state;
    return s !== undefined && (s.handoffs !== undefined || s.gates !== undefined || s.approvals !== undefined);
  }

  /**
   * v3 (SPEC §35, §36): this hub has memory: its last sync carried `memory.rev`, and no memory endpoint answered 404
   * in the last 10 minutes. Off, the relay keeps v1's notes (session start, `note`, `notes`).
   */
  memoryAvailable(now = this.now()): boolean {
    return this.state?.memory !== undefined && this.memoryOffUntil <= now;
  }

  /** The accepted memories as of the last good brief, newest first; undefined before the first one (or without memory). */
  brief(now = this.now()): readonly MemoryBriefItem[] | undefined {
    return this.memoryAvailable(now) ? this.memBrief?.memories : undefined;
  }

  /** The brief's rev and when it was fetched (for status lines and tests). */
  briefInfo(): { rev: string; fetchedAt: number; count: number } | undefined {
    const b = this.memBrief;
    return b ? { rev: b.rev, fetchedAt: b.fetchedAt, count: b.memories.length } : undefined;
  }

  /** Syncs first when the last sync is older than `maxAgeMs`, then waits for a brief fetch it started. Never throws. */
  async memoryReady(maxAgeMs = 5000): Promise<void> {
    await this.refreshed(maxAgeMs);
    if (this.briefInFlight) await this.briefInFlight;
  }

  // --- what hooks read (cached; never a network call) ----------------------------

  /** The hold on this session (or the session it runs under), if one is in force. */
  holdFor(localKey: string, now = this.now()): HubSyncHold | undefined {
    if (this.holds.size === 0) return undefined;
    const keys = [this.hubKey(localKey), this.hubKey(CoordClient.family(localKey))];
    for (const k of keys) {
      const h = this.holds.get(k);
      if (h && now - h.seenAt <= this.holdGraceMs) return h.hold;
    }
    return undefined;
  }

  /**
   * Other sessions' active leases covering `repo`/`relPath`, with the entries that cover it (for a glob, such as a
   * shell command's `src/*.ts`, the entries that overlap it). Empty unless the last sync is fresh. "Other" = any
   * session but this one and its subagents, the same person's included.
   */
  leasesCovering(
    repo: string,
    relPath: string,
    localKey: string,
    now = this.now(),
  ): Array<{ lease: HubLeaseAccepted; entries: string[] }> {
    if (!this.state || !this.fresh(now)) return [];
    const mine = CoordClient.family(localKey);
    const hubNow = this.hubNow(now);
    const out: Array<{ lease: HubLeaseAccepted; entries: string[] }> = [];
    for (const lease of this.state.leases) {
      if (lease.repo !== repo || lease.expiresAt <= hubNow) continue;
      const holderLocal = this.localKey(lease.holder.sessionKey);
      if (holderLocal !== undefined && CoordClient.family(holderLocal) === mine) continue;
      const entries = isLeaseGlob(relPath)
        ? lease.paths.filter((e) => leasePathsOverlap(e, relPath))
        : leaseEntriesCovering(lease.paths, relPath);
      if (entries.length > 0) out.push({ lease, entries });
    }
    return out;
  }

  /** Another person's sessions that edited `repo`/`relPath` in the last 10 minutes (newest first). */
  recentEditsByOthers(repo: string, relPath: string, now = this.now()): HubSyncEdit[] {
    if (!this.state || !this.fresh(now)) return [];
    const me = this.me()?.toLowerCase();
    const since = this.hubNow(now) - HUB_RECENT_EDIT_MS;
    return this.state.edits
      .filter(
        (e) =>
          e.repo === repo &&
          e.path === relPath &&
          e.ts >= since &&
          this.localKey(e.sessionKey) === undefined &&
          (me === undefined || e.person.toLowerCase() !== me),
      )
      .sort((a, b) => b.ts - a.ts);
  }

  /**
   * Messages for this session (exactly its key) that may be handed to it now, oldest first (the daemon's own notices
   * too). A message this machine's policy holds for the person is not among them.
   */
  pendingFor(localKey: string): HubSyncInboxItem[] {
    const out: HubSyncInboxItem[] = [];
    for (const { item } of this.inbox.values()) {
      if (this.delivered.has(item.id)) continue;
      if (this.recipientLocalKey(item) !== localKey) continue;
      if (this.policy?.holds(item, localKey)) continue;
      out.push(item);
    }
    for (const item of this.local.values()) {
      if (!this.delivered.has(item.id) && item.to === localKey) out.push(item);
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  /**
   * v2 (SPEC §31): whether a message asks to wake an idle session: the hub's `wake` when it set one, else yes for a
   * message a person wrote (no sending session) and no for one an agent sent. A request: this machine's policy has
   * the last word (`wakeFor`).
   */
  static wakes(item: HubSyncInboxItem): boolean {
    return item.wake ?? item.from.sessionKey === undefined;
  }

  /**
   * Whether a message is this device's person's own: one of this device's sessions sent it, or the hub names its
   * sender as it names this device's person (their other machines, the board, a terminal).
   */
  isOwn(item: HubSyncInboxItem): boolean {
    if (item.from.sessionKey !== undefined && this.localKey(item.from.sessionKey) !== undefined) return true;
    const me = this.me()?.toLowerCase();
    return me !== undefined && item.from.person.toLowerCase() === me;
  }

  /** Waiting messages that may wake this session if it is idle, oldest first: this machine's policy decides. */
  wakeFor(localKey: string): HubSyncInboxItem[] {
    const policy = this.policy;
    return this.pendingFor(localKey).filter((i) => (policy ? policy.wakes(i, localKey) : CoordClient.wakes(i)));
  }

  /** The local sessions (and subagents) with a message that may be handed over, for the daemon's wake check. */
  sessionsWithPending(): Set<string> {
    const out = new Set<string>();
    for (const { item } of this.inbox.values()) {
      if (this.delivered.has(item.id)) continue;
      const k = this.recipientLocalKey(item);
      if (k !== undefined && !this.policy?.holds(item, k)) out.add(k);
    }
    for (const item of this.local.values()) if (!this.delivered.has(item.id)) out.add(item.to);
    return out;
  }

  /**
   * v2: a notice for one of this device's sessions that the daemon writes itself (an approval was decided, a handoff
   * it sent was taken or finished). It is delivered like a teammate's message (next tool boundary, or a wake) and
   * never acked to the hub. Returns its id.
   */
  notify(localKey: string, text: string, opts: { from?: string; wake?: boolean } = {}): string {
    const id = `${LOCAL_ID_PREFIX}${this.now().toString(36)}${(this.localSeq++).toString(36)}`;
    this.local.set(id, {
      id,
      to: localKey,
      from: { person: opts.from ?? "Workmesh", sessionName: undefined, sessionKey: undefined },
      // A notice is printed as Workmesh's own words: nothing unseen stays in it, whatever went into it.
      text: cleanText(text).slice(0, 4000),
      ts: this.now(),
      thread: undefined,
      wake: opts.wake ?? true,
    });
    while (this.local.size > MAX_LOCAL) {
      const first = this.local.keys().next().value;
      if (first === undefined) break;
      this.local.delete(first);
    }
    return id;
  }

  /**
   * Every message waiting for this device's sessions, delivered or not (the person's view: the CLI at a terminal and
   * the menu bar). `held` marks one that waits for the person instead of going to its session.
   */
  inboxItems(): Array<HubSyncInboxItem & { delivered: boolean; held: boolean; localKey: string }> {
    const out: Array<HubSyncInboxItem & { delivered: boolean; held: boolean; localKey: string }> = [];
    for (const { item } of this.inbox.values()) {
      const localKey = this.recipientLocalKey(item);
      if (localKey === undefined) continue;
      const delivered = this.delivered.has(item.id);
      out.push({ ...item, delivered, held: !delivered && this.policy?.holds(item, localKey) === true, localKey });
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  /**
   * These messages will not reach an agent: the person dropped them, or nobody answered in time. They are never
   * handed over, and they are acked so the hub stops listing them. The hub is not told why.
   */
  discard(ids: readonly string[]): void {
    for (const id of ids) {
      if (isLocalNotice(id) || this.delivered.has(id)) continue;
      this.delivered.add(id);
      this.ackQueue.add(id);
    }
    while (this.delivered.size > MAX_DELIVERED) {
      const first = this.delivered.values().next().value;
      if (first === undefined) break;
      this.delivered.delete(first);
    }
    void this.flushAcks();
  }

  /** The local session key a message is for (a hub that sends a bare local key is read the same way). */
  private recipientLocalKey(item: HubSyncInboxItem): string | undefined {
    return this.localKey(item.to) ?? (!item.to.startsWith("dev_") && item.to.includes(":") ? item.to : undefined);
  }

  /** These messages reached their agent: never hand them over again, and ack them to the hub. */
  markDelivered(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.delivered.has(id)) continue;
      this.delivered.add(id);
      const item = this.inbox.get(id)?.item;
      const to = item ? this.recipientLocalKey(item) : undefined;
      if (item && to !== undefined) {
        this.received.push({
          to: CoordClient.family(to),
          id,
          thread: item.thread,
          fromKey: item.from.sessionKey,
          fromName: item.from.sessionName,
          fromPerson: item.from.person,
          at: this.now(),
        });
        if (this.received.length > 500) this.received.splice(0, this.received.length - 500);
      }
      if (id.startsWith(LOCAL_ID_PREFIX)) this.local.delete(id);
      else this.ackQueue.add(id);
    }
    while (this.delivered.size > MAX_DELIVERED) {
      const first = this.delivered.values().next().value;
      if (first === undefined) break;
      this.delivered.delete(first);
    }
    void this.flushAcks();
  }

  /**
   * Whether a message this session sends answers one it got (SPEC §23, 0.11.x): in a thread a message to it opened or
   * carried, or to the session that wrote to it in the last 30 minutes. Such a reply wakes its recipient; an agent's
   * unsolicited message doesn't.
   */
  isReply(localKey: string, to: { session?: string; agent?: string; person?: string }, thread?: string, now = this.now()): boolean {
    const mine = CoordClient.family(localKey);
    // The target session's name, for a message whose sender named only its session.
    const targetName =
      to.session === undefined
        ? undefined
        : this.state?.roster.flatMap((p) => p.sessions).find((x) => CoordClient.family(x.hubKey) === CoordClient.family(to.session!))?.name;
    for (let i = this.received.length - 1; i >= 0; i--) {
      const r = this.received[i]!;
      if (r.to !== mine) continue;
      if (thread !== undefined && (r.id === thread || r.thread === thread)) return true;
      if (now - r.at > 30 * 60_000) continue;
      if (to.session !== undefined && r.fromKey !== undefined && CoordClient.family(r.fromKey) === CoordClient.family(to.session)) return true;
      if (to.session !== undefined && r.fromKey === undefined && targetName && r.fromName?.toLowerCase() === targetName.toLowerCase()) return true;
      if (to.agent !== undefined && r.fromName !== undefined && r.fromName.toLowerCase() === to.agent.toLowerCase()) return true;
      // An agent of that person wrote: the hub hands a person's message to their newest session.
      if (to.person !== undefined && r.fromKey !== undefined && r.fromPerson.toLowerCase() === to.person.toLowerCase()) return true;
    }
    return false;
  }

  // --- sync ---------------------------------------------------------------------

  /**
   * Syncs first when the last good sync is older than `maxAgeMs` (a person listing their handoffs or approvals while
   * no shared session is live, when the poller is on its slow cadence). Never throws.
   */
  async refreshed(maxAgeMs = 5000): Promise<void> {
    if (this.halted || this.available === false) return;
    if (this.fetchedAt !== undefined && this.now() - this.fetchedAt <= maxAgeMs) return;
    await this.sync();
  }

  /** One `GET /relay/sync`. Never throws. */
  sync(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.syncUnsafe()
      .catch((err: unknown) => {
        this.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private setAvailable(on: boolean): void {
    if (this.available === on) return;
    this.available = on;
    this.log(on ? "hub: coordination on (leases, holds, messages)" : "hub: no coordination on this hub yet (404); asking again in 10 min");
  }

  private failed(message: string): void {
    this.error = message;
    this.failures++;
  }

  private async syncUnsafe(): Promise<void> {
    if (this.halted) return;
    const started = this.now();
    this.lastAttemptAt = started;
    const q = this.cursor ? `?cursor=${encodeURIComponent(this.cursor)}` : "";
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/relay/sync${q}`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      this.failed(`hub unreachable: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (res.status === 404) {
      await res.text().catch(() => "");
      this.error = undefined;
      this.failures = 0;
      this.state = undefined;
      this.fetchedAt = undefined;
      this.holds.clear();
      this.setAvailable(false);
      return;
    }
    if (res.status === 401) {
      await res.text().catch(() => "");
      this.halted = true;
      this.error = "device token rejected (401)";
      this.holds.clear(); // nothing we can confirm any more: fail open
      return;
    }
    if (res.status === 429) {
      await res.text().catch(() => "");
      this.retryAt = this.now() + parseRetryAfter(res.headers.get("retry-after"), this.now());
      this.error = "hub asked to slow down (429)";
      return;
    }
    if (!res.ok) {
      await res.text().catch(() => "");
      this.failed(`hub responded ${res.status} to /relay/sync`);
      return;
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      this.failed("hub sent a sync that isn't JSON");
      return;
    }
    const parsed = hubSyncAcceptSchema.safeParse(raw);
    if (!parsed.success) {
      this.failed("hub sent a sync this relay can't read");
      return;
    }
    const now = this.now();
    this.apply(parsed.data, now, started);
  }

  /**
   * A sync without the inbox items whose id starts with the daemon's own notice prefix. Only this daemon writes such
   * ids (`notify`), and an item with one would be printed as Workmesh's own notice, so one from the hub is refused: it
   * is never stored, delivered or acked, and the daemon log names it once.
   */
  private withoutLocalIds(s: HubSyncAccepted): HubSyncAccepted {
    const inbox = s.inbox.filter((i) => !isLocalNotice(i.id));
    if (inbox.length === s.inbox.length) return s;
    for (const i of s.inbox) {
      if (!isLocalNotice(i.id) || this.refusedIds.has(i.id) || this.refusedIds.size >= MAX_REFUSED_LOGGED) continue;
      this.refusedIds.add(i.id);
      this.log(`hub: ignored an inbox item whose id is one of this daemon's own (${oneLine(i.id, 64)}, from ${label(i.from.person)})`);
    }
    return { ...s, inbox };
  }

  /** Takes in a good sync answer (exposed for tests). */
  apply(sync: HubSyncAccepted, now = this.now(), sentAt = now): void {
    const s = this.withoutLocalIds(sync);
    const previous = this.state;
    this.state = s;
    this.fetchedAt = now;
    this.error = undefined;
    this.failures = 0;
    this.retryAt = 0;
    if (s.cursor !== undefined) this.cursor = s.cursor;
    // The hub's clock at the midpoint of the request.
    if (s.serverNow !== undefined) this.skew = s.serverNow - Math.round((sentAt + now) / 2);
    const holds = new Map<string, { hold: HubSyncHold; seenAt: number }>();
    for (const h of s.holds) holds.set(h.sessionKey, { hold: h, seenAt: now });
    for (const [k, h] of holds) {
      if (!this.holds.has(k) && this.localKey(k) !== undefined) this.log(`hub: ${oneLine(k, 300)} held by ${label(h.hold.by)}`);
    }
    this.holds = holds;
    // The hub lists an item until it is acked: one it no longer lists that was delivered is done. One never delivered
    // stays a while (a hub that sends only what is new since the cursor lists each item once).
    const ids = new Set(s.inbox.map((i) => i.id));
    for (const [id, e] of [...this.inbox]) {
      if (ids.has(id)) continue;
      if (this.delivered.has(id) || now - e.seenAt > INBOX_KEEP_MS) this.inbox.delete(id);
    }
    for (const item of s.inbox) this.inbox.set(item.id, { item, seenAt: now });
    // A delivered item the hub still lists was never acked (or the ack was lost): ack it again.
    for (const item of s.inbox) if (this.delivered.has(item.id)) this.ackQueue.add(item.id);
    this.setAvailable(true);
    if (this.ackQueue.size > 0) void this.flushAcks();
    // v3 (SPEC §36): the accepted set moved: fetch the brief (throttled, in the background).
    const rev = s.memory?.rev;
    if (rev !== undefined && this.memoryOffUntil <= now && rev !== this.memBrief?.rev && rev !== this.memBrief?.forRev) {
      void this.fetchBrief(rev);
    }
    if (this.onSync) {
      try {
        this.onSync(s, previous);
      } catch (err) {
        this.log(`hub: delegate check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private flushAcks(): Promise<void> {
    if (this.acking) return this.acking;
    if (this.ackQueue.size === 0 || this.halted || this.available === false) return Promise.resolve();
    this.acking = (async () => {
      while (this.ackQueue.size > 0) {
        const ids = [...this.ackQueue].slice(0, 200);
        const r = await this.post("/relay/inbox/ack", hubInboxAckRequestSchema, { ids }, null);
        if (!r.ok) return; // retried after the next sync
        for (const id of ids) this.ackQueue.delete(id);
      }
    })()
      .catch(() => {})
      .finally(() => {
        this.acking = undefined;
      });
    return this.acking;
  }

  // --- v3 Memory: the brief (SPEC §36) ----------------------------------------------

  /**
   * `GET /relay/memories` for the sync `rev` that moved: at most every `briefMinMs`, backing off after errors (10 s
   * doubling to 5 min, a 429's `Retry-After`). A 404 turns memory off for 10 minutes (v1 and v2 carry on). Never throws.
   */
  private fetchBrief(forRev: string): Promise<void> {
    if (this.briefInFlight) return this.briefInFlight;
    const now = this.now();
    if (this.halted || now - this.briefAttemptAt < this.briefMinMs || this.briefRetryAt > now) return Promise.resolve();
    this.briefAttemptAt = now;
    this.briefSentAt = now;
    this.briefInFlight = this.fetchBriefUnsafe(forRev)
      .catch((err: unknown) => this.briefFailed(`brief: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.briefInFlight = undefined;
      });
    return this.briefInFlight;
  }

  private briefFailed(message: string): void {
    this.briefFailures++;
    this.briefRetryAt = this.now() + Math.min(this.maxBackoffMs, 10_000 * 2 ** Math.min(this.briefFailures - 1, 10));
    this.log(`hub: memory ${message}`);
  }

  private memoryOff(): void {
    if (this.memoryOffUntil <= this.now()) this.log("hub: no memory on this hub yet (404); asking again in 10 min");
    this.memoryOffUntil = this.now() + this.absentRetryMs;
    this.memBrief = undefined;
  }

  private async fetchBriefUnsafe(forRev: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/relay/memories`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      this.briefFailed(`unreachable: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const text = await res.text().catch(() => "");
    if (res.status === 404) {
      this.memoryOff();
      return;
    }
    if (res.status === 401) {
      this.halted = true;
      this.error = "device token rejected (401)";
      this.holds.clear();
      return;
    }
    if (res.status === 429) {
      this.briefRetryAt = this.now() + parseRetryAfter(res.headers.get("retry-after"), this.now());
      return;
    }
    if (!res.ok) {
      this.briefFailed(`brief: hub responded ${res.status}`);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      this.briefFailed("brief isn't JSON");
      return;
    }
    const parsed = hubMemoryBriefResponseAcceptSchema.safeParse(raw);
    if (!parsed.success) {
      this.briefFailed("brief this relay can't read");
      return;
    }
    this.briefFailures = 0;
    this.briefRetryAt = 0;
    // Writes the hub answered after this brief was asked for aren't in it: keep them on top; the rest it carries.
    const sentAt = this.briefSentAt;
    this.memWrites = this.memWrites.filter((w) => w.at >= sentAt);
    let memories = [...parsed.data.memories];
    for (const w of this.memWrites) memories = w.apply(memories);
    memories.sort((a, b) => b.updatedAt - a.updatedAt);
    this.memBrief = { rev: parsed.data.rev, forRev, memories, fetchedAt: this.now() };
  }

  /**
   * A memory the hub just answered for (remember, forget), applied to the cached brief: accepted → in it (in place of
   * the one it supersedes); retired, superseded or rejected → out of it; proposed → no change (the brief holds only
   * accepted memories). The brief's `rev` is left as it was, so the sync that follows still fetches the hub's own.
   */
  private applyMemoryWrite(m: HubMemoryAccepted): void {
    const item: MemoryBriefItem = {
      id: m.id,
      kind: m.kind,
      title: m.title,
      body: m.body.slice(0, HUB_MEMORY_BRIEF_BODY_MAX),
      scope: m.scope,
      issues: m.links?.issues,
      tags: m.tags,
      by: { person: m.by.person },
      updatedAt: m.updatedAt,
    };
    const apply = (list: MemoryBriefItem[]): MemoryBriefItem[] => {
      if (m.status === "proposed") return list;
      const rest = list.filter((x) => x.id !== m.id && !(m.status === "accepted" && m.supersedes !== undefined && x.id === m.supersedes));
      return m.status === "accepted" ? [item, ...rest] : rest;
    };
    if (m.status === "proposed") return;
    this.memWrites.push({ at: this.now(), apply });
    if (this.memWrites.length > 200) this.memWrites.splice(0, this.memWrites.length - 200);
    if (this.memBrief) {
      const memories = apply(this.memBrief.memories).sort((a, b) => b.updatedAt - a.updatedAt);
      this.memBrief = { ...this.memBrief, memories };
    }
  }

  // --- hub calls (from the MCP server and CLI, through the daemon) ----------------

  private async post<Req, Res>(
    pathname: string,
    reqSchema: z.ZodType<Req>,
    body: unknown,
    resSchema: z.ZodType<Res> | null,
    /**
     * A v2 or v3 endpoint: a 404 means this hub has no v2 (or no memory), remembered for a while, not that it has no
     * coordination.
     */
    family?: "v2" | "memory",
  ): Promise<CoordResult<Res>> {
    if (this.halted) return { ok: false, error: "the hub rejected this device's token: run `workmesh hub connect` again" };
    if (this.available === false) {
      return { ok: false, unavailable: true, error: "this hub has no coordination yet (it predates Workmesh v1)" };
    }
    const v2 = family === "v2";
    if (v2 && (this.v2Absent.get(pathname) ?? 0) > this.now()) {
      return { ok: false, status: 404, unavailable: true, error: "this hub has no delegation yet (it predates Workmesh v2)" };
    }
    if (family === "memory" && this.memoryOffUntil > this.now()) {
      return { ok: false, status: 404, unavailable: true, error: NO_MEMORY };
    }
    const req = reqSchema.safeParse(body);
    if (!req.success) {
      return { ok: false, error: req.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") };
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}${pathname}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(req.data),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return { ok: false, error: `hub unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
    let raw: unknown;
    const text = await res.text().catch(() => "");
    try {
      raw = text ? (JSON.parse(text) as unknown) : {};
    } catch {
      raw = undefined;
    }
    if (res.status === 404 && v2 && (raw === undefined || (raw as { ok?: unknown }).ok === undefined)) {
      this.v2Absent.set(pathname, this.now() + this.absentRetryMs);
      return { ok: false, status: 404, unavailable: true, error: "this hub has no delegation yet (it predates Workmesh v2)" };
    }
    if (res.status === 404 && family === "memory" && (raw === undefined || (raw as { ok?: unknown }).ok === undefined)) {
      this.memoryOff();
      return { ok: false, status: 404, unavailable: true, error: NO_MEMORY };
    }
    if (res.status === 404 && (raw === undefined || (raw as { ok?: unknown }).ok === undefined)) {
      this.setAvailable(false);
      return { ok: false, status: 404, unavailable: true, error: "this hub has no coordination yet (it predates Workmesh v1)" };
    }
    if (res.status === 401) {
      this.halted = true;
      this.holds.clear();
      return { ok: false, status: 401, error: "the hub rejected this device's token: run `workmesh hub connect` again" };
    }
    if (res.status === 429) return { ok: false, status: 429, error: "the hub asked to slow down; try again in a minute" };
    if (resSchema === null) {
      return res.ok ? { ok: true, status: res.status, body: undefined as Res } : { ok: false, status: res.status, error: `hub responded ${res.status}` };
    }
    const parsed = resSchema.safeParse(raw);
    if (parsed.success) {
      // A change the next hook should see: sync soon.
      this.poke();
      return { ok: true, status: res.status, body: parsed.data };
    }
    const msg = (raw as { error?: unknown } | undefined)?.error;
    return { ok: false, status: res.status, error: typeof msg === "string" && msg ? msg.slice(0, 300) : `hub responded ${res.status}` };
  }

  async lease(req: HubLeaseRequest): Promise<CoordResult<HubLeaseResponseAccepted>> {
    const r = await this.post("/relay/leases", hubLeaseRequestSchema, req, hubLeaseResponseAcceptSchema);
    // The next `leases` (and the next hook) sees the write at once, not after the sync that follows it.
    if (r.ok && r.body.ok && this.state) {
      const st = this.state;
      if (req.action === "acquire" && r.body.lease) {
        const lease = r.body.lease;
        this.state = { ...st, leases: [...st.leases.filter((l) => l.id !== lease.id), lease] };
      } else if (req.action === "release") {
        const holder = this.hubKey(CoordClient.family(req.sessionKey));
        this.state = {
          ...st,
          leases: st.leases.filter(
            (l) =>
              !(
                CoordClient.family(l.holder.sessionKey) === holder &&
                l.repo === req.repo &&
                (req.leaseId ? l.id === req.leaseId : req.paths.length === 0 || l.paths.some((p) => req.paths.includes(p)))
              ),
          ),
        };
      } else if (req.action === "renew" && r.body.lease) {
        const lease = r.body.lease;
        this.state = { ...st, leases: st.leases.map((l) => (l.id === lease.id ? lease : l)) };
      }
    }
    return r;
  }

  async claim(req: HubClaimRequest): Promise<CoordResult<HubClaimResponseAccepted>> {
    const r = await this.post("/relay/claims", hubClaimRequestSchema, req, hubClaimResponseAcceptSchema);
    if (r.ok && r.body.ok && this.state) {
      const st = this.state;
      const others = st.claims.filter((c) => c.issue.toUpperCase() !== req.issue.toUpperCase());
      if (req.action === "claim") {
        const claim = r.body.claim ?? {
          issue: req.issue,
          holder: { person: this.me() ?? "me", sessionKey: this.hubKey(CoordClient.family(req.sessionKey)), sessionName: undefined },
          since: this.hubNow(),
          note: req.note,
        };
        this.state = { ...st, claims: [...others, claim] };
      } else {
        this.state = { ...st, claims: others };
      }
    }
    return r;
  }

  message(req: HubMessageRequest): Promise<CoordResult<z.infer<typeof hubIdResponseAcceptSchema>>> {
    return this.post("/relay/messages", hubMessageRequestSchema, req, hubIdResponseAcceptSchema);
  }

  note(req: HubNoteRequest): Promise<CoordResult<z.infer<typeof hubIdResponseAcceptSchema>>> {
    return this.post("/relay/notes", hubNoteRequestSchema, req, hubIdResponseAcceptSchema);
  }

  // --- v2 Delegate (SPEC §30) ------------------------------------------------------

  handoff(req: HubHandoffRequest): Promise<CoordResult<HubHandoffResponseAccepted>> {
    return this.post("/relay/handoffs", hubHandoffRequestSchema, req, hubHandoffResponseAcceptSchema, "v2");
  }

  approval(req: HubApprovalRequest): Promise<CoordResult<HubApprovalResponseAccepted>> {
    return this.post("/relay/approvals", hubApprovalRequestSchema, req, hubApprovalResponseAcceptSchema, "v2");
  }

  async setGates(req: HubGatesRequest): Promise<CoordResult<HubGatesResponseAccepted>> {
    const r = await this.post("/relay/gates", hubGatesRequestSchema, req, hubGatesResponseAcceptSchema, "v2");
    // 0.12.1: `gates` (and the gate in the hook path) see the new policy at once, not after the next sync.
    const st = this.state;
    if (r.ok && r.body.ok && st?.gates !== undefined) {
      const owner = r.body.gates?.owner ?? this.me();
      if (owner !== undefined) {
        const was = st.gates.find((g) => g.owner.toLowerCase() === owner.toLowerCase());
        const policy = r.body.gates ?? { owner, actions: req.actions, approvers: was?.approvers };
        this.state = { ...st, gates: [...st.gates.filter((g) => g !== was), policy] };
      }
    }
    return r;
  }

  // --- v3 Memory (SPEC §35) ----------------------------------------------------------

  /** `POST /relay/memories`: remember, forget, used. A 404 without an answer turns memory off for 10 minutes. */
  async memory(req: HubMemoryRequest): Promise<CoordResult<HubMemoryResponseAccepted>> {
    const r = await this.post("/relay/memories", hubMemoryRequestSchema, req, hubMemoryResponseAcceptSchema, "memory");
    if (r.ok && r.body.ok && r.body.memory && req.action !== "used") this.applyMemoryWrite(r.body.memory);
    return r;
  }

  /** `POST /relay/recall`: the team's accepted memories that match, best first. */
  recall(req: HubRecallRequest): Promise<CoordResult<HubRecallResponseAccepted>> {
    return this.post("/relay/recall", hubRecallRequestSchema, req, hubRecallResponseAcceptSchema, "memory");
  }

  /** Session start put these memories in a session's context (SPEC §36): reported in the background, failures dropped. */
  async memoryUsed(sessionKey: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0 || !this.memoryAvailable()) return;
    try {
      await this.memory({ action: "used", sessionKey, ids: [...new Set(ids)].slice(0, 50), how: "start" });
    } catch {
      // dropped: a use count is not worth a retry
    }
  }

  // --- Ask (SPEC §29) --------------------------------------------------------------

  /**
   * `POST /relay/ask`: one question, answered whole. One at a time per asker; the hub's no (404 or 503: no Ask on this
   * hub; 429: its rate limit or daily cap, with `Retry-After`) is remembered, so a retrying agent doesn't hammer it.
   */
  async ask(req: HubAskRequest, asker = "person", timeoutMs = ASK_TIMEOUT_MS): Promise<CoordResult<HubAskResponseAccepted>> {
    if (this.halted) return { ok: false, status: 401, error: "the hub rejected this device's token: run `workmesh hub connect` again" };
    if (this.available === false) {
      return { ok: false, unavailable: true, error: "this hub has no coordination yet (it predates Workmesh v1)" };
    }
    const now = this.now();
    const blocked = this.askBlocked;
    if (blocked && blocked.until > now) {
      return {
        ok: false,
        status: blocked.status,
        error: blocked.error,
        ...(blocked.status === 404 || blocked.status === 503 ? { unavailable: true } : {}),
        retryAfterMs: blocked.until - now,
      };
    }
    if (this.asking.has(asker)) return { ok: false, status: 409, error: "your last question is still being answered" };
    const parsed = hubAskRequestSchema.safeParse(req);
    if (!parsed.success) {
      return { ok: false, status: 400, error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") };
    }
    this.asking.add(asker);
    let res: Response;
    let raw: unknown;
    try {
      res = await this.fetchImpl(`${this.url}/relay/ask`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text().catch(() => "");
      try {
        raw = text ? (JSON.parse(text) as unknown) : {};
      } catch {
        raw = undefined;
      }
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return { ok: false, error: timedOut ? "the hub took too long to answer" : `hub unreachable: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      this.asking.delete(asker);
    }
    const said = (raw as { error?: unknown } | undefined)?.error;
    const hubSaid = typeof said === "string" && said ? said.slice(0, 300) : undefined;
    const block = (status: number, ms: number, error: string): CoordResult<HubAskResponseAccepted> => {
      this.askBlocked = { until: this.now() + ms, status, error };
      return { ok: false, status, error, ...(status === 404 || status === 503 ? { unavailable: true } : {}), retryAfterMs: ms };
    };
    switch (res.status) {
      case 401:
        this.halted = true;
        this.holds.clear();
        return { ok: false, status: 401, error: "the hub rejected this device's token: run `workmesh hub connect` again" };
      case 404:
        return block(404, ASK_ABSENT_MS, "this team's hub has no Ask yet");
      case 503:
        return block(503, ASK_ABSENT_MS, hubSaid ?? "Ask isn't set up on this team's hub");
      case 429:
        return block(429, askRetryAfter(res.headers.get("retry-after")), hubSaid ?? "the hub asked to slow down");
      default:
        break;
    }
    if (res.ok) {
      const body = hubAskResponseAcceptSchema.safeParse(raw);
      if (body.success) return { ok: true, status: res.status, body: body.data };
      return { ok: false, status: res.status, error: "the hub sent an answer this relay can't read" };
    }
    if (res.status === 502) return { ok: false, status: 502, error: hubSaid ? `the hub's model failed (${hubSaid})` : "the hub's model failed to answer" };
    return { ok: false, status: res.status, error: hubSaid ?? `hub responded ${res.status}` };
  }
}

/** A `Retry-After` in seconds (or an HTTP date) → ms, between 5 s and an hour; absent, a minute. */
export function askRetryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 60_000;
  const secs = Number(value);
  let ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(ms)) ms = 60_000;
  return Math.min(Math.max(ms, 5000), 60 * 60_000);
}

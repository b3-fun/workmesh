import {
  HUB_RECENT_EDIT_MS,
  hubApprovalRequestSchema,
  hubApprovalResponseAcceptSchema,
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
  hubMessageRequestSchema,
  hubNoteRequestSchema,
  hubSyncAcceptSchema,
  isLeaseGlob,
  leaseEntriesCovering,
  leasePathsOverlap,
} from "@workmesh/protocol";
import type {
  HubApprovalRequest,
  HubApprovalResponseAccepted,
  HubGatesRequest,
  HubGatesResponseAccepted,
  HubHandoffRequest,
  HubHandoffResponseAccepted,
  HubClaimRequest,
  HubClaimResponseAccepted,
  HubLeaseAccepted,
  HubLeaseRequest,
  HubLeaseResponseAccepted,
  HubMessageRequest,
  HubNoteRequest,
  HubSyncAccepted,
} from "@workmesh/protocol";
import type { z } from "zod";
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
}

/** What a hub call answered: the parsed body, or why there is none. */
export type CoordResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status?: number; error: string; unavailable?: boolean };

const MAX_DELIVERED = 2000;
/** Ids of notices the daemon writes itself (an approval decided, a handoff finished): never acked to the hub. */
const LOCAL_ID_PREFIX = "wm_";
const MAX_LOCAL = 500;
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
  private readonly onSync: CoordClientOptions["onSync"];
  /** v2 endpoints this hub answered 404 to, and until when that is remembered. */
  private readonly v2Absent = new Map<string, number>();

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

  /** Messages for this session (exactly its key) not yet handed to it, oldest first (the daemon's own notices too). */
  pendingFor(localKey: string): HubSyncInboxItem[] {
    const out: HubSyncInboxItem[] = [];
    for (const { item } of this.inbox.values()) {
      if (this.delivered.has(item.id)) continue;
      if (this.recipientLocalKey(item) === localKey) out.push(item);
    }
    for (const item of this.local.values()) {
      if (!this.delivered.has(item.id) && item.to === localKey) out.push(item);
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  /**
   * v2 (SPEC §31): whether a message should wake an idle session: the hub's `wake` when it set one, else yes for a
   * message a person wrote (no sending session) and no for one an agent sent.
   */
  static wakes(item: HubSyncInboxItem): boolean {
    return item.wake ?? item.from.sessionKey === undefined;
  }

  /** Waiting messages that should wake this session if it is idle, oldest first. */
  wakeFor(localKey: string): HubSyncInboxItem[] {
    return this.pendingFor(localKey).filter((i) => CoordClient.wakes(i));
  }

  /** The local sessions (and subagents) with any undelivered message, for the daemon's wake check. */
  sessionsWithPending(): Set<string> {
    const out = new Set<string>();
    for (const { item } of this.inbox.values()) {
      if (this.delivered.has(item.id)) continue;
      const k = this.recipientLocalKey(item);
      if (k !== undefined) out.add(k);
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
      text: text.slice(0, 4000),
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

  /** Every message waiting for this device's sessions, delivered or not (the CLI's and menu bar's view). */
  inboxItems(): Array<HubSyncInboxItem & { delivered: boolean; localKey: string }> {
    const out: Array<HubSyncInboxItem & { delivered: boolean; localKey: string }> = [];
    for (const { item } of this.inbox.values()) {
      const localKey = this.recipientLocalKey(item);
      if (localKey !== undefined) out.push({ ...item, delivered: this.delivered.has(item.id), localKey });
    }
    return out.sort((a, b) => a.ts - b.ts);
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

  // --- sync ---------------------------------------------------------------------

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

  /** Takes in a good sync answer (exposed for tests). */
  apply(s: HubSyncAccepted, now = this.now(), sentAt = now): void {
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
      if (!this.holds.has(k) && this.localKey(k) !== undefined) this.log(`hub: ${k} held by ${h.hold.by}`);
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

  // --- hub calls (from the MCP server and CLI, through the daemon) ----------------

  private async post<Req, Res>(
    pathname: string,
    reqSchema: z.ZodType<Req>,
    body: unknown,
    resSchema: z.ZodType<Res> | null,
    /** A v2 endpoint: a 404 means this hub has no v2 (remembered for a while), not that it has no coordination. */
    v2 = false,
  ): Promise<CoordResult<Res>> {
    if (this.halted) return { ok: false, error: "the hub rejected this device's token: run `workmesh hub connect` again" };
    if (this.available === false) {
      return { ok: false, unavailable: true, error: "this hub has no coordination yet (it predates Workmesh v1)" };
    }
    if (v2 && (this.v2Absent.get(pathname) ?? 0) > this.now()) {
      return { ok: false, status: 404, unavailable: true, error: "this hub has no delegation yet (it predates Workmesh v2)" };
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

  lease(req: HubLeaseRequest): Promise<CoordResult<HubLeaseResponseAccepted>> {
    return this.post("/relay/leases", hubLeaseRequestSchema, req, hubLeaseResponseAcceptSchema);
  }

  claim(req: HubClaimRequest): Promise<CoordResult<HubClaimResponseAccepted>> {
    return this.post("/relay/claims", hubClaimRequestSchema, req, hubClaimResponseAcceptSchema);
  }

  message(req: HubMessageRequest): Promise<CoordResult<z.infer<typeof hubIdResponseAcceptSchema>>> {
    return this.post("/relay/messages", hubMessageRequestSchema, req, hubIdResponseAcceptSchema);
  }

  note(req: HubNoteRequest): Promise<CoordResult<z.infer<typeof hubIdResponseAcceptSchema>>> {
    return this.post("/relay/notes", hubNoteRequestSchema, req, hubIdResponseAcceptSchema);
  }

  // --- v2 Delegate (SPEC §30) ------------------------------------------------------

  handoff(req: HubHandoffRequest): Promise<CoordResult<HubHandoffResponseAccepted>> {
    return this.post("/relay/handoffs", hubHandoffRequestSchema, req, hubHandoffResponseAcceptSchema, true);
  }

  approval(req: HubApprovalRequest): Promise<CoordResult<HubApprovalResponseAccepted>> {
    return this.post("/relay/approvals", hubApprovalRequestSchema, req, hubApprovalResponseAcceptSchema, true);
  }

  setGates(req: HubGatesRequest): Promise<CoordResult<HubGatesResponseAccepted>> {
    return this.post("/relay/gates", hubGatesRequestSchema, req, hubGatesResponseAcceptSchema, true);
  }
}

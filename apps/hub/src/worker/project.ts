import { DurableObject } from "cloudflare:workers";
import type {
  HubIngestAccepted,
  HubIngestResponse,
  HubPairPollResponse,
  HubPairStartResponse,
  HubSessionUpsertAccepted,
} from "@workmesh/protocol";
import {
  BOARD_WINDOW_MS,
  EVENT_RETENTION_MS,
  PAIRING_TTL_SEC,
  PROJECT,
  displayName,
  type BoardState,
  type Device,
  type Digest,
  type EventKind,
  type HubEvent,
  type PairInfo,
  type Person,
  type Session,
  type SessionState,
  type ShareLevel,
  type StreamMessage,
} from "../shared/types";
import { deviceToken, pairingCode, randomHex, sha256Hex, ulid } from "./crypto";
import { conversationFields } from "./ingest";
import { POLICY, capAllows, dailyCap, dueAt, mergeTrigger, utcDay, type Trigger } from "./summaries/policy";
import {
  digestRequest,
  parseDigestOutput,
  parseSessionOutput,
  sessionRequest,
  type DigestItem,
  type EventInfo,
} from "./summaries/prompts";
import { pickProvider, type CompletionRequest, type CompletionResult, type SummaryProvider } from "./summaries/provider";
import type { AiLike } from "./summaries/workers-ai";

/** What every RPC method returns; the Worker turns it into an HTTP response. */
export interface Result<T = unknown> {
  status: number;
  body: T;
  headers?: Record<string, string>;
}

type DeviceRow = {
  id: string;
  email: string;
  machine: string;
  client: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  share: string | null;
};

type PairingRow = {
  code: string;
  device_id: string;
  poll_secret_hash: string;
  machine: string;
  client: string;
  created_at: number;
  expires_at: number;
  approved_by: string | null;
  approved_at: number | null;
  delivered: number;
  share: string | null;
};

type SessionRow = {
  hub_key: string;
  device_id: string;
  email: string;
  source: string;
  key: string;
  name: string | null;
  state: string;
  activity: string | null;
  background: number;
  agents: number | null;
  phase: string | null;
  orchestrator: string | null;
  repo: string | null;
  branch: string | null;
  issues_json: string;
  started_at: number;
  updated_at: number;
  state_since: number;
  ended_at: number | null;
  last_event_at: number | null;
  seen_at: number;
  now_line: string | null;
  now_at: number | null;
  waiting_reason: string | null;
  /** Summary bookkeeping: last call, newest event ts it covered, state it was written for. */
  sum_at: number | null;
  sum_event_ts: number | null;
  sum_state: string | null;
};

type EventRow = {
  device_id: string;
  id: string;
  hub_key: string;
  email: string;
  ts: number;
  kind: string;
  tool: string | null;
  label: string | null;
  path: string | null;
  cmd: string | null;
  repo: string | null;
  branch: string | null;
  issues_json: string;
  pr: string | null;
  ok: number | null;
  received_at: number;
  text: string | null;
  truncated: number;
  descr: string | null;
  duration_ms: number | null;
  summary: string | null;
};

type JobRow = {
  hub_key: string;
  due_at: number;
  turn_id: string | null;
  turn_ts: number | null;
  waiting: number;
  attempts: number;
  created_at: number;
};

type UsageRow = {
  day: string;
  calls: number;
  failures: number;
  skipped: number;
  input_tokens: number;
  output_tokens: number;
  ms_total: number;
  cost_usd: number;
};

type ViewerRow = {
  email: string;
  last_seen_at: number;
  visit_started_at: number;
  digest_since: number | null;
  digest_json: string | null;
  digest_built_at: number | null;
};

const HOUR = 3600_000;
const PAIR_STARTS_PER_HOUR = 10;
const INGEST_WINDOW_MS = 60_000;
const INGEST_PER_WINDOW = 300;
/** Re-broadcast a device's last-seen at most this often. */
const DEVICE_BROADCAST_MS = 15_000;

/** Session fields that, when changed, are pushed to boards. */
const SESSION_FIELDS = [
  "source",
  "name",
  "state",
  "activity",
  "background",
  "agents",
  "phase",
  "orchestrator",
  "repo",
  "branch",
  "issues_json",
  "started_at",
  "updated_at",
  "state_since",
  "ended_at",
] as const;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS people (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  machine TEXT NOT NULL,
  client TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS devices_email ON devices(email);
CREATE TABLE IF NOT EXISTS pairings (
  code TEXT PRIMARY KEY,
  device_id TEXT NOT NULL UNIQUE,
  poll_secret_hash TEXT NOT NULL,
  machine TEXT NOT NULL,
  client TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  delivered INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pair_starts (
  ip_hash TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pair_starts_ip ON pair_starts(ip_hash, ts);
CREATE TABLE IF NOT EXISTS sessions (
  hub_key TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  email TEXT NOT NULL,
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT,
  state TEXT NOT NULL,
  activity TEXT,
  background INTEGER NOT NULL DEFAULT 0,
  agents INTEGER,
  phase TEXT,
  orchestrator TEXT,
  repo TEXT,
  branch TEXT,
  issues_json TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  state_since INTEGER NOT NULL,
  ended_at INTEGER,
  last_event_at INTEGER,
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_device ON sessions(device_id);
CREATE INDEX IF NOT EXISTS sessions_seen ON sessions(seen_at);
CREATE TABLE IF NOT EXISTS events (
  device_id TEXT NOT NULL,
  id TEXT NOT NULL,
  hub_key TEXT NOT NULL,
  email TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT,
  label TEXT,
  path TEXT,
  cmd TEXT,
  repo TEXT,
  branch TEXT,
  issues_json TEXT NOT NULL DEFAULT '[]',
  pr TEXT,
  ok INTEGER,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, id)
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_session ON events(hub_key, ts);
`;

/** v0.2: sharing levels, conversation text, summaries (SPEC.md §8–11). Additive only, so v0 rows stay valid. */
const SCHEMA_V2 = `
ALTER TABLE devices ADD COLUMN share TEXT;
ALTER TABLE pairings ADD COLUMN share TEXT;
ALTER TABLE events ADD COLUMN text TEXT;
ALTER TABLE events ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN descr TEXT;
ALTER TABLE events ADD COLUMN duration_ms INTEGER;
ALTER TABLE events ADD COLUMN summary TEXT;
ALTER TABLE sessions ADD COLUMN now_line TEXT;
ALTER TABLE sessions ADD COLUMN now_at INTEGER;
ALTER TABLE sessions ADD COLUMN waiting_reason TEXT;
ALTER TABLE sessions ADD COLUMN sum_at INTEGER;
ALTER TABLE sessions ADD COLUMN sum_event_ts INTEGER;
ALTER TABLE sessions ADD COLUMN sum_state TEXT;
CREATE INDEX IF NOT EXISTS events_turns ON events(kind, ts);
CREATE TABLE IF NOT EXISTS summary_jobs (
  hub_key TEXT PRIMARY KEY,
  due_at INTEGER NOT NULL,
  turn_id TEXT,
  turn_ts INTEGER,
  waiting INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS summary_jobs_due ON summary_jobs(due_at);
CREATE TABLE IF NOT EXISTS summary_usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  ms_total INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS viewers (
  email TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL,
  visit_started_at INTEGER NOT NULL,
  digest_since INTEGER,
  digest_json TEXT,
  digest_built_at INTEGER
);
`;

const DIGEST_PREFIX = "digest:";

function toDevice(r: DeviceRow): Device {
  return {
    id: r.id,
    email: r.email,
    machine: r.machine,
    client: r.client,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    revokedAt: r.revoked_at,
    share: asShare(r.share),
  };
}

function asShare(v: string | null | undefined): ShareLevel | null {
  return v === "conversation" || v === "metadata" ? v : null;
}

function parseIssues(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toSession(r: SessionRow): Session {
  return {
    hubKey: r.hub_key,
    deviceId: r.device_id,
    email: r.email,
    source: r.source,
    key: r.key,
    name: r.name,
    state: r.state as SessionState,
    activity: r.activity,
    background: r.background === 1,
    agents: r.agents,
    phase: r.phase,
    orchestrator: r.orchestrator,
    repo: r.repo,
    branch: r.branch,
    issues: parseIssues(r.issues_json),
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    stateSince: r.state_since,
    endedAt: r.ended_at,
    lastEventAt: r.last_event_at,
    seenAt: r.seen_at,
    nowLine: r.now_line,
    nowAt: r.now_at,
    waitingReason: r.waiting_reason,
  };
}

function toEvent(r: EventRow): HubEvent {
  return {
    deviceId: r.device_id,
    id: r.id,
    hubKey: r.hub_key,
    email: r.email,
    ts: r.ts,
    kind: r.kind as EventKind,
    tool: r.tool,
    label: r.label,
    path: r.path,
    cmd: r.cmd,
    repo: r.repo,
    branch: r.branch,
    issues: parseIssues(r.issues_json),
    pr: r.pr,
    ok: r.ok == null ? null : r.ok === 1,
    text: r.text,
    truncated: r.truncated === 1,
    desc: r.descr,
    durationMs: r.duration_ms,
    summary: r.summary,
  };
}

function toEventInfo(r: EventRow): EventInfo {
  return {
    ts: r.ts,
    kind: r.kind,
    tool: r.tool,
    label: r.label,
    path: r.path,
    cmd: r.cmd,
    desc: r.descr,
    text: r.text,
    ok: r.ok == null ? null : r.ok === 1,
    pr: r.pr,
    durationMs: r.duration_ms,
  };
}

export class Project extends DurableObject<Env> {
  private sql: SqlStorage;
  private ingestCounts = new Map<string, { start: number; count: number }>();
  /** undefined: choose from env. Tests set a fake (or null) here. */
  private providerOverride: SummaryProvider | null | undefined;
  private providerFromEnv: SummaryProvider | null | undefined;
  /** Test hook: jobs run only when runSummaries is called, never from a real alarm. */
  private manualSummaries = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      if (this.meta("next_prune_at") == null) this.setMeta("next_prune_at", Date.now() + HOUR);
      if ((await ctx.storage.getAlarm()) == null) await ctx.storage.setAlarm(this.nextAlarmAt());
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    const row = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'schema'").toArray()[0];
    const version = row ? Number(row.v) : 0;
    if (version < 1) {
      this.sql.exec(SCHEMA_V1);
      this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', '1')");
    }
    if (version < 2) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(SCHEMA_V2);
        this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', '2')");
      });
    }
  }

  private meta(k: string): string | null {
    return this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null;
  }

  private setMeta(k: string, v: string | number): void {
    this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", k, String(v));
  }

  // ---------------------------------------------------------------- pairing

  async pairStart(input: {
    ipHash: string;
    machine: string;
    client: string;
    origin: string;
    share?: ShareLevel | null;
  }): Promise<Result> {
    const pollSecret = randomHex(16);
    const pollSecretHash = await sha256Hex(pollSecret);
    const now = Date.now();
    const recent = this.sql
      .exec<{ ts: number }>(
        "SELECT ts FROM pair_starts WHERE ip_hash = ? AND ts > ? ORDER BY ts ASC",
        input.ipHash,
        now - HOUR,
      )
      .toArray();
    if (recent.length >= PAIR_STARTS_PER_HOUR) {
      const retryAfter = Math.max(1, Math.ceil((recent[0]!.ts + HOUR - now) / 1000));
      return {
        status: 429,
        body: { error: "too many pairing attempts; try again later" },
        headers: { "Retry-After": String(retryAfter) },
      };
    }
    this.sql.exec("INSERT INTO pair_starts (ip_hash, ts) VALUES (?, ?)", input.ipHash, now);

    let code = pairingCode();
    while (this.sql.exec("SELECT 1 FROM pairings WHERE code = ?", code).toArray().length > 0) code = pairingCode();
    const deviceId = `dev_${ulid(now)}`;
    this.sql.exec(
      `INSERT INTO pairings (code, device_id, poll_secret_hash, machine, client, created_at, expires_at, share)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      code,
      deviceId,
      pollSecretHash,
      input.machine,
      input.client,
      now,
      now + PAIRING_TTL_SEC * 1000,
      input.share ?? null,
    );
    return {
      status: 200,
      body: {
        code,
        deviceId,
        pollSecret,
        verifyUrl: `${input.origin}/pair?code=${code}`,
        expiresInSec: PAIRING_TTL_SEC,
      } satisfies HubPairStartResponse,
    };
  }

  pairInfo(code: string): Result<PairInfo | { error: string }> {
    const p = this.pairing(code);
    if (!p) return { status: 404, body: { error: "unknown code" } };
    const now = Date.now();
    const status = p.approved_by ? "approved" : now > p.expires_at ? "expired" : "pending";
    return {
      status: 200,
      body: {
        code: p.code,
        machine: p.machine,
        client: p.client,
        share: asShare(p.share),
        status,
        expiresAt: p.expires_at,
        approvedBy: p.approved_by,
      },
    };
  }

  pairApprove(code: string, email: string): Result {
    const p = this.pairing(code);
    if (!p) return { status: 404, body: { error: "unknown code" } };
    if (p.approved_by) {
      if (p.approved_by === email) return { status: 200, body: { ok: true, machine: p.machine } };
      return { status: 409, body: { error: "already approved by someone else" } };
    }
    const now = Date.now();
    if (now > p.expires_at) return { status: 410, body: { error: "code expired" } };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE pairings SET approved_by = ?, approved_at = ? WHERE code = ?", email, now, p.code);
      this.sql.exec("INSERT OR IGNORE INTO people (email, name) VALUES (?, ?)", email, displayName(email));
    });
    return { status: 200, body: { ok: true, machine: p.machine } };
  }

  async pairPoll(deviceId: string, pollSecretHash: string): Promise<Result> {
    // Mint before reading so the read-check-write below runs without an await in between.
    const token = deviceToken();
    const tokenHash = await sha256Hex(token);
    const p = this.sql
      .exec<PairingRow>("SELECT * FROM pairings WHERE device_id = ?", deviceId)
      .toArray()[0];
    if (!p || p.poll_secret_hash !== pollSecretHash) return { status: 401, body: { error: "unknown pairing" } };
    const now = Date.now();
    if (!p.approved_by) {
      return { status: 200, body: { status: now > p.expires_at ? "expired" : "pending" } satisfies HubPairPollResponse };
    }
    const person = this.person(p.approved_by);
    const project = {
      id: PROJECT.id,
      name: PROJECT.name,
      include: PROJECT.include,
      issueKeys: PROJECT.issueKeys,
      defaultShare: PROJECT.defaultShare,
    };
    if (p.delivered) return { status: 200, body: { status: "complete", person, project } satisfies HubPairPollResponse };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO devices (id, email, machine, client, token_hash, created_at, share)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        p.device_id,
        p.approved_by,
        p.machine,
        p.client,
        tokenHash,
        now,
        p.share,
      );
      this.sql.exec("UPDATE pairings SET delivered = 1 WHERE code = ?", p.code);
    });
    const device = this.device(p.device_id);
    if (device) this.broadcast({ type: "device", device: toDevice(device) });
    return { status: 200, body: { status: "complete", deviceToken: token, person, project } satisfies HubPairPollResponse };
  }

  // ----------------------------------------------------------------- ingest

  async ingest(tokenHash: string, payload: HubIngestAccepted): Promise<Result> {
    const device = this.sql.exec<DeviceRow>("SELECT * FROM devices WHERE token_hash = ?", tokenHash).toArray()[0];
    if (!device || device.revoked_at != null) {
      return { status: 401, body: { error: "unknown or revoked device token; pair again" } };
    }
    const now = Date.now();
    const retryAfter = this.ingestLimited(device.id, now);
    if (retryAfter) {
      return { status: 429, body: { error: "too many requests" }, headers: { "Retry-After": String(retryAfter) } };
    }

    // Relays before v0.2 send no level: metadata (SPEC.md §8).
    const share: ShareLevel = payload.share ?? "metadata";
    const shareChanged = device.share !== share;
    const purge = device.share === "conversation" && share === "metadata";
    const changed = new Set<string>();
    const inserted: HubEvent[] = [];
    const triggers = new Map<string, Trigger>();
    const trigger = (hubKey: string, t: Trigger) => triggers.set(hubKey, mergeTrigger(triggers.get(hubKey), t));
    const deviceStale = shareChanged || device.last_seen_at == null || now - device.last_seen_at > DEVICE_BROADCAST_MS;

    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE devices SET last_seen_at = ?, share = ? WHERE id = ?", now, share, device.id);
      if (purge) this.purgeConversation(device.id);

      const present = new Set<string>();
      for (const s of payload.sessions) {
        const hubKey = `${device.id}:${s.key}`;
        present.add(hubKey);
        const r = this.upsertSession(device, hubKey, s, now);
        if (r.changed) changed.add(hubKey);
        if (r.prevState != null && r.prevState !== s.state) {
          trigger(hubKey, { stateChanged: true, waiting: s.state === "waiting" });
        } else if (r.prevState == null && s.state === "waiting") {
          trigger(hubKey, { waiting: true });
        }
      }
      if (payload.full) {
        const open = this.sql
          .exec<{ hub_key: string }>("SELECT hub_key FROM sessions WHERE device_id = ? AND state != 'ended'", device.id)
          .toArray();
        for (const { hub_key } of open) {
          if (present.has(hub_key)) continue;
          this.sql.exec(
            "UPDATE sessions SET state = 'ended', ended_at = ?, state_since = ?, seen_at = ? WHERE hub_key = ?",
            now,
            now,
            now,
            hub_key,
          );
          changed.add(hub_key);
        }
      }

      for (const e of payload.events) {
        const conv = conversationFields(e, share);
        // A message without its text says nothing (metadata devices never send text).
        if (e.kind === "message" && !conv.text) continue;
        const hubKey = `${device.id}:${e.key}`;
        const row = this.sql
          .exec<EventRow>(
            `INSERT OR IGNORE INTO events
               (device_id, id, hub_key, email, ts, kind, tool, label, path, cmd, repo, branch, issues_json, pr, ok,
                received_at, text, truncated, descr, duration_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING *`,
            device.id,
            e.id,
            hubKey,
            device.email,
            e.ts,
            e.kind,
            e.tool ?? null,
            e.label ?? null,
            e.path ?? null,
            e.cmd ?? null,
            e.repo ?? null,
            e.branch ?? null,
            JSON.stringify(e.issues ?? []),
            e.pr ?? null,
            e.ok == null ? null : e.ok ? 1 : 0,
            now,
            conv.text,
            conv.truncated ? 1 : 0,
            conv.desc,
            e.kind === "turn" ? (e.durationMs ?? null) : null,
          )
          .toArray()[0];
        if (!row) continue;
        inserted.push(toEvent(row));
        const bumped = this.sql
          .exec(
            `UPDATE sessions SET last_event_at = ?
             WHERE hub_key = ? AND (last_event_at IS NULL OR last_event_at < ?) RETURNING hub_key`,
            e.ts,
            hubKey,
            e.ts,
          )
          .toArray();
        if (bumped.length) changed.add(hubKey);
        // A resent backlog is stored but summarizes nothing (SPEC.md §11 guards).
        if (now - e.ts > POLICY.staleEventMs) continue;
        if (e.kind === "turn") trigger(hubKey, { turnId: e.id, turnTs: e.ts });
        else if (e.kind === "prompt" || e.kind === "message" || e.kind === "waiting") trigger(hubKey, { text: true });
        else if (e.kind === "tool") trigger(hubKey, { tools: true });
      }
    });

    if (purge) this.broadcast({ type: "purge", deviceId: device.id });
    if (deviceStale) {
      const fresh = this.device(device.id);
      if (fresh) this.broadcast({ type: "device", device: toDevice(fresh) });
    }
    for (const hubKey of changed) {
      const row = this.sql.exec<SessionRow>("SELECT * FROM sessions WHERE hub_key = ?", hubKey).toArray()[0];
      if (row) this.broadcast({ type: "session", session: toSession(row) });
    }
    if (inserted.length) this.broadcast({ type: "events", events: inserted });

    if (triggers.size && this.provider()) {
      this.enqueue(triggers, now);
      await this.armAlarm();
    }
    return { status: 200, body: { ok: true, accepted: inserted.length } satisfies HubIngestResponse };
  }

  /** A device went back to metadata: its text, and everything written from it, leaves the hub (SPEC.md §8). */
  private purgeConversation(deviceId: string): void {
    this.sql.exec("UPDATE events SET text = NULL, truncated = 0, descr = NULL, summary = NULL WHERE device_id = ?", deviceId);
    this.sql.exec(
      `UPDATE sessions SET now_line = NULL, now_at = NULL, waiting_reason = NULL, sum_at = NULL, sum_event_ts = NULL,
         sum_state = NULL WHERE device_id = ?`,
      deviceId,
    );
    this.sql.exec("UPDATE viewers SET digest_json = NULL");
  }

  /** `changed`: a board-visible field changed. `prevState`: the state before, or null for a new session. */
  private upsertSession(
    device: DeviceRow,
    hubKey: string,
    s: HubSessionUpsertAccepted,
    now: number,
  ): { changed: boolean; prevState: string | null } {
    const existing = this.sql.exec<SessionRow>("SELECT * FROM sessions WHERE hub_key = ?", hubKey).toArray()[0];
    const enteredWaiting = s.state === "waiting" && existing?.state !== "waiting";
    const next: SessionRow = {
      hub_key: hubKey,
      device_id: device.id,
      email: device.email, // owner always comes from the token, never the payload
      source: s.source,
      key: s.key,
      name: s.name ?? null,
      state: s.state,
      activity: s.activity ?? null,
      background: s.background ? 1 : 0,
      agents: s.agents ?? null,
      phase: s.phase ?? null,
      orchestrator: s.orchestrator ?? null,
      repo: s.repo ?? null,
      branch: s.branch ?? null,
      issues_json: JSON.stringify(s.issues ?? []),
      started_at: s.startedAt,
      updated_at: s.updatedAt,
      state_since: s.stateSince,
      ended_at: s.state === "ended" ? (existing?.ended_at ?? now) : null,
      last_event_at: existing?.last_event_at ?? null,
      seen_at: now,
      now_line: existing?.now_line ?? null,
      now_at: existing?.now_at ?? null,
      // A new wait gets a new reason; until it is written the board shows the activity label.
      waiting_reason: enteredWaiting ? null : (existing?.waiting_reason ?? null),
      sum_at: existing?.sum_at ?? null,
      sum_event_ts: existing?.sum_event_ts ?? null,
      sum_state: existing?.sum_state ?? null,
    };
    const prevState = existing?.state ?? null;
    if (existing && SESSION_FIELDS.every((f) => existing[f] === next[f])) {
      this.sql.exec("UPDATE sessions SET seen_at = ? WHERE hub_key = ?", now, hubKey);
      return { changed: false, prevState };
    }
    this.sql.exec(
      `INSERT INTO sessions (hub_key, device_id, email, source, key, name, state, activity, background, agents, phase,
         orchestrator, repo, branch, issues_json, started_at, updated_at, state_since, ended_at, last_event_at, seen_at,
         waiting_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hub_key) DO UPDATE SET
         source = excluded.source, name = excluded.name, state = excluded.state, activity = excluded.activity,
         background = excluded.background, agents = excluded.agents, phase = excluded.phase,
         orchestrator = excluded.orchestrator, repo = excluded.repo, branch = excluded.branch,
         issues_json = excluded.issues_json, started_at = excluded.started_at, updated_at = excluded.updated_at,
         state_since = excluded.state_since, ended_at = excluded.ended_at, seen_at = excluded.seen_at,
         waiting_reason = excluded.waiting_reason`,
      next.hub_key,
      next.device_id,
      next.email,
      next.source,
      next.key,
      next.name,
      next.state,
      next.activity,
      next.background,
      next.agents,
      next.phase,
      next.orchestrator,
      next.repo,
      next.branch,
      next.issues_json,
      next.started_at,
      next.updated_at,
      next.state_since,
      next.ended_at,
      next.last_event_at,
      next.seen_at,
      next.waiting_reason,
    );
    return { changed: true, prevState };
  }

  private ingestLimited(deviceId: string, now: number): number {
    const w = this.ingestCounts.get(deviceId);
    if (!w || now - w.start >= INGEST_WINDOW_MS) {
      this.ingestCounts.set(deviceId, { start: now, count: 1 });
      return 0;
    }
    w.count += 1;
    if (w.count <= INGEST_PER_WINDOW) return 0;
    return Math.max(1, Math.ceil((w.start + INGEST_WINDOW_MS - now) / 1000));
  }

  // ------------------------------------------------------------------ board

  async boardState(email: string): Promise<BoardState> {
    const now = Date.now();
    const digest = this.visit(email, now);
    await this.armAlarm();
    const since = now - BOARD_WINDOW_MS;
    const devices = this.sql
      .exec<DeviceRow>("SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at")
      .toArray()
      .map(toDevice);
    const sessions = this.sql
      .exec<SessionRow>(
        `SELECT s.* FROM sessions s JOIN devices d ON d.id = s.device_id
         WHERE d.revoked_at IS NULL AND s.seen_at > ? AND (s.state != 'ended' OR s.ended_at > ?)
         ORDER BY s.started_at`,
        since,
        since,
      )
      .toArray()
      .map(toSession);
    const events = this.sql
      .exec<EventRow>(
        `SELECT e.* FROM events e JOIN devices d ON d.id = e.device_id
         WHERE d.revoked_at IS NULL ORDER BY e.ts DESC, e.received_at DESC LIMIT 300`,
      )
      .toArray()
      .map(toEvent);
    const people = this.sql.exec<{ email: string; name: string }>("SELECT email, name FROM people ORDER BY email").toArray();
    return {
      project: { id: PROJECT.id, name: PROJECT.name },
      me: this.person(email),
      people,
      devices,
      sessions,
      events,
      serverNow: now,
      summarizer: this.provider()?.label ?? null,
      digest,
    };
  }

  sessionEvents(hubKey: string, before: number, limit: number): HubEvent[] {
    return this.sql
      .exec<EventRow>(
        "SELECT * FROM events WHERE hub_key = ? AND ts < ? ORDER BY ts DESC, received_at DESC LIMIT ?",
        hubKey,
        before,
        limit,
      )
      .toArray()
      .map(toEvent);
  }

  me(email: string): Person {
    return this.person(email);
  }

  myDevices(email: string): Device[] {
    return this.sql
      .exec<DeviceRow>("SELECT * FROM devices WHERE email = ? ORDER BY created_at DESC", email)
      .toArray()
      .map(toDevice);
  }

  revokeDevice(id: string, email: string): Result {
    const d = this.device(id);
    if (!d || d.email !== email) return { status: 404, body: { error: "no such device" } };
    if (d.revoked_at != null) return { status: 200, body: { ok: true } };
    const now = Date.now();
    let ended: SessionRow[] = [];
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE devices SET revoked_at = ? WHERE id = ?", now, id);
      ended = this.sql
        .exec<SessionRow>(
          `UPDATE sessions SET state = 'ended', ended_at = ?, state_since = ?
           WHERE device_id = ? AND state != 'ended' RETURNING *`,
          now,
          now,
          id,
        )
        .toArray();
    });
    const fresh = this.device(id);
    if (fresh) this.broadcast({ type: "device", device: toDevice(fresh) });
    for (const row of ended) this.broadcast({ type: "session", session: toSession(row) });
    return { status: 200, body: { ok: true } };
  }

  // ------------------------------------------------------------- websockets

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // The Worker sets this after Access; nothing outside the Worker reaches the Durable Object.
    const viewer = request.headers.get("x-workmesh-viewer")?.slice(0, 200);
    this.ctx.acceptWebSocket(server, viewer ? [viewer] : []);
    server.send(JSON.stringify({ type: "hello", serverNow: Date.now() } satisfies StreamMessage));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") ws.send("pong");
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    const viewer = this.ctx.getTags(ws)[0];
    if (viewer) this.sql.exec("UPDATE viewers SET last_seen_at = MAX(last_seen_at, ?) WHERE email = ?", Date.now(), viewer);
    try {
      ws.close(code, reason);
    } catch {
      // already closed, or a reserved close code
    }
  }

  private broadcast(msg: StreamMessage, viewer?: string): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(viewer)) {
      try {
        ws.send(data);
      } catch {
        // socket went away; the runtime cleans it up
      }
    }
  }

  // -------------------------------------------------------------- retention

  /** One alarm serves both the hourly prune and the summary queue. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    if (now >= Number(this.meta("next_prune_at") ?? 0)) {
      this.prune(now);
      this.setMeta("next_prune_at", now + HOUR);
    }
    try {
      if (!this.manualSummaries) await this.runSummaries(now);
    } catch (err) {
      console.error("summaries failed", err instanceof Error ? err.message : String(err));
    }
    await this.armAlarm(true);
  }

  private nextAlarmAt(): number {
    const prune = Number(this.meta("next_prune_at") ?? 0) || Date.now() + HOUR;
    if (this.manualSummaries) return prune;
    const job = this.sql.exec<{ d: number | null }>("SELECT MIN(due_at) AS d FROM summary_jobs").one().d;
    return job == null ? prune : Math.min(prune, job);
  }

  private async armAlarm(force = false): Promise<void> {
    const next = this.nextAlarmAt();
    const current = await this.ctx.storage.getAlarm();
    if (force || current == null || next < current) await this.ctx.storage.setAlarm(next);
  }

  /** Public so tests (and the alarm) can run it with a chosen clock. */
  prune(now: number): { events: number; sessions: number; pairings: number } {
    const cutoff = now - EVENT_RETENTION_MS;
    const events = this.sql
      .exec("DELETE FROM events WHERE ts < ? OR received_at < ? RETURNING id", cutoff, cutoff)
      .toArray().length;
    const sessions = this.sql.exec("DELETE FROM sessions WHERE seen_at < ? RETURNING hub_key", cutoff).toArray().length;
    const pairings = this.sql
      .exec("DELETE FROM pairings WHERE created_at < ? RETURNING code", now - 24 * HOUR)
      .toArray().length;
    this.sql.exec("DELETE FROM pair_starts WHERE ts < ?", now - HOUR);
    for (const [id, w] of this.ingestCounts) if (now - w.start >= INGEST_WINDOW_MS) this.ingestCounts.delete(id);
    return { events, sessions, pairings };
  }

  // -------------------------------------------------------------- summaries (SPEC.md §11)

  private provider(): SummaryProvider | null {
    if (this.providerOverride !== undefined) return this.providerOverride;
    if (this.providerFromEnv === undefined) {
      this.providerFromEnv = pickProvider({
        OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY,
        SUMMARY_MODEL: this.env.SUMMARY_MODEL,
        SUMMARY_MODEL_FALLBACK: this.env.SUMMARY_MODEL_FALLBACK,
        AI: this.env.AI as unknown as AiLike | undefined,
      });
    }
    return this.providerFromEnv;
  }

  /** Test hook: a fake provider, or null for summaries off; undefined goes back to env. */
  setSummaryProvider(p: SummaryProvider | null | undefined, opts: { manual?: boolean } = {}): void {
    this.providerOverride = p;
    this.manualSummaries = opts.manual ?? false;
  }

  private enqueue(triggers: Map<string, Trigger>, now: number): void {
    for (const [hubKey, t] of triggers) {
      const s = this.sql
        .exec<Pick<SessionRow, "state" | "sum_at">>("SELECT state, sum_at FROM sessions WHERE hub_key = ?", hubKey)
        .toArray()[0];
      // Ended sessions get no now line; a turn that ended with them still gets its summary.
      if (!s || (s.state === "ended" && !t.turnId)) continue;
      this.upsertJob(hubKey, dueAt(t, now, s.sum_at), t, 0, now);
    }
  }

  private upsertJob(hubKey: string, due: number, t: Trigger, attempts: number, now: number): void {
    this.sql.exec(
      `INSERT INTO summary_jobs (hub_key, due_at, turn_id, turn_ts, waiting, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hub_key) DO UPDATE SET
         due_at = MIN(due_at, excluded.due_at),
         turn_id = CASE WHEN excluded.turn_ts >= COALESCE(turn_ts, -1) THEN excluded.turn_id ELSE turn_id END,
         turn_ts = MAX(COALESCE(turn_ts, -1), COALESCE(excluded.turn_ts, -1)),
         waiting = MAX(waiting, excluded.waiting),
         attempts = MAX(attempts, excluded.attempts)`,
      hubKey,
      due,
      t.turnId ?? null,
      t.turnTs ?? null,
      t.waiting ? 1 : 0,
      attempts,
      now,
    );
  }

  /** Runs the jobs due at `now` (public so tests can pass a clock). Returns how many were taken. */
  async runSummaries(now = Date.now()): Promise<number> {
    const provider = this.provider();
    if (!provider) {
      this.sql.exec("DELETE FROM summary_jobs");
      return 0;
    }
    const jobs = this.sql
      .exec<JobRow>("SELECT * FROM summary_jobs WHERE due_at <= ? ORDER BY due_at LIMIT ?", now, POLICY.perAlarm)
      .toArray();
    if (!jobs.length) return 0;
    // Claim before the first await: a trigger arriving meanwhile queues a fresh job.
    for (const j of jobs) this.sql.exec("DELETE FROM summary_jobs WHERE hub_key = ? AND due_at = ?", j.hub_key, j.due_at);
    await Promise.all(
      jobs.map((j) =>
        (j.hub_key.startsWith(DIGEST_PREFIX) ? this.runDigest(j, provider, now) : this.runSessionJob(j, provider, now)).catch(
          (err) => console.error("summary job failed", err instanceof Error ? err.message : String(err)),
        ),
      ),
    );
    return jobs.length;
  }

  private async runSessionJob(job: JobRow, provider: SummaryProvider, now: number): Promise<void> {
    const row = this.sql.exec<SessionRow>("SELECT * FROM sessions WHERE hub_key = ?", job.hub_key).toArray()[0];
    if (!row) return;
    const device = this.device(row.device_id);
    if (!device || device.revoked_at != null) return;
    const turn = job.turn_id
      ? this.sql
          .exec<EventRow>(
            "SELECT * FROM events WHERE device_id = ? AND id = ? AND kind = 'turn' AND summary IS NULL",
            row.device_id,
            job.turn_id,
          )
          .toArray()[0]
      : undefined;
    const need = { turn: !!turn, waiting: job.waiting === 1 && row.state === "waiting" };
    const latest = this.sql
      .exec<{ ts: number | null }>("SELECT MAX(ts) AS ts FROM events WHERE hub_key = ?", job.hub_key)
      .one().ts;
    // Nothing new since the last now line, or nothing at all to describe: skip.
    if (!need.turn && !need.waiting) {
      if (row.state === "ended" || latest == null) return;
      if (row.now_line && row.sum_state === row.state && latest <= (row.sum_event_ts ?? 0)) return;
    }

    const day = utcDay(now);
    const calls = this.usage(day).calls;
    if (!capAllows(calls, dailyCap(this.env.SUMMARY_DAILY_CAP), !need.turn && !need.waiting)) {
      this.bumpUsage(day, { skipped: 1 });
      return;
    }

    const events = turn ? this.turnEvents(row.hub_key, turn) : this.recentEvents(row.hub_key, 60);
    const share: ShareLevel = device.share === "conversation" ? "conversation" : "metadata";
    const req = sessionRequest(
      {
        person: this.person(row.email).name,
        name: row.name,
        source: row.source,
        repo: row.repo,
        branch: row.branch,
        state: row.state,
        activity: row.activity,
        issues: parseIssues(row.issues_json),
        agents: row.agents,
        phase: row.phase,
        share,
        stateSince: row.state_since,
      },
      events.map(toEventInfo),
      need,
      now,
    );
    const capturedState = row.state;
    this.sql.exec("UPDATE sessions SET sum_at = ? WHERE hub_key = ?", Date.now(), row.hub_key);
    const kind = need.turn ? "turn" : need.waiting ? "waiting" : "now";
    const res = await this.call(provider, req, day, kind);
    if (!res.ok) {
      this.retryLater(job, res, now);
      return;
    }
    const out = parseSessionOutput(res.value, need);
    if (!out) {
      console.warn(JSON.stringify({ msg: "summary unusable", kind, provider: res.provider }));
      return;
    }

    const at = Date.now();
    const fresh = this.sql.exec<SessionRow>("SELECT * FROM sessions WHERE hub_key = ?", row.hub_key).toArray()[0];
    if (!fresh) return;
    if (out.now) {
      this.sql.exec(
        "UPDATE sessions SET now_line = ?, now_at = ?, sum_event_ts = ?, sum_state = ? WHERE hub_key = ?",
        out.now,
        at,
        latest ?? null,
        capturedState,
        row.hub_key,
      );
    }
    // The person may have answered while the model ran: a reason for a wait that is over is dropped.
    if (out.waiting && fresh.state === "waiting") {
      this.sql.exec("UPDATE sessions SET waiting_reason = ? WHERE hub_key = ?", out.waiting, row.hub_key);
    }
    if (out.now || (out.waiting && fresh.state === "waiting")) {
      const updated = this.sql.exec<SessionRow>("SELECT * FROM sessions WHERE hub_key = ?", row.hub_key).toArray()[0];
      if (updated) this.broadcast({ type: "session", session: toSession(updated) });
    }
    if (turn && out.turn) {
      this.sql.exec("UPDATE events SET summary = ? WHERE device_id = ? AND id = ?", out.turn, turn.device_id, turn.id);
      this.broadcast({ type: "turnSummary", deviceId: turn.device_id, id: turn.id, hubKey: turn.hub_key, summary: out.turn });
    }
  }

  /** The turn that ended at `turn`: from its prompt (or the previous turn end) up to it. */
  private turnEvents(hubKey: string, turn: EventRow): EventRow[] {
    const rows = this.sql
      .exec<EventRow>(
        "SELECT * FROM events WHERE hub_key = ? AND ts <= ? ORDER BY ts DESC, received_at DESC LIMIT 200",
        hubKey,
        turn.ts,
      )
      .toArray();
    const out: EventRow[] = [];
    for (const r of rows) {
      if (r.kind === "turn" && r.id !== turn.id) break;
      out.push(r);
      if (r.kind === "prompt") break;
    }
    return out.reverse();
  }

  private recentEvents(hubKey: string, limit: number): EventRow[] {
    return this.sql
      .exec<EventRow>("SELECT * FROM events WHERE hub_key = ? ORDER BY ts DESC, received_at DESC LIMIT ?", hubKey, limit)
      .toArray()
      .reverse();
  }

  private async call(provider: SummaryProvider, req: CompletionRequest, day: string, kind: string): Promise<CompletionResult> {
    this.bumpUsage(day, { calls: 1 });
    const t0 = Date.now();
    const res = await provider.complete(req);
    const ms = Date.now() - t0;
    this.bumpUsage(day, {
      ms,
      failures: res.ok ? 0 : 1,
      inputTokens: res.ok ? res.inputTokens : 0,
      outputTokens: res.ok ? res.outputTokens : 0,
      costUsd: res.ok ? res.costUsd : 0,
    });
    // Metadata only: never the prompt or the output.
    console.log(
      JSON.stringify({
        msg: "summary",
        kind,
        provider: res.provider,
        ms,
        ok: res.ok,
        ...(res.ok ? { in: res.inputTokens, out: res.outputTokens } : { reason: res.reason, status: res.status }),
      }),
    );
    return res;
  }

  /** Outages and rate limits retry once a minute later; refusals and cut-off answers are final. */
  private retryLater(job: JobRow, res: Extract<CompletionResult, { ok: false }>, now: number): void {
    if (res.reason !== "error" && res.reason !== "rate_limited") return;
    if (job.attempts + 1 >= POLICY.maxAttempts) return;
    this.upsertJob(
      job.hub_key,
      now + POLICY.retryMs,
      { turnId: job.turn_id ?? undefined, turnTs: job.turn_ts ?? undefined, waiting: job.waiting === 1 },
      job.attempts + 1,
      now,
    );
  }

  private usage(day: string): UsageRow {
    return (
      this.sql.exec<UsageRow>("SELECT * FROM summary_usage WHERE day = ?", day).toArray()[0] ?? {
        day,
        calls: 0,
        failures: 0,
        skipped: 0,
        input_tokens: 0,
        output_tokens: 0,
        ms_total: 0,
        cost_usd: 0,
      }
    );
  }

  private bumpUsage(
    day: string,
    d: {
      calls?: number;
      failures?: number;
      skipped?: number;
      inputTokens?: number;
      outputTokens?: number;
      ms?: number;
      costUsd?: number;
    },
  ): void {
    this.sql.exec(
      `INSERT INTO summary_usage (day, calls, failures, skipped, input_tokens, output_tokens, ms_total, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET calls = calls + excluded.calls, failures = failures + excluded.failures,
         skipped = skipped + excluded.skipped, input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens, ms_total = ms_total + excluded.ms_total,
         cost_usd = cost_usd + excluded.cost_usd`,
      day,
      d.calls ?? 0,
      d.failures ?? 0,
      d.skipped ?? 0,
      d.inputTokens ?? 0,
      d.outputTokens ?? 0,
      d.ms ?? 0,
      d.costUsd ?? 0,
    );
  }

  /** Usage per UTC day, newest first, for `GET /api/summaries`. */
  summaryUsage(): { provider: string | null; cap: number; days: UsageRow[] } {
    const days = this.sql.exec<UsageRow>("SELECT * FROM summary_usage ORDER BY day DESC LIMIT 14").toArray();
    return { provider: this.provider()?.label ?? null, cap: dailyCap(this.env.SUMMARY_DAILY_CAP), days };
  }

  /**
   * Viewer bookkeeping for the digest. Back after more than 30 minutes away starts a visit whose digest covers the
   * time away; it is built once, off the request path, and served for 10 minutes.
   */
  private visit(email: string, now: number): Digest | null {
    const v = this.sql.exec<ViewerRow>("SELECT * FROM viewers WHERE email = ?", email).toArray()[0];
    if (!v) {
      this.sql.exec("INSERT INTO viewers (email, last_seen_at, visit_started_at) VALUES (?, ?, ?)", email, now, now);
      return null;
    }
    // An open board pings every 25 s; the runtime answers without waking us but keeps the time.
    let live = 0;
    for (const ws of this.ctx.getWebSockets(email)) {
      live = Math.max(live, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0);
    }
    const lastSeen = Math.max(v.last_seen_at, live);
    if (now - lastSeen > POLICY.digestAwayMs) {
      this.sql.exec(
        `UPDATE viewers SET last_seen_at = ?, visit_started_at = ?, digest_since = ?, digest_json = NULL,
           digest_built_at = NULL WHERE email = ?`,
        now,
        now,
        lastSeen,
        email,
      );
      if (this.provider()) this.upsertJob(`${DIGEST_PREFIX}${email}`, now, {}, 0, now);
      return null;
    }
    this.sql.exec("UPDATE viewers SET last_seen_at = ? WHERE email = ?", now, email);
    if (!v.digest_json || v.digest_since == null || v.digest_built_at == null) return null;
    if (now - v.digest_built_at > POLICY.digestCacheMs) return null;
    return { since: v.digest_since, builtAt: v.digest_built_at, lines: JSON.parse(v.digest_json) as string[] };
  }

  private async runDigest(job: JobRow, provider: SummaryProvider, now: number): Promise<void> {
    const email = job.hub_key.slice(DIGEST_PREFIX.length);
    const v = this.sql.exec<ViewerRow>("SELECT * FROM viewers WHERE email = ?", email).toArray()[0];
    if (!v || v.digest_since == null) return;
    const since = v.digest_since;
    const rows = this.sql
      .exec<{ ts: number; summary: string; email: string; name: string | null; repo: string | null }>(
        `SELECT e.ts, e.summary, e.email, s.name, s.repo FROM events e
         JOIN devices d ON d.id = e.device_id
         LEFT JOIN sessions s ON s.hub_key = e.hub_key
         WHERE e.kind = 'turn' AND e.summary IS NOT NULL AND e.ts > ? AND d.revoked_at IS NULL
         ORDER BY e.ts DESC LIMIT 40`,
        since,
      )
      .toArray()
      .reverse();
    if (!rows.length) return;
    const day = utcDay(now);
    if (!capAllows(this.usage(day).calls, dailyCap(this.env.SUMMARY_DAILY_CAP), false)) {
      this.bumpUsage(day, { skipped: 1 });
      return;
    }
    const me = this.person(email).name;
    const items: DigestItem[] = rows.map((r) => ({
      ts: r.ts,
      person: r.email === email ? `${this.person(r.email).name} (the reader)` : this.person(r.email).name,
      session: r.name,
      repo: r.repo,
      summary: r.summary,
    }));
    const res = await this.call(provider, digestRequest(me, items, now - since), day, "digest");
    if (!res.ok) {
      this.retryLater(job, res, now);
      return;
    }
    const lines = parseDigestOutput(res.value);
    if (!lines) return;
    const builtAt = Date.now();
    // Only if the visit it was built for is still the current one.
    const updated = this.sql
      .exec(
        "UPDATE viewers SET digest_json = ?, digest_built_at = ? WHERE email = ? AND digest_since = ? RETURNING email",
        JSON.stringify(lines),
        builtAt,
        email,
        since,
      )
      .toArray();
    if (updated.length) this.broadcast({ type: "digest", digest: { since, builtAt, lines } }, email);
  }

  // ---------------------------------------------------------------- helpers

  private pairing(code: string): PairingRow | undefined {
    return this.sql.exec<PairingRow>("SELECT * FROM pairings WHERE code = ?", code).toArray()[0];
  }

  private device(id: string): DeviceRow | undefined {
    return this.sql.exec<DeviceRow>("SELECT * FROM devices WHERE id = ?", id).toArray()[0];
  }

  private person(email: string): Person {
    const row = this.sql.exec<{ name: string }>("SELECT name FROM people WHERE email = ?", email).toArray()[0];
    return { email, name: row?.name ?? displayName(email) };
  }
}

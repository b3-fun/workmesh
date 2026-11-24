import { DurableObject } from "cloudflare:workers";
import {
  BOARD_WINDOW_MS,
  EVENT_RETENTION_MS,
  PAIRING_TTL_SEC,
  PROJECT,
  displayName,
  type BoardState,
  type Device,
  type EventKind,
  type HubEvent,
  type PairInfo,
  type Person,
  type Session,
  type SessionState,
  type StreamMessage,
} from "../shared/types";
import { deviceToken, pairingCode, randomHex, sha256Hex, ulid } from "./crypto";
import type { IngestPayload, SessionUpsert } from "./schema";

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

function toDevice(r: DeviceRow): Device {
  return {
    id: r.id,
    email: r.email,
    machine: r.machine,
    client: r.client,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    revokedAt: r.revoked_at,
  };
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
  };
}

export class Project extends DurableObject<Env> {
  private sql: SqlStorage;
  private ingestCounts = new Map<string, { start: number; count: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      if ((await ctx.storage.getAlarm()) == null) await ctx.storage.setAlarm(Date.now() + HOUR);
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
  }

  // ---------------------------------------------------------------- pairing

  async pairStart(input: { ipHash: string; machine: string; client: string; origin: string }): Promise<Result> {
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
      `INSERT INTO pairings (code, device_id, poll_secret_hash, machine, client, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      code,
      deviceId,
      pollSecretHash,
      input.machine,
      input.client,
      now,
      now + PAIRING_TTL_SEC * 1000,
    );
    return {
      status: 200,
      body: {
        code,
        deviceId,
        pollSecret,
        verifyUrl: `${input.origin}/pair?code=${code}`,
        expiresInSec: PAIRING_TTL_SEC,
      },
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
      return { status: 200, body: { status: now > p.expires_at ? "expired" : "pending" } };
    }
    const person = this.person(p.approved_by);
    const project = { id: PROJECT.id, name: PROJECT.name, include: PROJECT.include, issueKeys: PROJECT.issueKeys };
    if (p.delivered) return { status: 200, body: { status: "complete", person, project } };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO devices (id, email, machine, client, token_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        p.device_id,
        p.approved_by,
        p.machine,
        p.client,
        tokenHash,
        now,
      );
      this.sql.exec("UPDATE pairings SET delivered = 1 WHERE code = ?", p.code);
    });
    const device = this.device(p.device_id);
    if (device) this.broadcast({ type: "device", device: toDevice(device) });
    return { status: 200, body: { status: "complete", deviceToken: token, person, project } };
  }

  // ----------------------------------------------------------------- ingest

  ingest(tokenHash: string, payload: IngestPayload): Result {
    const device = this.sql.exec<DeviceRow>("SELECT * FROM devices WHERE token_hash = ?", tokenHash).toArray()[0];
    if (!device || device.revoked_at != null) {
      return { status: 401, body: { error: "unknown or revoked device token; pair again" } };
    }
    const now = Date.now();
    const retryAfter = this.ingestLimited(device.id, now);
    if (retryAfter) {
      return { status: 429, body: { error: "too many requests" }, headers: { "Retry-After": String(retryAfter) } };
    }

    const changed = new Set<string>();
    const inserted: HubEvent[] = [];
    const deviceStale = device.last_seen_at == null || now - device.last_seen_at > DEVICE_BROADCAST_MS;

    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE devices SET last_seen_at = ? WHERE id = ?", now, device.id);

      const present = new Set<string>();
      for (const s of payload.sessions) {
        const hubKey = `${device.id}:${s.key}`;
        present.add(hubKey);
        if (this.upsertSession(device, hubKey, s, now)) changed.add(hubKey);
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
        const hubKey = `${device.id}:${e.key}`;
        const row = this.sql
          .exec<EventRow>(
            `INSERT OR IGNORE INTO events
               (device_id, id, hub_key, email, ts, kind, tool, label, path, cmd, repo, branch, issues_json, pr, ok, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      }
    });

    if (deviceStale) {
      const fresh = this.device(device.id);
      if (fresh) this.broadcast({ type: "device", device: toDevice(fresh) });
    }
    for (const hubKey of changed) {
      const row = this.sql.exec<SessionRow>("SELECT * FROM sessions WHERE hub_key = ?", hubKey).toArray()[0];
      if (row) this.broadcast({ type: "session", session: toSession(row) });
    }
    if (inserted.length) this.broadcast({ type: "events", events: inserted });

    return { status: 200, body: { ok: true, accepted: inserted.length } };
  }

  /** Returns true when a board-visible field changed. */
  private upsertSession(device: DeviceRow, hubKey: string, s: SessionUpsert, now: number): boolean {
    const existing = this.sql.exec<SessionRow>("SELECT * FROM sessions WHERE hub_key = ?", hubKey).toArray()[0];
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
    };
    if (existing && SESSION_FIELDS.every((f) => existing[f] === next[f])) {
      this.sql.exec("UPDATE sessions SET seen_at = ? WHERE hub_key = ?", now, hubKey);
      return false;
    }
    this.sql.exec(
      `INSERT INTO sessions (hub_key, device_id, email, source, key, name, state, activity, background, agents, phase,
         orchestrator, repo, branch, issues_json, started_at, updated_at, state_since, ended_at, last_event_at, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hub_key) DO UPDATE SET
         source = excluded.source, name = excluded.name, state = excluded.state, activity = excluded.activity,
         background = excluded.background, agents = excluded.agents, phase = excluded.phase,
         orchestrator = excluded.orchestrator, repo = excluded.repo, branch = excluded.branch,
         issues_json = excluded.issues_json, started_at = excluded.started_at, updated_at = excluded.updated_at,
         state_since = excluded.state_since, ended_at = excluded.ended_at, seen_at = excluded.seen_at`,
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
    );
    return true;
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

  boardState(email: string): BoardState {
    const now = Date.now();
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
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "hello", serverNow: Date.now() } satisfies StreamMessage));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") ws.send("pong");
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // already closed, or a reserved close code
    }
  }

  private broadcast(msg: StreamMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // socket went away; the runtime cleans it up
      }
    }
  }

  // -------------------------------------------------------------- retention

  override async alarm(): Promise<void> {
    this.prune(Date.now());
    await this.ctx.storage.setAlarm(Date.now() + HOUR);
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

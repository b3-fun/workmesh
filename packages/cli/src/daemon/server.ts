import http from "node:http";
import { sessionEventSchema } from "@workmesh/core";
import type { SessionEvent, SlackStatus, StatusSnapshot } from "@workmesh/core";
import { secretsEqual } from "../lib/daemon-auth";
import { z } from "zod";
import { liveConfigPatchSchema } from "../lib/config";
import type { LiveConfigPatch, SafeConfig } from "../lib/config";
import { pauseRequestSchema, resolvePauseUntil } from "../lib/snooze";
import type { OwnershipSummary } from "./pusher";
import type { HubForwarderStatus } from "../hub/forwarder";
import type { HubShareLevel, HubTeamAccepted } from "@workmesh/protocol";
import type { HookAnswer } from "./coord-hooks";
import { coordOpRequestSchema } from "./coord-ops";
import type { CoordOpRequest, CoordOpResult } from "./coord-ops";
import type { DelegateSummary, WaitAnswer } from "./delegate";

/** GET /hub: the forwarder's status, or `enabled: false` when not paired. */
export type HubState = ({ enabled: true } & HubForwarderStatus) | { enabled: false };

/**
 * GET /team (v0.5, docs/SPEC.md §16): the team as the hub last told it, for the
 * menu bar, with this machine's hub connection and sharing level. `?open=1`
 * says the menu is open (the daemon then polls the hub every 15 s).
 */
export type TeamState =
  | { enabled: false }
  | {
      enabled: true;
      hubUrl: string;
      /** Where "Open board" goes. */
      boardUrl: string;
      /** The project's name ("B3"), for "Connected to B3". */
      hubName: string;
      /**
       * This machine's device id: a needsMe item whose session starts with
       * `<deviceId>:` is one of this machine's sessions (the local list is
       * authoritative for those).
       */
      deviceId: string;
      share: HubShareLevel;
      /** The last send to the hub succeeded. */
      connected: boolean;
      /** The hub rejected this device's token: pair again. */
      halted: boolean;
      /** null: not asked yet; false: this hub has no team view (older hub). */
      available: boolean | null;
      fetchedAt?: number;
      error?: string;
      pollMs: number;
      team?: HubTeamAccepted;
      /** v1 (SPEC §23): holds on this machine's agents and messages waiting for them. */
      coord?: CoordSummary;
      /** v2 (SPEC §31): handoffs offered to this person or running here, and pending approvals. */
      delegate?: DelegateSummary;
    };

/** v1: what the menu bar shows about coordination (this machine's agents only). */
export interface CoordSummary {
  /** null: not asked yet; false: this hub has no coordination. */
  available: boolean | null;
  holds: Array<{ session: string; name?: string; by: string; reason?: string; since: number }>;
  unread: Array<{ id: string; session?: string; name?: string; from: string; fromSession?: string; text: string; ts: number; delivered: boolean }>;
}

/** The header a hook sends with its event: the agent's hook event name (`PreToolUse`, …). */
export const HOOK_HEADER = "x-workmesh-hook";

const MAX_BODY_BYTES = 64 * 1024;

const dismissRequestSchema = z.object({ key: z.string().min(1).max(200) }).strict();
const wakeWaitRequestSchema = z.object({ session: z.string().min(1).max(200), timeoutMs: z.number().int().min(0).max(120_000).default(55_000) });

export interface DaemonServerDeps {
  /** Per-daemon bearer secret required on every endpoint except /health. */
  secret: string;
  applyEvent(event: SessionEvent): void;
  getState(): {
    snapshot: StatusSnapshot;
    formatted: SlackStatus | null;
    paused: boolean;
    /** When a snooze ends (epoch ms); absent while paused until resumed, or not paused. */
    pausedUntil?: number;
    lastError?: string;
  };
  getLastError(): string | undefined;
  /** Ownership guard summary — included in /state and /health. */
  getOwnership(): OwnershipSummary;
  /** Pause pushing; `until` (epoch ms) makes it a snooze that resumes itself. */
  pause(until?: number): Promise<void>;
  resume(): void;
  /** Drop a session from the list (POST /sessions/dismiss). False when unknown. */
  dismiss(key: string): boolean;
  /** Token-free config view (GET /config). */
  getConfig(): SafeConfig;
  /** Apply live-tunable settings and persist them (POST /config). */
  setConfig(patch: LiveConfigPatch): SafeConfig;
  /** Hub forwarder status (GET /hub). Optional so test harnesses can omit it. */
  getHub?(): HubState;
  /** Re-read the hub section from config and restart the forwarder (POST /hub/reload). */
  reloadHub?(): HubState;
  /** The team view (GET /team); `open` = the menu bar is showing it. */
  getTeam?(open: boolean): TeamState;
  /**
   * v1 (SPEC §23): apply a hook's event and answer the hook (a refusal, context for the agent) from cached state.
   * Absent: hooks get `{ ok: true }` as before.
   */
  applyHookEvent?(event: SessionEvent, hook: string): HookAnswer | undefined;
  /** v1: an MCP or CLI coordination call (POST /coord/op). */
  coordOp?(req: CoordOpRequest): Promise<CoordOpResult>;
  /** v2 (SPEC §31): an idle session's waiter long-polls for its next waking message (POST /wake/wait). */
  wakeWait?(session: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitAnswer>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

type ParsedBody<T> = { ok: true; data: T } | { ok: false; error: string };

/** Reads a JSON body (empty = `{}`) and validates it; errors are client-facing. */
async function parseBody<T>(
  req: http.IncomingMessage,
  schema: z.ZodType<T>,
): Promise<ParsedBody<T>> {
  const body = await readBody(req);
  let raw: unknown = {};
  if (body.trim()) {
    try {
      raw = JSON.parse(body) as unknown;
    } catch {
      return { ok: false, error: "invalid JSON body" };
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    };
  }
  return { ok: true, data: parsed.data };
}

function isAuthorized(req: http.IncomingMessage, secret: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return secretsEqual(header.slice("Bearer ".length), secret);
}

/** Loopback HTTP API — the single integration surface for all adapters. */
export function createDaemonServer(deps: DaemonServerDeps): http.Server {
  const startedAt = Date.now();

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    try {
      if (method === "GET" && url === "/health") {
        json(res, 200, {
          ok: true,
          pid: process.pid,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          lastError: deps.getLastError(),
          ownership: deps.getOwnership(),
        });
        return;
      }
      // Loopback TCP is reachable by every local user on shared hosts — all
      // session data and control endpoints require the per-daemon secret.
      if (!isAuthorized(req, deps.secret)) {
        json(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      if (method === "POST" && url === "/event") {
        const body = await readBody(req);
        let raw: unknown;
        try {
          raw = JSON.parse(body) as unknown;
        } catch {
          json(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        let parsed = sessionEventSchema.safeParse(raw);
        if (!parsed.success && typeof raw === "object" && raw !== null && "detail" in raw) {
          // A malformed local-only detail must not cost the status update:
          // retry without it (the hub forwarder just sees less).
          const { detail: _dropped, ...rest } = raw as Record<string, unknown>;
          const retry = sessionEventSchema.safeParse(rest);
          if (retry.success) parsed = retry;
        }
        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          json(res, 400, { ok: false, error: detail });
          return;
        }
        const hook = req.headers[HOOK_HEADER];
        if (typeof hook === "string" && hook && deps.applyHookEvent) {
          // Fail open: a coordination error must never cost the event or block the agent.
          let answer: HookAnswer | undefined;
          try {
            answer = deps.applyHookEvent(parsed.data, hook.slice(0, 64));
          } catch {
            deps.applyEvent(parsed.data);
          }
          json(res, 200, answer ? { ok: true, coord: answer } : { ok: true });
          return;
        }
        deps.applyEvent(parsed.data);
        json(res, 200, { ok: true });
        return;
      }
      if (method === "POST" && url === "/coord/op") {
        if (!deps.coordOp) {
          json(res, 404, { ok: false, error: "not found" });
          return;
        }
        const parsed = await parseBody(req, coordOpRequestSchema);
        if (!parsed.ok) {
          json(res, 400, { ok: false, error: parsed.error });
          return;
        }
        json(res, 200, await deps.coordOp(parsed.data));
        return;
      }
      if (method === "POST" && url === "/wake/wait") {
        if (!deps.wakeWait) {
          json(res, 404, { ok: false, error: "not found" });
          return;
        }
        const parsed = await parseBody(req, wakeWaitRequestSchema);
        if (!parsed.ok) {
          json(res, 400, { ok: false, error: parsed.error });
          return;
        }
        // A waiter that goes away (its session ended, Claude Code killed it) gives up its slot, so no message is
        // marked delivered to a waiter that can't hear it.
        const gone = new AbortController();
        let done = false;
        res.on("close", () => {
          if (!done) gone.abort();
        });
        const answer = await deps.wakeWait(parsed.data.session, parsed.data.timeoutMs, gone.signal);
        done = true;
        if (!res.destroyed) json(res, 200, { ok: true, ...answer });
        return;
      }
      if (method === "GET" && url === "/state") {
        json(res, 200, { ...deps.getState(), ownership: deps.getOwnership() });
        return;
      }
      if (method === "POST" && url === "/pause") {
        // Optional body: {} pauses until resumed, {for: "30m"|"1h"|"tomorrow"}
        // or {until: epochMs} snoozes with an auto-resume.
        const parsed = await parseBody(req, pauseRequestSchema);
        if (!parsed.ok) {
          json(res, 400, { ok: false, error: parsed.error });
          return;
        }
        let until: number | undefined;
        try {
          until = resolvePauseUntil(parsed.data);
        } catch (err) {
          json(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad until" });
          return;
        }
        // Respond immediately: pause() flips the flag synchronously but then
        // awaits a status-clear push (up to 10s) — far past the CLI's 1.5s
        // request timeout. The clearing push runs in the background.
        void deps.pause(until).catch(() => {});
        json(res, 200, { ok: true, paused: true, ...(until === undefined ? {} : { pausedUntil: until }) });
        return;
      }
      if (method === "POST" && url === "/sessions/dismiss") {
        const parsed = await parseBody(req, dismissRequestSchema);
        if (!parsed.ok) {
          json(res, 400, { ok: false, error: parsed.error });
          return;
        }
        json(res, 200, { ok: true, removed: deps.dismiss(parsed.data.key) });
        return;
      }
      if (method === "POST" && url === "/resume") {
        deps.resume();
        json(res, 200, { ok: true, paused: false });
        return;
      }
      if (method === "GET" && (url === "/team" || url.startsWith("/team?"))) {
        const open = new URL(url, "http://127.0.0.1").searchParams.get("open") === "1";
        json(res, 200, deps.getTeam?.(open) ?? { enabled: false });
        return;
      }
      if (method === "GET" && url === "/hub") {
        json(res, 200, deps.getHub?.() ?? { enabled: false });
        return;
      }
      if (method === "POST" && url === "/hub/reload") {
        if (!deps.reloadHub) {
          json(res, 404, { ok: false, error: "not found" });
          return;
        }
        json(res, 200, deps.reloadHub());
        return;
      }
      if (method === "GET" && url === "/config") {
        json(res, 200, deps.getConfig());
        return;
      }
      if (method === "POST" && url === "/config") {
        const body = await readBody(req);
        let raw: unknown;
        try {
          raw = JSON.parse(body) as unknown;
        } catch {
          json(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        const parsed = liveConfigPatchSchema.safeParse(raw);
        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          json(res, 400, { ok: false, error: detail });
          return;
        }
        json(res, 200, deps.setConfig(parsed.data));
        return;
      }
      json(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      json(res, message === "body too large" ? 413 : 500, {
        ok: false,
        error: message,
      });
    }
  }

  return http.createServer((req, res) => {
    void handle(req, res);
  });
}

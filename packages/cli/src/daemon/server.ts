import http from "node:http";
import { sessionEventSchema } from "@agentblip/core";
import type { SessionEvent, SlackStatus, StatusSnapshot } from "@agentblip/core";
import { secretsEqual } from "../lib/daemon-auth";
import { z } from "zod";
import { liveConfigPatchSchema } from "../lib/config";
import type { LiveConfigPatch, SafeConfig } from "../lib/config";
import { pauseRequestSchema, resolvePauseUntil } from "../lib/snooze";
import type { OwnershipSummary } from "./pusher";
import type { HubForwarderStatus } from "../hub/forwarder";

/** GET /hub: the forwarder's status, or `enabled: false` when not paired. */
export type HubState = ({ enabled: true } & HubForwarderStatus) | { enabled: false };

const MAX_BODY_BYTES = 64 * 1024;

const dismissRequestSchema = z.object({ key: z.string().min(1).max(200) }).strict();

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
        deps.applyEvent(parsed.data);
        json(res, 200, { ok: true });
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

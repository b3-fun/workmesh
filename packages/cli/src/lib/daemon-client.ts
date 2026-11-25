import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SessionEvent, SlackStatus, StatusSnapshot } from "@workmesh/core";
import type { OwnershipSummary } from "../daemon/pusher";
import type { CoordSummary, HubState } from "../daemon/server";
import { HOOK_HEADER } from "../daemon/server";
import type { HookAnswer } from "../daemon/coord-hooks";
import type { CoordOpRequest, CoordOpResult } from "../daemon/coord-ops";
import type { Config } from "./config";
import { readDaemonSecret } from "./daemon-auth";
import type { SnoozePreset } from "./snooze";
import { logFilePath, spawnLockPath, startFailedMarkerPath, stateDir } from "./paths";
import { sleep } from "./ui";
import { startService } from "./service";

export const REQUEST_TIMEOUT_MS = 1500;
const SPAWN_LOCK_STALE_MS = 15_000;
const START_WAIT_MS = 5000;
/** After a failed autostart, don't re-spawn (5s of dead hook time) for this long. */
export const START_FAILURE_COOLDOWN_MS = 60_000;

/** How long a caller waits on the daemon: the CLI's commands use the defaults. */
export interface DaemonTiming {
  /** Per request (health check, POST). */
  requestTimeoutMs: number;
  /** After spawning a daemon, for it to answer /health. */
  startWaitMs: number;
  /** When another process holds the spawn lock (it is starting one). */
  lockWaitMs: number;
}

export const DEFAULT_TIMING: DaemonTiming = {
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  startWaitMs: START_WAIT_MS,
  lockWaitMs: START_WAIT_MS,
};

/**
 * Hooks run synchronously on every tool call, so they wait less. The daemon is
 * on loopback and answers in milliseconds; a refused connection fails at
 * once, so these limits only bite when it is hung or starting. Worst case per
 * hook: 0.75 s with the daemon hung, 0.75 + 3 + 0.75 s for the one hook that
 * starts it, 0.75 + 1 s for hooks that arrive while it starts (they don't
 * wait the whole start out).
 */
export const HOOK_TIMING: DaemonTiming = {
  requestTimeoutMs: 750,
  startWaitMs: 3000,
  lockWaitMs: 1000,
};

export interface DaemonState {
  snapshot: StatusSnapshot;
  formatted: SlackStatus | null;
  paused: boolean;
  /** When a snooze ends (epoch ms); absent for an open-ended pause or older daemons. */
  pausedUntil?: number;
  lastError?: string;
  /** Optional: daemons predating the ownership guard don't report it. */
  ownership?: OwnershipSummary;
}

export interface DaemonHealth {
  ok: boolean;
  pid: number;
  uptimeSec: number;
  lastError?: string;
  /** Optional: daemons predating the ownership guard don't report it. */
  ownership?: OwnershipSummary;
}

async function daemonFetch<T>(
  port: number,
  pathname: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
  extra: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  // Re-read per request: a restarted daemon rotates its secret.
  const secret = readDaemonSecret();
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      ...(secret === undefined ? {} : { authorization: `Bearer ${secret}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extra.headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(extra.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed.error) detail = `: ${parsed.error}`;
    } catch {
      // non-JSON error body
    }
    throw new Error(`daemon responded ${res.status} for ${method} ${pathname}${detail}`);
  }
  return (await res.json()) as T;
}

/**
 * Sends an event. With `hook` (the agent's hook event name) a v1 daemon answers the hook too: a refusal or context
 * for the agent (`coord`). An older daemon ignores the header and answers `{ ok: true }`.
 */
export function postEvent(
  port: number,
  event: SessionEvent,
  hook?: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ ok: boolean; coord?: HookAnswer }> {
  return daemonFetch(port, "/event", "POST", event, { ...(hook ? { headers: { [HOOK_HEADER]: hook } } : {}), timeoutMs });
}

/** Hub calls go through the daemon (it holds the device token); they may take a network round trip. */
export const COORD_TIMEOUT_MS = 12_000;
/** `ask` waits for the hub's model (ASK_TIMEOUT_MS in hub/coord.ts, plus room). */
export const ASK_OP_TIMEOUT_MS = 100_000;

export function coordOp(port: number, req: CoordOpRequest): Promise<CoordOpResult> {
  return daemonFetch(port, "/coord/op", "POST", req, { timeoutMs: req.op === "ask" ? ASK_OP_TIMEOUT_MS : COORD_TIMEOUT_MS });
}

/** v2 (SPEC §31): one long-poll for an idle session's next waking message. */
export function wakeWait(
  port: number,
  session: string,
  timeoutMs: number,
): Promise<{ wake?: string; end?: boolean; reason?: string }> {
  return daemonFetch(port, "/wake/wait", "POST", { session, timeoutMs }, { timeoutMs: timeoutMs + 5000 });
}

export function getTeamState(port: number): Promise<{ enabled: boolean; coord?: CoordSummary }> {
  return daemonFetch(port, "/team");
}

export function getState(port: number): Promise<DaemonState> {
  return daemonFetch(port, "/state");
}

export function pauseDaemon(
  port: number,
  snooze?: SnoozePreset,
): Promise<{ ok: boolean; paused: boolean; pausedUntil?: number }> {
  return daemonFetch(port, "/pause", "POST", snooze ? { for: snooze } : undefined);
}

export function resumeDaemon(port: number): Promise<{ ok: boolean; paused: boolean }> {
  return daemonFetch(port, "/resume", "POST");
}

export function getHubState(port: number): Promise<HubState> {
  return daemonFetch(port, "/hub");
}

export function reloadHub(port: number): Promise<HubState> {
  return daemonFetch(port, "/hub/reload", "POST");
}

export function getHealth(port: number, timeoutMs = REQUEST_TIMEOUT_MS): Promise<DaemonHealth> {
  return daemonFetch(port, "/health", "GET", undefined, { timeoutMs });
}

export async function isDaemonUp(port: number, timeoutMs = REQUEST_TIMEOUT_MS): Promise<boolean> {
  try {
    return (await getHealth(port, timeoutMs)).ok;
  } catch {
    return false;
  }
}

function acquireSpawnLock(): boolean {
  const lock = spawnLockPath();
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch {
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > SPAWN_LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue; // stale lock removed — retry the exclusive open
        }
      } catch {
        continue; // lock vanished between open and stat — retry
      }
      return false; // fresh lock held by another process
    }
  }
  return false;
}

function releaseSpawnLock(): void {
  try {
    fs.unlinkSync(spawnLockPath());
  } catch {
    // already gone
  }
}

/** Polls /health until the daemon answers or `timeoutMs` passes. */
export function waitForDaemon(port: number, timeoutMs: number): Promise<boolean> {
  return waitForHealth(port, timeoutMs);
}

async function waitForHealth(port: number, timeoutMs: number, requestTimeoutMs = REQUEST_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const left = deadline - Date.now();
    if (await isDaemonUp(port, Math.max(50, Math.min(requestTimeoutMs, left)))) return true;
    if (Date.now() + 250 >= deadline) break;
    await sleep(250);
  }
  return false;
}

function recordStartFailure(): void {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(startFailedMarkerPath(), `${Date.now()}\n`);
  } catch {
    // best effort — worst case hooks keep retrying
  }
}

function clearStartFailure(): void {
  try {
    fs.unlinkSync(startFailedMarkerPath());
  } catch {
    // already gone
  }
}

/** True while a recent failed autostart means re-spawning would just burn 5s. */
export function inStartFailureCooldown(now = Date.now()): boolean {
  try {
    const ts = Number.parseInt(
      fs.readFileSync(startFailedMarkerPath(), "utf8").trim(),
      10,
    );
    return Number.isFinite(ts) && now - ts < START_FAILURE_COOLDOWN_MS;
  } catch {
    return false;
  }
}

/**
 * Cheap pre-flight: a daemon whose sink can't be created dies instantly in
 * createSink — don't spawn one just to watch it crash for 5 seconds.
 */
export function sinkConfigured(config: Config): boolean {
  if (config.mode === "relay") return Boolean(config.deviceToken);
  if (config.mode === "slack") return Boolean(config.slackToken);
  return true;
}

/**
 * Spawns `workmesh start` detached, logging to the state dir. A lockfile
 * guards against concurrent hooks racing to start multiple daemons. Failed
 * starts leave a cooldown marker so hooks stop re-spawning a crashing daemon.
 */
export async function spawnDetachedDaemon(config: Config, timing: DaemonTiming = DEFAULT_TIMING): Promise<boolean> {
  if (!acquireSpawnLock()) return waitForHealth(config.port, timing.lockWaitMs, timing.requestTimeoutMs);
  let up = false;
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const out = fs.openSync(logFilePath(), "a");
    // import.meta.url is the bundled CLI entry (dist/index.js) at runtime.
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "start"], {
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.on("error", () => {});
    child.unref();
    fs.closeSync(out);
    up = await waitForHealth(config.port, timing.startWaitMs, timing.requestTimeoutMs);
    return up;
  } finally {
    if (up) clearStartFailure();
    else recordStartFailure();
    releaseSpawnLock();
  }
}

/**
 * Starts the daemon in the background: through its service (launchd, systemd)
 * when one is installed, so the service keeps owning it (SPEC §24), else as a
 * detached process.
 */
export async function startDaemonInBackground(config: Config, timing: DaemonTiming = DEFAULT_TIMING): Promise<boolean> {
  if (startService()) {
    if (await waitForHealth(config.port, timing.startWaitMs, timing.requestTimeoutMs)) return true;
  }
  return spawnDetachedDaemon(config, timing);
}

/** Returns true when the daemon is reachable, auto-starting it if configured. */
export async function ensureDaemon(config: Config, timing: DaemonTiming = DEFAULT_TIMING): Promise<boolean> {
  if (await isDaemonUp(config.port, timing.requestTimeoutMs)) return true;
  if (!config.autoStartDaemon) return false;
  if (!sinkConfigured(config)) return false;
  if (inStartFailureCooldown()) return false;
  return startDaemonInBackground(config, timing);
}

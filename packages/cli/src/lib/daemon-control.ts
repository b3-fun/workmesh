import { execFileSync } from "node:child_process";
import { OUR_COMMAND_RE } from "./names";
import fs from "node:fs";
import path from "node:path";
import { legacyPidFilePath, pidFilePath, stopRequestPath } from "./paths";
import { isProcessAlive, readPidFile, removePidFile } from "./pidfile";
import { sleep } from "./ui";

/** How long `stop` lets the daemon shut down (clear the status, flush the hub) before SIGKILL. */
export const STOP_GRACE_MS = 5000;
/** After SIGKILL, how long to wait for the process to disappear. */
const KILL_WAIT_MS = 2000;
/** How long a starting daemon waits for one that is still shutting down. */
export const START_EXIT_WAIT_MS = STOP_GRACE_MS + 1000;

/** Tells daemon `pid` that the SIGTERM it is about to get is a stop (SPEC §24: its service then leaves it stopped). */
export function markStopRequested(pid: number, file = stopRequestPath()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${pid}\n`);
  } catch {
    // best effort: the service restarts a daemon it thinks was killed
  }
}

/** Whether a stop was requested for `pid` (and forgets the request). */
export function takeStopRequest(pid: number, file = stopRequestPath()): boolean {
  const named = readPidFile(file);
  if (named === undefined) return false;
  if (named === pid) removePidFile(file);
  return named === pid;
}

/** Polls until `pid` is gone. True when it exited within `timeoutMs`. */
export async function waitForExit(pid: number, timeoutMs: number, pollMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
  return true;
}

/**
 * Whether `pid` runs one of our daemons, judged by its command line: a `start`
 * argument plus one of our names or the CLI entry (`dist/index.js`). A pidfile
 * can outlive its process (crash, reboot) and the pid can be reused, so this
 * keeps `start` from refusing to run, and `stop` from signalling a stranger.
 * Undefined when the command line can't be read; callers then assume it's ours.
 */
export function looksLikeOurDaemon(pid: number): boolean | undefined {
  let command: string;
  try {
    command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
  } catch {
    return undefined; // no ps, or the pid vanished meanwhile
  }
  if (!command) return undefined;
  return /(^|\s)start(\s|$)/.test(command) && (OUR_COMMAND_RE.test(command) || /index\.[cm]?js\b/.test(command));
}

export interface DaemonControlOptions {
  /** Pidfiles to consult, newest name first. Default: ours, then the pre-rename one. */
  pidFiles?: string[];
  /** Injected in tests. */
  isOurs?: (pid: number) => boolean | undefined;
}

function defaults(opts: DaemonControlOptions): Required<DaemonControlOptions> {
  return {
    pidFiles: opts.pidFiles ?? [pidFilePath(), legacyPidFilePath()],
    isOurs: opts.isOurs ?? looksLikeOurDaemon,
  };
}

/** The live daemon a pidfile names, or undefined after removing a stale one. */
function liveDaemonPid(file: string, isOurs: (pid: number) => boolean | undefined): number | undefined {
  const pid = readPidFile(file);
  if (pid === undefined) return undefined;
  if (pid === process.pid) return undefined;
  if (!isProcessAlive(pid) || isOurs(pid) === false) {
    removePidFile(file);
    return undefined;
  }
  return pid;
}

/**
 * Before a daemon starts: the pid of another daemon that is still alive, or
 * undefined. Ignores (and removes) a pidfile whose process is gone or now
 * belongs to another program. A daemon that is shutting down gets `exitWaitMs`
 * to finish, so `stop` and an immediate `start` (or a hook's autostart) don't
 * collide.
 */
export async function findRunningDaemon(
  opts: DaemonControlOptions & { exitWaitMs?: number } = {},
): Promise<number | undefined> {
  const { pidFiles, isOurs } = defaults(opts);
  for (const file of pidFiles) {
    const pid = liveDaemonPid(file, isOurs);
    if (pid === undefined) continue;
    if (await waitForExit(pid, opts.exitWaitMs ?? START_EXIT_WAIT_MS)) {
      if (readPidFile(file) === pid) removePidFile(file);
      continue;
    }
    return pid;
  }
  return undefined;
}

export type StopOutcome =
  | { kind: "not-running" }
  /** A pidfile named a process that is gone or isn't ours; it was removed. */
  | { kind: "stale" }
  /** `legacy`: it was a daemon started before the rename. `killed`: it needed SIGKILL. */
  | { kind: "stopped"; pid: number; killed: boolean; legacy: boolean }
  | { kind: "stuck"; pid: number };

/**
 * Stops the daemon and returns only once its process is gone: SIGTERM, up to
 * `graceMs` for its own shutdown (clear the Slack status, flush the hub), then
 * SIGKILL. Also stops a daemon started before the rename (its pidfile lives in
 * the agentblip state dir).
 */
export async function stopDaemon(
  opts: DaemonControlOptions & { graceMs?: number; killWaitMs?: number } = {},
): Promise<StopOutcome> {
  const { pidFiles, isOurs } = defaults(opts);
  let stale = false;
  for (const [index, file] of pidFiles.entries()) {
    const hadPid = readPidFile(file) !== undefined;
    const pid = liveDaemonPid(file, isOurs);
    if (pid === undefined) {
      stale ||= hadPid;
      continue;
    }
    markStopRequested(pid);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      removePidFile(file);
      stale = true;
      continue;
    }
    let killed = false;
    if (!(await waitForExit(pid, opts.graceMs ?? STOP_GRACE_MS))) {
      killed = true;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // exited between the check and the kill
      }
      if (!(await waitForExit(pid, opts.killWaitMs ?? KILL_WAIT_MS))) return { kind: "stuck", pid };
    }
    // A clean exit removes its own pidfile; a killed daemon can't.
    if (readPidFile(file) === pid) removePidFile(file);
    return { kind: "stopped", pid, killed, legacy: index > 0 };
  }
  return stale ? { kind: "stale" } : { kind: "not-running" };
}

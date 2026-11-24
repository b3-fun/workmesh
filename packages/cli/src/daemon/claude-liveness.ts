import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentSession } from "@workmesh/core";
import { isProcessAlive } from "../lib/pidfile";

/**
 * Liveness for Claude Code sessions, from the per-process files Claude Code
 * keeps at ~/.claude/sessions/<pid>.json ({pid, sessionId, name, status, …}).
 *
 * Hooks can't report a crash: a killed or crashed session never sends
 * SessionEnd, so without this it lingers (waiting for 30 min, then idle for
 * 15 more). And a single long tool call sends no hook events, so a session
 * can look stale while Claude Code reports it busy.
 */

/** A session whose process has been gone this long, with no SessionEnd, is ended. */
export const DEAD_SESSION_GRACE_MS = 120_000;

export interface ClaudeProcess {
  pid: number;
  sessionId: string;
  /** Claude Code's session name, e.g. "documents-07". */
  name?: string;
  /** Claude Code's own status: "busy" | "idle" | "shell" (idle, background shells running) | … */
  status?: string;
}

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/**
 * Live Claude Code processes keyed by sessionId (files whose pid is alive).
 * Undefined when the sessions directory can't be read: liveness is unknown,
 * so nothing may be reaped.
 */
export function readLiveClaudeSessions(
  claudeDir = claudeConfigDir(),
  alive: (pid: number) => boolean = isProcessAlive,
): Map<string, ClaudeProcess> | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(claudeDir, "sessions"));
  } catch {
    return undefined;
  }
  const live = new Map<string, ClaudeProcess>();
  for (const file of names) {
    if (!file.endsWith(".json")) continue;
    try {
      const info = JSON.parse(
        fs.readFileSync(path.join(claudeDir, "sessions", file), "utf8"),
      ) as Record<string, unknown>;
      const { pid, sessionId, name, status } = info;
      if (typeof pid !== "number" || typeof sessionId !== "string" || !alive(pid)) continue;
      live.set(sessionId, {
        pid,
        sessionId,
        name: typeof name === "string" && name ? name.slice(0, 120) : undefined,
        status: typeof status === "string" ? status : undefined,
      });
    } catch {
      // half-written or foreign file: skip
    }
  }
  return live;
}

export interface LivenessActions {
  /** Session keys whose process is gone past the grace period: end them. */
  reap: string[];
  /** Working sessions Claude Code reports busy: keep them from going stale. */
  touch: string[];
  /** Session names learned from Claude Code: [key, name]. */
  names: Array<[string, string]>;
}

/**
 * Pure decision step, run on a timer by the daemon. A session is reaped only
 * after its process was seen alive at least once and then missing for
 * `graceMs`: sessions that never show up in the sessions dir (an older Claude
 * Code, another config dir) are left to the normal staleness sweep.
 */
export class ClaudeLiveness {
  /** session key → last time its process was seen alive */
  private readonly lastSeen = new Map<string, number>();

  constructor(private readonly graceMs = DEAD_SESSION_GRACE_MS) {}

  step(
    sessions: readonly AgentSession[],
    live: Map<string, ClaudeProcess> | undefined,
    now: number,
  ): LivenessActions {
    const out: LivenessActions = { reap: [], touch: [], names: [] };
    if (!live) return out;
    const present = new Set<string>();
    for (const s of sessions) {
      if (s.source !== "claude-code") continue;
      present.add(s.key);
      const proc = live.get(s.sessionId);
      if (proc) {
        this.lastSeen.set(s.key, now);
        if (proc.name && proc.name !== s.name) out.names.push([s.key, proc.name]);
        if (s.state === "working" && (proc.status === "busy" || proc.status === "shell")) {
          out.touch.push(s.key);
        }
        continue;
      }
      const seen = this.lastSeen.get(s.key);
      if (seen !== undefined && now - seen > this.graceMs) {
        out.reap.push(s.key);
        this.lastSeen.delete(s.key);
      }
    }
    for (const key of this.lastSeen.keys()) {
      if (!present.has(key)) this.lastSeen.delete(key);
    }
    return out;
  }
}

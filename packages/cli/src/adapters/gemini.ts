import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionEvent } from "@workmesh/core";

/**
 * Gemini CLI watcher adapter (SPEC §62): polls `~/.gemini/tmp/<hash>/chats/session-*.json`
 * read-only and reports recently updated Gemini CLI sessions into the Workmesh daemon.
 * Degrades to a no-op when `~/.gemini/tmp` is absent.
 */

export interface GeminiWatcher {
  stop(): void;
}

export interface GeminiWatcherOptions {
  dir?: string;
  intervalMs?: number;
  activeWindowMs?: number;
  idleWindowMs?: number;
  onEvent: (event: SessionEvent) => void;
  log?: (message: string) => void;
}

export function defaultGeminiDir(home = os.homedir()): string {
  return path.join(home, ".gemini");
}

interface GeminiSessionHit {
  id: string;
  mtimeMs: number;
  cwd?: string;
  project?: string;
  activity?: string;
}

function scanGeminiSessions(baseDir: string, idleCutoffMs: number): GeminiSessionHit[] {
  const tmpDir = path.join(baseDir, "tmp");
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const hits: GeminiSessionHit[] = [];
  for (const dirent of projectDirs) {
    if (!dirent.isDirectory()) continue;
    const chatsDir = path.join(tmpDir, dirent.name, "chats");
    let files: string[];
    try {
      files = fs.readdirSync(chatsDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.startsWith("session-") || !file.endsWith(".json")) continue;
      const full = path.join(chatsDir, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs < idleCutoffMs) continue;
      const id = file.slice("session-".length, -".json".length);
      let cwd: string | undefined;
      let activity: string | undefined;
      try {
        if (stat.size <= 512 * 1024) {
          const parsed = JSON.parse(fs.readFileSync(full, "utf8")) as Record<string, unknown>;
          if (typeof parsed.projectRoot === "string" && parsed.projectRoot) cwd = parsed.projectRoot;
          else if (typeof parsed.cwd === "string" && parsed.cwd) cwd = parsed.cwd;
          if (typeof parsed.summary === "string" && parsed.summary.trim()) {
            activity = parsed.summary.trim().slice(0, 120);
          }
        }
      } catch {
        // Ignore partial writes while Gemini CLI is actively flushing.
      }
      hits.push({
        id,
        mtimeMs: stat.mtimeMs,
        cwd,
        project: cwd ? path.basename(cwd) : undefined,
        activity,
      });
    }
  }
  return hits;
}

export function createGeminiWatcher(opts: GeminiWatcherOptions): GeminiWatcher {
  const baseDir = opts.dir ?? defaultGeminiDir();
  const intervalMs = opts.intervalMs ?? 8000;
  const activeWindowMs = opts.activeWindowMs ?? 90_000;
  const idleWindowMs = opts.idleWindowMs ?? 15 * 60_000;
  const seen = new Map<string, { kind: "working" | "idle"; mtimeMs: number }>();
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    const now = Date.now();
    const hits = scanGeminiSessions(baseDir, now - idleWindowMs);
    const alive = new Set<string>();
    for (const hit of hits) {
      alive.add(hit.id);
      const kind: "working" | "idle" = now - hit.mtimeMs <= activeWindowMs ? "working" : "idle";
      const prev = seen.get(hit.id);
      if (prev && prev.kind === kind && prev.mtimeMs === hit.mtimeMs) continue;
      seen.set(hit.id, { kind, mtimeMs: hit.mtimeMs });
      opts.onEvent({
        source: "gemini-cli",
        sessionId: hit.id,
        kind,
        ...(hit.cwd ? { cwd: hit.cwd } : {}),
        ...(hit.project ? { project: hit.project } : {}),
        ...(hit.activity ? { activity: hit.activity } : {}),
        ts: Math.round(hit.mtimeMs),
      });
    }
    for (const [id] of seen) {
      if (!alive.has(id)) {
        seen.delete(id);
        opts.onEvent({ source: "gemini-cli", sessionId: id, kind: "end", ts: now });
      }
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

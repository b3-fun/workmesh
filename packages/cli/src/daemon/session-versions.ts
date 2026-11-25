import { readStateFile, writeStateFile } from "../hub/persist";
import { isNewer, parseVersion } from "../lib/versions";

/**
 * Sessions that started before Workmesh was updated (SPEC §41). Hook commands run the files on disk, so they're new at
 * once; but the `workmesh mcp` server a session started keeps running the old code until the session restarts, so a
 * session that started under an older Workmesh lacks the new tools. The session's next hook that can carry context
 * says so, once.
 *
 * What a session started under: its SessionStart hook (a new process: `startup` or `resume`) sends the hook's version
 * and surface fingerprint (lib/surface.ts). For a session the daemon has no record of, a Claude Code process that
 * started before this version first ran here counts as started under the previous one. Two versions with the same
 * surface gave sessions the same tools: no note.
 */

/** Records kept this long after their last use. */
const KEEP_MS = 14 * 24 * 3600_000;
const MAX_SESSIONS = 3000;
const SAVE_EVERY_MS = 1000;

export interface RunningVersion {
  current: string;
  /** When this version first ran on this machine (epoch ms). */
  since: number;
  surface: string;
  previous?: string;
  previousSurface?: string;
}

interface SessionRecord {
  /** The Workmesh version the session started under (its SessionStart hook's). */
  v?: string;
  surface?: string;
  /** Last touched. */
  at: number;
  /** The version it was told about. */
  noted?: string;
}

export interface SessionVersionsOptions {
  file?: string;
  current: string;
  surface: string;
  now?: () => number;
  /** The agent's own name for the note's advice (Claude Code, Codex). */
  advice?: (source: string) => string;
}

/** Which SessionStart sources start a new agent process (with new MCP servers): Claude Code's and Codex's. */
const NEW_PROCESS_STARTS = new Set(["startup", "resume"]);

export class SessionVersions {
  private readonly file: string | undefined;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionRecord>();
  readonly running: RunningVersion;
  private dirty = false;
  private savedAt = 0;
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly advice: (source: string) => string;

  constructor(opts: SessionVersionsOptions) {
    this.file = opts.file;
    this.now = opts.now ?? Date.now;
    this.advice = opts.advice ?? staleAdvice;
    const raw = (opts.file ? readStateFile(opts.file) : undefined) as { version?: Partial<RunningVersion>; sessions?: Record<string, SessionRecord> } | undefined;
    const prev = raw?.version;
    const now = this.now();
    if (prev && prev.current === opts.current && typeof prev.since === "number" && prev.surface === opts.surface) {
      this.running = {
        current: opts.current,
        since: prev.since,
        surface: opts.surface,
        ...(prev.previous && parseVersion(prev.previous) ? { previous: prev.previous } : {}),
        ...(typeof prev.previousSurface === "string" ? { previousSurface: prev.previousSurface } : {}),
      };
    } else {
      // A new version (or a first run of a version that keeps this file): it starts now.
      this.running = {
        current: opts.current,
        since: now,
        surface: opts.surface,
        ...(prev?.current && parseVersion(prev.current) ? { previous: prev.current } : {}),
        ...(typeof prev?.surface === "string" ? { previousSurface: prev.surface } : {}),
      };
      this.dirty = true;
    }
    for (const [key, rec] of Object.entries(raw?.sessions ?? {})) {
      if (!rec || typeof rec !== "object" || typeof rec.at !== "number" || now - rec.at > KEEP_MS) continue;
      this.sessions.set(key, {
        at: rec.at,
        ...(typeof rec.v === "string" && parseVersion(rec.v) ? { v: rec.v } : {}),
        ...(typeof rec.surface === "string" ? { surface: rec.surface.slice(0, 64) } : {}),
        ...(typeof rec.noted === "string" && parseVersion(rec.noted) ? { noted: rec.noted } : {}),
      });
    }
    if (this.dirty) this.save(true);
  }

  /**
   * A SessionStart hook: a new process (`startup`, `resume`, or a hook that didn't say) records the version its hook
   * ran; `/clear` and compaction keep the process, so they keep what was recorded.
   */
  observeStart(key: string, start: { source?: string; version?: string; surface?: string }): void {
    if (start.source && !NEW_PROCESS_STARTS.has(start.source)) return;
    if (!start.version || !parseVersion(start.version)) return;
    const rec: SessionRecord = { v: start.version, at: this.now(), ...(start.surface ? { surface: start.surface.slice(0, 64) } : {}) };
    const old = this.sessions.get(key);
    if (old?.noted) rec.noted = old.noted;
    this.sessions.set(key, rec);
    this.trim();
    this.save();
  }

  /** Whether the session runs older tools than this daemon's, and the version it started under ("older" if unknown). */
  stale(key: string, processStartedAt?: number): { from?: string } | undefined {
    const r = this.running;
    const rec = this.sessions.get(key);
    if (rec?.v) {
      if (!isNewer(r.current, rec.v)) return undefined;
      if (rec.surface && rec.surface === r.surface) return undefined;
      return { from: rec.v };
    }
    if (processStartedAt === undefined || processStartedAt >= r.since) return undefined;
    // Started before this version ran here: under the previous one (or, with no record of one, an older Workmesh).
    if (r.previous && !isNewer(r.current, r.previous)) return undefined;
    if (r.previousSurface && r.previousSurface === r.surface) return undefined;
    return r.previous ? { from: r.previous } : {};
  }

  /** The note for a stale session, once per session and version; undefined otherwise. */
  note(key: string, source: string, processStartedAt?: number): string | undefined {
    const rec = this.sessions.get(key);
    if (rec?.noted && !isNewer(this.running.current, rec.noted)) return undefined;
    const st = this.stale(key, processStartedAt);
    if (!st) return undefined;
    this.sessions.set(key, { ...(rec ?? {}), at: this.now(), noted: this.running.current });
    this.trim();
    this.save();
    return staleNote(this.running.current, st.from, this.advice(source));
  }

  /** Drops records past their keep time or over the cap (oldest first). */
  private trim(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const now = this.now();
    for (const [k, r] of this.sessions) if (now - r.at > KEEP_MS) this.sessions.delete(k);
    const extra = this.sessions.size - MAX_SESSIONS;
    if (extra > 0) [...this.sessions.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, extra).forEach(([k]) => this.sessions.delete(k));
  }

  /** Saves at most once a second (a timer catches the last change). */
  save(force = false): void {
    this.dirty = true;
    if (!this.file) return;
    const now = this.now();
    if (!force && now - this.savedAt < SAVE_EVERY_MS) {
      if (!this.saveTimer) {
        this.saveTimer = setTimeout(() => {
          this.saveTimer = undefined;
          this.save(true);
        }, SAVE_EVERY_MS);
        this.saveTimer.unref();
      }
      return;
    }
    this.savedAt = now;
    this.dirty = false;
    try {
      writeStateFile(this.file, { version: this.running, sessions: Object.fromEntries(this.sessions) });
    } catch {
      // best effort: the worst case is a note said twice
    }
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (this.dirty) this.save(true);
  }
}

/**
 * What reloads, verified live on Claude Code 2.1.332 and Codex 0.164 (SPEC §41; evidence in the 0.12 PR): Claude Code
 * picks up hooks added to settings.json within seconds, and `/mcp reconnect <server>` (or the /mcp menu's Reconnect)
 * starts a new MCP process from the files on disk, but `/clear` keeps the old one. A Codex thread keeps the MCP server
 * and hooks it started with; Codex has no MCP reconnect, and a new thread (`/new`, or a new `codex`) gets new ones.
 */
export function staleAdvice(source: string): string {
  if (source === "codex") {
    return "This thread keeps the older Workmesh MCP server and hooks (Codex can't reconnect an MCP server): start a new thread (/new, or a new codex) for the new tools.";
  }
  return "Its hooks are already current, but this session's Workmesh MCP server is the older one: run `/mcp reconnect workmesh`, or start a new session, for the new tools (/clear doesn't restart it).";
}

export function staleNote(current: string, from: string | undefined, advice: string): string {
  return `Workmesh was updated to ${current} ${from ? `(this session started under ${from})` : "after this session started"}. ${advice}`;
}

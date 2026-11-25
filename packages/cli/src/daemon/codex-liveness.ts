import fs from "node:fs";
import path from "node:path";
import type { SessionEvent } from "@workmesh/core";
import { codexHomeOfRollout } from "../hub/agents";
import { codexHome } from "../lib/paths";

/**
 * Codex SessionEnd that isn't an end (docs/SPEC.md §31). Codex 0.164+ runs threads in a shared app-server daemon per
 * Codex home; the TUI is its client. When that daemon restarts (it updates itself: 0.164 → 0.172 live on 11-25) it
 * unloads every thread, firing SessionEnd, and the open TUI resumes the thread on the new daemon a second or two
 * later, firing nothing. Taken at its word, the board showed the session ended and the daemon stopped waking it until
 * its person typed again. So a Codex SessionEnd waits a short grace; if by then Codex holds the thread again (its
 * writer lock, `<home>/thread-writer-locks/<id>.lock`, made at or after the end), the session stays, as idle.
 * Quitting the TUI fires no SessionEnd at all (the daemon keeps the thread), so an idle Codex session ends when its
 * thread is unloaded for good, or when it goes quiet long enough to be swept.
 */

export const CODEX_END_GRACE_MS = 10_000;
/** File times on some filesystems round to whole seconds. */
const LOCK_CLOCK_SLACK_MS = 2_000;

/** Whether Codex loaded the thread again at or after `since`: its writer lock exists and was made since then. */
export function codexThreadReloaded(home: string, threadId: string, since: number): boolean {
  if (!/^[\w-]{8,128}$/.test(threadId)) return false;
  try {
    const st = fs.statSync(path.join(home, "thread-writer-locks", `${threadId}.lock`));
    return st.mtimeMs >= since - LOCK_CLOCK_SLACK_MS;
  } catch {
    return false;
  }
}

export interface CodexEndGuardDeps {
  /** Applies an event past the guard. */
  apply: (event: SessionEvent) => void;
  /** The Codex home when the event's rollout path doesn't say (default: $CODEX_HOME or ~/.codex). */
  home?: () => string;
  reloaded?: (home: string, threadId: string, since: number) => boolean;
  graceMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export class CodexEndGuard {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly graceMs: number;

  constructor(private readonly deps: CodexEndGuardDeps) {
    this.graceMs = deps.graceMs ?? CODEX_END_GRACE_MS;
  }

  /**
   * True when the guard took the event: a Codex SessionEnd, applied after the grace unless the thread came back. A
   * hook event from the same thread meanwhile (it is plainly alive) drops the pending end.
   */
  intercept(event: SessionEvent): boolean {
    if (event.source !== "codex") return false;
    const key = `codex:${event.sessionId}`;
    if (event.kind !== "end") {
      const hookEvent = event.detail?.hookEvent;
      if (hookEvent && hookEvent !== "notify") this.cancel(key);
      return false;
    }
    if (this.pending.has(key)) return true; // Codex can fire it twice
    const since = (this.deps.now ?? Date.now)();
    const home = codexHomeOfRollout(event.detail?.transcriptPath) ?? (this.deps.home ?? codexHome)();
    const timer = setTimeout(() => {
      if (this.pending.get(key) !== timer) return;
      this.pending.delete(key);
      if ((this.deps.reloaded ?? codexThreadReloaded)(home, event.sessionId, since)) {
        this.deps.log?.(`codex ${event.sessionId.slice(0, 8)}: thread reloaded after its SessionEnd (Codex's app server restarted); kept`);
        // The rollout path stays (local only): the forwarder keeps tailing the thread and reads its name again.
        const transcriptPath = event.detail?.transcriptPath;
        this.deps.apply({
          ...event,
          kind: "idle",
          activity: undefined,
          detail: transcriptPath ? { transcriptPath } : undefined,
          ts: (this.deps.now ?? Date.now)(),
        });
        return;
      }
      this.deps.apply(event);
    }, this.graceMs);
    timer.unref?.();
    this.pending.set(key, timer);
    return true;
  }

  /** Ends still waiting (tests, /hub). */
  waiting(): number {
    return this.pending.size;
  }

  stop(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  private cancel(key: string): void {
    const t = this.pending.get(key);
    if (t === undefined) return;
    clearTimeout(t);
    this.pending.delete(key);
  }
}

import { execFile } from "node:child_process";
import path from "node:path";
import type { SessionEvent } from "@workmesh/core";

/**
 * Harness bridge adapter: polls `harness ps --json` and forwards non-Claude/non-Codex
 * Harness sessions (`antigravity`/`agy`, `grok`, `opencode`, `cursor-agent`, etc.) into
 * the Workmesh daemon so Workmesh, Slack (`agentblip`), and `studio-pixbar` automatically
 * see every Harness-managed CLI without duplicating native Claude/Codex hooks.
 */

export interface HarnessWatcher {
  stop(): void;
}

export interface HarnessWatcherOptions {
  bin?: string;
  intervalMs?: number;
  onEvent: (event: SessionEvent) => void;
  log?: (message: string) => void;
}

interface HarnessEntry {
  id?: string;
  name?: string;
  agent?: string;
  state?: string;
  folder?: string;
  lastActive?: string;
  about?: string;
}

function normalizeSource(agent: string | undefined): string | undefined {
  const a = (agent ?? "").toLowerCase().trim();
  if (!a) return undefined;
  // Skip Claude Code and Codex — Workmesh already tracks them with richer native hooks.
  if (a.includes("claude") || a.includes("codex")) return undefined;
  if (a.includes("antigravity") || a === "agy") return "antigravity";
  if (a.includes("gemini")) return "gemini-cli";
  if (a.includes("grok")) return "grok";
  if (a.includes("opencode")) return "opencode";
  if (a.includes("cursor")) return "cursor";
  if (a.includes("copilot")) return "copilot";
  if (a.includes("windsurf")) return "windsurf";
  if (a === "amp" || a.includes("sourcegraph")) return "amp";
  if (a.includes("aider")) return "aider";
  if (a.includes("cline")) return "cline";
  if (a.includes("zed")) return "zed";
  return a.replace(/[^a-z0-9_-]+/g, "-").slice(0, 32) || undefined;
}

function mapState(state: string | undefined): "working" | "waiting" | "idle" | "end" {
  const s = (state ?? "").toLowerCase();
  if (s === "working" || s === "starting" || s === "installing") return "working";
  if (s === "needs the person" || s === "held") return "waiting";
  if (s === "closed" || s === "gone" || s === "stopped" || s === "failed") return "end";
  return "idle";
}

function pollHarness(bin: string): Promise<HarnessEntry[]> {
  return new Promise((resolve) => {
    execFile(bin, ["ps", "--json"], { timeout: 3000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve([]);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { harnesses?: unknown };
        resolve(Array.isArray(parsed?.harnesses) ? (parsed.harnesses as HarnessEntry[]) : []);
      } catch {
        resolve([]);
      }
    });
  });
}

export function createHarnessWatcher(opts: HarnessWatcherOptions): HarnessWatcher {
  const bin = opts.bin ?? "harness";
  const intervalMs = opts.intervalMs ?? 8000;
  const seen = new Map<string, { source: string; kind: string; lastActive: string }>();
  let stopped = false;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const list = await pollHarness(bin);
      const now = Date.now();
      const alive = new Set<string>();
      for (const h of list) {
        if (!h?.id) continue;
        const source = normalizeSource(h.agent);
        if (!source) continue;
        const kind = mapState(h.state);
        if (kind === "end") continue;
        alive.add(h.id);
        const lastActive = h.lastActive ?? "";
        const prev = seen.get(h.id);
        if (prev && prev.kind === kind && prev.lastActive === lastActive) continue;
        seen.set(h.id, { source, kind, lastActive });
        const ts = lastActive ? Date.parse(lastActive) || now : now;
        const project = h.folder ? path.basename(h.folder) : undefined;
        const activity = (h.about || h.name || "").split("\n")[0]?.trim().slice(0, 120) || undefined;
        opts.onEvent({
          source,
          sessionId: h.id,
          kind,
          ...(h.folder ? { cwd: h.folder } : {}),
          ...(project ? { project } : {}),
          ...(h.name ? { name: h.name.slice(0, 80) } : {}),
          ...(activity ? { activity } : {}),
          ts,
        });
      }
      for (const [id, prev] of seen) {
        if (!alive.has(id)) {
          seen.delete(id);
          opts.onEvent({ source: prev.source, sessionId: id, kind: "end", ts: now });
        }
      }
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

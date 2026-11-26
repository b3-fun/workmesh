import fs from "node:fs";
import { loadConfig, loadConfigSafe, messageSettings, saveConfig } from "../lib/config";
import type { MessageWakeRule } from "../lib/config";
import { isDaemonUp, wakeWait } from "../lib/daemon-client";
import { bold, dim, green } from "../lib/ui";
import { readStdin } from "./hook";
import { WAKE_WINDOW_SEC } from "../adapters/claude-code";

/**
 * v2 wake (docs/SPEC.md §31), Claude Code: an `asyncRewake` Stop hook. Claude Code runs it in the background when a
 * turn ends; it long-polls the daemon for this session's next waking message (a teammate's message, an approval
 * decided, a handoff finished) and exits 2 with it on stderr, which Claude Code shows the model as a system reminder
 * and so wakes the idle session. It exits 0 when the session ends, another waiter takes over, the daemon is gone, or
 * after its window; the next Stop arms a new one. It never fails the session: every error exits 0.
 */

/** How long one waiter waits: just under the hook's `timeout` (WAKE_WINDOW_SEC), which Claude Code enforces. */
const WINDOW_MS = (WAKE_WINDOW_SEC - 60) * 1000;
const POLL_MS = 55_000;
/** The oldest Claude Code verified to run `asyncRewake` hooks in the background (2.1.330–2.1.332 on disk, 11-25). */
export const MIN_CLAUDE_VERSION = [2, 1, 330] as const;

/** The Claude Code version a transcript was written by: its newest `"version":"x.y.z"`. */
export function transcriptVersion(file: string | undefined, maxBytes = 2 * 1024 * 1024): [number, number, number] | undefined {
  if (!file) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const chunk = 256 * 1024;
    for (let end = size; end > 0 && size - end < maxBytes; end -= chunk) {
      const start = Math.max(0, end - chunk - 64);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const all = [...buf.toString("utf8").matchAll(/"version":"(\d+)\.(\d+)\.(\d+)"/g)];
      const last = all.at(-1);
      if (last) return [Number(last[1]), Number(last[2]), Number(last[3])];
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return undefined;
}

export function versionAtLeast(v: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const a = v[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * A Claude Code session nobody sits at: a Workmesh handoff's agent (`WORKMESH_HANDOFF`), or one started by `claude -p`
 * or an SDK (`CLAUDE_CODE_ENTRYPOINT` sdk-cli, sdk-ts, sdk-py; interactive sessions say cli, or an editor's name).
 */
export function isHeadless(env: NodeJS.ProcessEnv): boolean {
  if (env.WORKMESH_HANDOFF) return true;
  const entry = env.CLAUDE_CODE_ENTRYPOINT ?? "";
  return /^sdk/i.test(entry) || entry === "mcp";
}

export interface WakeWaitDeps {
  env?: NodeJS.ProcessEnv;
  stdin?: () => Promise<string>;
  wait?: typeof wakeWait;
  daemonUp?: (port: number) => Promise<boolean>;
  stderr?: (text: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  windowMs?: number;
  /** The process that ran the hook; a change means it is gone. */
  parentPid?: () => number;
}

/** Runs one waiter; resolves with its exit code (0 or 2). Never throws. */
export async function wakeWaitOnce(source: string, deps: WakeWaitDeps = {}): Promise<number> {
  try {
    if (source !== "claude-code") return 0;
    const raw = await (deps.stdin ?? (() => readStdin(1000)))();
    if (!raw.trim()) return 0;
    const input = JSON.parse(raw) as { session_id?: unknown; transcript_path?: unknown; hook_event_name?: unknown };
    if (input.hook_event_name !== undefined && input.hook_event_name !== "Stop") return 0;
    const sessionId = typeof input.session_id === "string" && /^[\w-]{1,128}$/.test(input.session_id) ? input.session_id : undefined;
    if (!sessionId) return 0;
    // Headless runs (`claude -p`, the SDK, a handoff's agent) end when their turn does: a waiter would hold them open
    // (Claude Code waits for an asyncRewake hook before a print-mode run exits), and nobody is there to wake.
    if (isHeadless(deps.env ?? process.env)) return 0;
    // An older Claude Code that doesn't know asyncRewake would run this in the foreground and hold the turn's end:
    // wait only when the transcript says a version that runs it in the background.
    const version = transcriptVersion(typeof input.transcript_path === "string" ? input.transcript_path : undefined);
    if (!version || !versionAtLeast(version, MIN_CLAUDE_VERSION)) return 0;
    const config = loadConfigSafe();
    if (config.wake === false || !config.hub) return 0;
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const parent = deps.parentPid ?? (() => process.ppid);
    const firstParent = parent();
    const deadline = now() + (deps.windowMs ?? WINDOW_MS);
    const key = `claude-code:${sessionId}`;
    let downSince: number | undefined;
    while (now() < deadline) {
      if (parent() !== firstParent) return 0;
      if (!(await (deps.daemonUp ?? isDaemonUp)(config.port))) {
        downSince ??= now();
        if (now() - downSince > 5 * 60_000) return 0;
        await sleep(10_000);
        continue;
      }
      downSince = undefined;
      let answer: { wake?: string; end?: boolean };
      try {
        answer = await (deps.wait ?? wakeWait)(config.port, key, Math.min(POLL_MS, Math.max(1000, deadline - now())));
      } catch {
        // A daemon without /wake/wait (older), or a restart mid-poll: try again shortly, within the window.
        await sleep(15_000);
        continue;
      }
      if (answer.wake) {
        (deps.stderr ?? ((t: string) => fs.writeSync(2, t)))(`${answer.wake}\n`);
        return 2;
      }
      if (answer.end) return 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

/** `workmesh wake-wait claude-code`: the hook entry point. */
export async function runWakeWait(source: string): Promise<void> {
  const code = await wakeWaitOnce(source);
  process.exit(code);
}

/** Whose messages a wake rule lets start a turn (SPEC §23), as `workmesh wake` says it. */
export function wakeRuleText(rule: MessageWakeRule): string {
  if (rule === "team") return "any teammate's message";
  if (rule === "self") return "your own messages only";
  if (Array.isArray(rule)) return `your own messages, and messages from ${rule.join(", ")}`;
  return "your own messages, and a reply to a message the session sent";
}

/**
 * `workmesh wake [on|off|replies|team|self]`: show or set whether idle sessions are woken (`wake`), and whose
 * messages may wake them (`messages.wake`). This machine decides: a sender can only ask.
 */
export async function runWake(value?: string): Promise<void> {
  const config = loadConfig();
  const current = config.wake ?? true;
  const rule = messageSettings(config).wake;
  if (value === undefined) {
    console.log(
      `${bold(current ? "on" : "off")} — ${current ? `an idle session starts a turn for ${wakeRuleText(rule)}, and for an approval or a handoff result` : "messages wait for the session's next turn"}`,
    );
    console.log(dim(`  who may wake: ${Array.isArray(rule) ? "a list of people" : rule} (workmesh wake replies | team | self; a list of people goes in the config file as messages.wake)`));
    return;
  }
  const v = value.trim().toLowerCase();
  if (v === "replies" || v === "team" || v === "self") {
    config.messages = { ...config.messages, wake: v };
    saveConfig(config);
    console.log(green(`who may wake: ${v}`));
    console.log(dim(`  an idle session starts a turn for ${wakeRuleText(v)}; takes effect within a few seconds`));
    return;
  }
  if (!["on", "off", "true", "false", "yes", "no"].includes(v)) throw new Error(`unknown value "${value}" — use on, off, replies, team or self`);
  const next = v === "on" || v === "true" || v === "yes";
  config.wake = next;
  saveConfig(config);
  console.log(green(`wake ${next ? "on" : "off"}`));
  console.log(dim("  takes effect at each session's next turn end"));
}

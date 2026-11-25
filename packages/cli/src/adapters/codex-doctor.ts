import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_HOOK_EVENTS, isOurCodexHook } from "./codex";
import { OUR_COMMAND_RE } from "../lib/names";

/**
 * What `workmesh doctor` reports about Codex beyond "the files are there" (docs/SPEC.md §31): whether Codex trusts
 * Workmesh's hooks (it runs an untrusted or changed hook not at all), and where the notify fallback really points.
 */

export type CodexTrustStatus = "trusted" | "untrusted" | "modified" | "disabled";

export interface CodexHookTrust {
  /** `codex`: Codex's own answer (`hooks/list` on its app server); `config`: read from config.toml. */
  source: "codex" | "config";
  /** Workmesh's hooks Codex found, by event. */
  hooks: Array<{ event: string; status: CodexTrustStatus }>;
}

/** Codex's event key (`PreToolUse` → `pre_tool_use`), as its hook state keys spell it. */
export function codexEventKey(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** One line summary of the trust state, and whether it is all good. */
export function describeCodexTrust(t: CodexHookTrust): { ok: boolean; text: string } {
  const total = t.hooks.length;
  if (total === 0) return { ok: false, text: "Codex finds none of Workmesh's hooks" };
  const not = t.hooks.filter((h) => h.status !== "trusted");
  const via = t.source === "codex" ? "Codex says" : "config.toml says";
  if (not.length === 0) return { ok: true, text: `${via} all ${total} trusted` };
  const by = (s: CodexTrustStatus) => t.hooks.filter((h) => h.status === s).map((h) => h.event);
  const parts: string[] = [];
  if (by("untrusted").length) parts.push(`${by("untrusted").length} not trusted yet`);
  if (by("modified").length) parts.push(`${by("modified").length} changed since you trusted them`);
  if (by("disabled").length) parts.push(`${by("disabled").length} turned off`);
  const fix = by("disabled").length === not.length ? "turn them on in Codex's /hooks" : "open Codex and run /hooks to trust them";
  return { ok: false, text: `${via} ${parts.join(", ")} (of ${total}): Codex skips them until then — ${fix}` };
}

/**
 * Trust read from config.toml when Codex itself can't be asked: `[hooks.state."<hooks.json>:<event>:<group>:<hook>"]`
 * tables with a `trusted_hash`. It can't tell a hook changed since (Codex hashes a normalized form of it), so a
 * hash present reads as trusted.
 */
export function codexTrustFromConfig(hooksPath: string, hooksJson: string, configToml: string): CodexHookTrust {
  const state = parseHookState(configToml);
  let real = hooksPath;
  try {
    real = fs.realpathSync(hooksPath);
  } catch {
    // keep the path as given
  }
  const hooks: CodexHookTrust["hooks"] = [];
  let doc: { hooks?: Record<string, unknown> } = {};
  try {
    doc = JSON.parse(hooksJson) as typeof doc;
  } catch {
    return { source: "config", hooks };
  }
  for (const event of CODEX_HOOK_EVENTS) {
    const groups = doc.hooks?.[event];
    if (!Array.isArray(groups)) continue;
    groups.forEach((g, gi) => {
      const list = (g as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(list)) return;
      list.forEach((h, hi) => {
        if (!isOurCodexHook((h as { command?: unknown } | null)?.command)) return;
        const s = state.get(`${real}:${codexEventKey(event)}:${gi}:${hi}`) ?? state.get(`${hooksPath}:${codexEventKey(event)}:${gi}:${hi}`);
        hooks.push({ event, status: s?.enabled === false ? "disabled" : s?.trusted ? "trusted" : "untrusted" });
      });
    });
  }
  return { source: "config", hooks };
}

/** `[hooks.state."<key>"]` tables: whether each carries a trusted hash, and `enabled`. */
export function parseHookState(toml: string): Map<string, { trusted: boolean; enabled?: boolean }> {
  const out = new Map<string, { trusted: boolean; enabled?: boolean }>();
  let cur: { trusted: boolean; enabled?: boolean } | undefined;
  for (const line of toml.split("\n")) {
    const header = /^\s*\[\s*hooks\.state\."((?:[^"\\]|\\.)*)"\s*\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      cur = { trusted: false };
      out.set(header[1]!.replace(/\\(["\\])/g, "$1"), cur);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      cur = undefined;
      continue;
    }
    if (!cur) continue;
    if (/^\s*trusted_hash\s*=\s*"sha256:[0-9a-f]+/.test(line)) cur.trusted = true;
    const en = /^\s*enabled\s*=\s*(true|false)\b/.exec(line);
    if (en) cur.enabled = en[1] === "true";
  }
  return out;
}

/** Codex's `hooks/list` answer, reduced to Workmesh's hooks. */
export function codexTrustFromList(entries: unknown): CodexHookTrust | undefined {
  if (!Array.isArray(entries)) return undefined;
  const hooks: CodexHookTrust["hooks"] = [];
  for (const e of entries) {
    const h = e as { command?: unknown; eventName?: unknown; trustStatus?: unknown; enabled?: unknown } | null;
    if (!h || !isOurCodexHook(h.command)) continue;
    const name = typeof h.eventName === "string" ? h.eventName : "?";
    const event = name.charAt(0).toUpperCase() + name.slice(1);
    const raw = typeof h.trustStatus === "string" ? h.trustStatus : "untrusted";
    const status: CodexTrustStatus =
      h.enabled === false ? "disabled" : raw === "trusted" || raw === "managed" ? "trusted" : raw === "modified" ? "modified" : "untrusted";
    hooks.push({ event, status });
  }
  return { source: "codex", hooks };
}

/**
 * Asks Codex which hooks it would run and whether each is trusted: `codex app-server` over stdio, `initialize`, then
 * `hooks/list` (codex-cli 0.164+; what its TUI's /hooks reads). Undefined when Codex can't answer in time (an older
 * build, no binary); the caller falls back to config.toml.
 */
export function askCodexHooks(opts: { bin: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<unknown[] | undefined> {
  return new Promise((resolve) => {
    let done = false;
    let buf = "";
    const child = spawn(opts.bin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], env: opts.env ?? process.env });
    const finish = (v: unknown[] | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // gone already
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(undefined), opts.timeoutMs ?? 8000);
    child.on("error", () => finish(undefined));
    child.on("exit", () => finish(undefined));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > 4 * 1024 * 1024) return finish(undefined);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { id?: unknown; result?: { data?: Array<{ hooks?: unknown[] }> }; error?: unknown };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue;
        }
        if (msg.id === 1) {
          write({ jsonrpc: "2.0", method: "initialized" });
          write({ jsonrpc: "2.0", id: 2, method: "hooks/list", params: { cwds: [opts.cwd ?? os.homedir()] } });
        } else if (msg.id === 2) {
          finish(msg.error ? undefined : (msg.result?.data?.[0]?.hooks ?? undefined));
        }
      }
    });
    const write = (m: unknown): void => {
      try {
        child.stdin.write(`${JSON.stringify(m)}\n`);
      } catch {
        finish(undefined);
      }
    };
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "workmesh-doctor", version: "1" } } });
  });
}

export interface CodexNotifyState {
  /** `direct`: Codex runs Workmesh's notify; `chained`: another program's notify passes the turn on to it. */
  kind: "none" | "direct" | "chained" | "other";
  /** The program that owns the notify line when chained (e.g. Codex Computer Use's client). */
  via?: string;
  /** The Workmesh CLI the notify runs (its dist/index.js, or a bare command name). */
  target?: string;
}

/**
 * Where `notify` in config.toml leads. Workmesh's own line runs `[node, cli, "hook", "codex"]`; other tools (Codex
 * Computer Use) put theirs first and pass the previous notify on as a JSON array in one argument, which may still
 * name an old checkout (live on Sean's Mac: the pre-rename agentblip path).
 */
export function codexNotifyState(configToml: string): CodexNotifyState {
  const line = configToml.split("\n").find((l) => /^\s*notify\s*=/.test(l));
  if (!line) return { kind: "none" };
  const argv = parseArgv(line.replace(/^\s*notify\s*=\s*/, "").replace(/\s+#.*$/, ""));
  if (!argv) return { kind: OUR_COMMAND_RE.test(line) ? "chained" : "other" };
  const ours = ourNotify(argv);
  if (ours) return { kind: "direct", target: ours };
  for (const arg of argv) {
    if (!arg.trimStart().startsWith("[")) continue;
    const inner = parseArgv(arg);
    const t = inner ? ourNotify(inner) : undefined;
    if (t) return { kind: "chained", via: path.basename(argv[0] ?? ""), target: t };
  }
  return { kind: "other", via: path.basename(argv[0] ?? "") };
}

function parseArgv(text: string): string[] | undefined {
  try {
    const v = JSON.parse(text.trim()) as unknown;
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
  } catch {
    return undefined;
  }
}

/** `[node, cli, "hook", "codex"]` or `[name, "hook", "codex"]` naming one of our commands: the CLI it runs. */
function ourNotify(argv: string[]): string | undefined {
  const n = argv.length;
  if (n < 3 || argv[n - 2] !== "hook" || argv[n - 1] !== "codex") return undefined;
  const cli = n >= 4 ? argv[n - 3]! : argv[0]!;
  return OUR_COMMAND_RE.test(cli) ? cli : undefined;
}

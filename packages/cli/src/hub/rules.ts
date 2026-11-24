import os from "node:os";
import path from "node:path";
import { HUB_CMD_RE, HUB_TOOL_RE } from "@agentblip/core";

/**
 * Pure reductions from raw hook facts to the metadata the hub may receive
 * (Bullpen SPEC §3.3). Each function returns only fixed-vocabulary strings,
 * ids, or values that already passed an allow list.
 */

/** Rule 5: programs whose name (and one subcommand word) may be sent. */
export const CMD_ALLOW_LIST: ReadonlySet<string> = new Set([
  "git",
  "gh",
  "cargo",
  "pnpm",
  "npm",
  "npx",
  "bun",
  "yarn",
  "node",
  "python",
  "python3",
  "pytest",
  "go",
  "make",
  "just",
  "wrangler",
  "linear",
  "docker",
  "kubectl",
  "terraform",
  "rustc",
  "tsc",
  "vitest",
  "jest",
  "biome",
  "eslint",
  "prettier",
  "uv",
  "pip",
]);

const SUBCOMMAND_RE = /^[a-z][a-z0-9:-]{0,24}$/;
/** Prefixes that don't change which program runs. */
const WRAPPERS = new Set(["time", "nohup", "exec", "command", "env", "sudo"]);
/** Shell preludes before the real program: `cd repo && cargo test`, `export X=1; npm test`. */
const DIR_CHANGERS = new Set(["cd", "pushd", "export", "unset", "source", "."]);
const OPERATORS = new Set(["&&", "||", ";", "|", "&", "\n", "(", ")"]);
/** git options that take a value before the subcommand: `git -C <dir> status`. */
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/** Splits a shell command into words and operators, honoring quotes (no expansion). */
export function shellTokens(command: string, limit = 64): string[] {
  const tokens: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | undefined;
  const push = (): void => {
    if (has) tokens.push(cur);
    cur = "";
    has = false;
  };
  for (let i = 0; i < command.length && tokens.length < limit; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      cur += command[++i];
      has = true;
      continue;
    }
    if (c === " " || c === "\t") {
      push();
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      push();
      tokens.push(two);
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "(" || c === ")") {
      push();
      tokens.push(c);
      continue;
    }
    cur += c;
    has = true;
  }
  push();
  return tokens;
}

/**
 * Rule 5: "<program> <subcommand>" for an allow-listed program, the program
 * alone when the next word isn't a plain subcommand, nothing otherwise.
 * Leading env assignments, wrappers (time, env, sudo…) and `cd dir &&` are
 * skipped; arguments are never returned.
 */
export function extractCmd(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const tokens = shellTokens(command);
  let i = 0;
  for (;;) {
    while (i < tokens.length && OPERATORS.has(tokens[i]!)) i++;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
    if (i < tokens.length && WRAPPERS.has(tokens[i]!)) {
      i++;
      while (i < tokens.length && (tokens[i]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!))) i++;
      continue;
    }
    if (i < tokens.length && DIR_CHANGERS.has(tokens[i]!)) {
      while (i < tokens.length && !OPERATORS.has(tokens[i]!)) i++;
      if (i >= tokens.length) return undefined;
      continue;
    }
    break;
  }
  const first = tokens[i];
  if (!first || OPERATORS.has(first)) return undefined;
  const program = path.posix.basename(first);
  if (!CMD_ALLOW_LIST.has(program)) return undefined;
  let j = i + 1;
  if (program === "git") {
    while (j < tokens.length && tokens[j]!.startsWith("-")) {
      j += GIT_VALUE_OPTS.has(tokens[j]!) ? 2 : 1;
    }
  }
  const sub = tokens[j];
  const cmd = sub && !OPERATORS.has(sub) && SUBCOMMAND_RE.test(sub) ? `${program} ${sub}` : program;
  return HUB_CMD_RE.test(cmd) ? cmd : undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rule 6: Linear-style ids (`B3-7166`) for the configured keys, upper-cased,
 * de-duplicated, at most `max`. Only the ids are ever kept.
 */
export function extractIssues(text: string | undefined, keys: readonly string[], max = 20): string[] {
  if (!text || keys.length === 0) return [];
  const out: string[] = [];
  for (const key of keys) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,9}$/.test(key)) continue;
    const re = new RegExp(`\\b(${escapeRegExp(key)})-(\\d{1,6})\\b`, "gi");
    for (const m of text.matchAll(re)) {
      const id = `${key.toUpperCase()}-${m[2]}`;
      if (!out.includes(id)) out.push(id);
      if (out.length >= max) return out;
    }
  }
  return out;
}

const GH_PR_COMMAND = /(?:^|[\s;&|(])gh\s+pr\s+(?:create|view|merge)\b/;
const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;

/**
 * Rule 7: the first GitHub PR URL in the output of a `gh pr create|view|merge`
 * command, with its "owner/name". The caller decides whether that repo is shared.
 */
export function extractPr(
  command: string | undefined,
  responseText: string | undefined,
): { url: string; repo: string } | undefined {
  if (!command || !responseText || !GH_PR_COMMAND.test(command)) return undefined;
  const m = PR_URL.exec(responseText);
  if (!m) return undefined;
  return { url: m[0], repo: `${m[1]}/${m[2]}` };
}

/** `p` is `dir` or inside it (both absolute, normalized). */
export function isUnder(p: string, dir: string): boolean {
  if (!dir) return false;
  const d = dir.length > 1 && dir.endsWith(path.sep) ? dir.slice(0, -1) : dir;
  return p === d || p.startsWith(d === path.sep ? d : `${d}${path.sep}`);
}

/** Absolute paths a command mentions ("/x/y", "~/x"), normalized, `~` expanded. */
export function absolutePathsIn(command: string, home = os.homedir()): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/(?:^|[\s'"=:(,])((?:~(?=\/)|\/)[^\s'";|&<>(),`]*)/g)) {
    const raw = m[1]!;
    const abs = raw.startsWith("~") ? path.join(home, raw.slice(1)) : raw;
    out.push(path.normalize(abs));
    if (out.length >= 50) break;
  }
  return out;
}

/** Rule 4: the first of `roots` that an absolute path in `command` sits inside. */
export function mentionedRoot(
  command: string | undefined,
  roots: Iterable<string>,
  home = os.homedir(),
): string | undefined {
  if (!command) return undefined;
  const paths = absolutePathsIn(command, home);
  if (paths.length === 0) return undefined;
  for (const root of roots) {
    if (paths.some((p) => isUnder(p, root))) return root;
  }
  return undefined;
}

/** A tool name the hub accepts, or nothing. */
export function hubToolName(tool: string | undefined): string | undefined {
  return tool && tool.length <= 64 && HUB_TOOL_RE.test(tool) ? tool : undefined;
}

/** agentblip's own fixed labels: safe to send as they are. */
export const SAFE_LABELS: ReadonlySet<string> = new Set([
  "thinking",
  "needs my input",
  "running commands",
  "reading code",
  "editing files",
  "delegating to subagents",
  "orchestrating a workflow",
  "running a workflow",
  "browsing the web",
  "running in background",
  "planning",
  "done",
]);

/**
 * The activity label the hub may see. Fixed labels pass; "editing <file>"
 * keeps the file name only when that file is in a shared repo (else "editing
 * files"); "using <ToolName>" passes for plain tool names, with MCP tools shown
 * by server ("using mcp__linear__get_issue" → "using linear"). With
 * `toolNames: false` (a session whose cwd isn't shared, on an event that touched
 * no shared file) "using <ToolName>" becomes "working", so work outside shared
 * repos doesn't show through the session's label. Anything else — Codex
 * notify's assistant text, custom free text — is dropped.
 */
export function hubLabel(
  raw: string | undefined,
  sharedBasenames: ReadonlySet<string> = new Set(),
  opts: { toolNames?: boolean } = {},
): string | undefined {
  if (!raw) return undefined;
  if (SAFE_LABELS.has(raw)) return raw;
  const editing = /^editing (.+)$/.exec(raw);
  if (editing) return sharedBasenames.has(editing[1]!) ? raw.slice(0, 200) : "editing files";
  const using = /^using ([\w.:-]{1,64})$/.exec(raw);
  if (using) {
    if (opts.toolNames === false) return "working";
    return `using ${toolDisplayName(using[1]!)}`;
  }
  return undefined;
}

/** "mcp__claude-in-chrome__browser_batch" → "claude-in-chrome"; "mcp__plugin_slack_slack__x" → "slack". */
export function toolDisplayName(tool: string): string {
  const mcp = /^mcp__(.+?)__/.exec(tool);
  if (!mcp) return tool;
  const parts = mcp[1]!.replace(/^plugin_/, "").split("_").filter(Boolean);
  return parts[parts.length - 1] ?? tool;
}

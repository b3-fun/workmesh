import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { watch } from "chokidar";
import { z } from "zod";
import { DETAIL_LIMITS } from "@workmesh/core";
import { isInjectedPrompt } from "@workmesh/protocol";
import type { SessionEvent, SessionEventDetail } from "@workmesh/core";
import {
  absolutePath,
  clip,
  clipHead,
  compactDetail,
  mcpDesc,
  oneLine,
  responseOk,
  responseText,
  transcriptPathOf,
} from "./detail";
import { OUR_COMMAND_RE } from "../lib/names";
import { removeOurHooks, writeBackup } from "../lib/hook-files";
import { codexHome } from "../lib/paths";

const MAX_ACTIVITY_LEN = 60;

/**
 * Absolute notify invocation: GUI-launched agents don't inherit the login-shell
 * PATH, so a bare `workmesh` may not resolve. import.meta.url is the bundled
 * CLI entry (dist/index.js) at runtime; JSON strings are valid TOML strings.
 */
export function codexNotifyLine(): string {
  const entry = fileURLToPath(import.meta.url);
  return `notify = [${JSON.stringify(process.execPath)}, ${JSON.stringify(entry)}, "hook", "codex"]`;
}

/** $CODEX_HOME/config.toml (default ~/.codex/config.toml). */
export function codexConfigPath(): string {
  return path.join(codexHome(), "config.toml");
}

/** $CODEX_HOME/sessions (default ~/.codex/sessions). */
export function codexSessionsDir(): string {
  return path.join(codexHome(), "sessions");
}

const notifySchema = z.looseObject({ type: z.string() });

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Maps the JSON argument Codex passes to its notify hook. Only turn completion maps. */
export function mapNotifyArg(argvJson: string, fallbackNow = Date.now()): SessionEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(argvJson) as unknown;
  } catch {
    return null;
  }
  const parsed = notifySchema.safeParse(raw);
  if (!parsed.success || parsed.data.type !== "agent-turn-complete") return null;
  const data = parsed.data as Record<string, unknown>;
  const sessionId =
    pickString(data["thread-id"]) ?? pickString(data["turn-id"]) ?? "codex";
  const message = pickString(data["last-assistant-message"]);
  const collapsed = message?.replace(/\s+/g, " ").trim();
  const activity =
    collapsed && collapsed.length > MAX_ACTIVITY_LEN
      ? `${collapsed.slice(0, MAX_ACTIVITY_LEN - 1)}…`
      : collapsed;
  return {
    source: "codex",
    sessionId: sessionId.slice(0, 128),
    kind: "idle",
    activity: activity || undefined,
    ts: fallbackNow,
  };
}

export type CodexInstallResult = "installed" | "already-installed" | "manual";

/**
 * Adds the Workmesh notify hook to ~/.codex/config.toml. If a notify key
 * already exists we never rewrite it — the user gets manual instructions.
 */
export function installCodexNotify(configPath = codexConfigPath()): CodexInstallResult {
  let text = "";
  if (fs.existsSync(configPath)) text = fs.readFileSync(configPath, "utf8");
  if (/^\s*notify\s*=/m.test(text)) {
    if (!notifyLineIsOurs(text)) return "manual";
    // Only our own line is repointed (an older install path, the bare legacy
    // command, or an install from before the rename): exactly
    // ["<node>", "<entry>", "hook", "codex"] or ["<name>", "hook", "codex"].
    // Another tool's notify that merely chains to us is left alone.
    const ours = /^[ \t]*notify[ \t]*=[ \t]*\[[ \t]*"[^"\n]*"[ \t]*,[ \t]*(?:"[^"\n]*"[ \t]*,[ \t]*)?"hook"[ \t]*,[ \t]*"codex"[ \t]*\][ \t]*$/m;
    const match = ours.exec(text);
    if (!match || !OUR_COMMAND_RE.test(match[0])) return "already-installed";
    const next = text.replace(ours, codexNotifyLine());
    if (next === text) return "already-installed";
    writeBackup(configPath, text);
    fs.writeFileSync(configPath, next);
    return "installed";
  }
  const block = `# workmesh: surface Codex turns in your Slack status\n${codexNotifyLine()}\n`;
  // `notify` must be top-level TOML: if the file has [table] sections, appending
  // would land the key inside the last table — prepend instead.
  const next = /^\s*\[/m.test(text)
    ? `${block}\n${text}`
    : text
      ? `${text.replace(/\n*$/, "\n")}\n${block}`
      : block;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (text) writeBackup(configPath, text);
  fs.writeFileSync(configPath, next);
  return "installed";
}

/**
 * Takes our notify line (and the comment we put above it) out of
 * config.toml. Another tool's notify, even one that chains to us, is left
 * alone. True when the file changed.
 */
export function removeCodexNotify(configPath = codexConfigPath()): boolean {
  if (!fs.existsSync(configPath)) return false;
  const text = fs.readFileSync(configPath, "utf8");
  const ours = /^[ \t]*notify[ \t]*=[ \t]*\[[ \t]*"[^"\n]*"[ \t]*,[ \t]*(?:"[^"\n]*"[ \t]*,[ \t]*)?"hook"[ \t]*,[ \t]*"codex"[ \t]*\][ \t]*$/m;
  const match = ours.exec(text);
  if (!match || !OUR_COMMAND_RE.test(match[0])) return false;
  const lines = text.split("\n");
  const at = text.slice(0, match.index).split("\n").length - 1;
  let from = at;
  if (from > 0 && /^# workmesh:/.test(lines[from - 1] ?? "")) from--;
  lines.splice(from, at - from + 1);
  // The blank line install added between our block and the rest goes too.
  if (lines[from] === "" && (from === 0 || lines[from - 1] === "")) lines.splice(from, 1);
  writeBackup(configPath, text);
  fs.writeFileSync(configPath, lines.join("\n"));
  return true;
}

/** Takes our hooks out of Codex's hooks.json; other tools' entries stay. Returns how many went. */
export function removeCodexHooks(hooksPath = codexHooksPath()): { removed: number; hooksPath: string; backupPath?: string } {
  if (!fs.existsSync(hooksPath)) return { removed: 0, hooksPath };
  const original = fs.readFileSync(hooksPath, "utf8");
  if (!original.trim()) return { removed: 0, hooksPath };
  const parsed = JSON.parse(original) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`unexpected shape in ${hooksPath} — expected a JSON object`);
  }
  const doc = parsed as Record<string, unknown>;
  const hooks = doc.hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return { removed: 0, hooksPath };
  const removed = removeOurHooks(hooks as Record<string, unknown>, isOurCodexHook);
  if (removed === 0) return { removed, hooksPath };
  const backupPath = writeBackup(hooksPath, original);
  fs.writeFileSync(hooksPath, `${JSON.stringify(doc, null, 2)}\n`);
  return { removed, hooksPath, backupPath };
}

/** A top-level `notify = …` line that names one of our commands. */
function notifyLineIsOurs(text: string): boolean {
  return text.split("\n").some((line) => /^\s*notify\s*=/.test(line) && OUR_COMMAND_RE.test(line));
}

export function isCodexNotifyInstalled(configPath = codexConfigPath()): boolean {
  try {
    const text = fs.readFileSync(configPath, "utf8");
    return notifyLineIsOurs(text);
  } catch {
    return false;
  }
}

export interface CodexWatcher {
  close(): Promise<void>;
}

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Rollout files are `rollout-<timestamp>-<uuid>.jsonl` while the notify hook
 * keys sessions by the bare thread uuid — extract the trailing uuid so both
 * paths land on the same `codex:<uuid>` session. Falls back to the basename.
 */
export function rolloutSessionId(file: string): string {
  const base = path.basename(file, ".jsonl");
  return (UUID_RE.exec(base)?.[0] ?? base).slice(0, 128);
}

/** Rollouts silent for longer than this can't be a live session. */
const MAX_ROLLOUT_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * chokidar `ignored` filter: Codex keeps every rollout ever under YYYY/MM/DD,
 * so skip stale files instead of holding an fs watch per historical session
 * (months of use would exhaust inotify/fd limits).
 */
export function isIgnoredRollout(file: string, stats?: fs.Stats): boolean {
  if (!stats?.isFile()) return false;
  if (!file.endsWith(".jsonl")) return true;
  return Date.now() - stats.mtimeMs > MAX_ROLLOUT_AGE_MS;
}

/**
 * Watches the Codex sessions dir: rollout .jsonl writes mean a session is
 * actively working. Turn completion (idle) arrives via the notify hook.
 */
export function createCodexWatcher(
  dir: string,
  onEvent: (event: SessionEvent) => void,
  log: (message: string) => void = () => {},
): CodexWatcher {
  const watcher = watch(dir, {
    ignoreInitial: true,
    persistent: true,
    ignored: isIgnoredRollout,
  });
  const emit = (file: string): void => {
    if (!file.endsWith(".jsonl")) return;
    onEvent({
      source: "codex",
      sessionId: rolloutSessionId(file),
      kind: "working",
      ts: Date.now(),
      // Local only: the hub forwarder reads the rollout's session_meta (who
      // spawned this thread) and token totals from it.
      ...(path.isAbsolute(file) && file.length <= DETAIL_LIMITS.transcriptPath ? { detail: { transcriptPath: file } } : {}),
    });
  };
  watcher.on("add", emit);
  watcher.on("change", emit);
  watcher.on("error", (err) => {
    // transient fs errors must never take the daemon down — but say so
    log(`codex watcher error: ${err instanceof Error ? err.message : String(err)}`);
  });
  return { close: () => watcher.close() };
}

// --- Codex hooks (~/.codex/hooks.json) ---------------------------------------
//
// Codex 0.16x runs Claude-Code-style lifecycle hooks: same hooks.json shape,
// JSON on stdin. Input fields verified against the JSON schemas embedded in
// the codex 0.164 binary (pre-tool-use.command.input etc.): every event has
// session_id, cwd, hook_event_name, transcript_path (nullable), model;
// PreToolUse/PostToolUse add turn_id, tool_name, tool_use_id, tool_input
// (untyped) and PostToolUse tool_response (untyped); UserPromptSubmit adds
// prompt. Codex runs a user hook only after the person trusts it (/hooks).
// The notify hook above stays installed as a fallback for older Codex builds.

/** Absolute hook invocation, quoted for spaces (see codexNotifyLine). */
export function codexHookCommand(): string {
  return `"${process.execPath}" "${fileURLToPath(import.meta.url)}" hook codex-hooks`;
}

/** $CODEX_HOME/hooks.json (default ~/.codex/hooks.json). */
export function codexHooksPath(): string {
  return path.join(codexHome(), "hooks.json");
}

/**
 * Events Workmesh installs. PermissionRequest is beyond Claude Code's set:
 * it is Codex's "blocked on an approval" signal, which maps to waiting.
 */
export const CODEX_HOOK_EVENTS: readonly string[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
  "SessionEnd",
];

/** SessionEnd hooks may run at most 3 s in Codex; the rest get 5 s like other tools' hooks. */
function codexHookTimeout(event: string): number {
  return event === "SessionEnd" ? 3 : 5;
}

const codexHookInputSchema = z.looseObject({
  hook_event_name: z.string(),
  session_id: z.string().min(1),
  cwd: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  prompt: z.string().optional(),
  transcript_path: z.string().nullish(),
  /** Stop: the turn's final assistant text (verified in the codex 0.164 Stop input schema). */
  last_assistant_message: z.string().nullish(),
});

/** Codex's names for a shell call: docs say "matched as Bash"; the rest are wire names seen across versions. */
const CODEX_SHELL_TOOLS = new Set([
  "Bash",
  "shell",
  "shell_command",
  "local_shell",
  "exec_command",
  "unified_exec",
  "container.exec",
  "write_stdin",
]);
const CODEX_PATCH_TOOLS = new Set(["apply_patch", "Edit", "Write"]);
/** Codex asks the person a question and blocks on the answer. */
const CODEX_ASKS_USER_TOOLS = new Set(["request_user_input"]);

/** Files an apply_patch body touches ("*** Update File: src/a.rs", "*** Move to: …"). */
export function parsePatchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$/gm)) {
    const file = m[1]!;
    if (!files.includes(file)) files.push(file);
  }
  return files;
}

function patchText(toolInput: unknown): string | undefined {
  if (typeof toolInput === "string") return toolInput;
  if (toolInput && typeof toolInput === "object") {
    const r = toolInput as Record<string, unknown>;
    for (const key of ["command", "input", "patch"]) {
      if (typeof r[key] === "string") return r[key];
    }
  }
  return undefined;
}

/**
 * The shell command a Codex tool call runs. `command` may be a string or an
 * argv array (["bash", "-lc", "…"]); unified exec uses `cmd`. A `workdir`
 * other than the session cwd is kept as a leading `cd <dir> &&` so the hub
 * forwarder can tell which repo the command ran in.
 */
export function codexShellCommand(toolInput: unknown, cwd: string | undefined): string | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const r = toolInput as Record<string, unknown>;
  const raw = r.command ?? r.cmd;
  let command: string | undefined;
  if (typeof raw === "string") command = raw;
  else if (Array.isArray(raw) && raw.every((a) => typeof a === "string")) {
    const argv = raw as string[];
    const shell = argv[0] ? path.basename(argv[0]) : "";
    command =
      ["bash", "zsh", "sh"].includes(shell) && (argv[1] === "-lc" || argv[1] === "-c") && argv[2]
        ? argv[2]
        : argv.join(" ");
  }
  if (!command) return undefined;
  const workdir = typeof r.workdir === "string" ? r.workdir : undefined;
  if (workdir && path.isAbsolute(workdir) && workdir !== cwd) {
    command = `cd ${workdir} && ${command}`;
  }
  return command;
}

/** Codex shell output often reads "Exit code: 1\nWall time: …\nOutput: …". */
function codexResponseOk(resp: unknown): boolean | undefined {
  if (typeof resp === "string") {
    const exit = /^Exit code: (-?\d+)/m.exec(resp);
    if (exit) return exit[1] === "0";
    if (resp.trimStart().startsWith("{")) {
      try {
        return codexResponseOk(JSON.parse(resp) as unknown);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  if (resp && typeof resp === "object" && !Array.isArray(resp)) {
    const meta = (resp as Record<string, unknown>).metadata;
    if (meta && typeof meta === "object" && typeof (meta as Record<string, unknown>).exit_code === "number") {
      return (meta as Record<string, unknown>).exit_code === 0;
    }
  }
  return responseOk(resp);
}

function codexToolLabel(toolName: string | undefined, files: string[]): string | undefined {
  if (!toolName) return undefined;
  if (CODEX_PATCH_TOOLS.has(toolName)) {
    return files[0] ? `editing ${path.basename(files[0])}` : "editing files";
  }
  if (CODEX_SHELL_TOOLS.has(toolName)) return "running commands";
  switch (toolName) {
    case "request_user_input":
      return "thinking"; // PostToolUse: the person answered
    case "update_plan":
      return "planning";
    case "spawn_agent":
    case "Agent":
      return "delegating to subagents";
    case "web_search":
    case "WebSearch":
      return "browsing the web";
    default:
      return `using ${toolName}`;
  }
}

/**
 * Raw one-line description of a Codex tool call (SPEC §9 `desc`). UNVERIFIED
 * against live payloads: tool_input is untyped in Codex's hook schema, so
 * this reads the fields Codex's own tool definitions use — `description`
 * (spawn_agent and Claude-style tools), `justification` (escalated shell
 * calls), `query` (web search), `explanation` (update_plan) — and
 * "server · tool" for mcp__ names.
 */
export function codexToolDesc(toolName: string, toolInput: unknown): string | undefined {
  if (toolName.startsWith("mcp__")) return oneLine(mcpDesc(toolName));
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return undefined;
  const r = toolInput as Record<string, unknown>;
  for (const key of ["description", "justification", "query", "explanation"]) {
    const line = oneLine(r[key]);
    if (line) return line;
  }
  return undefined;
}

/** Local-only facts about one Codex tool call (see SessionEventDetail). */
export function codexToolDetail(
  hookEvent: string,
  toolName: string | undefined,
  toolInput: unknown,
  cwd: string | undefined,
  toolResponse?: unknown,
): { detail: SessionEventDetail | undefined; files: string[] } {
  if (!toolName) return { detail: compactDetail({ hookEvent }), files: [] };
  const isPatch = CODEX_PATCH_TOOLS.has(toolName);
  const isShell = CODEX_SHELL_TOOLS.has(toolName);
  const patch = isPatch ? patchText(toolInput) : undefined;
  const files = patch
    ? parsePatchFiles(patch)
    : toolInput && typeof toolInput === "object"
      ? [(toolInput as Record<string, unknown>).file_path, (toolInput as Record<string, unknown>).path].filter(
          (p): p is string => typeof p === "string" && p.length > 0,
        )
      : [];
  const abs = files
    .map((f) => absolutePath(f, cwd))
    .filter((f): f is string => f !== undefined)
    .slice(0, DETAIL_LIMITS.filePaths);
  const post = hookEvent === "PostToolUse";
  return {
    files,
    detail: compactDetail({
      hookEvent,
      tool: toolName.slice(0, DETAIL_LIMITS.tool),
      filePath: abs[0],
      filePaths: abs.length > 1 ? abs : undefined,
      command: isShell ? clip(codexShellCommand(toolInput, cwd), DETAIL_LIMITS.command) : undefined,
      toolResponseText: post && isShell ? responseText(toolResponse) : undefined,
      ok: post ? codexResponseOk(toolResponse) : undefined,
      desc: codexToolDesc(toolName, toolInput),
    }),
  };
}

/** Maps Codex hook stdin JSON to a wire SessionEvent, or null to ignore. */
export function mapCodexHookInput(json: unknown, fallbackNow = Date.now()): SessionEvent | null {
  const parsed = codexHookInputSchema.safeParse(json);
  if (!parsed.success) return null;
  const input = parsed.data;
  const project = input.cwd ? path.basename(input.cwd).slice(0, 120) : undefined;
  const base = {
    source: "codex",
    sessionId: input.session_id.slice(0, 128),
    project: project || undefined,
    cwd: input.cwd && input.cwd.length <= 1024 ? input.cwd : undefined,
    ts: fallbackNow,
  };
  const mapped = mapCodexEvent(input, base);
  const transcriptPath = transcriptPathOf(input.transcript_path);
  if (!mapped || !transcriptPath) return mapped;
  // Local only: lets the hub forwarder tail the rollout once the session is shared.
  const detail = mapped.detail ?? compactDetail({ hookEvent: input.hook_event_name.slice(0, DETAIL_LIMITS.hookEvent) });
  return { ...mapped, detail: { ...detail, transcriptPath } };
}

type CodexHookInput = z.infer<typeof codexHookInputSchema>;

function mapCodexEvent(
  input: CodexHookInput,
  base: Pick<SessionEvent, "source" | "sessionId" | "project" | "cwd" | "ts">,
): SessionEvent | null {
  const event = input.hook_event_name;
  switch (event) {
    case "SessionStart":
      return { ...base, kind: "start" };
    case "UserPromptSubmit":
      if (isInjectedPrompt(input.prompt)) {
        // Markup Codex put there (a notice, another agent's message): a turn starts, nobody typed it.
        return { ...base, kind: "working", activity: "thinking", detail: compactDetail({ hookEvent: "InjectedPrompt" }) };
      }
      return {
        ...base,
        kind: "working",
        activity: "thinking",
        detail: compactDetail({ hookEvent: event, prompt: clipHead(input.prompt, DETAIL_LIMITS.prompt) }),
      };
    case "PreToolUse":
    case "PostToolUse": {
      const { detail, files } = codexToolDetail(
        event,
        input.tool_name,
        input.tool_input,
        input.cwd,
        input.tool_response,
      );
      if (event === "PreToolUse" && input.tool_name && CODEX_ASKS_USER_TOOLS.has(input.tool_name)) {
        return { ...base, kind: "waiting", activity: "needs my input", detail };
      }
      return {
        ...base,
        kind: "working",
        activity: codexToolLabel(input.tool_name, files)?.slice(0, 200),
        detail,
      };
    }
    case "PermissionRequest": {
      const { detail } = codexToolDetail(event, input.tool_name, input.tool_input, input.cwd);
      return { ...base, kind: "waiting", activity: "needs my input", detail };
    }
    case "Stop":
      return {
        ...base,
        kind: "idle",
        detail: compactDetail({
          hookEvent: event,
          lastAssistantMessage: clipHead(input.last_assistant_message ?? undefined, DETAIL_LIMITS.lastAssistantMessage),
        }),
      };
    case "SessionEnd":
      return { ...base, kind: "end" };
    default:
      return null;
  }
}

/** Our Codex hooks.json command, under either name and any install path. */
export function isOurCodexHook(command: unknown): command is string {
  return typeof command === "string" && OUR_COMMAND_RE.test(command) && command.includes("codex-hooks");
}

function hookListHasOurs(entries: unknown): boolean {
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    const hooks = (entry as { hooks?: unknown } | null)?.hooks;
    return Array.isArray(hooks) && hooks.some((hook) => isOurCodexHook((hook as { command?: unknown } | null)?.command));
  });
}

/** Repoints our Codex hook commands to `command` in place; true when any changed. */
function repointCodexHooks(entries: unknown, command: string): boolean {
  let updated = false;
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    const hooks = (entry as { hooks?: unknown } | null)?.hooks;
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      const h = hook as { command?: unknown } | null;
      if (h && isOurCodexHook(h.command) && h.command !== command) {
        (h as { command: string }).command = command;
        updated = true;
      }
    }
  }
  return updated;
}

export interface CodexHooksInstallResult {
  changed: boolean;
  hooksPath: string;
  backupPath?: string;
}

/**
 * Merges Workmesh's entries into Codex's hooks.json. Never overwrites: other
 * tools' entries and unknown keys are kept, events that already carry our
 * codex-hooks command are skipped, and the file as it was is backed up
 * (a new timestamped copy each time it changes). Throws (changing nothing) when the file isn't a JSON object.
 */
export function installCodexHooks(hooksPath = codexHooksPath()): CodexHooksInstallResult {
  let doc: Record<string, unknown> = {};
  let original: string | undefined;
  if (fs.existsSync(hooksPath)) {
    original = fs.readFileSync(hooksPath, "utf8");
    if (original.trim()) {
      const parsed = JSON.parse(original) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`unexpected shape in ${hooksPath} — expected a JSON object`);
      }
      doc = parsed as Record<string, unknown>;
    }
  }
  const existing = doc.hooks;
  if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) {
    throw new Error(`unexpected "hooks" in ${hooksPath} — expected an object`);
  }
  const hooks = (existing as Record<string, unknown> | undefined) ?? {};
  doc.hooks = hooks;

  let changed = false;
  const command = codexHookCommand();
  for (const event of CODEX_HOOK_EVENTS) {
    const list = hooks[event];
    if (repointCodexHooks(list, command)) changed = true;
    if (hookListHasOurs(list)) continue;
    const entry = { hooks: [{ type: "command", command, timeout: codexHookTimeout(event) }] };
    if (Array.isArray(list)) list.push(entry);
    else if (list === undefined) hooks[event] = [entry];
    else continue; // unmanageable shape — leave it alone
    changed = true;
  }

  let backupPath: string | undefined;
  if (changed) {
    if (original !== undefined && original.trim()) backupPath = writeBackup(hooksPath, original);
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, `${JSON.stringify(doc, null, 2)}\n`);
  }
  return { changed, hooksPath, backupPath };
}

export function areCodexHooksInstalled(hooksPath = codexHooksPath()): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(hooksPath, "utf8")) as { hooks?: Record<string, unknown> };
    return CODEX_HOOK_EVENTS.every((event) => hookListHasOurs(parsed.hooks?.[event]));
  } catch {
    return false;
  }
}

/** Whether any Workmesh hook is in hooks.json (0.12, `workmesh update` refreshes an older install). */
export function hasAnyCodexHook(hooksPath = codexHooksPath()): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(hooksPath, "utf8")) as { hooks?: Record<string, unknown> };
    return Object.values(parsed.hooks ?? {}).some((entries) => hookListHasOurs(entries));
  } catch {
    return false;
  }
}

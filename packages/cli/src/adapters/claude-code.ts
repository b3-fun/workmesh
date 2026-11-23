import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { SessionEvent } from "@agentblip/core";

/**
 * Absolute hook invocation: GUI-launched agents don't inherit the login-shell
 * PATH, so a bare `agentblip` may not resolve (exit 127 on every hook).
 * import.meta.url is the bundled CLI entry (dist/index.js) at runtime; both
 * paths are quoted for spaces.
 */
export function claudeHookCommand(): string {
  return `"${process.execPath}" "${fileURLToPath(import.meta.url)}" hook claude-code`;
}

/** PreToolUse/PostToolUse hook entries take a matcher; the rest don't. */
const MATCHER_EVENTS = ["PreToolUse", "PostToolUse"] as const;
const PLAIN_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Notification",
  "Stop",
  "SessionEnd",
] as const;
export const CLAUDE_HOOK_EVENTS: readonly string[] = [
  ...MATCHER_EVENTS,
  ...PLAIN_EVENTS,
];

const hookInputSchema = z.looseObject({
  hook_event_name: z.string(),
  session_id: z.string().min(1),
  cwd: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
  notification_type: z.string().optional(),
});

/** A subagent transcript written this recently means that subagent is still running. */
const SUBAGENT_LIVE_MS = 120_000;

/**
 * True when a Claude Code session is idle only because it is waiting on its own
 * background work, which resumes it automatically:
 *  - Claude Code's per-process file ~/.claude/sessions/<pid>.json reports status
 *    "shell" (turn over, background Bash still running) or "busy"; or
 *  - a subagent transcript under ~/.claude/projects/<project>/<session>/subagents/
 *    (including workflow agents) was written in the last two minutes.
 * Best effort: any read error counts as "no background work".
 */
export function hasBackgroundWork(
  sessionId: string,
  now = Date.now(),
  claudeDir = path.join(os.homedir(), ".claude"),
): boolean {
  try {
    const dir = path.join(claudeDir, "sessions");
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const info = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as {
          sessionId?: unknown;
          status?: unknown;
        };
        if (info.sessionId === sessionId && (info.status === "shell" || info.status === "busy")) {
          return true;
        }
      } catch {
        // unreadable / half-written file: skip
      }
    }
  } catch {
    // no sessions dir
  }
  const fresh = (file: string): boolean => {
    try {
      return now - fs.statSync(file).mtimeMs < SUBAGENT_LIVE_MS;
    } catch {
      return false;
    }
  };
  try {
    const projects = path.join(claudeDir, "projects");
    for (const proj of fs.readdirSync(projects)) {
      const subDir = path.join(projects, proj, sessionId, "subagents");
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(subDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".jsonl") && fresh(path.join(subDir, e.name))) return true;
        if (e.isDirectory() && e.name === "workflows") {
          for (const run of fs.readdirSync(path.join(subDir, e.name), { withFileTypes: true })) {
            if (!run.isDirectory()) continue;
            const runDir = path.join(subDir, e.name, run.name);
            for (const f of fs.readdirSync(runDir)) {
              if (f.endsWith(".jsonl") && fresh(path.join(runDir, f))) return true;
            }
          }
        }
      }
      return false; // the session's own project dir was found; no need to scan others
    }
  } catch {
    // no projects dir
  }
  return false;
}

export interface MapHookOptions {
  /** Injected for tests; defaults to reading Claude Code's local state. */
  backgroundWork?: (sessionId: string) => boolean;
}

function toolLabel(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
): string | undefined {
  if (!toolName) return undefined;
  switch (toolName) {
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const filePath = toolInput?.file_path ?? toolInput?.notebook_path;
      return typeof filePath === "string" && filePath
        ? `editing ${path.basename(filePath)}`
        : "editing files";
    }
    case "Bash":
      return "running commands";
    case "Read":
    case "Grep":
    case "Glob":
      return "reading code";
    case "Task":
    case "Agent":
      return "delegating to subagents";
    case "Workflow":
      return "orchestrating a workflow";
    case "WebFetch":
    case "WebSearch":
      return "browsing the web";
    default:
      return `using ${toolName}`;
  }
}

/** Maps Claude Code hook stdin JSON to a wire SessionEvent, or null to ignore. */
export function mapHookInput(
  json: unknown,
  fallbackNow = Date.now(),
  opts: MapHookOptions = {},
): SessionEvent | null {
  const parsed = hookInputSchema.safeParse(json);
  if (!parsed.success) return null;
  const input = parsed.data;
  const project = input.cwd ? path.basename(input.cwd).slice(0, 120) : undefined;
  const base = {
    source: "claude-code",
    sessionId: input.session_id.slice(0, 128),
    project: project || undefined,
    ts: fallbackNow,
  };
  switch (input.hook_event_name) {
    case "SessionStart":
      return { ...base, kind: "start" };
    case "UserPromptSubmit":
      return { ...base, kind: "working", activity: "thinking" };
    case "PreToolUse":
      return {
        ...base,
        kind: "working",
        activity: toolLabel(input.tool_name, input.tool_input)?.slice(0, 200),
      };
    case "PostToolUse":
      // "working", not heartbeat: after a permission prompt (waiting) is
      // approved, tool completion is the first signal — it must flip the
      // state back to working. The fresh tool label avoids inheriting a
      // stale "needs my input" activity.
      return {
        ...base,
        kind: "working",
        activity: toolLabel(input.tool_name, input.tool_input)?.slice(0, 200),
      };
    case "Notification": {
      // Claude Code's 60s idle reminder ("idle_prompt") also fires when the turn is
      // over but the session is still waiting on its own background shells or
      // subagents, which resume it automatically. That is not "needs my input".
      // Permission prompts and questions (and unknown types) still are.
      const backgroundWork = opts.backgroundWork ?? ((id: string) => hasBackgroundWork(id));
      if (input.notification_type === "idle_prompt" && backgroundWork(base.sessionId)) {
        return { ...base, kind: "working", activity: "running in background" };
      }
      return { ...base, kind: "waiting", activity: "needs my input" };
    }
    case "Stop":
    case "SubagentStop":
      return { ...base, kind: "idle" };
    case "SessionEnd":
      return { ...base, kind: "end" };
    default:
      return null;
  }
}

export function claudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function entryListHasAgentblip(entries: unknown): boolean {
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const hooks = (entry as { hooks?: unknown }).hooks;
    if (!Array.isArray(hooks)) return false;
    return hooks.some((hook) => {
      if (typeof hook !== "object" || hook === null) return false;
      const command = (hook as { command?: unknown }).command;
      return typeof command === "string" && command.includes("agentblip");
    });
  });
}

export interface HookInstallResult {
  changed: boolean;
  settingsPath: string;
  backupPath?: string;
}

/**
 * Merges agentblip hook entries into Claude Code settings. Idempotent: events
 * that already carry an agentblip command are skipped, unknown keys are
 * preserved, and the original file is backed up once.
 */
export function installClaudeHooks(settingsPath = claudeSettingsPath()): HookInstallResult {
  let settings: Record<string, unknown> = {};
  let original: string | undefined;
  if (fs.existsSync(settingsPath)) {
    original = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(original) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`unexpected shape in ${settingsPath} — expected a JSON object`);
    }
    settings = parsed as Record<string, unknown>;
  }

  const existingHooks = settings.hooks;
  const hooks: Record<string, unknown> =
    typeof existingHooks === "object" && existingHooks !== null && !Array.isArray(existingHooks)
      ? (existingHooks as Record<string, unknown>)
      : {};
  settings.hooks = hooks;

  let changed = false;
  const hookCommand = claudeHookCommand();
  for (const event of CLAUDE_HOOK_EVENTS) {
    const existing = hooks[event];
    if (entryListHasAgentblip(existing)) continue;
    const command = { type: "command", command: hookCommand };
    const entry = (MATCHER_EVENTS as readonly string[]).includes(event)
      ? { matcher: "*", hooks: [command] }
      : { hooks: [command] };
    if (Array.isArray(existing)) {
      existing.push(entry);
    } else if (existing === undefined) {
      hooks[event] = [entry];
    } else {
      continue; // unmanageable shape — leave the user's config untouched
    }
    changed = true;
  }

  let backupPath: string | undefined;
  if (changed) {
    if (original !== undefined) {
      backupPath = `${settingsPath}.agentblip-backup`;
      if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, original);
    }
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return { changed, settingsPath, backupPath };
}

export function areClaudeHooksInstalled(settingsPath = claudeSettingsPath()): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    return CLAUDE_HOOK_EVENTS.every((event) =>
      entryListHasAgentblip(parsed.hooks?.[event]),
    );
  } catch {
    return false;
  }
}

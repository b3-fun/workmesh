import fs from "node:fs";
import { sessionEventSchema } from "@workmesh/core";
import type { SessionEvent } from "@workmesh/core";
import { mapHookInput } from "../adapters/claude-code";
import { mapCodexHookInput, mapNotifyArg } from "../adapters/codex";
import { fitEventBody } from "../adapters/detail";
import { loadConfigSafe } from "../lib/config";
import { ensureDaemon, postEvent } from "../lib/daemon-client";
import type { HookAnswer } from "../daemon/coord-hooks";

const STDIN_TIMEOUT_MS = 1000;

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/** Hook events whose JSON output can carry Workmesh's answer (Claude Code and Codex share the shape). */
const ANSWERABLE = new Set(["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart"]);

/**
 * The hook's stdout for a daemon answer (Claude Code's documented hook JSON, which Codex 0.164's hook output schemas
 * match field for field): a PreToolUse refusal as `permissionDecision: "deny"` with its reason, context as
 * `additionalContext`. Never `allow`: Workmesh only ever refuses or informs, the agent's own permissions stand.
 */
export function hookOutput(hookEvent: string | undefined, answer: HookAnswer | undefined): string | undefined {
  if (!answer || !hookEvent || !ANSWERABLE.has(hookEvent)) return undefined;
  const out: Record<string, string> = { hookEventName: hookEvent };
  if (answer.deny && hookEvent === "PreToolUse") {
    out.permissionDecision = "deny";
    out.permissionDecisionReason = answer.deny;
  }
  if (answer.context) out.additionalContext = answer.context;
  if (Object.keys(out).length === 1) return undefined;
  return JSON.stringify({ hookSpecificOutput: out });
}

function hookEventName(json: unknown): string | undefined {
  const name = (json as { hook_event_name?: unknown } | null)?.hook_event_name;
  return typeof name === "string" && name.length <= 64 ? name : undefined;
}

/**
 * Adapter entrypoint installed into agent hooks. It must NEVER break the host
 * agent session: every error is swallowed and the process always exits 0.
 */
export async function runHook(source: string, payload?: string): Promise<void> {
  try {
    let event: SessionEvent | null = null;
    // Claude Code and Codex hooks: the hook event name, so the daemon can answer it (v1 Coordinate).
    let hook: string | undefined;
    if (source === "claude-code") {
      const raw = await readStdin(STDIN_TIMEOUT_MS);
      if (!raw.trim()) return;
      const json = JSON.parse(raw) as unknown;
      hook = hookEventName(json);
      event = mapHookInput(json);
    } else if (source === "codex-hooks") {
      // Codex lifecycle hooks: JSON on stdin. Codex adds a SessionStart/UserPromptSubmit hook's plain stdout to the
      // model's context, so nothing is printed but the structured JSON answer below.
      const raw = await readStdin(STDIN_TIMEOUT_MS);
      if (!raw.trim()) return;
      const json = JSON.parse(raw) as unknown;
      hook = hookEventName(json);
      event = mapCodexHookInput(json);
    } else if (source === "codex") {
      const raw = payload ?? (await readStdin(STDIN_TIMEOUT_MS));
      if (!raw.trim()) return;
      event = mapNotifyArg(raw);
    } else {
      // custom source: payload/stdin is a raw SessionEvent JSON
      const raw = payload ?? (await readStdin(STDIN_TIMEOUT_MS));
      if (!raw.trim()) return;
      const parsed = sessionEventSchema.safeParse(JSON.parse(raw) as unknown);
      event = parsed.success ? parsed.data : null;
    }
    if (!event) return;
    const config = loadConfigSafe();
    if (!(await ensureDaemon(config))) return;
    const res = await postEvent(config.port, fitEventBody(event), hook);
    const out = hookOutput(hook, res.coord);
    // Synchronous: the process exits right after, and a pipe write could be cut short.
    if (out) fs.writeSync(1, `${out}\n`);
  } catch {
    // swallow everything — exit 0 below
  } finally {
    process.exit(0);
  }
}

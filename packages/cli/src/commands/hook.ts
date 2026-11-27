import fs from "node:fs";
import pkg from "../../package.json";
import { sessionEventSchema } from "@workmesh/core";
import type { SessionEvent } from "@workmesh/core";
import { mapHookInput } from "../adapters/claude-code";
import { mapCodexHookInput, mapNotifyArg } from "../adapters/codex";
import { fitEventBody } from "../adapters/detail";
import { loadConfigSafe } from "../lib/config";
import { HOOK_TIMING, ensureDaemon, postEvent } from "../lib/daemon-client";
import type { HookAnswer } from "../daemon/coord-hooks";
import type { HookMeta } from "../daemon/server";
import { actionDigest, needsMessageConsent, CONSENT_UNAVAILABLE } from "../daemon/message-consent";
import { surfaceFingerprint } from "../lib/surface";

const STDIN_TIMEOUT_MS = 1000;

export function readStdin(timeoutMs: number): Promise<string> {
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
export function hookOutput(
  hookEvent: string | undefined,
  answer: HookAnswer | undefined,
  agent: "claude-code" | "codex" = "claude-code",
): string | undefined {
  if (!answer || !hookEvent || !ANSWERABLE.has(hookEvent)) return undefined;
  const out: Record<string, string> = { hookEventName: hookEvent };
  if (answer.deny && hookEvent === "PreToolUse") {
    out.permissionDecision = "deny";
    // Codex shows "Command blocked by PreToolUse hook: <reason>. Command: <command>": its own period follows ours.
    out.permissionDecisionReason = agent === "codex" ? answer.deny.replace(/\.\s*$/, "") : answer.deny;
  }
  if (answer.context) out.additionalContext = answer.context;
  if (Object.keys(out).length === 1 && !answer.systemMessage) return undefined;
  return JSON.stringify({ hookSpecificOutput: out, ...(answer.systemMessage ? { systemMessage: answer.systemMessage } : {}) });
}

function hookEventName(json: unknown): string | undefined {
  const name = (json as { hook_event_name?: unknown } | null)?.hook_event_name;
  return typeof name === "string" && name.length <= 64 ? name : undefined;
}

/**
 * 0.12 (SPEC §41): this hook's version, and at SessionStart what started the session (`startup`, `resume`, `clear`,
 * `compact`) and the tools it got, so the daemon knows what a session started under.
 */
export function hookMeta(hook: string | undefined, json: unknown, env: NodeJS.ProcessEnv = process.env): HookMeta {
  // A Workmesh handoff's agent runs with its id in the environment (SPEC §31): the daemon then knows the run before it
  // knows the session's key (a Codex thread names itself only after it started), and applies a review's read-only gate.
  const run = env.WORKMESH_HANDOFF;
  const handoff = typeof run === "string" && /^[\w-]{1,64}$/.test(run) ? { handoff: run } : {};
  if (hook === "PreToolUse") return { version: pkg.version, actionDigest: actionDigest(json), ...handoff };
  if (hook !== "SessionStart") return { version: pkg.version, ...handoff };
  const source = (json as { source?: unknown } | null)?.source;
  return {
    version: pkg.version,
    ...(typeof source === "string" && /^[a-z_-]{1,20}$/.test(source) ? { start: source } : {}),
    surface: surfaceFingerprint(),
    ...handoff,
  };
}

/**
 * Adapter entrypoint installed into agent hooks. It must NEVER break the host
 * agent session: every error is swallowed and the process always exits 0.
 */
export async function runHook(source: string, payload?: string): Promise<void> {
  const agent = source === "codex-hooks" ? "codex" : "claude-code";
  let preToolSession: string | undefined;
  let hook: string | undefined;
  let answer: HookAnswer | undefined;
  try {
    let event: SessionEvent | null = null;
    let meta: HookMeta = {};
    if (source === "claude-code" || source === "codex-hooks") {
      const raw = await readStdin(STDIN_TIMEOUT_MS);
      if (!raw.trim()) return;
      const json = JSON.parse(raw) as { session_id?: unknown };
      hook = hookEventName(json);
      if (hook === "PreToolUse" && typeof json.session_id === "string") {
        preToolSession = `${agent}:${json.session_id.slice(0, 128)}`;
      }
      meta = hookMeta(hook, json);
      event = agent === "codex" ? mapCodexHookInput(json) : mapHookInput(json);
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
    if (!(await ensureDaemon(config, HOOK_TIMING))) return;
    // The daemon answers from cached state within the native hook timeout.
    answer = (await postEvent(config.port, fitEventBody(event), hook, HOOK_TIMING.requestTimeoutMs, meta)).coord;
  } catch {
    // If the daemon or adapter failed, a locally guarded call still receives a refusal below.
  } finally {
    try {
      if (preToolSession && !answer?.deny && !answer?.consentChecked && needsMessageConsent(preToolSession)) {
        answer = { deny: CONSENT_UNAVAILABLE };
      }
      const out = hookOutput(hook, answer, agent);
      if (out) fs.writeSync(1, `${out}\n`);
    } finally {
      process.exit(0);
    }
  }
}

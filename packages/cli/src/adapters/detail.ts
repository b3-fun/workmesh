import path from "node:path";
import { DETAIL_LIMITS, PERMISSION_MODE_RE, truncateHead, truncateMiddle } from "@workmesh/core";
import type { SessionEvent, SessionEventDetail } from "@workmesh/core";

/**
 * Helpers that build the local-only `detail` block of a SessionEvent from raw
 * hook input. Everything here stays on the machine: the daemon hands detail to
 * the hub forwarder, which reduces it to metadata.
 */

/** Absolute form of a tool's path argument (relative paths resolve against cwd). */
export function absolutePath(p: unknown, cwd: string | undefined): string | undefined {
  if (typeof p !== "string" || !p) return undefined;
  const abs = path.isAbsolute(p) ? path.normalize(p) : cwd ? path.resolve(cwd, p) : undefined;
  return abs && abs.length <= DETAIL_LIMITS.filePath ? abs : undefined;
}

export function clip(text: unknown, max: number): string | undefined {
  if (typeof text !== "string" || !text) return undefined;
  return truncateMiddle(text, max);
}

/** Keeps the start of text (prompts and messages read from the top). */
export function clipHead(text: unknown, max: number): string | undefined {
  if (typeof text !== "string" || !text) return undefined;
  return truncateHead(text, max);
}

/** A hook payload's permission mode (`permission_mode`), when it is one word the detail schema takes. */
export function permissionModeOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= DETAIL_LIMITS.permissionMode && PERMISSION_MODE_RE.test(value) ? value : undefined;
}

/** The event with the hook's permission mode in its detail (local only), when the hook reported one. */
export function withPermissionMode(event: SessionEvent, hookEvent: string, value: unknown): SessionEvent {
  const permissionMode = permissionModeOf(value);
  if (!permissionMode) return event;
  return { ...event, detail: { ...(event.detail ?? { hookEvent: hookEvent.slice(0, DETAIL_LIMITS.hookEvent) }), permissionMode } };
}

/** An absolute transcript path from a hook payload, within the detail limit. */
export function transcriptPathOf(value: unknown): string | undefined {
  return typeof value === "string" && path.isAbsolute(value) && value.length <= DETAIL_LIMITS.transcriptPath
    ? value
    : undefined;
}

/** "mcp__claude-in-chrome__navigate" → "claude-in-chrome · navigate"; "mcp__plugin_slack_slack__send" → "slack · send". */
export function mcpDesc(tool: string): string | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (!m) return undefined;
  const parts = m[1]!.replace(/^plugin_/, "").split("_").filter(Boolean);
  const server = parts[parts.length - 1] ?? m[1]!;
  return `${server} · ${m[2]}`;
}

/** The host of a URL argument, or nothing (never its path or query). */
export function urlHost(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).host || undefined;
  } catch {
    return undefined;
  }
}

/** One line of at most DETAIL_LIMITS.desc chars, or nothing. */
export function oneLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(/\s+/g, " ").trim();
  return line ? truncateHead(line, DETAIL_LIMITS.desc) : undefined;
}

/**
 * Text of a shell tool's output: Claude Code reports {stdout, stderr}; Codex's
 * shape is not a stable contract, so common output keys and plain strings are
 * all accepted.
 */
export function responseText(resp: unknown): string | undefined {
  if (typeof resp === "string") return clip(resp, DETAIL_LIMITS.toolResponseText);
  if (resp && typeof resp === "object" && !Array.isArray(resp)) {
    const r = resp as Record<string, unknown>;
    const parts = [r.stdout, r.stderr, r.output, r.aggregated_output, r.formatted_output].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    if (parts.length > 0) return clip(parts.join("\n"), DETAIL_LIMITS.toolResponseText);
  }
  return undefined;
}

/** Whether a tool response reports success; undefined when it doesn't say. */
export function responseOk(resp: unknown): boolean | undefined {
  if (!resp || typeof resp !== "object" || Array.isArray(resp)) return undefined;
  const r = resp as Record<string, unknown>;
  if (r.is_error === true || r.isError === true || r.success === false || r.interrupted === true) {
    return false;
  }
  for (const key of ["exit_code", "exitCode"]) {
    if (typeof r[key] === "number") return r[key] === 0;
  }
  return true;
}

/** Drops empty keys so detail stays minimal on the wire to the daemon. */
export function compactDetail(detail: SessionEventDetail): SessionEventDetail | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? (out as SessionEventDetail) : undefined;
}

/** Hook → daemon bodies must stay under the daemon's 64 KB limit. */
const MAX_EVENT_BYTES = 60_000;

/**
 * Shrinks an event's detail until its JSON fits the daemon's body limit:
 * tool output first, then the prompt, then detail as a whole. The status
 * fields are never touched, so Slack still updates.
 */
export function fitEventBody(event: SessionEvent): SessionEvent {
  const size = (e: SessionEvent): number => Buffer.byteLength(JSON.stringify(e));
  if (!event.detail || size(event) <= MAX_EVENT_BYTES) return event;
  let detail: SessionEventDetail = { ...event.detail, toolResponseText: undefined };
  if (size({ ...event, detail }) <= MAX_EVENT_BYTES) return { ...event, detail };
  detail = {
    ...detail,
    prompt: undefined,
    filePaths: undefined,
    lastAssistantMessage: undefined,
    messageText: undefined,
  };
  if (size({ ...event, detail }) <= MAX_EVENT_BYTES) return { ...event, detail };
  const { detail: _dropped, ...rest } = event;
  return rest;
}

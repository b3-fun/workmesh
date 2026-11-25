import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DETAIL_LIMITS } from "@workmesh/core";
import { isInjectedPrompt as isInjected } from "@workmesh/protocol";
import type { SessionEvent, SessionEventDetail, SlackRef } from "@workmesh/core";
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
  urlHost,
} from "./detail";
import { OUR_COMMAND_RE } from "../lib/names";

/**
 * Absolute hook invocation: GUI-launched agents don't inherit the login-shell
 * PATH, so a bare `workmesh` may not resolve (exit 127 on every hook).
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
  // v0.6: subagents (hub forward only; the parent's Slack status is unchanged).
  "SubagentStart",
  "SubagentStop",
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
  transcript_path: z.string().optional(),
  prompt: z.string().optional(),
  tool_response: z.unknown().optional(),
  last_assistant_message: z.string().optional(),
  // v0.6, verified against live Claude Code 2.1.331 hook payloads (keys and
  // types only): every hook fired inside a subagent carries agent_id and
  // agent_type; SubagentStart adds nothing else; SubagentStop adds
  // agent_transcript_path; Stop and SubagentStop carry background_tasks
  // ({id, type: "shell" | …, status: "running", command, description}).
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
  agent_transcript_path: z.string().optional(),
  background_tasks: z.array(z.unknown()).optional(),
});

/** Tools whose PreToolUse means Claude is now asking the user and blocks on the answer. */
const ASKS_USER_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

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

/**
 * Claude Code's config dir as seen by this session, derived from its transcript
 * path (<dir>/projects/<slug>/<session>.jsonl). Honors CLAUDE_CONFIG_DIR
 * setups without the hook needing that env var. Undefined when the path has
 * another shape.
 */
export function claudeDirFromTranscript(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath) return undefined;
  const projects = path.dirname(path.dirname(transcriptPath));
  return path.basename(projects) === "projects" ? path.dirname(projects) : undefined;
}

/** How a finished turn ended: by asking the user something, or not. */
export type TurnEnding = "asks" | "done";

/** Phrases that put a question or an ask to the user, even without a "?". */
const ASK_PHRASES =
  /\b(want me to|should i|shall i|do you want|would you like|would you prefer|do you prefer|let me know|tell me (?:if|whether|which)|please confirm|can you confirm|needs? your|waiting (?:on|for) your|your (?:ok|okay|go-ahead|approval|sign-?off|call|decision|input))\b/gi;
/** A heading that opens a section of asks ("## Needs your OK", "**Questions for you**"). */
const ASK_HEADING =
  /\b(needs? (?:you|your)|waiting (?:on|for) you|for you|your (?:ok|okay|call|input|decision|approval|sign-?off)|open questions?|questions?|action (?:required|needed))\b/gi;
const HEADING_LINE = /^\s{0,3}(?:#{1,6}\s+(.+)|\*\*([^*]+)\*\*:?)\s*$/;
/** "nothing is waiting on you", "doesn't need your input": a negated ask is no ask. */
const NEGATION = /\b(nothing|no longer|not|never|none|no)\b[^.?!\n]{0,24}$|n't\b[^.?!\n]{0,24}$/i;

/** True when `pattern` matches somewhere in `text` not preceded by a negation. */
function hasUnnegated(pattern: RegExp, text: string): boolean {
  for (const m of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!NEGATION.test(before)) return true;
  }
  return false;
}
/** A "?" that ends a sentence or clause (not one inside a URL or identifier). */
const QUESTION_MARK = /\?(?=["'\u201d\u2019)\]*_~]*(\s|$))/;
const LIST_LINE = /^\s*([-*\u2022+]|\d+[.)])\s+/;

/** Removes text that can't be a question to the user: code, URLs, quotes, blockquotes. */
function proseOnly(paragraph: string): string {
  return paragraph
    .split("\n")
    .filter((line) => !/^\s*>/.test(line)) // quoted message drafts, not addressed to the user
    .join("\n")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/"[^"\n]*"|\u201c[^\u201d\n]*\u201d/g, " ") // reported speech: "Can you install it?"
    .trim();
}

/**
 * True when an assistant message ends by asking the user something:
 *  - its final paragraph (plus the lead-in, when that paragraph is a list) has
 *    a question mark ending a sentence, or an ask like "want me to", "should
 *    I", "let me know", "needs your OK", "waiting on your";
 *  - or any heading in it opens a section of asks ("## Needs your OK").
 * Code, URLs, quoted speech and blockquotes are ignored, and negated asks
 * ("nothing is waiting on you") don't count, so a message that reports a
 * question sent to someone else ("I asked An: \"can you…?\"", "When he
 * replies, I'll…") reads as done.
 */
export function textAsksUser(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?```/g, " ");
  for (const line of prose.split("\n")) {
    const h = HEADING_LINE.exec(line);
    const heading = h?.[1] ?? h?.[2];
    if (heading && hasUnnegated(ASK_HEADING, heading)) return true;
  }
  const paragraphs = prose
    .split(/\n\s*\n/)
    .map(proseOnly)
    .filter((p) => p.length > 0);
  const last = paragraphs.at(-1);
  if (last === undefined) return false;
  const lines = last.split("\n").filter((l) => l.trim());
  const isList = lines.length > 0 && lines.every((l) => LIST_LINE.test(l));
  const tail = isList && paragraphs.length > 1 ? `${paragraphs.at(-2)}\n${last}` : last;
  return QUESTION_MARK.test(tail) || hasUnnegated(ASK_PHRASES, tail);
}

const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
const TRANSCRIPT_TAIL_MAX_BYTES = 1024 * 1024;
/** Walked past every complete line in the tail without deciding. */
const NEED_MORE = Symbol("need-more");

interface TranscriptBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  id?: unknown;
  tool_use_id?: unknown;
}
interface TranscriptEntry {
  type?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  isVisibleInTranscriptOnly?: unknown;
  message?: { content?: unknown };
}

/** Walks transcript lines newest-first and decides how the last turn ended. */
function classifyLines(lines: string[]): TurnEnding | undefined | typeof NEED_MORE {
  const answered = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    // Cheap prefilter: most lines (api requests, attachments, system) are irrelevant.
    if (!line.includes('"assistant"') && !line.includes('"user"')) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    if (entry.isSidechain === true) continue;
    const content = entry.message?.content;
    if (entry.type === "user") {
      // Injected context and compaction summaries aren't the user speaking.
      if (entry.isMeta === true || entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) {
        continue;
      }
      if (typeof content === "string") return undefined; // a real prompt, no reply since
      if (!Array.isArray(content)) continue;
      let prompt = false;
      for (const b of content as TranscriptBlock[]) {
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") answered.add(b.tool_use_id);
        else if (b.type === "text") prompt = true;
      }
      if (prompt) return undefined;
      continue;
    }
    if (entry.type !== "assistant" || !Array.isArray(content)) continue;
    const blocks = content as TranscriptBlock[];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j]!;
      if (
        b.type === "tool_use" &&
        typeof b.name === "string" &&
        ASKS_USER_TOOLS.has(b.name) &&
        !(typeof b.id === "string" && answered.has(b.id))
      ) {
        return "asks"; // a question dialog is still open
      }
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        return textAsksUser(b.text) ? "asks" : "done";
      }
    }
  }
  return NEED_MORE;
}

/**
 * Reads the end of a Claude Code transcript (64 KB, growing to 1 MB when the
 * tail holds no assistant text) and reports whether the last turn ended by
 * asking the user something. Undefined when it can't tell: unreadable file,
 * or the user spoke last (e.g. an interrupted turn).
 */
export function lastTurnEnding(transcriptPath: string): TurnEnding | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size;
    for (let want = TRANSCRIPT_TAIL_BYTES; ; want *= 4) {
      const start = Math.max(0, size - want);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n");
      if (start > 0) lines.shift(); // partial first line
      const result = classifyLines(lines);
      if (result !== NEED_MORE) return result;
      if (start === 0 || want >= TRANSCRIPT_TAIL_MAX_BYTES) return undefined;
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/** Claude Code agent ids: `a` + 16 hex today; anything id-shaped is kept. */
const AGENT_ID_RE = /^[\w.-]{1,64}$/;

/** The subagent a hook fired in, as local detail fields (agentId, agentType). */
function agentFields(input: { agent_id?: string; agent_type?: string }): Pick<SessionEventDetail, "agentId" | "agentType"> {
  const agentId = input.agent_id && AGENT_ID_RE.test(input.agent_id) ? input.agent_id : undefined;
  return {
    agentId,
    agentType: agentId ? oneLine(input.agent_type)?.slice(0, DETAIL_LIMITS.agentType) : undefined,
  };
}

/** Counts the running entries of a Stop's `background_tasks` by kind (shells vs agents). */
export function backgroundCounts(tasks: readonly unknown[] | undefined): { shells?: number; agents?: number } {
  if (!tasks) return {};
  let shells = 0;
  let agents = 0;
  for (const t of tasks) {
    if (!t || typeof t !== "object") continue;
    const r = t as { type?: unknown; status?: unknown };
    if (r.status !== undefined && r.status !== "running") continue;
    if (r.type === "shell") shells++;
    else agents++; // "shell" is verified; every other kind is an agent-like task
  }
  return { shells: Math.min(shells, 999), agents: Math.min(agents, 999) };
}

/**
 * A prompt Claude Code injected rather than the person typed: a background
 * task's completion notice, a message from another session, agent or
 * teammate, a local command's output, or nothing but provenance markers
 * (`@workmesh/protocol`'s `stripInjected`, SPEC §19). Its text is not the
 * person's, so it never travels as a prompt.
 */
export function isInjectedPrompt(prompt: string | undefined): boolean {
  return isInjected(prompt);
}

const SLACK_TOOL_RE = /^mcp__.*slack.*__/i;
const SLACK_LINK_RE = /https:\/\/[\w-]+\.slack\.com\/archives\/([A-Z0-9]{6,20})\/p(\d{10})(\d{6})(?:\?[^\s"'\\]*)?/;
const SLACK_CHANNEL_RE = /^[A-Z][A-Z0-9]{5,19}$/;
const SLACK_TS_RE = /^\d{9,11}\.\d{1,9}$/;

/**
 * Slack messages an MCP Slack tool call touched (shapes read from real
 * transcripts of the Slack plugin: inputs carry `channel_id` and `message_ts`
 * or `thread_ts`; slack_send_message answers `{message_link, message_context:
 * {channel_id, message_ts}}` as JSON text with escaped slashes). Channel ids,
 * message ts and the permalink only; never message text.
 */
export function slackRefs(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
  toolResponse?: unknown,
): SlackRef[] | undefined {
  if (!toolName || !SLACK_TOOL_RE.test(toolName)) return undefined;
  const out: SlackRef[] = [];
  const add = (ref: SlackRef): void => {
    if (out.some((r) => r.channel === ref.channel && r.ts === ref.ts)) return;
    if (out.length < 5) out.push(ref);
  };
  let responseText: string | undefined;
  if (typeof toolResponse === "string") responseText = toolResponse;
  else if (toolResponse !== undefined) {
    try {
      responseText = JSON.stringify(toolResponse);
    } catch {
      responseText = undefined;
    }
  }
  // The Slack MCP server's JSON escapes slashes (`https:\/\/x.slack.com\/archives\/…`), verified on real results.
  const link = responseText ? SLACK_LINK_RE.exec(responseText.slice(0, 200_000).replace(/\\+\//g, "/")) : null;
  if (link) {
    const url = link[0].length <= DETAIL_LIMITS.slackLink ? link[0] : undefined;
    add({ channel: link[1]!, ts: `${link[2]}.${link[3]}`, link: url });
  }
  const channel = typeof toolInput?.channel_id === "string" ? toolInput.channel_id : undefined;
  if (channel && SLACK_CHANNEL_RE.test(channel)) {
    const rawTs = toolInput?.message_ts ?? toolInput?.thread_ts;
    const ts = typeof rawTs === "string" && SLACK_TS_RE.test(rawTs) ? rawTs : undefined;
    const name = oneLine(toolInput?.channel_name)?.slice(0, DETAIL_LIMITS.slackName);
    if (!link || link[1] !== channel) add({ channel, ts, name });
    else if (name) out[0] = { ...out[0]!, name };
  }
  return out.length > 0 ? out : undefined;
}

/** SendMessage's recipient and text (Claude Code: `to` + `message`, or `recipient` + `content`). */
export function sendMessageFields(
  toolInput: Record<string, unknown> | undefined,
): Pick<SessionEventDetail, "messageTo" | "messageText"> {
  const to = [toolInput?.to, toolInput?.recipient].find((v): v is string => typeof v === "string" && v.trim() !== "");
  const text = [toolInput?.message, toolInput?.content, toolInput?.summary].find(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  return {
    messageTo: to ? oneLine(to)?.slice(0, DETAIL_LIMITS.messagePeer) : undefined,
    messageText: clipHead(text, DETAIL_LIMITS.messageText),
  };
}

export interface MapHookOptions {
  /** Injected for tests; defaults to reading Claude Code's local state. */
  backgroundWork?: (sessionId: string) => boolean;
  /** Injected for tests; defaults to reading the tail of the session transcript. */
  turnEnding?: (transcriptPath: string | undefined) => TurnEnding | undefined;
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
    case "AskUserQuestion":
    case "ExitPlanMode":
      return "thinking"; // PostToolUse: the user answered, Claude carries on
    case "Workflow":
      return "orchestrating a workflow";
    case "WebFetch":
    case "WebSearch":
      return "browsing the web";
    default:
      return `using ${toolName}`;
  }
}

/**
 * The raw one-line description of a tool call (SPEC §9 `desc`): Bash and
 * Agent/Task `description`, the WebSearch query, the WebFetch host (never
 * the path), the Skill name, "server · tool" for MCP tools. Local only: the
 * hub forwarder redacts it and sends it only at the conversation level.
 */
export function claudeToolDesc(toolName: string, toolInput: Record<string, unknown> | undefined): string | undefined {
  switch (toolName) {
    case "Bash":
    case "Task":
    case "Agent":
      return oneLine(toolInput?.description);
    case "WebSearch":
      return oneLine(toolInput?.query);
    case "WebFetch":
      return urlHost(toolInput?.url);
    case "Skill":
      return oneLine(toolInput?.skill ?? toolInput?.name);
    default:
      return toolName.startsWith("mcp__") ? oneLine(mcpDesc(toolName)) : undefined;
  }
}

/**
 * Local-only facts about one tool call (see SessionEventDetail): the tool, the
 * absolute path it touched, a Bash command, and on PostToolUse the output text
 * and success flag.
 */
export function claudeToolDetail(
  hookEvent: string,
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
  cwd: string | undefined,
  toolResponse?: unknown,
  agent: Pick<SessionEventDetail, "agentId" | "agentType"> = {},
): SessionEventDetail | undefined {
  if (!toolName) return compactDetail({ hookEvent, ...agent });
  const post = hookEvent === "PostToolUse" || hookEvent === "PostToolUseFailure";
  const isShell = toolName === "Bash";
  let text: string | undefined;
  if (post) {
    text = isShell ? responseText(toolResponse) : clip(toolResponse, DETAIL_LIMITS.toolResponseText);
  }
  return compactDetail({
    hookEvent,
    tool: toolName.slice(0, DETAIL_LIMITS.tool),
    filePath: absolutePath(toolInput?.file_path ?? toolInput?.notebook_path ?? toolInput?.path, cwd),
    command: isShell ? clip(toolInput?.command, DETAIL_LIMITS.command) : undefined,
    toolResponseText: text,
    ok: hookEvent === "PostToolUseFailure" ? false : post ? responseOk(toolResponse) : undefined,
    desc: claudeToolDesc(toolName, toolInput),
    ...agent,
    // One agent_message per send: PreToolUse carries it.
    ...(toolName === "SendMessage" && !post ? sendMessageFields(toolInput) : {}),
    slack: slackRefs(toolName, toolInput, post ? toolResponse : undefined),
  });
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
    cwd: input.cwd && input.cwd.length <= 1024 ? input.cwd : undefined,
    ts: fallbackNow,
  };
  // Every event carries the transcript path (local only) so the hub forwarder
  // can tail it from the moment the session is shared.
  const transcriptPath = transcriptPathOf(input.transcript_path);
  const withTranscript = (detail: SessionEventDetail | undefined): SessionEventDetail | undefined =>
    transcriptPath ? { ...(detail ?? {}), transcriptPath } : detail;
  const event = mapClaudeEvent(input, base, opts);
  if (!event) return null;
  if (!transcriptPath) return event;
  return { ...event, detail: withTranscript(event.detail ?? compactDetail({ hookEvent: input.hook_event_name.slice(0, DETAIL_LIMITS.hookEvent) })) };
}

type ClaudeHookInput = z.infer<typeof hookInputSchema>;
type EventBase = Pick<SessionEvent, "source" | "sessionId" | "project" | "cwd" | "ts">;

function mapClaudeEvent(input: ClaudeHookInput, base: EventBase, opts: MapHookOptions): SessionEvent | null {
  switch (input.hook_event_name) {
    case "SessionStart":
      return { ...base, kind: "start" };
    case "UserPromptSubmit":
      if (isInjectedPrompt(input.prompt)) {
        // Claude Code is resuming on a task notice or another agent's message:
        // the turn starts, but no person spoke and the text isn't theirs.
        return { ...base, kind: "working", activity: "thinking", detail: compactDetail({ hookEvent: "InjectedPrompt" }) };
      }
      return {
        ...base,
        kind: "working",
        activity: "thinking",
        detail: compactDetail({
          hookEvent: "UserPromptSubmit",
          prompt: clipHead(input.prompt, DETAIL_LIMITS.prompt),
        }),
      };
    case "PreToolUse": {
      const detail = claudeToolDetail("PreToolUse", input.tool_name, input.tool_input, input.cwd, undefined, agentFields(input));
      // AskUserQuestion / ExitPlanMode open a dialog and block on the user.
      if (input.tool_name && ASKS_USER_TOOLS.has(input.tool_name)) {
        return { ...base, kind: "waiting", activity: "needs my input", detail };
      }
      return {
        ...base,
        kind: "working",
        activity: toolLabel(input.tool_name, input.tool_input)?.slice(0, 200),
        detail,
      };
    }
    case "PostToolUse":
    case "PostToolUseFailure":
      // "working", not heartbeat: after a permission prompt (waiting) is
      // approved, tool completion is the first signal — it must flip the
      // state back to working. The fresh tool label avoids inheriting a
      // stale "needs my input" activity.
      return {
        ...base,
        kind: "working",
        activity: toolLabel(input.tool_name, input.tool_input)?.slice(0, 200),
        detail: claudeToolDetail(
          input.hook_event_name,
          input.tool_name,
          input.tool_input,
          input.cwd,
          input.tool_response,
          agentFields(input),
        ),
      };
    case "Notification": {
      // Claude Code's 60s idle reminder ("idle_prompt") fires whenever a finished
      // turn sits unanswered. It only "needs my input" when the turn ended by
      // asking the user something:
      //  - still running its own background shells/subagents → working
      //    (it resumes by itself);
      //  - the last assistant text asks nothing (e.g. "When he replies, I'll…")
      //    → idle/"done";
      //  - it asks, or we can't tell → waiting, as before.
      // Permission prompts, elicitation dialogs and unknown types stay waiting.
      if (input.notification_type === "idle_prompt") {
        const claudeDir = claudeDirFromTranscript(input.transcript_path);
        const backgroundWork =
          opts.backgroundWork ?? ((id: string) => hasBackgroundWork(id, Date.now(), claudeDir));
        if (backgroundWork(base.sessionId)) {
          return { ...base, kind: "working", activity: "running in background", background: true };
        }
        const ending = opts.turnEnding
          ? opts.turnEnding(input.transcript_path)
          : input.transcript_path
            ? lastTurnEnding(input.transcript_path)
            : undefined;
        if (ending === "done") return { ...base, kind: "idle", activity: "done" };
      }
      return { ...base, kind: "waiting", activity: "needs my input" };
    }
    case "Stop": {
      const bg = backgroundCounts(input.background_tasks);
      return {
        ...base,
        kind: "idle",
        detail: compactDetail({
          hookEvent: input.hook_event_name,
          lastAssistantMessage: clipHead(input.last_assistant_message, DETAIL_LIMITS.lastAssistantMessage),
          backgroundShells: bg.shells,
          backgroundAgents: bg.agents,
        }),
      };
    }
    case "SubagentStart":
    case "SubagentStop": {
      // The parent session's state doesn't change (a heartbeat keeps it): a
      // subagent is the hub forwarder's business. Its last message stays home.
      const agent = agentFields(input);
      if (!agent.agentId) return null;
      const stop = input.hook_event_name === "SubagentStop";
      return {
        ...base,
        kind: "heartbeat",
        detail: compactDetail({
          hookEvent: input.hook_event_name,
          ...agent,
          agentTranscriptPath: stop ? transcriptPathOf(input.agent_transcript_path) : undefined,
        }),
      };
    }
    case "SessionEnd":
      return { ...base, kind: "end" };
    default:
      return null;
  }
}

export function claudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

/** Our Claude Code hook command, under any of our names (lib/names.ts) and any install path. */
export function isOurClaudeHook(command: unknown): command is string {
  return typeof command === "string" && OUR_COMMAND_RE.test(command) && command.includes("hook claude-code");
}

/**
 * Finds our hook in an event's entry list. When it points somewhere else (an
 * older install path, a checkout from before the rename), it is repointed
 * to `command` in place. Returns whether ours was found and whether it changed.
 */
function refreshOurHook(entries: unknown, command: string): { found: boolean; updated: boolean } {
  let found = false;
  let updated = false;
  if (!Array.isArray(entries)) return { found, updated };
  for (const entry of entries) {
    const hooks = (entry as { hooks?: unknown } | null)?.hooks;
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      const h = hook as { command?: unknown } | null;
      if (h && isOurClaudeHook(h.command)) {
        found = true;
        if (h.command !== command) {
          (h as { command: string }).command = command;
          updated = true;
        }
      }
    }
  }
  return { found, updated };
}

function entryListHasOurs(entries: unknown): boolean {
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    const hooks = (entry as { hooks?: unknown } | null)?.hooks;
    return Array.isArray(hooks) && hooks.some((hook) => isOurClaudeHook((hook as { command?: unknown } | null)?.command));
  });
}

export interface HookInstallResult {
  changed: boolean;
  settingsPath: string;
  backupPath?: string;
}

/**
 * Merges Workmesh hook entries into Claude Code settings. Idempotent: events
 * that already carry our command are skipped, unknown keys are
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
    const ours = refreshOurHook(existing, hookCommand);
    if (ours.updated) changed = true;
    if (ours.found) continue;
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
      backupPath = `${settingsPath}.workmesh-backup`;
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
      entryListHasOurs(parsed.hooks?.[event]),
    );
  } catch {
    return false;
  }
}

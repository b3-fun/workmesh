/**
 * Synthetic transcript lines in the shapes Claude Code and Codex write
 * (structure copied from real files on a dev machine, field by field; every
 * value here is made up). Claude Code writes one content block per
 * `assistant` line; Codex 0.164 rollouts wrap records as {timestamp, type, payload}.
 */
const iso = (ms: number): string => new Date(ms).toISOString();
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

const claudeBase = (ts: number) => ({
  parentUuid: uuid(),
  isSidechain: false,
  userType: "external",
  entrypoint: "cli",
  cwd: "/repo",
  sessionId: "s",
  version: "2.9.0",
  gitBranch: "main",
  timestamp: iso(ts),
});

const assistantMessage = (content: unknown[], model = "claude-opus-5-5") => ({
  model,
  id: `msg_${n}`,
  type: "message",
  role: "assistant",
  content,
  stop_reason: null,
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

export const claudeLines = {
  text: (text: string, id: string, ts: number, over: Record<string, unknown> = {}): string =>
    JSON.stringify({ ...claudeBase(ts), type: "assistant", uuid: id, requestId: "req_1", message: assistantMessage([{ type: "text", text }]), ...over }),
  thinking: (thinking: string, ts = 1): string =>
    JSON.stringify({ ...claudeBase(ts), type: "assistant", uuid: uuid(), message: assistantMessage([{ type: "thinking", thinking, signature: "sig" }]) }),
  toolUse: (name: string, input: Record<string, unknown>, ts = 1): string =>
    JSON.stringify({ ...claudeBase(ts), type: "assistant", uuid: uuid(), message: assistantMessage([{ type: "tool_use", id: `toolu_${n}`, name, input }]) }),
  toolResult: (content: string, ts = 1): string =>
    JSON.stringify({
      ...claudeBase(ts),
      type: "user",
      uuid: uuid(),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${n}`, content }] },
      toolUseResult: { stdout: content, stderr: "" },
    }),
  user: (text: string, ts = 1): string =>
    JSON.stringify({ ...claudeBase(ts), type: "user", uuid: uuid(), promptId: uuid(), message: { role: "user", content: text } }),
  apiBlob: (text: string): string =>
    JSON.stringify({ type: "api-request-blob", hash: "h", sessionId: "s", message: { role: "assistant", content: [{ type: "text", text }] } }),
  synthetic: (text: string, ts = 1): string =>
    JSON.stringify({
      ...claudeBase(ts),
      type: "assistant",
      uuid: uuid(),
      isApiErrorMessage: true,
      message: assistantMessage([{ type: "text", text }], "<synthetic>"),
    }),
  turnDuration: (durationMs: number, ts: number): string =>
    JSON.stringify({ ...claudeBase(ts), type: "system", subtype: "turn_duration", durationMs, messageCount: 12, uuid: uuid(), isMeta: false }),
  stopHookSummary: (ts: number): string =>
    JSON.stringify({ ...claudeBase(ts), type: "system", subtype: "stop_hook_summary", hookCount: 4, hookInfos: [], hookErrors: [], uuid: uuid(), level: "suggestion" }),
  attachment: (ts: number): string =>
    JSON.stringify({ ...claudeBase(ts), type: "attachment", uuid: uuid(), attachment: { type: "todo", content: "ATTACHMENT_MARKER" } }),
};

const codex = (type: string, payload: Record<string, unknown>, ts = 1): string =>
  JSON.stringify({ timestamp: iso(ts), ordinal: ++n, type, payload });

export const codexLines = {
  sessionMeta: (id = "t", ts = 1): string =>
    codex("session_meta", { id, session_id: id, timestamp: iso(ts), cwd: "/repo", originator: "codex_cli_rs", cli_version: "0.164.0" }, ts),
  assistant: (text: string, id: string, ts: number): string =>
    codex("response_item", { type: "message", status: "completed", id, role: "assistant", content: [{ type: "output_text", text, annotations: [], logprobs: [] }], phase: "commentary" }, ts),
  reasoning: (ts = 1): string => codex("response_item", { type: "reasoning", id: "rs_1", summary: [], content: null, encrypted_content: "ENCRYPTED_REASONING" }, ts),
  functionCall: (name: string, args: string, ts = 1): string =>
    codex("response_item", { type: "function_call", status: "completed", id: "fc_1", name, arguments: args, call_id: "call_1" }, ts),
  functionCallOutput: (output: string, ts = 1): string => codex("response_item", { type: "function_call_output", id: "fco_1", call_id: "call_1", output }, ts),
  developer: (text: string, ts = 1): string =>
    codex("response_item", { type: "message", id: "m_dev", role: "developer", content: [{ type: "input_text", text }] }, ts),
  user: (text: string, ts = 1): string => codex("response_item", { type: "message", id: "m_user", role: "user", content: [{ type: "input_text", text }] }, ts),
  agentMessage: (text: string, ts = 1): string =>
    codex("response_item", { type: "agent_message", id: "am_1", author: "/root/agent_a", recipient: "/root", content: [{ type: "input_text", text }] }, ts),
  taskStarted: (ts: number): string => codex("event_msg", { type: "task_started", turn_id: "turn_1", started_at: Math.floor(ts / 1000) }, ts),
  taskComplete: (durationMs: number, ts: number, last = "LAST_AGENT_MESSAGE_COPY"): string =>
    codex("event_msg", { type: "task_complete", turn_id: "turn_1", last_agent_message: last, duration_ms: durationMs, time_to_first_token_ms: 900 }, ts),
};

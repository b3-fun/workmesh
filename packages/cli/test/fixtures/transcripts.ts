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

/**
 * v0.6 shapes (Claude Code 2.1.331 and Codex 0.164, keys copied from real
 * files; values made up): assistant usage with cache tokens (several lines of
 * one API message share its id and usage), a subagent's meta.json, peer
 * messages, and Codex spawned-thread metadata, token totals and agent sends.
 */
export const structureLines = {
  claudeUsage: (msgId: string, usage: Record<string, number>, ts = 1, model = "claude-opus-5-5", block = 0): string =>
    JSON.stringify({
      ...claudeBase(ts),
      isSidechain: true,
      agentId: "a0123456789abcdef",
      type: "assistant",
      uuid: uuid(),
      apiBlockIndex: block,
      requestId: `req_${msgId}`,
      message: { model, id: msgId, type: "message", role: "assistant", content: [{ type: "text", text: "SUBAGENT_TEXT" }], usage },
    }),
  subagentMeta: (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      agentType: "general-purpose",
      isBuiltIn: true,
      description: "Polling PR 164 CI checks",
      toolUseId: "toolu_01",
      spawnDepth: 1,
      requestShape: "background",
      requestNonInteractive: true,
      model: "opus",
      pickedEffortModel: "claude-opus-5-5",
      ...over,
    }),
  peerFromSubagent: (agentId: string, body: string, ts = 1): string =>
    JSON.stringify({
      ...claudeBase(ts),
      type: "user",
      uuid: uuid(),
      isMeta: true,
      origin: { kind: "peer", from: agentId, name: "general-purpose", body, senderTaskId: agentId },
      message: { role: "user", content: body },
    }),
  peerFromSession: (name: string, body: string, ts = 1): string =>
    JSON.stringify({
      ...claudeBase(ts),
      type: "user",
      uuid: uuid(),
      isMeta: true,
      origin: { kind: "peer", from: "uds:/tmp/cc-socks/12345.sock", name, body, msg_id: "m1", fromMode: "bypass", verifiedPeerPid: 12345 },
      message: { role: "user", content: `<cross-session-message from="uds:/tmp/cc-socks/12345.sock">${body}</cross-session-message>` },
    }),
  codexSpawnedMeta: (id: string, parent: string, agentPath = "/root/review_auth_flow"): string =>
    codex("session_meta", {
      id,
      session_id: id,
      cwd: "/repo",
      originator: "codex_cli_rs",
      cli_version: "0.164.0",
      base_instructions: { text: "BASE_INSTRUCTIONS" },
      parent_thread_id: parent,
      agent_nickname: "Gauss",
      agent_path: agentPath,
      thread_source: "subagent",
      multi_agent_version: "v2",
      source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: agentPath, agent_nickname: "Gauss", agent_role: "worker" } } },
    }),
  /** `context`: the latest call's input (the thread's context now); `output`: cumulative output. */
  codexTokenCount: (context: number, output: number, ts = 1): string =>
    codex("event_msg", {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: context * 4, cached_input_tokens: context * 3, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: context * 4 + output },
        last_token_usage: { input_tokens: context, cached_input_tokens: context - 1, output_tokens: 1 },
        model_context_window: 400000,
      },
    }, ts),
  codexTurnContext: (model: string, ts = 1): string => codex("turn_context", { cwd: "/repo", model, approval_policy: "never" }, ts),
  codexSend: (name: string, args: Record<string, unknown>, callId: string, ts = 1): string =>
    codex("response_item", { type: "function_call", status: "completed", id: `fc_${callId}`, name, arguments: JSON.stringify(args), call_id: callId }, ts),
};

/**
 * v0.11 session mirror shapes (Claude Code 2.1.332, Codex 0.164; keys, enum values and Claude Code's own notice
 * templates copied from real files, every value made up).
 */
const notification = (inner: string): string => `<task-notification>\n${inner}\n</task-notification>`;
export const mirrorLines = {
  aiTitle: (title: string): string => JSON.stringify({ type: "ai-title", aiTitle: title, sessionId: "s" }),
  customTitle: (title: string): string => JSON.stringify({ type: "custom-title", customTitle: title, sessionId: "s" }),
  permissionMode: (mode: string): string => JSON.stringify({ type: "permission-mode", permissionMode: mode, sessionId: "s" }),
  mode: (): string => JSON.stringify({ type: "mode", mode: "normal", sessionId: "s" }),
  compact: (ts: number, durationMs = 41_000): string =>
    JSON.stringify({
      ...claudeBase(ts),
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      uuid: uuid(),
      level: "info",
      logicalParentUuid: uuid(),
      compactMetadata: { trigger: "auto", preTokens: 180_000, postTokens: 12_000, durationMs, preservedMessages: 4 },
    }),
  turnDuration: (durationMs: number, ts: number, pendingAgents?: number, pendingWorkflows?: number): string =>
    JSON.stringify({
      ...claudeBase(ts),
      type: "system",
      subtype: "turn_duration",
      durationMs,
      messageCount: 12,
      pendingBackgroundAgentCount: pendingAgents,
      pendingWorkflowCount: pendingWorkflows,
      uuid: uuid(),
      isMeta: false,
    }),
  /** A task notice as Claude Code injects it: a `user` line, origin task-notification. */
  notice: (fields: { summary: string; taskId?: string; status?: string; durationMs?: number; event?: string; result?: string }, ts = 1): string => {
    const parts = [
      fields.taskId ? `<task-id>${fields.taskId}</task-id>` : "",
      `<tool-use-id>toolu_${n}</tool-use-id>`,
      `<output-file>/private/tmp/claude-501/tasks/${fields.taskId ?? "x"}.output</output-file>`,
      fields.status ? `<status>${fields.status}</status>` : "",
      `<summary>${fields.summary}</summary>`,
      fields.event ? `<event>${fields.event}</event>` : "",
      fields.result ? `<result>${fields.result}</result>` : "",
      fields.durationMs !== undefined ? `<usage><total_tokens>1</total_tokens><tool_uses>2</tool_uses><duration_ms>${fields.durationMs}</duration_ms></usage>` : "",
    ].filter(Boolean);
    return JSON.stringify({
      ...claudeBase(ts),
      type: "user",
      uuid: uuid(),
      isMeta: true,
      origin: { kind: "task-notification", producer: "session-task", runId: "run_1" },
      turnOrigin: "task_notification",
      message: { role: "user", content: notification(parts.join("\n")) },
    });
  },
  bashBackground: (taskId: string, ts = 1): string =>
    JSON.stringify({
      ...claudeBase(ts),
      type: "user",
      uuid: uuid(),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${n}`, content: "BG_TOOL_OUTPUT" }] },
      toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: taskId },
    }),
  monitorStarted: (taskId: string, ts = 1): string =>
    JSON.stringify({
      ...claudeBase(ts),
      type: "user",
      uuid: uuid(),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${n}`, content: "MONITOR_TOOL_OUTPUT" }] },
      toolUseResult: { taskId, persistent: false, timeoutMs: 600_000 },
    }),
  agentLaunched: (agentId: string, ts = 1): string =>
    JSON.stringify({
      ...claudeBase(ts),
      type: "user",
      uuid: uuid(),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${n}`, content: "AGENT_LAUNCH_OUTPUT" }] },
      toolUseResult: { status: "async_launched", agentId, description: "AGENT_DESCRIPTION_IN_RESULT", prompt: "AGENT_PROMPT", isAsync: true, outputFile: "/tmp/x", canReadOutputFile: true, canContinueAgent: true, resolvedModel: "claude-opus-5-5" },
    }),
  codexTurnContext: (model: string, approval: string, sandbox: string, ts = 1): string =>
    codex("turn_context", { cwd: "/repo", model, approval_policy: approval, sandbox_policy: { type: sandbox }, effort: "high", summary: "auto" }, ts),
  codexCompacted: (ts = 1): string =>
    codex("compacted", { message: "COMPACTION_SUMMARY_TEXT", replacement_history: [], window_number: 2 }, ts),
  codexCompactionItem: (id: string, ts: number, ms = 3000): string =>
    codex("event_msg", { type: "item_completed", thread_id: "t", turn_id: "turn_1", item: { type: "ContextCompaction", id }, started_at_ms: ts - ms, completed_at_ms: ts }, ts),
  codexPlan: (plan: Array<{ step: string; status: string }>, callId: string, ts = 1): string =>
    codex("response_item", { type: "function_call", status: "completed", id: `fc_${callId}`, name: "update_plan", arguments: JSON.stringify({ explanation: "PLAN_EXPLANATION", plan }), call_id: callId }, ts),
};

/**
 * SPEC §45 usage shapes (Claude Code 2.1.331 transcripts, Codex 0.164 rollouts; keys, enum values and the way lines
 * repeat copied from real files, every number and text made up).
 */
export interface ClaudeCallUsage {
  input?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  output?: number;
}
const claudeUsageObject = (u: ClaudeCallUsage) => {
  const w5 = u.cacheWrite5m ?? 0;
  const w1 = u.cacheWrite1h ?? 0;
  const one = { input_tokens: u.input ?? 0, output_tokens: u.output ?? 0, cache_read_input_tokens: u.cacheRead ?? 0, cache_creation_input_tokens: w5 + w1 };
  return {
    ...one,
    output_tokens_details: { thinking_tokens: Math.floor((u.output ?? 0) / 3) },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: w1, ephemeral_5m_input_tokens: w5 },
    inference_geo: "global",
    iterations: [{ ...one, cache_creation: { ephemeral_1h_input_tokens: w1, ephemeral_5m_input_tokens: w5 }, type: "message" }],
    speed: "standard",
    fallback_credit: null,
  };
};
export const usageLines = {
  /** One content block of an API message (Claude Code writes one line per block, each repeating id and usage). */
  claudeCall: (
    msgId: string,
    u: ClaudeCallUsage,
    ts: number,
    o: { model?: string; block?: "thinking" | "text" | "tool_use"; sidechain?: boolean; apiError?: boolean } = {},
  ): string => {
    const block =
      o.block === "thinking"
        ? { type: "thinking", thinking: "", signature: "SIG" }
        : o.block === "tool_use"
          ? { type: "tool_use", id: `toolu_${++n}`, name: "Bash", input: { command: "TOOL_INPUT" } }
          : { type: "text", text: "ASSISTANT_TEXT" };
    return JSON.stringify({
      ...claudeBase(ts),
      isSidechain: o.sidechain === true,
      ...(o.sidechain ? { agentId: "a0123456789abcdef" } : {}),
      type: "assistant",
      uuid: uuid(),
      requestId: `req_${msgId}`,
      ...(o.apiError ? { isApiErrorMessage: true } : {}),
      message: {
        model: o.model ?? "claude-opus-5-5",
        id: msgId,
        type: "message",
        role: "assistant",
        content: [block],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: claudeUsageObject(u),
      },
    });
  },
  /** Claude Code's request record beside each call (no usage of its own). */
  apiRequest: (ts: number): string =>
    JSON.stringify({ type: "api-request", sessionId: "s", id: uuid(), timestamp: iso(ts), version: "2.1.331", querySource: "repl_main_thread", params: { model: "claude-opus-5-5", max_tokens: 64000 } }),
  compactBoundary: (ts: number): string =>
    JSON.stringify({
      ...claudeBase(ts),
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      isMeta: false,
      level: "info",
      uuid: uuid(),
      logicalParentUuid: uuid(),
      compactMetadata: { trigger: "auto", preTokens: 180_000, postTokens: 9_000, durationMs: 41_000 },
    }),
  compactSummary: (ts: number): string =>
    JSON.stringify({ ...claudeBase(ts), type: "user", uuid: uuid(), isCompactSummary: true, message: { role: "user", content: "COMPACT_SUMMARY_TEXT" } }),
  derivedFrom: (via: "resume" | "compact"): string =>
    JSON.stringify({ type: "derived-from", v: 1, sessionId: "s", sessions: [{ type: "claude_code_session", id: "s", via }] }),
  /** Claude Code's own `/cost` record (counts the main thread, subagents and side calls together: never read). */
  costState: (): string =>
    JSON.stringify({ type: "cost-state", sessionId: "s", totalCostUSD: 12.5, modelUsage: { "claude-opus-5-5": { inputTokens: 1, outputTokens: 1, costUSD: 12.5 } } }),
  /** A Codex token_count: the thread's cumulative totals and the last call's. `null` info = a rate-limit-only update. */
  codexCount: (
    total: { input: number; cached: number; output: number; reasoning?: number; cacheWrite?: number } | null,
    ts: number,
    lastInput = 0,
  ): string =>
    codex(
      "event_msg",
      {
        type: "token_count",
        info: total
          ? {
              total_token_usage: {
                input_tokens: total.input,
                cached_input_tokens: total.cached,
                cache_write_input_tokens: total.cacheWrite ?? 0,
                output_tokens: total.output,
                reasoning_output_tokens: total.reasoning ?? 0,
                total_tokens: total.input + total.output,
              },
              last_token_usage: { input_tokens: lastInput, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: lastInput + 1 },
              model_context_window: 258_400,
            }
          : null,
        rate_limits: { primary: { used_percent: 12.0, window_minutes: 300 } },
      },
      ts,
    ),
  codexTurnContext: (model: string, ts: number): string =>
    codex("turn_context", { cwd: "/repo", model, approval_policy: "on-request", sandbox_policy: { type: "workspace-write" }, effort: "high", summary: "auto" }, ts),
};

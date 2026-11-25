import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sessionEventSchema } from "@workmesh/core";
import {
  CLAUDE_HOOK_EVENTS,
  backgroundCounts,
  installClaudeHooks,
  isInjectedPrompt,
  mapHookInput,
  sendMessageFields,
  slackAction,
  slackRefs,
} from "../src/adapters/claude-code";

/**
 * v0.6 hook mapping. Payload keys are the ones live Claude Code 2.1.331 hooks
 * sent on this machine (shapes only); values are made up.
 */
const base = {
  session_id: "sess-1",
  cwd: "/Users/dev/b3/workmesh",
  transcript_path: "/Users/dev/.claude/projects/-Users-dev-b3-workmesh/sess-1.jsonl",
  permission_mode: "default",
  prompt_id: "00000000-0000-4000-8000-000000000001",
};
const AGENT = "a0123456789abcdef";

describe("Claude Code subagent hooks (v0.6)", () => {
  it("installs SubagentStart and SubagentStop", () => {
    expect(CLAUDE_HOOK_EVENTS).toEqual(expect.arrayContaining(["SubagentStart", "SubagentStop"]));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-hooks-"));
    try {
      const file = path.join(dir, "settings.json");
      installClaudeHooks(file);
      const hooks = (JSON.parse(fs.readFileSync(file, "utf8")) as { hooks: Record<string, unknown[]> }).hooks;
      expect(Object.keys(hooks)).toEqual(expect.arrayContaining(["SubagentStart", "SubagentStop"]));
      expect(hooks.SubagentStart?.[0]).not.toHaveProperty("matcher");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps SubagentStart to a heartbeat carrying the agent's id and type", () => {
    const e = mapHookInput({ ...base, hook_event_name: "SubagentStart", agent_id: AGENT, agent_type: "Explore" }, 5);
    expect(e).toMatchObject({ kind: "heartbeat", sessionId: "sess-1", ts: 5 });
    expect(e?.detail).toEqual({ hookEvent: "SubagentStart", agentId: AGENT, agentType: "Explore", transcriptPath: base.transcript_path });
    expect(sessionEventSchema.safeParse(e).success).toBe(true);
  });

  it("maps SubagentStop with the subagent's transcript, never its last message", () => {
    const e = mapHookInput({
      ...base,
      hook_event_name: "SubagentStop",
      agent_id: AGENT,
      agent_type: "Explore",
      agent_transcript_path: "/Users/dev/.claude/projects/-x/sess-1/subagents/agent-a0123456789abcdef.jsonl",
      last_assistant_message: "SUBAGENT_LAST_MESSAGE",
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [],
    });
    expect(e?.kind).toBe("heartbeat");
    expect(e?.detail?.agentTranscriptPath).toMatch(/agent-a0123456789abcdef\.jsonl$/);
    expect(JSON.stringify(e)).not.toContain("SUBAGENT_LAST_MESSAGE");
  });

  it("drops a SubagentStart without a usable agent id", () => {
    expect(mapHookInput({ ...base, hook_event_name: "SubagentStart", agent_type: "Explore" })).toBeNull();
    expect(mapHookInput({ ...base, hook_event_name: "SubagentStart", agent_id: "has spaces", agent_type: "x" })).toBeNull();
  });

  it("tags tool hooks fired inside a subagent; the parent still shows the work", () => {
    const e = mapHookInput({ ...base, hook_event_name: "PreToolUse", agent_id: AGENT, agent_type: "Explore", tool_name: "Glob", tool_input: { pattern: "*", path: "." }, tool_use_id: "toolu_1" });
    expect(e).toMatchObject({ kind: "working", activity: "reading code" });
    expect(e?.detail).toMatchObject({ agentId: AGENT, agentType: "Explore", tool: "Glob" });
    const main = mapHookInput({ ...base, hook_event_name: "PreToolUse", tool_name: "Glob", tool_input: { pattern: "*" } });
    expect(main?.detail?.agentId).toBeUndefined();
  });

  it("counts a Stop's running background tasks by kind", () => {
    const e = mapHookInput({
      ...base,
      hook_event_name: "Stop",
      last_assistant_message: "ok",
      background_tasks: [
        { id: "b1", type: "shell", status: "running", command: "sleep 20", description: "SLEEP" },
        { id: "b2", type: "local_agent", status: "running", description: "x" },
        { id: "b3", type: "shell", status: "completed" },
      ],
    });
    expect(e?.detail).toMatchObject({ backgroundShells: 1, backgroundAgents: 1 });
    expect(JSON.stringify(e)).not.toContain("sleep 20");
    expect(backgroundCounts(undefined)).toEqual({});
    expect(backgroundCounts([null, "x", { type: "shell" }])).toEqual({ shells: 1, agents: 0 });
  });
});

describe("prompts Claude Code injected (v0.6)", () => {
  it("are not the person's: a task notice or another agent's message starts a turn without prompt text", () => {
    for (const prompt of [
      "<task-notification>\n<task-id>a1</task-id>RESULT_TEXT</task-notification>",
      '<cross-session-message from="uds:/tmp/x.sock">PEER_TEXT</cross-session-message>',
      "  <teammate-message>hi</teammate-message>",
    ]) {
      expect(isInjectedPrompt(prompt)).toBe(true);
      const e = mapHookInput({ ...base, hook_event_name: "UserPromptSubmit", prompt });
      expect(e).toMatchObject({ kind: "working", activity: "thinking" });
      expect(e?.detail?.hookEvent).toBe("InjectedPrompt");
      expect(e?.detail?.prompt).toBeUndefined();
    }
    expect(isInjectedPrompt("please look at <task-notification> handling")).toBe(false);
    expect(mapHookInput({ ...base, hook_event_name: "UserPromptSubmit", prompt: "fix it" })?.detail?.prompt).toBe("fix it");
  });
});

describe("SendMessage (v0.6)", () => {
  it("keeps the recipient and text locally, for the hub forwarder to reduce", () => {
    const e = mapHookInput({ ...base, hook_event_name: "PreToolUse", tool_name: "SendMessage", tool_input: { to: AGENT, message: "status?", summary: "ask" } });
    expect(e?.detail).toMatchObject({ tool: "SendMessage", messageTo: AGENT, messageText: "status?" });
    // PostToolUse doesn't send it again.
    const post = mapHookInput({ ...base, hook_event_name: "PostToolUse", tool_name: "SendMessage", tool_input: { to: AGENT, message: "status?" }, tool_response: { success: true } });
    expect(post?.detail?.messageTo).toBeUndefined();
    expect(sendMessageFields({ recipient: "documents-07", content: "hi" })).toEqual({ messageTo: "documents-07", messageText: "hi" });
    expect(sendMessageFields({ to: "x", message: { type: "shutdown_request" }, summary: "stop" })).toEqual({ messageTo: "x", messageText: "stop" });
    expect(sendMessageFields(undefined)).toEqual({ messageTo: undefined, messageText: undefined });
  });
});

describe("Slack MCP tools (v0.6; labels since 0.11)", () => {
  const send = "mcp__plugin_slack_slack__slack_send_message";
  const sent = (channel: string, ts: string) => [
    { type: "text", text: JSON.stringify({ message_link: `https://b3-labs.slack.com/archives/${channel}/p${ts.replace(".", "")}`, message_context: { channel_id: channel, message_ts: ts } }) },
  ];
  it("keeps channel id, message ts, the permalink and the action from a send's response, never its text", () => {
    expect(slackRefs(send, { channel_id: "C0123ABCD", message: "MESSAGE_TEXT" }, sent("C0123ABCD", "1795545603.000100"))).toEqual([
      { channel: "C0123ABCD", ts: "1795545603.000100", link: "https://b3-labs.slack.com/archives/C0123ABCD/p1795545603000100", name: undefined, action: "Sent" },
    ]);
    const e = mapHookInput({ ...base, hook_event_name: "PostToolUse", tool_name: send, tool_input: { channel_id: "C0123ABCD", message: "MESSAGE_TEXT" }, tool_response: sent("C0123ABCD", "1795545603.000100") });
    expect(e?.detail?.slack).toHaveLength(1);
    expect(JSON.stringify(e?.detail?.slack)).not.toContain("MESSAGE_TEXT");
  });

  it("names a DM send once: the permalink's DM, not the user id the call was given; nothing before the response", () => {
    expect(slackRefs(send, { channel_id: "U07ABCDEF1", message: "x" }, sent("D07ABCDEF1", "1795624663.424829"))).toEqual([
      expect.objectContaining({ channel: "D07ABCDEF1", action: "Sent" }),
    ]);
    expect(slackRefs(send, { channel_id: "U07ABCDEF1", message: "x" })).toBeUndefined();
  });

  it("reads the permalink when the server escapes its slashes (the real shape)", () => {
    const text = '{"message_link":"https:\\/\\/b3-labs.slack.com\\/archives\\/C0123ABCD\\/p1795545603000100?thread_ts=1795545000.000200&cid=C0123ABCD","message_context":{"channel_id":"C0123ABCD","message_ts":"1795545603.000100"}}';
    expect(text).toContain("https:\\/\\/");
    expect(slackRefs(send, { channel_id: "C0123ABCD", message: "x", thread_ts: "1795545000.000200" }, [{ type: "text", text }])?.[0]).toMatchObject({
      channel: "C0123ABCD",
      ts: "1795545603.000100",
      link: "https://b3-labs.slack.com/archives/C0123ABCD/p1795545603000100?thread_ts=1795545000.000200&cid=C0123ABCD",
    });
  });

  it("says where from a read's channel line, a draft's channel_info, and how many places a search found", () => {
    const read = "mcp__plugin_slack_slack__slack_read_channel";
    const channelRead = [{ type: "text", text: JSON.stringify({ messages: "Channel: #eng (C0ENG00001)\n\n=== Message from Someone ===\nMESSAGE_TEXT", pagination_info: "" }) }];
    expect(slackRefs(read, { channel_id: "C0ENG00001" }, channelRead)).toEqual([{ channel: "C0ENG00001", ts: undefined, name: "#eng", action: "Read" }]);
    const dmRead = [{ type: "text", text: "Channel: DM (D07ABCDEF1)\n\nMESSAGE_TEXT" }];
    expect(slackRefs(read, { channel_id: "D07ABCDEF1" }, dmRead)?.[0]).toMatchObject({ name: "DM", action: "Read" });
    const draft = [{ type: "text", text: JSON.stringify({ result: "ok", draft_id: "x", channel_link: "https://b3-labs.slack.com/archives/C0ENG00001", channel_info: { channel_id: "C0ENG00001", name: "eng", is_dm: false } }) }];
    expect(slackRefs("mcp__plugin_slack_slack__slack_send_message_draft", { channel_id: "C0ENG00001", message: "DRAFT_TEXT" }, draft)?.[0]).toMatchObject({ channel: "C0ENG00001", name: "#eng", action: "Drafted" });
    const search = "mcp__plugin_slack_slack__slack_search_public_and_private";
    const hits = (lines: string[]) => [{ type: "text", text: JSON.stringify({ results: lines.map((l) => `### Result\nChannel: ${l}\nFrom: Someone\nText: MESSAGE_TEXT`).join("\n\n") }) }];
    expect(slackRefs(search, { query: "QUERY_TEXT" }, hits(["#eng (ID: C0ENG00001)", "DM (ID: D07ABCDEF1)", "Group DM (ID: G07ABCDEF1)", "#eng (ID: C0ENG00001)"]))).toEqual([
      { channel: "C0ENG00001", name: "3 channels", action: "Searched" },
    ]);
    expect(slackRefs(search, { query: "QUERY_TEXT" }, hits(["#oncall (ID: C0ONC00001)"]))?.[0]).toMatchObject({ name: "#oncall" });
    expect(JSON.stringify(slackRefs(search, { query: "QUERY_TEXT" }, hits(["#eng (ID: C0ENG00001)"])))).not.toMatch(/QUERY_TEXT|MESSAGE_TEXT|Someone/);
  });

  it("names actions from any Slack MCP server's tools; other tools have none", () => {
    expect(slackAction("mcp__slack__search_messages")).toBe("Searched");
    expect(slackAction("mcp__plugin_slack_slack__slack_add_reaction")).toBe("Reacted");
    expect(slackAction("mcp__plugin_slack_slack__slack_schedule_message")).toBe("Scheduled");
    expect(slackAction("mcp__plugin_slack_slack__slack_list_channel_members")).toBe("Listed");
    expect(slackRefs("mcp__plugin_slack_slack__slack_read_channel", { channel_id: "not-an-id" }, [{ type: "text", text: "x" }])).toBeUndefined();
    expect(slackRefs("Bash", { channel_id: "C0123ABCD" }, "x")).toBeUndefined();
  });
});

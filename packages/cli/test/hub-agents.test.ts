import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ClaudeUsageReader,
  backgroundStatusLine,
  claudeSubagentsDir,
  codexTaskTitle,
  readClaudeSubagentMeta,
  readCodexThreadMeta,
  readCodexUsage,
} from "../src/hub/agents";
import { extractGithubLink } from "../src/hub/rules";
import { parseClaudeLine, parseCodexLine } from "../src/hub/transcript";
import { claudeLines as cl, codexLines as cx, structureLines as sl } from "./fixtures/transcripts";

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-agents-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const write = (name: string, lines: string[]): string => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, lines.map((l) => `${l}\n`).join(""));
  return f;
};

describe("Claude Code subagent usage (v0.6)", () => {
  it("reports the latest context (input with cache reads and writes) and output summed once per API message", async () => {
    const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 7 };
    const f = write("agent-a1.jsonl", [
      sl.claudeUsage("msg_1", usage, 1, "claude-opus-5-5", 0),
      sl.claudeUsage("msg_1", usage, 1, "claude-opus-5-5", 1), // same message, second block: counted once
      cl.toolResult("TOOL_OUTPUT"),
    ]);
    const r = new ClaudeUsageReader(f);
    expect(await r.read()).toEqual({ tokensIn: 1110, tokensOut: 7, model: "claude-opus-5-5", more: false });
    fs.appendFileSync(f, `${sl.claudeUsage("msg_2", { input_tokens: 5, output_tokens: 3 }, 2, "claude-haiku-5-5")}\n`);
    expect(await r.read()).toEqual({ tokensIn: 5, tokensOut: 10, model: "claude-haiku-5-5", more: false });
    // A partial line waits for its newline.
    fs.appendFileSync(f, sl.claudeUsage("msg_3", { input_tokens: 1, output_tokens: 1 }).slice(0, 40));
    expect((await r.read())?.tokensOut).toBe(10);
  });

  it("keeps totals when old message ids are evicted, and restarts on a replaced file", async () => {
    const f = write("agent-a2.jsonl", Array.from({ length: 6 }, (_, i) => sl.claudeUsage(`m${i}`, { input_tokens: 1, output_tokens: 2 })));
    const r = new ClaudeUsageReader(f, 2 * 1024 * 1024, 2);
    expect(await r.read()).toMatchObject({ tokensIn: 1, tokensOut: 12 }); // evicted ids keep their output
    fs.rmSync(f);
    write("agent-a2.jsonl", [sl.claudeUsage("n1", { input_tokens: 4, output_tokens: 4 })]);
    expect(await r.read()).toMatchObject({ tokensIn: 4, tokensOut: 4 });
    expect(await new ClaudeUsageReader(path.join(dir, "missing.jsonl")).read()).toBeUndefined();
  });

  it("ignores synthetic models and API error lines", async () => {
    const f = write("agent-a3.jsonl", [
      cl.synthetic("ERR"),
      sl.claudeUsage("ok", { input_tokens: 2, output_tokens: 2 }, 1, "<synthetic>"),
    ]);
    expect(await new ClaudeUsageReader(f).read()).toMatchObject({ tokensIn: 2, tokensOut: 2, model: undefined });
  });

  it("reads meta.json: type, task description, background shape, workflow membership", async () => {
    const f = path.join(dir, "agent-a1.meta.json");
    fs.writeFileSync(f, sl.subagentMeta());
    expect(await readClaudeSubagentMeta(f)).toEqual({
      agentType: "general-purpose",
      description: "Polling PR 164 CI checks",
      requestShape: "background",
      inWorkflowRun: undefined,
    });
    fs.writeFileSync(f, sl.subagentMeta({ agentType: "workflow-subagent", inWorkflowRun: true }));
    expect((await readClaudeSubagentMeta(f))?.inWorkflowRun).toBe(true);
    fs.writeFileSync(f, "not json");
    expect(await readClaudeSubagentMeta(f)).toBeUndefined();
  });

  it("finds a session's subagents dir from its main transcript only", () => {
    expect(claudeSubagentsDir("/h/.claude/projects/-x/s1.jsonl")).toBe("/h/.claude/projects/-x/s1/subagents");
    expect(claudeSubagentsDir("/h/.claude/projects/-x/s1/subagents/agent-a.jsonl")).toBeUndefined();
    expect(claudeSubagentsDir("relative.jsonl")).toBeUndefined();
    expect(claudeSubagentsDir(undefined)).toBeUndefined();
  });
});

describe("Codex threads (v0.6)", () => {
  it("reads who spawned a thread from its session_meta", async () => {
    const f = write("rollout-2026-11-24T00-00-00-child.jsonl", [sl.codexSpawnedMeta("019b0000-0000-7000-8000-000000000002", "019b0000-0000-7000-8000-000000000001")]);
    expect(await readCodexThreadMeta(f)).toEqual({
      parentThreadId: "019b0000-0000-7000-8000-000000000001",
      agentRole: "worker",
      agentNickname: "Gauss",
      agentPath: "/root/review_auth_flow",
      depth: 1,
    });
    const top = write("rollout-top.jsonl", [cx.sessionMeta("t1")]);
    expect((await readCodexThreadMeta(top))?.parentThreadId).toBeUndefined();
  });

  it("takes the context and cumulative output of the last token_count, and the model, from the rollout's end", async () => {
    const f = write("rollout-usage.jsonl", [
      cx.sessionMeta("t2"),
      sl.codexTurnContext("gpt-6-codex"),
      sl.codexTokenCount(100, 10),
      cx.assistant("ASSISTANT", "m1", 2),
      sl.codexTokenCount(250, 40),
    ]);
    expect(await readCodexUsage(f)).toEqual({ tokensIn: 250, tokensOut: 40, model: "gpt-6-codex" });
    expect(await readCodexUsage(write("rollout-none.jsonl", [cx.sessionMeta("t3")]))).toBeUndefined();
  });

  it("turns an agent path into a title", () => {
    expect(codexTaskTitle("/root/review_auth_flow")).toBe("review auth flow");
    expect(codexTaskTitle("/root")).toBeUndefined();
    expect(codexTaskTitle(undefined)).toBeUndefined();
  });
});

describe("status lines (v0.6)", () => {
  it("says what a session waits on", () => {
    expect(backgroundStatusLine(1, 0)).toBe("waiting on 1 shell");
    expect(backgroundStatusLine(0, 2)).toBe("waiting on 2 agents");
    expect(backgroundStatusLine(2, 1)).toBe("waiting on 2 shells, 1 agent");
    expect(backgroundStatusLine(0, 0)).toBeUndefined();
  });
});

describe("agent messages in transcripts (v0.6)", () => {
  it("reads Claude Code peer messages: a subagent reporting back, another session writing in", () => {
    expect(parseClaudeLine(sl.peerFromSubagent("a0123456789abcdef", "PR 164 is green", 5))).toMatchObject([
      { kind: "agentMessage", direction: "in", channel: "claude-session", fromAgentId: "a0123456789abcdef", from: "general-purpose", text: "PR 164 is green" },
    ]);
    const [x] = parseClaudeLine(sl.peerFromSession("documents-07", "can you rebase?", 6));
    expect(x).toMatchObject({ kind: "agentMessage", direction: "in", from: "documents-07", text: "can you rebase?" });
    expect(JSON.stringify(x)).not.toContain("uds:"); // the sender's socket address stays home
    // A sidechain copy or a plain user prompt is not a peer message.
    expect(parseClaudeLine(sl.peerFromSubagent("a0123456789abcdef", "x").replace('"isSidechain":false', '"isSidechain":true'))).toEqual([]);
    expect(parseClaudeLine(cl.user("PROMPT"))).toEqual([]);
  });

  it("reads Codex sends to other agents; other calls yield nothing", () => {
    expect(parseCodexLine(sl.codexSend("send_message", { target: "/root/worker_1", message: "check the logs" }, "c1"))).toEqual([
      { kind: "agentMessage", id: "codex-send:c1", ts: 1, direction: "out", channel: "codex-mail", to: "/root/worker_1", text: "check the logs" },
    ]);
    expect(parseCodexLine(sl.codexSend("spawn_agent", { task_name: "review_auth", message: "review it" }, "c2"))[0]).toMatchObject({ to: "review_auth" });
    expect(parseCodexLine(sl.codexSend("wait_agent", { timeout_ms: 1000 }, "c3"))).toEqual([]);
    expect(parseCodexLine(sl.codexSend("shell", { command: ["ls"] }, "c4"))).toEqual([]);
    expect(parseCodexLine(sl.codexSend("send_message", { target: "x" }, "c5"))).toEqual([]);
  });
});

describe("GitHub links (v0.6)", () => {
  it("finds the PR or issue a gh call is about, in its output or its arguments", () => {
    expect(extractGithubLink("gh pr checks 164", "https://github.com/b3-fun/workmesh/pull/164 all green")).toEqual({
      type: "github_pr",
      url: "https://github.com/b3-fun/workmesh/pull/164",
      repo: "b3-fun/workmesh",
      number: 164,
    });
    expect(extractGithubLink("gh pr view https://github.com/b3-fun/workmesh/pull/9", undefined)?.number).toBe(9);
    expect(extractGithubLink("gh issue create -t x", "https://github.com/b3-fun/workmesh/issues/12\n")).toMatchObject({ type: "github_issue", number: 12 });
    expect(extractGithubLink("git push", "https://github.com/b3-fun/workmesh/pull/1")).toBeUndefined();
    expect(extractGithubLink(undefined, "x")).toBeUndefined();
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionStore } from "@workmesh/core";
import { hubIngestAcceptSchema, hubIngestRequestSchema } from "@workmesh/protocol";
import type { SessionEvent } from "@workmesh/core";
import type { HubActivityEvent, HubIngestRequest, HubProjectRule, HubSessionUpsert, HubShareLevel } from "@workmesh/protocol";
import { mapHookInput } from "../src/adapters/claude-code";
import { mapCodexHookInput } from "../src/adapters/codex";
import { stepWorkflows } from "../src/adapters/workflow";
import { HubForwarder } from "../src/hub/forwarder";
import { claudeLines as cl, codexLines as cx, structureLines as sl } from "./fixtures/transcripts";

/**
 * v0.6 capture through the whole forwarder (docs/SPEC.md §15): subagents as
 * sessions under their parent, agent messages, links, the person's GitHub
 * login. Temp HOME with fake repos, a fake ~/.claude/projects and a fake
 * ~/.codex/sessions; hook payloads in the shapes live hooks send.
 */

const NOW = 1_795_545_600_000;
const TOKEN = `bp_${"a".repeat(64)}`;
const RULE: HubProjectRule = {
  id: "b3",
  name: "B3",
  include: { remotes: ["github.com/b3-fun/"], dirs: [] },
  issueKeys: ["B3"],
  defaultShare: "conversation",
};
const AGENT = "a0123456789abcdef";
const AGENT2 = "afedcba9876543210";

let home: string;
let beta: string;
let salience: string;
let projects: string;
let codexDay: string;
let codexSessions: string;

function fakeRepo(dir: string, origin: string, branch = "main"): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${origin}\n`);
}

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-structure-")));
  beta = path.join(home, "Documents", "b3", "b3os-beta");
  salience = path.join(home, "Documents", "salience");
  projects = path.join(home, ".claude", "projects", "-Users-dev-b3os-beta");
  codexSessions = path.join(home, ".codex", "sessions");
  codexDay = path.join(codexSessions, "2026", "11", "24");
  fakeRepo(beta, "git@github.com:b3-fun/b3os-beta.git");
  fakeRepo(salience, "https://github.com/seangeng/salience.git");
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(codexDay, { recursive: true });
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function harness(over: { share?: HubShareLevel; structured?: boolean; github?: string; heartbeatMs?: number } = {}) {
  const store = new SessionStore();
  const raw: string[] = [];
  const bodies: HubIngestRequest[] = [];
  const replies: Array<{ status: number; body?: unknown }> = [];
  let now = NOW;
  const fwd = new HubForwarder({
    url: "https://hub.test",
    token: TOKEN,
    rule: RULE,
    listSessions: () => store.list(),
    getSession: (k) => store.get(k),
    fetchImpl: (async (_u: string | URL, init?: RequestInit) => {
      const text = String(init?.body ?? "");
      raw.push(text);
      const body = JSON.parse(text) as HubIngestRequest;
      bodies.push(body);
      const r = replies.shift() ?? { status: 200, body: { ok: true, accepted: body.events.length } };
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
    }) as typeof fetch,
    now: () => now,
    homeDir: home,
    share: over.share ?? "conversation",
    codexSessionsDir: codexSessions,
    turnRecordWaitMs: 0,
    structured: over.structured ?? true,
    github: over.github,
    heartbeatMs: over.heartbeatMs,
  });
  const feed = (e: SessionEvent | null): void => {
    if (!e) throw new Error("mapper returned null");
    store.apply(e, now);
    fwd.observe(e);
  };
  const claude = (sessionId: string, cwd: string, input: Record<string, unknown>): void =>
    feed(
      mapHookInput(
        { session_id: sessionId, cwd, transcript_path: path.join(projects, `${sessionId}.jsonl`), permission_mode: "default", ...input },
        now,
        { backgroundWork: () => false, turnEnding: () => "done" },
      ),
    );
  const send = async (): Promise<void> => {
    await fwd.flushTranscripts();
    await fwd.tick();
  };
  const upserts = (key: string): HubSessionUpsert[] => bodies.flatMap((b) => b.sessions).filter((s) => s.key === key);
  return {
    store,
    fwd,
    raw,
    bodies,
    replies,
    feed,
    claude,
    send,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    events: (key?: string): HubActivityEvent[] => bodies.flatMap((b) => b.events).filter((e) => !key || e.key === key),
    upserts,
    last: (key: string): HubSessionUpsert | undefined => upserts(key).at(-1),
  };
}

/** Writes a session's subagent transcript + meta.json under the fake projects dir. */
function subagentFiles(sessionId: string, agentId: string, lines: string[], meta: Record<string, unknown> = {}): string {
  const dir = path.join(projects, sessionId, "subagents");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
  fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), sl.subagentMeta(meta));
  return file;
}

describe("Claude Code subagents (SPEC §15)", () => {
  it("sends each subagent as a session under its parent: type, task, model, tokens, status line", async () => {
    const h = harness();
    const file = subagentFiles("p1", AGENT, [
      sl.claudeUsage("msg_1", { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 }),
      sl.claudeUsage("msg_1", { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 }, 1, "claude-opus-5-5", 1),
    ]);
    h.claude("p1", beta, { hook_event_name: "UserPromptSubmit", prompt: "check CI for B3-7166" });
    h.claude("p1", beta, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { description: "Poll CI", prompt: "PROMPT_FOR_SUBAGENT", subagent_type: "general-purpose" } });
    h.claude("p1", beta, { hook_event_name: "SubagentStart", agent_id: AGENT, agent_type: "general-purpose" });
    h.advance(1000);
    h.claude("p1", beta, { hook_event_name: "PreToolUse", agent_id: AGENT, agent_type: "general-purpose", tool_name: "Bash", tool_input: { command: "gh pr checks 164", description: "Check CI" } });
    await h.send();

    const sub = h.last(`claude-code:p1/${AGENT}`);
    expect(sub).toMatchObject({
      source: "claude-code",
      state: "working",
      parent: "claude-code:p1",
      role: "subagent",
      agentType: "general-purpose",
      title: "Polling PR 164 CI checks",
      model: "claude-opus-5-5",
      tokensIn: 100,
      tokensOut: 5,
      statusLine: "running commands",
      repo: "b3-fun/b3os-beta",
    });
    expect(h.last("claude-code:p1")).toMatchObject({ role: "main", state: "working" });
    // The subagent's tool call is on its own timeline; the parent keeps its own.
    expect(h.events(`claude-code:p1/${AGENT}`).map((e) => [e.kind, e.tool, e.cmd])).toEqual([["tool", "Bash", "gh pr"]]);
    expect(h.events("claude-code:p1").map((e) => e.kind)).toEqual(["prompt", "tool"]);
    // Its prompt and transcript text never leave.
    const all = h.raw.join("\n");
    expect(all).not.toContain("PROMPT_FOR_SUBAGENT");
    expect(all).not.toContain("SUBAGENT_TEXT");
    for (const b of h.bodies) expect(hubIngestAcceptSchema.parse(hubIngestRequestSchema.parse(b))).toBeTruthy();

    // More usage, then SubagentStop: a final read, and the session ends.
    fs.appendFileSync(file, `${sl.claudeUsage("msg_2", { input_tokens: 1, output_tokens: 20 })}\n`);
    h.advance(6000);
    h.claude("p1", beta, { hook_event_name: "SubagentStop", agent_id: AGENT, agent_type: "general-purpose", agent_transcript_path: file, last_assistant_message: "SUBAGENT_LAST", background_tasks: [] });
    await h.send();
    expect(h.last(`claude-code:p1/${AGENT}`)).toMatchObject({ state: "ended", tokensIn: 1, tokensOut: 25 });
    expect(h.raw.join("\n")).not.toContain("SUBAGENT_LAST");
    expect(h.fwd.status()).toMatchObject({ structured: true, subagentSessions: 0 });
  });

  it("at the metadata level a subagent has no title; the rest is metadata", async () => {
    const h = harness({ share: "metadata" });
    subagentFiles("p2", AGENT, [sl.claudeUsage("m", { input_tokens: 3, output_tokens: 4 })]);
    h.claude("p2", beta, { hook_event_name: "SubagentStart", agent_id: AGENT, agent_type: "Explore" });
    await h.send();
    const sub = h.last(`claude-code:p2/${AGENT}`);
    expect(sub).toMatchObject({ parent: "claude-code:p2", role: "subagent", agentType: "Explore", tokensIn: 3, tokensOut: 4 });
    expect(sub?.title).toBeUndefined();
    expect(h.raw.join("\n")).not.toContain("Polling PR");
  });

  it("an older hub (no team view) gets no subagent sessions: their work stays on the parent", async () => {
    const h = harness({ structured: false });
    subagentFiles("p3", AGENT, []);
    h.claude("p3", beta, { hook_event_name: "SubagentStart", agent_id: AGENT, agent_type: "Explore" });
    h.claude("p3", beta, { hook_event_name: "PreToolUse", agent_id: AGENT, tool_name: "Read", tool_input: { file_path: path.join(beta, "README.md") } });
    await h.send();
    expect(h.upserts(`claude-code:p3/${AGENT}`)).toEqual([]);
    expect(h.events("claude-code:p3").map((e) => [e.kind, e.path])).toEqual([["tool", "README.md"]]);
    // When the hub starts reading structure, live subagents show up.
    h.fwd.setStructured(true);
    h.advance(1000);
    await h.send();
    expect(h.last(`claude-code:p3/${AGENT}`)).toMatchObject({ state: "working", parent: "claude-code:p3" });
  });

  it("nothing from a subagent of an unshared session leaves", async () => {
    const h = harness();
    subagentFiles("p4", AGENT, [sl.claudeUsage("m", { input_tokens: 3, output_tokens: 4 })]);
    h.claude("p4", salience, { hook_event_name: "SubagentStart", agent_id: AGENT, agent_type: "Explore" });
    h.claude("p4", salience, { hook_event_name: "PreToolUse", agent_id: AGENT, tool_name: "Bash", tool_input: { command: "ls" } });
    await h.send();
    expect(h.bodies.flatMap((b) => [...b.sessions, ...b.events])).toEqual([]);
  });

  it("a workflow's agent is left to the workflow session", async () => {
    const h = harness();
    subagentFiles("p5", AGENT, [], { agentType: "workflow-subagent", inWorkflowRun: true });
    h.claude("p5", beta, { hook_event_name: "SubagentStart", agent_id: AGENT, agent_type: "general-purpose" });
    h.claude("p5", beta, { hook_event_name: "SubagentStart", agent_id: AGENT2, agent_type: "workflow-subagent" });
    await h.send();
    expect(h.upserts(`claude-code:p5/${AGENT}`)).toEqual([]);
    expect(h.upserts(`claude-code:p5/${AGENT2}`)).toEqual([]);
  });

  it("subagents end with their parent", async () => {
    const h = harness();
    subagentFiles("p6", AGENT, []);
    h.claude("p6", beta, { hook_event_name: "SubagentStart", agent_id: AGENT, agent_type: "Explore" });
    await h.send();
    h.claude("p6", beta, { hook_event_name: "SessionEnd" });
    h.advance(1000);
    await h.send();
    expect(h.last(`claude-code:p6/${AGENT}`)?.state).toBe("ended");
    expect(h.last("claude-code:p6")?.state).toBe("ended");
  });

  it("a Stop with background work says what the session waits on", async () => {
    const h = harness();
    h.claude("p7", beta, { hook_event_name: "UserPromptSubmit", prompt: "run it" });
    h.claude("p7", beta, {
      hook_event_name: "Stop",
      last_assistant_message: "started",
      background_tasks: [{ id: "b1", type: "shell", status: "running", command: "sleep 99", description: "SLEEP_DESC" }],
    });
    await h.send();
    expect(h.last("claude-code:p7")).toMatchObject({ state: "idle", statusLine: "waiting on 1 shell" });
    expect(h.raw.join("\n")).not.toContain("SLEEP_DESC");
    h.advance(1000);
    h.claude("p7", beta, { hook_event_name: "UserPromptSubmit", prompt: "next" });
    await h.send();
    expect(h.last("claude-code:p7")?.statusLine).toBeUndefined();
  });
});

describe("agent messages (SPEC §15)", () => {
  it("SendMessage: who wrote to whom always; the text only at conversation level, redacted", async () => {
    const secret = `ghp_${"A1b2C3d4E5".repeat(4)}`;
    for (const share of ["conversation", "metadata"] as const) {
      const h = harness({ share });
      h.claude("q1", beta, { hook_event_name: "PreToolUse", tool_name: "SendMessage", tool_input: { to: AGENT, message: `token is ${secret}, see /Users/dev/notes` } });
      h.claude("q1", beta, { hook_event_name: "PreToolUse", tool_name: "SendMessage", tool_input: { to: "uds:/tmp/cc-socks/1.sock", message: "hi" } });
      h.claude("q1", beta, { hook_event_name: "PreToolUse", tool_name: "SendMessage", tool_input: { to: "documents-07", message: "rebase please" } });
      await h.send();
      const msgs = h.events("claude-code:q1").filter((e) => e.kind === "agent_message");
      expect(msgs.map((m) => [m.from, m.to, m.channel])).toEqual([
        ["claude-code:q1", `claude-code:q1/${AGENT}`, "claude-session"],
        ["claude-code:q1", "another session", "claude-session"],
        ["claude-code:q1", "documents-07", "claude-session"],
      ]);
      if (share === "metadata") {
        expect(msgs.every((m) => m.text === undefined)).toBe(true);
      } else {
        expect(msgs[0]?.text).toContain("[redacted]");
        expect(msgs[2]?.text).toBe("rebase please");
      }
      expect(h.raw.join("\n")).not.toContain(secret);
      expect(h.raw.join("\n")).not.toContain("uds:");
    }
  });

  it("a subagent's SendMessage comes from the subagent", async () => {
    const h = harness();
    subagentFiles("q2", AGENT, []);
    h.claude("q2", beta, { hook_event_name: "SubagentStart", agent_id: AGENT, agent_type: "general-purpose" });
    h.claude("q2", beta, { hook_event_name: "PreToolUse", agent_id: AGENT, tool_name: "SendMessage", tool_input: { to: "team-lead", message: "done" } });
    await h.send();
    expect(h.events().filter((e) => e.kind === "agent_message")).toMatchObject([
      { key: `claude-code:q2/${AGENT}`, from: `claude-code:q2/${AGENT}`, to: "team-lead", text: "done" },
    ]);
  });

  it("peer messages in the transcript (conversation level): from a subagent, from another session", async () => {
    const h = harness();
    const t = path.join(projects, "q3.jsonl");
    fs.writeFileSync(t, "");
    h.claude("q3", beta, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    fs.appendFileSync(t, `${sl.peerFromSubagent(AGENT, "CI is green", NOW + 5)}\n${sl.peerFromSession("documents-07", "can you rebase?", NOW + 6)}\n`);
    h.claude("q3", beta, { hook_event_name: "UserPromptSubmit", prompt: '<cross-session-message from="uds:/tmp/x">can you rebase?</cross-session-message>' });
    await h.send();
    const msgs = h.events("claude-code:q3").filter((e) => e.kind === "agent_message");
    expect(msgs.map((m) => [m.from, m.to, m.text])).toEqual([
      [`claude-code:q3/${AGENT}`, "claude-code:q3", "CI is green"],
      ["documents-07", "claude-code:q3", "can you rebase?"],
    ]);
    // The injected copy of the peer message is not the person's prompt.
    expect(h.events("claude-code:q3").filter((e) => e.kind === "prompt").map((e) => e.text)).toEqual(["go"]);
    expect(h.raw.join("\n")).not.toContain("uds:");
  });

  it("an older hub that 400s agent_message gets them held back, the rest still flows", async () => {
    const h = harness();
    h.claude("q4", beta, { hook_event_name: "PreToolUse", tool_name: "SendMessage", tool_input: { to: "x", message: "m" } });
    h.replies.push({ status: 400, body: { error: "events.1.kind: invalid" } });
    await h.send();
    h.advance(2000);
    h.claude("q4", beta, { hook_event_name: "PreToolUse", tool_name: "SendMessage", tool_input: { to: "y", message: "m2" } });
    await h.send();
    const second = h.bodies.at(-1)!;
    expect(second.events.map((e) => e.kind)).toEqual(["tool", "tool"]); // both SendMessage calls; their messages held
    expect(h.fwd.status().conversationHeldUntil).toBeGreaterThan(h.now());
  });
});

describe("links (SPEC §15)", () => {
  it("Linear ids, PRs and issues on shared repos; Slack messages at conversation level only", async () => {
    const sendTool = "mcp__plugin_slack_slack__slack_send_message";
    const slackResp = [{ type: "text", text: JSON.stringify({ message_link: "https://b3-labs.slack.com/archives/C0123ABCD/p1795545603000100", message_context: { channel_id: "C0123ABCD", message_ts: "1795545603.000100" } }) }];
    for (const share of ["conversation", "metadata"] as const) {
      const h = harness({ share });
      h.claude("l1", beta, { hook_event_name: "UserPromptSubmit", prompt: "ship B3-7166" });
      h.claude("l1", beta, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gh pr checks 164" }, tool_response: { stdout: "https://github.com/b3-fun/b3os-beta/pull/164 ok", stderr: "" } });
      h.claude("l1", beta, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gh issue create -t x" }, tool_response: { stdout: "https://github.com/b3-fun/b3os-beta/issues/12", stderr: "" } });
      h.claude("l1", beta, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gh pr view 1" }, tool_response: { stdout: "https://github.com/seangeng/salience/pull/1", stderr: "" } });
      h.claude("l1", beta, { hook_event_name: "PostToolUse", tool_name: sendTool, tool_input: { channel_id: "C0123ABCD", message: "SLACK_TEXT" }, tool_response: slackResp });
      h.claude("l1", beta, { hook_event_name: "PreToolUse", tool_name: "mcp__plugin_slack_slack__slack_read_thread", tool_input: { channel_id: "C0999ZZZZ", message_ts: "1795545000.000200" } });
      await h.send();
      const links = h.events("claude-code:l1").flatMap((e) => e.links ?? []);
      const expected = [
        { type: "linear", id: "B3-7166" },
        { type: "github_pr", id: "b3-fun/b3os-beta#164", url: "https://github.com/b3-fun/b3os-beta/pull/164" },
        { type: "github_issue", id: "b3-fun/b3os-beta#12", url: "https://github.com/b3-fun/b3os-beta/issues/12" },
      ];
      if (share === "conversation") {
        expected.push(
          { type: "slack", id: "C0123ABCD/1795545603.000100", url: "https://b3-labs.slack.com/archives/C0123ABCD/p1795545603000100" },
          // a thread read by id: linked through the workspace host seen in the earlier permalink
          { type: "slack", id: "C0999ZZZZ/1795545000.000200", url: "https://b3-labs.slack.com/archives/C0999ZZZZ/p1795545000000200" },
        );
      }
      expect(links).toEqual(expected);
      const all = h.raw.join("\n");
      expect(all).not.toContain("SLACK_TEXT");
      expect(all).not.toContain("seangeng/salience");
    }
  });
});

describe("the person (SPEC §15)", () => {
  it("sends the GitHub login on heartbeats only", async () => {
    const h = harness({ github: "sean-test", heartbeatMs: 30_000 });
    h.claude("g1", beta, { hook_event_name: "SessionStart" });
    await h.send();
    expect(h.bodies[0]?.full).toBe(true);
    expect(h.bodies[0]?.person).toEqual({ github: "sean-test" });
    h.advance(1000);
    h.claude("g1", beta, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: path.join(beta, "x.ts") } });
    await h.send();
    expect(h.bodies.at(-1)?.full).toBe(false);
    expect(h.bodies.at(-1)?.person).toBeUndefined();
    h.fwd.setGithub("not a login");
    h.advance(31_000);
    await h.send();
    expect(h.bodies.at(-1)?.full).toBe(true);
    expect(h.bodies.at(-1)?.person).toBeUndefined();
  });
});

describe("Codex threads and workflows (SPEC §15)", () => {
  const PARENT = "019b0000-0000-7000-8000-00000000000a";
  const CHILD = "019b0000-0000-7000-8000-00000000000b";

  it("a spawned Codex thread names its parent, role and task; tokens and model from its rollout", async () => {
    const h = harness();
    const parentFile = path.join(codexDay, `rollout-2026-11-24T00-00-00-${PARENT}.jsonl`);
    const childFile = path.join(codexDay, `rollout-2026-11-24T00-00-01-${CHILD}.jsonl`);
    fs.writeFileSync(parentFile, `${cx.sessionMeta(PARENT)}\n`);
    fs.writeFileSync(childFile, [sl.codexSpawnedMeta(CHILD, PARENT), sl.codexTurnContext("gpt-6-codex"), sl.codexTokenCount(500, 50)].map((l) => `${l}\n`).join(""));
    const codex = (id: string, file: string, input: Record<string, unknown>): void =>
      h.feed(mapCodexHookInput({ session_id: id, cwd: beta, transcript_path: file, model: "gpt-6-codex", ...input }, h.now()));
    codex(PARENT, parentFile, { hook_event_name: "UserPromptSubmit", prompt: "split the work" });
    fs.appendFileSync(parentFile, `${sl.codexSend("spawn_agent", { task_name: "review_auth_flow", message: "review the auth flow" }, "c1", NOW + 1)}\n`);
    codex(CHILD, childFile, { hook_event_name: "SessionStart" });
    codex(PARENT, parentFile, { hook_event_name: "Stop", last_assistant_message: "ok" });
    await h.send();
    expect(h.last(`codex:${CHILD}`)).toMatchObject({
      source: "codex",
      parent: `codex:${PARENT}`,
      role: "subagent",
      agentType: "worker",
      title: "review auth flow",
      model: "gpt-6-codex",
      tokensIn: 500,
      tokensOut: 50,
    });
    expect(h.last(`codex:${PARENT}`)).toMatchObject({ role: "main" });
    expect(h.events(`codex:${PARENT}`).filter((e) => e.kind === "agent_message")).toMatchObject([
      { from: `codex:${PARENT}`, to: "review_auth_flow", channel: "codex-mail", text: "review the auth flow" },
    ]);
  });

  it("a workflow run is a workflow session under its orchestrator, with its agents' tokens", async () => {
    const h = harness();
    const wfDir = path.join(projects, "w1", "subagents", "workflows", "wf_1");
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, "journal.jsonl"), '{"type":"started","agentId":"x"}\n');
    fs.writeFileSync(path.join(wfDir, "agent-x1.jsonl"), `${sl.claudeUsage("a", { input_tokens: 7, output_tokens: 1 })}\n`);
    fs.writeFileSync(path.join(wfDir, "agent-x2.jsonl"), `${sl.claudeUsage("b", { input_tokens: 3, output_tokens: 2 })}\n`);
    h.claude("w1", beta, { hook_event_name: "PreToolUse", tool_name: "Workflow", tool_input: {} });
    for (const e of stepWorkflows(new Map(), [{ wfId: "wf_1", count: 2, orchestrator: "claude-code:w1", file: path.join(wfDir, "journal.jsonl") }], h.now())) h.feed(e);
    await h.send();
    expect(h.last("workflow:wf_1")).toMatchObject({ role: "workflow", parent: "claude-code:w1", agentType: "workflow", agents: 2, tokensIn: 10, tokensOut: 3, model: "claude-opus-5-5" });
  });
});

describe("transcript fixtures stay honest", () => {
  it("assistant usage lines parse as main-thread text only when not a sidechain", () => {
    expect(cl.text("x", "u", 1)).toContain('"isSidechain":false');
    expect(sl.claudeUsage("m", { input_tokens: 1 })).toContain('"isSidechain":true');
  });
});

describe("v0.7 polish (SPEC §19)", () => {
  const NOTICE = "This agent read Artifact content written by people other than the user; NOTICE_LINE.";
  const MARKERS = `<artifact-content-authored-by-others/>\n${NOTICE}\n<remote-control-device-report/>\nREMOTE_NOTICE_LINE\n`;

  it("a subagent has a name: its task at conversation level, its type at metadata", async () => {
    const conv = harness();
    subagentFiles("n1", AGENT, []);
    conv.claude("n1", beta, { hook_event_name: "SubagentStart", agent_id: AGENT, agent_type: "general-purpose" });
    await conv.send();
    await conv.send(); // meta.json is read off the hook path, before the next send
    expect(conv.last(`claude-code:n1/${AGENT}`)).toMatchObject({ name: "Polling PR 164 CI checks", title: "Polling PR 164 CI checks" });

    const meta = harness({ share: "metadata" });
    subagentFiles("n2", AGENT, [], { agentType: "Explore" });
    meta.claude("n2", beta, { hook_event_name: "SubagentStart", agent_id: AGENT, agent_type: "Explore" });
    await meta.send();
    await meta.send();
    const sub = meta.last(`claude-code:n2/${AGENT}`);
    expect(sub).toMatchObject({ name: "Explore", agentType: "Explore" });
    expect(sub?.title).toBeUndefined();
    expect(meta.raw.join("\n")).not.toContain("Polling PR");
  });

  it("a long task title is cut to the name's 120 characters", async () => {
    const h = harness();
    subagentFiles("n3", AGENT, [], { description: `Audit ${"x".repeat(180)}` });
    h.claude("n3", beta, { hook_event_name: "SubagentStart", agent_id: AGENT, agent_type: "general-purpose" });
    await h.send();
    await h.send();
    const sub = h.last(`claude-code:n3/${AGENT}`);
    expect(sub?.name).toHaveLength(120);
    expect(sub?.name?.endsWith("…")).toBe(true);
    expect(sub?.title?.length).toBeGreaterThan(120);
  });

  it("injected markup never goes as a prompt or as part of an agent's message", async () => {
    const h = harness();
    const t = path.join(projects, "i1.jsonl");
    fs.writeFileSync(t, "");
    h.claude("i1", beta, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    // A peer message opening with provenance markers, a wrapped one, an assistant reply opening with a reminder.
    fs.appendFileSync(
      t,
      [
        sl.peerFromSubagent(AGENT, `${MARKERS}#187 is merged and main is green.`, NOW + 5),
        sl.peerFromSubagent(AGENT2, `<agent-message from="${AGENT2}">\n${MARKERS}Step 2 is done.\n</agent-message>`, NOW + 6),
        sl.peerFromSubagent(AGENT, MARKERS, NOW + 7),
        cl.text("<system-reminder>\nREMINDER_TEXT\n</system-reminder>\nMerged; deploying now.", "u-1", NOW + 8),
        cl.text("<task-notification>\n<task-id>a1</task-id>\n<result>TASK_RESULT</result>\n</task-notification>", "u-2", NOW + 9),
      ]
        .map((l) => `${l}\n`)
        .join(""),
    );
    // Prompts: a notice, another agent's message, nothing but markers, and the person's words after markers.
    h.claude("i1", beta, { hook_event_name: "UserPromptSubmit", prompt: "<task-notification>\n<task-id>a1</task-id>\n<result>TASK_RESULT</result>\n</task-notification>" });
    h.claude("i1", beta, { hook_event_name: "UserPromptSubmit", prompt: `<agent-message from="${AGENT}">\nPEER_IN_PROMPT\n</agent-message>` });
    h.claude("i1", beta, { hook_event_name: "UserPromptSubmit", prompt: MARKERS });
    h.claude("i1", beta, { hook_event_name: "UserPromptSubmit", prompt: `${MARKERS}ship it after CI` });
    await h.send();

    const evs = h.events("claude-code:i1");
    expect(evs.filter((e) => e.kind === "prompt").map((e) => e.text)).toEqual(["go", "ship it after CI"]);
    expect(evs.filter((e) => e.kind === "agent_message").map((e) => e.text)).toEqual([
      "#187 is merged and main is green.",
      "Step 2 is done.",
      undefined, // nothing but markers: who wrote to whom, no text
    ]);
    expect(evs.filter((e) => e.kind === "message").map((e) => e.text)).toEqual(["Merged; deploying now."]);
    const all = h.raw.join("\n");
    for (const leak of ["artifact-content", "remote-control", "NOTICE_LINE", "REMINDER_TEXT", "TASK_RESULT", "PEER_IN_PROMPT", "task-notification", "agent-message"]) {
      expect(all, leak).not.toContain(leak);
    }
  });

  it("Codex prompts it injected start a turn without a prompt", () => {
    const e = mapCodexHookInput(
      { session_id: "c-inj", cwd: beta, hook_event_name: "UserPromptSubmit", prompt: "<task-notification><result>R</result></task-notification>", model: "gpt-6-codex" },
      NOW,
    );
    expect(e?.detail).toMatchObject({ hookEvent: "InjectedPrompt" });
    expect(e?.detail?.prompt).toBeUndefined();
    const person = mapCodexHookInput({ session_id: "c-inj", cwd: beta, hook_event_name: "UserPromptSubmit", prompt: "fix the tests", model: "gpt-6-codex" }, NOW);
    expect(person?.detail).toMatchObject({ hookEvent: "UserPromptSubmit", prompt: "fix the tests" });
  });

  it("an orchestrator outside a repo names the repos it works across, most recent first; its repo is the latest", async () => {
    const workmesh = path.join(home, "Documents", "b3", "workmesh");
    fakeRepo(workmesh, "git@github.com:b3-fun/workmesh.git");
    const docs = path.join(home, "Documents");
    const h = harness();
    h.claude("o1", docs, { hook_event_name: "UserPromptSubmit", prompt: "plan the day" });
    await h.send();
    expect(h.upserts("claude-code:o1")).toEqual([]); // not shared yet: nothing leaves

    h.claude("o1", docs, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: path.join(beta, "README.md") } });
    h.advance(1000);
    await h.send();
    expect(h.last("claude-code:o1")).toMatchObject({ repo: "b3-fun/b3os-beta", repos: ["b3-fun/b3os-beta"] });

    h.claude("o1", docs, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(workmesh, "ROADMAP.md"), old_string: "a", new_string: "b" } });
    h.advance(1000);
    await h.send();
    expect(h.last("claude-code:o1")).toMatchObject({ repo: "b3-fun/workmesh", repos: ["b3-fun/workmesh", "b3-fun/b3os-beta"] });

    // A shell command naming a shared root it has seen counts as working there.
    h.claude("o1", docs, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `git -C ${beta} status` } });
    h.advance(1000);
    await h.send();
    expect(h.last("claude-code:o1")).toMatchObject({ repo: "b3-fun/b3os-beta", repos: ["b3-fun/b3os-beta", "b3-fun/workmesh"] });

    // A session started in a repo is not an orchestrator, whatever else it touches.
    h.claude("o2", beta, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: path.join(workmesh, "README.md") } });
    h.advance(1000);
    await h.send();
    expect(h.last("claude-code:o2")?.repo).toBe("b3-fun/b3os-beta");
    expect(h.last("claude-code:o2")?.repos).toBeUndefined();
    for (const b of h.bodies) expect(hubIngestAcceptSchema.parse(hubIngestRequestSchema.parse(b))).toBeTruthy();
  });
});

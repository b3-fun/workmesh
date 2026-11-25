import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionStore } from "@workmesh/core";
import { hubIngestAcceptSchema, hubIngestRequestSchema } from "@workmesh/protocol";
import type { SessionEvent } from "@workmesh/core";
import type { HubActivityEvent, HubIngestRequest, HubProjectRule, HubSessionUpsert, HubShareLevel } from "@workmesh/protocol";
import { mapHookInput } from "../src/adapters/claude-code";
import { HubForwarder } from "../src/hub/forwarder";
import {
  TaskSet,
  claudeMirrorItems,
  codexMode,
  parseTaskNotification,
  runningTasks,
  tasksStatusLine,
} from "../src/hub/mirror";
import { parseClaudeLine, parseCodexLine, readMirrorSeed } from "../src/hub/transcript";
import { claudeLines as cl, mirrorLines as ml, structureLines as sl } from "./fixtures/transcripts";

/**
 * v0.11, the session mirror (docs/SPEC.md §26): what the person's terminal shows around the conversation, parsed from
 * real-shaped transcript lines and sent through the whole forwarder at both sharing levels.
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

let home: string;
let beta: string;
let projects: string;

function fakeRepo(dir: string, origin: string): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${origin}\n`);
}

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-mirror-")));
  beta = path.join(home, "Documents", "b3", "b3os-beta");
  projects = path.join(home, ".claude", "projects", "-x");
  fakeRepo(beta, "git@github.com:b3-fun/b3os-beta.git");
  fs.mkdirSync(projects, { recursive: true });
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("notice templates (Claude Code's own wording)", () => {
  const n = (summary: string, extra: Record<string, unknown> = {}) => {
    const line = ml.notice({ summary, ...extra });
    const e = JSON.parse(line) as { message: { content: string } };
    return parseTaskNotification(e.message.content, "id", 5);
  };

  it("reads each kind, its title, task id, duration and outcome", () => {
    expect(n('Agent "Web release 1124j (edge, apps, usercontent)" is waiting on its own background work', { taskId: AGENT, durationMs: 259_000 })).toMatchObject({
      noticeKind: "agent_waiting",
      title: "Web release 1124j (edge, apps, usercontent)",
      taskId: AGENT,
      durationMs: 259_000,
    });
    expect(n('Agent "Poll CI" finished', { taskId: AGENT, status: "completed" })).toMatchObject({ noticeKind: "agent_done", ok: true, ends: true });
    expect(n('Agent "Poll CI" failed: Agent terminated early due to an API error: overloaded', { status: "failed" })).toMatchObject({
      noticeKind: "agent_failed",
      title: "Poll CI",
      ok: false,
    });
    expect(n('Background command "Run the tests" completed (exit code 0)', { taskId: "bx1k2m3n4", status: "completed" })).toMatchObject({
      noticeKind: "shell_done",
      title: "Run the tests",
      ok: true,
      ends: true,
    });
    expect(n('Background command "Run "quoted" tests" failed with exit code 1', { status: "failed" })).toMatchObject({
      noticeKind: "shell_failed",
      title: 'Run "quoted" tests',
      ok: false,
    });
    expect(n('Background command "Build" was stopped', { status: "stopped" })).toMatchObject({ noticeKind: "shell_stopped", ends: true });
    expect(n('Background command "Deploy" is still running after 1h 2m, with no new output')).toMatchObject({ noticeKind: "shell_running" });
    expect(n('Monitor "CI watch" stream ended', { status: "completed" })).toMatchObject({ noticeKind: "monitor_ended", title: "CI watch" });
    expect(n('Dynamic workflow "review" completed', { status: "completed" })).toMatchObject({ noticeKind: "workflow_done", title: "review" });
  });

  it("a monitor event carries its kind only: its output is never read", () => {
    const got = n('Monitor event: "MONITOR_OUTPUT_LINE"', { taskId: "bmon12345", event: "MONITOR_OUTPUT_LINE" });
    expect(got).toMatchObject({ noticeKind: "monitor_event", taskId: "bmon12345" });
    expect(JSON.stringify(got)).not.toContain("MONITOR_OUTPUT_LINE");
  });

  it("an unknown template is a plain task notice with no title; escapes are decoded", () => {
    const got = n("Something new happened to UNKNOWN_TEMPLATE_TEXT", { status: "completed" });
    expect(got).toMatchObject({ noticeKind: "task", ok: true });
    expect(JSON.stringify(got)).not.toContain("UNKNOWN_TEMPLATE_TEXT");
    expect(n('Agent "a &lt;b&gt; &amp; c" finished')).toMatchObject({ title: "a <b> & c" });
  });
});

describe("mirror records in the tailer", () => {
  it("reads titles, mode, compaction, notices, launches and the turn's waiting agents", () => {
    expect(parseClaudeLine(ml.aiTitle("B3OS agent infra tools"))).toEqual([{ kind: "title", custom: false, text: "B3OS agent infra tools" }]);
    expect(parseClaudeLine(ml.customTitle("Release train"))).toEqual([{ kind: "title", custom: true, text: "Release train" }]);
    expect(parseClaudeLine(ml.permissionMode("auto"))).toEqual([{ kind: "mode", mode: "auto" }]);
    expect(parseClaudeLine(ml.permissionMode("auto mode on"))).toEqual([]);
    expect(parseClaudeLine(ml.mode())).toEqual([]);
    expect(parseClaudeLine(ml.compact(9_000))).toMatchObject([{ kind: "notice", noticeKind: "compact", durationMs: 41_000, ts: 9_000 }]);
    expect(parseClaudeLine(ml.bashBackground("bx1k2m3n4"))).toEqual([{ kind: "taskStart", ts: 1, taskId: "bx1k2m3n4", taskKind: "shells" }]);
    expect(parseClaudeLine(ml.monitorStarted("bmon12345"))).toEqual([{ kind: "taskStart", ts: 1, taskId: "bmon12345", taskKind: "monitors" }]);
    expect(parseClaudeLine(ml.agentLaunched(AGENT))).toEqual([{ kind: "taskStart", ts: 1, taskId: AGENT, taskKind: "agents" }]);
    expect(parseClaudeLine(ml.turnDuration(11_000, 2, 1, 2))).toEqual([
      { kind: "turnDuration", ts: 2, durationMs: 11_000, pendingAgents: 1, pendingWorkflows: 2 },
    ]);
    // Tool output and a launched agent's prompt never come out of these lines.
    const all = JSON.stringify([ml.bashBackground("b1"), ml.agentLaunched(AGENT)].flatMap(parseClaudeLine));
    for (const needle of ["BG_TOOL_OUTPUT", "AGENT_PROMPT", "AGENT_DESCRIPTION_IN_RESULT"]) expect(all).not.toContain(needle);
    // Sidechain lines yield nothing.
    const side = JSON.parse(ml.notice({ summary: 'Agent "x" finished' })) as Record<string, unknown>;
    expect(parseClaudeLine(JSON.stringify({ ...side, isSidechain: true }))).toEqual([]);
    expect(claudeMirrorItems({ type: "user", message: { content: "plain prompt" } }, 1)).toEqual([]);
  });

  it("reads Codex mode, model, compaction and plan updates", () => {
    expect(parseCodexLine(ml.codexTurnContext("gpt-6.1-sol", "never", "danger-full-access", 3))).toEqual([
      { kind: "model", ts: 3, model: "gpt-6.1-sol" },
      { kind: "mode", ts: 3, mode: "full-access" },
    ]);
    expect(codexMode("on-request", { type: "workspace-write" })).toBe("auto");
    expect(codexMode("on-request", "read-only")).toBe("read-only");
    expect(codexMode("untrusted", "workspace-write")).toBe("untrusted");
    expect(codexMode(undefined, undefined)).toBeUndefined();
    expect(parseCodexLine(ml.codexCompacted(4))).toMatchObject([{ kind: "notice", noticeKind: "compact" }]);
    expect(JSON.stringify(parseCodexLine(ml.codexCompacted(4)))).not.toContain("COMPACTION_SUMMARY_TEXT");
    expect(parseCodexLine(ml.codexCompactionItem("cc1", 10_000))).toMatchObject([{ kind: "notice", noticeKind: "compact", durationMs: 3000 }]);
    const plan = parseCodexLine(
      ml.codexPlan(
        [
          { step: "Read the shapes", status: "completed" },
          { step: "Write the parser", status: "in_progress" },
          { step: "Ship", status: "someday" },
        ],
        "c1",
      ),
    );
    expect(plan).toEqual([
      {
        kind: "plan",
        id: "plan:c1",
        ts: 1,
        steps: [
          { step: "Read the shapes", status: "completed" },
          { step: "Write the parser", status: "in_progress" },
          { step: "Ship", status: "pending" },
        ],
      },
    ]);
    expect(JSON.stringify(plan)).not.toContain("PLAN_EXPLANATION");
  });

  it("seeds mode and model from the file's end when a tail starts", async () => {
    const f = path.join(projects, "seed.jsonl");
    fs.writeFileSync(f, [ml.permissionMode("default"), cl.text("x", "u1", 1), ml.permissionMode("auto"), ml.aiTitle("SEED_TITLE")].join("\n") + "\n");
    expect(await readMirrorSeed(f, "claude-code")).toEqual({ mode: "auto", model: "claude-opus-5-5" });
  });
});

describe("background tasks", () => {
  it("counts the Stop's running tasks by kind and ends them by id", () => {
    const tasks = runningTasks([
      { id: "b1", type: "shell", status: "running", command: "COMMAND_TEXT", description: "d" },
      { id: "b2", type: "monitor", status: "running" },
      { id: AGENT, type: "subagent", status: "running", agent_type: "general-purpose" },
      { id: "w1", type: "workflow", status: "pending" },
      { id: "x1", type: "MCP task", status: "running" },
      { id: "b3", type: "shell", status: "completed" },
    ]);
    expect(JSON.stringify(tasks)).not.toContain("COMMAND_TEXT");
    const set = new TaskSet();
    set.replace(tasks);
    expect(set.counts()).toEqual({ shells: 1, monitors: 1, agents: 1, workflows: 1, other: 1 });
    set.remove("b1");
    expect(set.counts()).toEqual({ monitors: 1, agents: 1, workflows: 1, other: 1 });
    expect(tasksStatusLine({ shells: 1, monitors: 1 })).toBe("waiting on 1 shell, 1 monitor");
    expect(tasksStatusLine({ shells: 3, agents: 2 })).toBe("waiting on 3 shells, 2 agents");
    expect(tasksStatusLine({})).toBeUndefined();
  });
});

function harness(over: { share?: HubShareLevel; statePath?: string; clock?: { now: number } } = {}) {
  const store = new SessionStore();
  const raw: string[] = [];
  const bodies: HubIngestRequest[] = [];
  const clock = over.clock ?? { now: NOW };
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
      return new Response(JSON.stringify({ ok: true, accepted: body.events.length }), { status: 200 });
    }) as typeof fetch,
    now: () => clock.now,
    homeDir: home,
    share: over.share ?? "conversation",
    turnRecordWaitMs: 0,
    structured: true,
    statePath: over.statePath,
    seedSessions: (list) => store.restore(list, clock.now),
  });
  const claude = (sessionId: string, input: Record<string, unknown>): void => {
    const e: SessionEvent | null = mapHookInput(
      { session_id: sessionId, cwd: beta, transcript_path: path.join(projects, `${sessionId}.jsonl`), ...input },
      clock.now,
      { backgroundWork: () => false, turnEnding: () => "done" },
    );
    if (!e) throw new Error("mapper returned null");
    store.apply(e, clock.now);
    fwd.observe(e);
  };
  const send = async (): Promise<void> => {
    await fwd.flushTranscripts();
    await fwd.tick();
  };
  const upserts = (key: string): HubSessionUpsert[] => bodies.flatMap((b) => b.sessions).filter((s) => s.key === key);
  return {
    fwd,
    raw,
    bodies,
    claude,
    send,
    advance: (ms: number) => {
      clock.now += ms;
    },
    events: (key?: string): HubActivityEvent[] => bodies.flatMap((b) => b.events).filter((e) => !key || e.key === key),
    last: (key: string): HubSessionUpsert | undefined => upserts(key).at(-1),
  };
}

const transcript = (id: string, lines: string[] = []): string => {
  const f = path.join(projects, `${id}.jsonl`);
  fs.writeFileSync(f, lines.map((l) => `${l}\n`).join(""));
  return f;
};
const append = (f: string, ...lines: string[]): void => fs.appendFileSync(f, lines.map((l) => `${l}\n`).join(""));

/** One session's terminal: a title, auto mode, a background shell and monitor, a waiting agent, a compaction. */
async function terminalSession(share: HubShareLevel) {
  const h = harness({ share });
  const id = `mir-${share}`;
  const t = transcript(id, [ml.permissionMode("auto"), ml.aiTitle("PRE_SHARE_TITLE")]);
  h.claude(id, { hook_event_name: "UserPromptSubmit", prompt: "tell me when it's safe to restart" });
  append(
    t,
    ml.aiTitle("B3OS agent infra tools"),
    cl.text("On it.", "u-a1", NOW + 10),
    ml.bashBackground("bshell001", NOW + 20),
    ml.monitorStarted("bmon00001", NOW + 21),
  );
  h.claude(id, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test -- COMMAND_ARG_MARKER", description: "Run the tests", run_in_background: true } });
  h.claude(id, {
    hook_event_name: "Stop",
    background_tasks: [
      { id: "bshell001", type: "shell", status: "running", command: "npm test -- COMMAND_ARG_MARKER", description: "Run the tests" },
      { id: "bmon00001", type: "monitor", status: "running", description: "CI watch" },
      { id: AGENT, type: "subagent", status: "running", agent_type: "general-purpose", description: "Web release" },
    ],
  });
  append(t, ml.turnDuration(11_000, NOW + 30, 1));
  h.advance(2000);
  await h.send();
  append(
    t,
    ml.notice({ summary: 'Agent "Web release 1124j (edge, apps, usercontent)" is waiting on its own background work', taskId: AGENT, durationMs: 259_000 }, NOW + 40),
    ml.notice({ summary: 'Monitor event: "MONITOR_OUTPUT_LINE"', taskId: "bmon00001", event: "MONITOR_OUTPUT_LINE" }, NOW + 41),
    ml.notice({ summary: 'Background command "Run the tests" completed (exit code 0)', taskId: "bshell001", status: "completed" }, NOW + 42),
    ml.compact(NOW + 50),
  );
  // No hook fires: the tick's own tail check reads these lines.
  h.advance(1000);
  await h.send();
  return { h, key: `claude-code:${id}` };
}

describe("the forwarder at the conversation level", () => {
  it("sends the title, mode, tasks, notices with their titles, and the turn's running tasks", async () => {
    const { h, key } = await terminalSession("conversation");
    const s = h.last(key)!;
    expect(s).toMatchObject({ title: "B3OS agent infra tools", mode: "auto", model: "claude-opus-5-5" });
    expect(s.tasks).toEqual({ monitors: 1, agents: 1 });
    const turn = h.events(key).find((e) => e.kind === "turn")!;
    expect(turn).toMatchObject({ durationMs: 11_000, tasks: { shells: 1, monitors: 1, agents: 1 } });
    const notices = h.events(key).filter((e) => e.kind === "notice");
    expect(notices.map((e) => [e.noticeKind, e.desc])).toEqual([
      ["agent_waiting", "Web release 1124j (edge, apps, usercontent)"],
      ["monitor_event", undefined],
      ["shell_done", "Run the tests"],
      ["compact", undefined],
    ]);
    expect(notices[0]).toMatchObject({ durationMs: 259_000 });
    expect(notices[2]).toMatchObject({ ok: true, tasks: { monitors: 1, agents: 1 } });
    expect(notices[3]).toMatchObject({ durationMs: 41_000 });
    const all = h.raw.join("\n");
    // Nothing from before sharing, no monitor output, no tool output, no commands.
    for (const needle of ["PRE_SHARE_TITLE", "MONITOR_OUTPUT_LINE", "BG_TOOL_OUTPUT", "COMMAND_ARG_MARKER"]) expect(all, needle).not.toContain(needle);
    for (const b of h.bodies) expect(hubIngestAcceptSchema.parse(hubIngestRequestSchema.parse(b))).toBeTruthy();
  });

  it("a custom title beats the AI one; the title is redacted", async () => {
    const h = harness();
    const t = transcript("mir-title");
    h.claude("mir-title", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    append(t, ml.customTitle("Release sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), ml.aiTitle("An AI title"));
    h.advance(1000);
    await h.send();
    expect(h.last("claude-code:mir-title")?.title).toBe("Release [redacted]");
  });
});

describe("the forwarder at the metadata level: counts and states only", () => {
  it("sends mode, tasks and notice kinds, never a title or a notice's subject", async () => {
    const { h, key } = await terminalSession("metadata");
    const s = h.last(key)!;
    expect(s).toMatchObject({ mode: "auto", tasks: { monitors: 1, agents: 1 } });
    expect(s.title).toBeUndefined();
    const notices = h.events(key).filter((e) => e.kind === "notice");
    expect(notices.map((e) => e.noticeKind)).toEqual(["agent_waiting", "monitor_event", "shell_done", "compact"]);
    for (const e of notices) expect(e.desc).toBeUndefined();
    expect(h.events(key).some((e) => e.kind === "turn" || e.kind === "message")).toBe(false);
    const all = h.raw.join("\n");
    for (const needle of ["B3OS agent infra tools", "Web release", "Run the tests", "MONITOR_OUTPUT_LINE", "On it.", "COMMAND_ARG_MARKER"]) {
      expect(all, needle).not.toContain(needle);
    }
  });
});

describe("subagents waiting on their own background work", () => {
  it("a subagent that stops with a shell and a monitor stays open with that status, until its finished notice", async () => {
    const h = harness();
    const parent = "mir-sub";
    const t = transcript(parent);
    const dir = path.join(projects, parent, "subagents");
    fs.mkdirSync(dir, { recursive: true });
    const subFile = path.join(dir, `agent-${AGENT}.jsonl`);
    fs.writeFileSync(
      subFile,
      [
        sl.claudeUsage("m1", { input_tokens: 5, output_tokens: 2 }),
        ml.bashBackground("bsub00001"),
        ml.monitorStarted("bsubmon01"),
        ml.bashBackground("bsub00002"),
        ml.notice({ summary: 'Background command "Build" completed (exit code 0)', taskId: "bsub00002", status: "completed" }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(path.join(dir, `agent-${AGENT}.meta.json`), sl.subagentMeta({ description: "Playground experience: console pass" }));
    h.claude(parent, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    h.claude(parent, { hook_event_name: "SubagentStart", agent_id: AGENT, agent_type: "general-purpose" });
    h.claude(parent, { hook_event_name: "PreToolUse", agent_id: AGENT, agent_type: "general-purpose", tool_name: "Bash", tool_input: { command: "make", description: "Build" } });
    await h.send();
    h.advance(6000);
    h.claude(parent, { hook_event_name: "SubagentStop", agent_id: AGENT, agent_type: "general-purpose", agent_transcript_path: subFile, background_tasks: [] });
    await h.send();
    const subKey = `claude-code:${parent}/${AGENT}`;
    expect(h.last(subKey)).toMatchObject({ state: "idle", statusLine: "waiting on 1 shell, 1 monitor", tasks: { shells: 1, monitors: 1 } });

    // Its finished notice in the parent's transcript ends it.
    append(t, ml.notice({ summary: 'Agent "Playground experience: console pass" finished', taskId: AGENT, status: "completed" }, NOW + 9000));
    h.advance(1000);
    await h.send();
    expect(h.last(subKey)?.state).toBe("ended");
    expect(h.events(`claude-code:${parent}`).filter((e) => e.kind === "notice").map((e) => e.noticeKind)).toEqual(["agent_done"]);
  });
});

describe("a restarted daemon keeps the mirror (SPEC §24, §26)", () => {
  it("title, mode and running tasks survive a restart; nothing is re-read from before it", async () => {
    const statePath = path.join(home, "state", "hub-forward.json");
    const clock = { now: NOW };
    const a = harness({ statePath, clock });
    a.fwd.restoreState();
    const t = transcript("mir-restart");
    a.claude("mir-restart", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    append(t, ml.aiTitle("Release train"), ml.permissionMode("auto"));
    a.claude("mir-restart", { hook_event_name: "Stop", background_tasks: [{ id: "bshell009", type: "shell", status: "running" }] });
    clock.now += 2000;
    await a.send();
    expect(a.last("claude-code:mir-restart")).toMatchObject({ title: "Release train", mode: "auto", tasks: { shells: 1 } });
    await a.fwd.stop();

    clock.now += 3000;
    const b = harness({ statePath, clock });
    b.fwd.restoreState();
    await b.send();
    expect(b.last("claude-code:mir-restart")).toMatchObject({ title: "Release train", mode: "auto", tasks: { shells: 1 } });
    // Its shell finishes while the new daemon runs: the restored task ends by id.
    append(t, ml.notice({ summary: 'Background command "Build" completed (exit code 0)', taskId: "bshell009", status: "completed" }, clock.now));
    clock.now += 1000;
    await b.send();
    expect(b.last("claude-code:mir-restart")?.tasks).toBeUndefined();
    expect(b.events("claude-code:mir-restart").map((e) => e.noticeKind)).toEqual(["shell_done"]);
  });
});

describe("a tail restored from an older state file (SPEC §24, §26)", () => {
  it("seeds mode and model on its next hook, though its tail resumes at the saved offset", async () => {
    const statePath = path.join(home, "state", "old-forward.json");
    const clock = { now: NOW };
    transcript("mir-old", [ml.permissionMode("bypassPermissions"), cl.text("x", "u-old", NOW - 5000)]);
    const a = harness({ statePath, clock });
    a.fwd.restoreState();
    a.claude("mir-old", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    clock.now += 1000;
    await a.send();
    await a.fwd.stop();
    // The state file as a v0.10 daemon wrote it: no mirror.
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8")) as { sessions: Array<Record<string, unknown>> };
    for (const s of saved.sessions) delete s.mirror;
    fs.writeFileSync(statePath, JSON.stringify(saved));

    clock.now += 2000;
    const b = harness({ statePath, clock });
    b.fwd.restoreState();
    b.claude("mir-old", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: path.join(beta, "a.ts") } });
    await b.send();
    await new Promise((r) => setTimeout(r, 20));
    clock.now += 1000;
    await b.send();
    expect(b.last("claude-code:mir-old")).toMatchObject({ mode: "bypassPermissions", model: "claude-opus-5-5" });
  });
});

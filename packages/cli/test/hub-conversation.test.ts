import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionStore } from "@workmesh/core";
import { HUB_MAX_BODY_BYTES, hubIngestRequestSchema } from "@workmesh/protocol";
import type { SessionEvent } from "@workmesh/core";
import type { HubActivityEvent, HubIngestRequest, HubProjectRule, HubShareLevel } from "@workmesh/protocol";
import { mapHookInput } from "../src/adapters/claude-code";
import { mapCodexHookInput } from "../src/adapters/codex";
import { HubForwarder } from "../src/hub/forwarder";
import { claudeLines as cl, codexLines as cx } from "./fixtures/transcripts";

const NOW = 1_795_545_600_000;
const TOKEN = `bp_${"a".repeat(64)}`;
const RULE: HubProjectRule = {
  id: "b3",
  name: "B3",
  include: { remotes: ["github.com/b3-fun/"], dirs: [] },
  issueKeys: ["B3"],
  defaultShare: "conversation",
};

let home: string;
let docs: string;
let beta: string;
let salience: string;
let projects: string;
let codexSessions: string;

function fakeRepo(dir: string, origin: string, branch = "main"): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${origin}\n`);
}

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-convo-")));
  docs = path.join(home, "Documents");
  beta = path.join(docs, "b3", "b3os-beta");
  salience = path.join(docs, "salience");
  projects = path.join(home, ".claude", "projects", "-x");
  codexSessions = path.join(home, ".codex", "sessions");
  fakeRepo(beta, "git@github.com:b3-fun/b3os-beta.git");
  fakeRepo(salience, "https://github.com/seangeng/salience.git");
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(codexSessions, { recursive: true });
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

interface Reply {
  status: number;
  body?: unknown;
}

function harness(over: { share?: HubShareLevel; turnRecordWaitMs?: number; maxBufferBytes?: number } = {}) {
  const store = new SessionStore();
  const raw: string[] = [];
  const bodies: HubIngestRequest[] = [];
  const replies: Reply[] = [];
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
    turnRecordWaitMs: over.turnRecordWaitMs ?? 5000,
    maxBufferBytes: over.maxBufferBytes,
  });
  const feed = (e: SessionEvent | null): void => {
    if (!e) throw new Error("mapper returned null");
    store.apply(e, now);
    fwd.observe(e);
  };
  const claude = (sessionId: string, cwd: string, transcript: string | undefined, input: Record<string, unknown>): void =>
    feed(
      mapHookInput({ session_id: sessionId, cwd, transcript_path: transcript, ...input }, now, {
        backgroundWork: () => false,
        turnEnding: () => "done",
      }),
    );
  const codex = (sessionId: string, cwd: string, transcript: string | null, input: Record<string, unknown>): void =>
    feed(mapCodexHookInput({ session_id: sessionId, cwd, transcript_path: transcript, model: "gpt-5.5-codex", ...input }, now));
  /** Settle transcript reads, then send. */
  const send = async (): Promise<void> => {
    await fwd.flushTranscripts();
    await fwd.tick();
  };
  return {
    fwd,
    raw,
    bodies,
    replies,
    claude,
    codex,
    send,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    events: (key?: string): HubActivityEvent[] => bodies.flatMap((b) => b.events).filter((e) => !key || e.key === key),
  };
}

const transcript = (name: string, lines: string[] = []): string => {
  const f = path.join(projects, `${name}.jsonl`);
  fs.writeFileSync(f, lines.map((l) => `${l}\n`).join(""));
  return f;
};
const append = (f: string, ...lines: string[]): void => fs.appendFileSync(f, lines.map((l) => `${l}\n`).join(""));

describe("metadata level (SPEC §8): no text leaves", () => {
  it("sends prompts without text, no messages, no desc, no turns, and says share: metadata", async () => {
    const h = harness({ share: "metadata" });
    const t = transcript("meta");
    h.claude("m1", beta, t, { hook_event_name: "UserPromptSubmit", prompt: "PROMPT_TEXT fix B3-7166" });
    append(t, cl.text("ASSISTANT_TEXT on it", "m-a1", NOW + 10));
    h.claude("m1", beta, t, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cargo test", description: "DESC_TEXT run tests" } });
    append(t, cl.text("ASSISTANT_TEXT done", "m-a2", NOW + 20), cl.turnDuration(1234, NOW + 30));
    h.claude("m1", beta, t, { hook_event_name: "Stop" });
    h.advance(10_000);
    await h.send();
    const all = h.raw.join("\n");
    for (const needle of ["PROMPT_TEXT", "ASSISTANT_TEXT", "DESC_TEXT", '"text"', '"desc"', '"message"', '"turn"', "durationMs"]) {
      expect(all, needle).not.toContain(needle);
    }
    expect(h.bodies.every((b) => b.share === "metadata")).toBe(true);
    expect(h.events().map((e) => e.kind)).toEqual(["prompt", "tool", "idle"]);
    expect(h.events()[0]?.issues).toEqual(["B3-7166"]);
    expect(h.fwd.status()).toMatchObject({ share: "metadata", conversationSessions: 0 });
  });
});

describe("conversation level", () => {
  it("sends prompt text, transcript messages, desc and the turn with its recorded duration", async () => {
    const h = harness();
    const t = transcript("c1", [cl.user("old prompt"), cl.text("EARLIER_TEXT before the session was shared", "old-1", NOW - 60_000)]);
    h.claude("c1", beta, t, { hook_event_name: "SessionStart" });
    h.claude("c1", beta, t, { hook_event_name: "UserPromptSubmit", prompt: "Fix the flaky vm test (B3-7166)" });
    append(t, cl.user("Fix the flaky vm test (B3-7166)"), cl.thinking("THINKING_TEXT"), cl.text("Looking at the vm test first.", "a1", NOW + 1000));
    append(t, cl.toolUse("Bash", { command: "cargo test -p vm", description: "Run the vm tests" }, NOW + 1100));
    h.advance(1100);
    h.claude("c1", beta, t, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cargo test -p vm", description: "Run the vm tests" } });
    append(t, cl.toolResult("TOOL_OUTPUT_TEXT test result: ok"));
    h.claude("c1", beta, t, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "cargo test -p vm" }, tool_response: { stdout: "ok", stderr: "" } });
    h.advance(100);
    h.claude("c1", beta, t, { hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_input: { url: "https://docs.rs/tokio/latest/tokio/?q=SECRET_QUERY" } });
    h.advance(100);
    h.claude("c1", beta, t, { hook_event_name: "PreToolUse", tool_name: "mcp__claude-in-chrome__navigate", tool_input: { url: "https://x" } });
    append(t, cl.text("Fixed: the test raced the clock. **All green.**", "a2", NOW + 5000));
    h.advance(3750);
    h.claude("c1", beta, t, { hook_event_name: "Stop" });
    append(t, cl.stopHookSummary(NOW + 5100), cl.turnDuration(94_000, NOW + 5101));
    await h.send();

    const key = "claude-code:c1";
    const evs = h.events(key);
    expect(evs.map((e) => [e.kind, e.text ?? e.desc ?? e.durationMs ?? null])).toEqual([
      ["start", null],
      ["prompt", "Fix the flaky vm test (B3-7166)"],
      ["message", "Looking at the vm test first."],
      ["tool", "Run the vm tests"],
      ["tool", "docs.rs"],
      ["tool", "claude-in-chrome · navigate"],
      ["message", "Fixed: the test raced the clock. **All green.**"],
      ["idle", null],
      ["turn", 94_000],
    ]);
    expect(evs.find((e) => e.kind === "message")).toMatchObject({ ts: NOW + 1000, repo: "b3-fun/b3os-beta", branch: "main" });
    const all = h.raw.join("\n");
    for (const needle of ["EARLIER_TEXT", "old prompt", "THINKING_TEXT", "TOOL_OUTPUT_TEXT", "cargo test -p vm", "SECRET_QUERY", "/tokio/"]) {
      expect(all, needle).not.toContain(needle);
    }
    expect(h.bodies.every((b) => b.share === "conversation")).toBe(true);
    for (const r of h.raw) expect(hubIngestRequestSchema.safeParse(JSON.parse(r)).success).toBe(true);
    expect(h.fwd.status()).toMatchObject({ share: "conversation", conversationSessions: 1 });
  });

  it("falls back to prompt → stop when the transcript has no turn-duration record", async () => {
    const h = harness({ turnRecordWaitMs: 5000 });
    const t = transcript("c2");
    h.claude("c2", beta, t, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    h.advance(42_000);
    append(t, cl.text("done", "c2-a", h.now()));
    h.claude("c2", beta, t, { hook_event_name: "Stop" });
    await h.send();
    expect(h.events().some((e) => e.kind === "turn")).toBe(false); // still waiting for the record
    h.advance(5000);
    await h.send();
    expect(h.events().find((e) => e.kind === "turn")).toMatchObject({ durationMs: 42_000, ts: NOW + 42_000 });
  });

  it("a prompt ends a turn still waiting for its record", async () => {
    const h = harness();
    const t = transcript("c3");
    h.claude("c3", beta, t, { hook_event_name: "UserPromptSubmit", prompt: "one" });
    h.advance(3000);
    h.claude("c3", beta, t, { hook_event_name: "Stop" });
    h.advance(1000);
    h.claude("c3", beta, t, { hook_event_name: "UserPromptSubmit", prompt: "two" });
    await h.send();
    expect(h.events().filter((e) => e.kind === "turn")).toEqual([expect.objectContaining({ durationMs: 3000 })]);
  });

  it("caps text at 4,000 chars and marks it truncated", async () => {
    const h = harness();
    const t = transcript("c4");
    h.claude("c4", beta, t, { hook_event_name: "UserPromptSubmit", prompt: `P${"p".repeat(7000)}` });
    append(t, cl.text(`M${"m".repeat(6000)}`, "c4-a", NOW));
    h.claude("c4", beta, t, { hook_event_name: "Stop" });
    await h.send();
    const prompt = h.events().find((e) => e.kind === "prompt");
    const msg = h.events().find((e) => e.kind === "message");
    expect(prompt?.text?.length).toBe(4000);
    expect(prompt?.truncated).toBe(true);
    expect(msg?.text?.length).toBe(4000);
    expect(msg?.truncated).toBe(true);
  });

  it("reads on hook events, never inside observe (the hook response path)", async () => {
    const h = harness();
    const t = transcript("c5");
    h.claude("c5", beta, t, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    append(t, cl.text("streamed text", "c5-a", NOW));
    h.claude("c5", beta, t, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: path.join(beta, "README.md") } });
    // observe() returned without reading: the message is not queued yet.
    expect(h.fwd.status().queued).toBe(2);
    await h.fwd.flushTranscripts();
    expect(h.fwd.status().queued).toBe(3);
  });
});

describe("share-from-now and §3.3 rule 4", () => {
  it("an orchestrator outside shared repos shares its conversation from the moment it touches a shared repo (max sharing)", async () => {
    const h = harness();
    const t = transcript("o1");
    // Before the session is shared: nothing of it may leave.
    h.claude("o1", docs, t, { hook_event_name: "UserPromptSubmit", prompt: "PRE_SHARE_PROMPT personal stuff" });
    append(t, cl.text("PRE_SHARE_TEXT about salience", "o-0", NOW - 5));
    // It touches a B3 file: shared from here on.
    h.claude("o1", docs, t, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: path.join(beta, "SPEC.md") } });
    append(t, cl.text("ORCH_TEXT read the spec", "o-a", NOW));
    h.claude("o1", docs, t, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls -la", description: "ORCH_DESC list" } });
    h.claude("o1", docs, t, { hook_event_name: "UserPromptSubmit", prompt: "ORCH_PROMPT two" });
    h.claude("o1", docs, t, { hook_event_name: "Stop" });
    h.advance(10_000);
    await h.send();
    const evs = h.events("claude-code:o1");
    const all = h.raw.join("\n");
    expect(evs.length).toBeGreaterThan(0);
    expect(all).not.toContain("PRE_SHARE_");
    expect(all).toContain("ORCH_PROMPT two");
    expect(all).toContain("ORCH_DESC list");
    expect(evs.some((e) => e.kind === "message" && String(e.text ?? "").includes("ORCH_TEXT"))).toBe(true);
    expect(all).not.toContain("/Users/");
  });

  it("an orchestrator at the metadata level still sends no text", async () => {
    const h = harness({ share: "metadata" });
    const t = transcript("o2");
    h.claude("o2", docs, t, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: path.join(beta, "SPEC.md") } });
    h.claude("o2", docs, t, { hook_event_name: "UserPromptSubmit", prompt: "ORCH_PROMPT meta" });
    append(t, cl.text("ORCH_TEXT meta", "o2-a", NOW));
    h.claude("o2", docs, t, { hook_event_name: "Stop" });
    h.advance(10_000);
    await h.send();
    expect(h.raw.join("\n")).not.toContain("ORCH_");
  });

  it("a session whose cwd moves into a shared repo sends only text written after that", async () => {
    const h = harness();
    const t = transcript("mv");
    h.claude("mv", salience, t, { hook_event_name: "UserPromptSubmit", prompt: "PRIVATE_PROMPT" });
    append(t, cl.text("PRIVATE_TEXT in salience", "mv-1", NOW));
    h.claude("mv", salience, t, { hook_event_name: "Stop" });
    await h.send();
    expect(h.raw.join("")).not.toContain("claude-code:mv");
    h.claude("mv", beta, t, { hook_event_name: "UserPromptSubmit", prompt: "now B3 work" });
    append(t, cl.text("on the B3 side", "mv-2", NOW + 1));
    h.claude("mv", beta, t, { hook_event_name: "Stop" });
    await h.send();
    const all = h.raw.join("\n");
    expect(all).not.toContain("PRIVATE_");
    expect(h.events("claude-code:mv").filter((e) => e.text).map((e) => e.text)).toEqual(["now B3 work", "on the B3 side"]);
  });

  it("skips subagent transcripts and sidechain lines (main thread only)", async () => {
    const h = harness();
    const t = transcript("sc");
    const sub = path.join(projects, "sc", "subagents", "agent-1.jsonl");
    fs.mkdirSync(path.dirname(sub), { recursive: true });
    fs.writeFileSync(sub, "");
    h.claude("sc", beta, t, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    append(t, cl.text("SIDECHAIN_TEXT", "sc-1", NOW, { isSidechain: true }), cl.text("main text", "sc-2", NOW));
    h.claude("sc", beta, sub, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: path.join(beta, "a.ts") } });
    append(sub, cl.text("SUBAGENT_TEXT", "sub-1", NOW));
    h.claude("sc", beta, t, { hook_event_name: "Stop" });
    await h.send();
    const all = h.raw.join("\n");
    expect(all).not.toContain("SIDECHAIN_TEXT");
    expect(all).not.toContain("SUBAGENT_TEXT");
    expect(h.events().filter((e) => e.kind === "message").map((e) => e.text)).toEqual(["main text"]);
  });
});

describe("Codex (recorded-style payloads and rollout lines)", () => {
  // Hook payload fields verified against the codex 0.164 binary's embedded JSON
  // schemas: session_id, cwd, transcript_path (nullable), prompt, tool_input,
  // last_assistant_message. tool_input contents and the shell tool's name are
  // not a stable contract (UNVERIFIED in live sessions).
  const ID = "019ab5c2-1000-7000-8000-00000000c0de";
  const rolloutPath = (): string => {
    const d = new Date(Number.parseInt("019ab5c21000", 16));
    const dir = path.join(codexSessions, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `rollout-2026-11-24T09-00-00-${ID}.jsonl`);
  };

  it("captures the prompt from UserPromptSubmit and messages from the rollout transcript_path names", async () => {
    const h = harness();
    const f = path.join(codexSessions, `rollout-x-${ID}.jsonl`);
    fs.writeFileSync(f, `${cx.sessionMeta(ID)}\n${cx.assistant("EARLIER_CODEX_TEXT", "m0", NOW - 1)}\n`);
    h.codex(ID, beta, f, { hook_event_name: "UserPromptSubmit", prompt: "Patch the vm (B3-7170)" });
    append(f, cx.taskStarted(NOW), cx.reasoning(), cx.assistant("Patching vm.rs now.", "m1", NOW + 100));
    h.advance(150);
    h.codex(ID, beta, f, { hook_event_name: "PreToolUse", tool_name: "shell", tool_input: { command: ["bash", "-lc", "cargo test"], justification: "Run the tests" } });
    append(f, cx.functionCallOutput("CODEX_TOOL_OUTPUT"), cx.assistant("Tests pass.", "m2", NOW + 200), cx.taskComplete(27_514, NOW + 300));
    h.advance(150);
    h.codex(ID, beta, f, { hook_event_name: "Stop", last_assistant_message: "Tests pass." });
    await h.send();
    const evs = h.events(`codex:${ID}`);
    expect(evs.map((e) => [e.kind, e.text ?? e.desc ?? e.durationMs ?? null])).toEqual([
      ["prompt", "Patch the vm (B3-7170)"],
      ["message", "Patching vm.rs now."],
      ["tool", "Run the tests"],
      ["message", "Tests pass."],
      ["idle", null],
      ["turn", 27_514],
    ]);
    const all = h.raw.join("\n");
    for (const needle of ["EARLIER_CODEX_TEXT", "CODEX_TOOL_OUTPUT", "ENCRYPTED_REASONING", "LAST_AGENT_MESSAGE_COPY"]) expect(all).not.toContain(needle);
  });

  it("finds the rollout file by thread id when the hook gives no transcript_path", async () => {
    const h = harness();
    const f = rolloutPath();
    fs.writeFileSync(f, `${cx.assistant("OLD_ROLLOUT_TEXT", "o0", NOW - 1)}\n`);
    h.codex(ID, beta, null, { hook_event_name: "UserPromptSubmit", prompt: "hi" });
    await h.fwd.flushTranscripts(); // the lookup runs off the hook path
    append(f, cx.assistant("found it", "o1", NOW + 1));
    h.codex(ID, beta, null, { hook_event_name: "Stop", last_assistant_message: "found it" });
    await h.send();
    const msgs = h.events().filter((e) => e.kind === "message").map((e) => e.text);
    expect(msgs).toEqual(["found it"]); // once: from the rollout, not also from the Stop fallback
    expect(h.raw.join("")).not.toContain("OLD_ROLLOUT_TEXT");
    fs.rmSync(f);
  });

  it("a task_complete read before the Stop hook ends the turn at Stop, without the wait", async () => {
    const h = harness({ turnRecordWaitMs: 60_000 });
    const id = "019ab5c2-6000-7000-8000-00000000aaaa";
    const f = path.join(codexSessions, `rollout-y-${id}.jsonl`);
    fs.writeFileSync(f, "");
    h.codex(id, beta, f, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    append(f, cx.assistant("done", "q1", NOW + 10), cx.taskComplete(4321, NOW + 20));
    // the rollout watcher's "working" event makes the daemon read before Stop arrives
    h.codex(id, beta, f, { hook_event_name: "PreToolUse", tool_name: "update_plan", tool_input: {} });
    await h.fwd.flushTranscripts();
    h.codex(id, beta, f, { hook_event_name: "Stop", last_assistant_message: "done" });
    await h.send();
    expect(h.events(`codex:${id}`).filter((e) => e.kind === "turn")).toEqual([expect.objectContaining({ durationMs: 4321 })]);
  });

  it("a thread with no rollout file (SQLite history) falls back to Stop's last_assistant_message", async () => {
    const h = harness();
    const id = "019ab5c2-2000-7000-8000-0000000051e7";
    h.codex(id, beta, null, { hook_event_name: "UserPromptSubmit", prompt: "summarize" });
    await h.fwd.flushTranscripts();
    h.advance(8000);
    h.codex(id, beta, null, { hook_event_name: "Stop", last_assistant_message: "Here is the summary." });
    await h.send();
    expect(h.events(`codex:${id}`).map((e) => [e.kind, e.text ?? e.durationMs ?? null])).toEqual([
      ["prompt", "summarize"],
      ["message", "Here is the summary."],
      ["idle", null],
      ["turn", 8000],
    ]);
  });

  it("ignores a subagent's rollout path and a Stop whose turn began before sharing", async () => {
    const h = harness();
    const id = "019ab5c2-3000-7000-8000-00000000ab0d";
    const other = path.join(codexSessions, "rollout-x-019ab5c2-3000-7000-8000-00000000beef.jsonl");
    fs.writeFileSync(other, "");
    h.codex(id, beta, other, { hook_event_name: "Stop", last_assistant_message: "BEFORE_SHARE_TEXT" });
    append(other, cx.assistant("SUBAGENT_ROLLOUT_TEXT", "s1", NOW));
    h.codex(id, beta, other, { hook_event_name: "PreToolUse", tool_name: "shell", tool_input: { command: "ls" } });
    await h.send();
    const all = h.raw.join("\n");
    expect(all).not.toContain("BEFORE_SHARE_TEXT");
    expect(all).not.toContain("SUBAGENT_ROLLOUT_TEXT");
  });
});

describe("forwarder restarts (hub share, hub connect)", () => {
  it("stop() settles a turn still waiting for its record and sends it", async () => {
    const h = harness({ turnRecordWaitMs: 60_000 });
    const t = transcript("restart");
    h.claude("restart", beta, t, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    h.advance(2000);
    h.claude("restart", beta, t, { hook_event_name: "Stop" });
    await h.send();
    expect(h.events().some((e) => e.kind === "turn")).toBe(false);
    await h.fwd.stop();
    expect(h.events().find((e) => e.kind === "turn")).toMatchObject({ durationMs: 2000 });
  });
});

describe("delivery with text", () => {
  it("splits batches to stay under 256 KB and delivers every event once", async () => {
    const h = harness();
    const t = transcript("big");
    h.claude("big", beta, t, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(cl.text(`${i} ${"ü".repeat(3990)}`, `big-${i}`, NOW + i));
    append(t, ...lines);
    h.claude("big", beta, t, { hook_event_name: "Stop" });
    await h.fwd.flushTranscripts();
    for (let i = 0; i < 10 && h.fwd.status().queued > 0; i++) await h.fwd.tick();
    expect(h.raw.length).toBeGreaterThan(5);
    for (const r of h.raw) expect(Buffer.byteLength(r)).toBeLessThanOrEqual(HUB_MAX_BODY_BYTES);
    const msgs = h.events().filter((e) => e.kind === "message");
    expect(msgs).toHaveLength(200);
    expect(new Set(msgs.map((e) => e.id)).size).toBe(200);
    expect(h.fwd.status().queued).toBe(0);
  });

  it("keeps queued text under its byte cap by dropping only the oldest events", async () => {
    const h = harness({ maxBufferBytes: 50_000 });
    const t = transcript("cap");
    h.claude("cap", beta, t, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    for (let i = 0; i < 30; i++) append(t, cl.text(`${i} ${"x".repeat(3900)}`, `cap-${i}`, NOW + i));
    h.claude("cap", beta, t, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } });
    await h.fwd.flushTranscripts();
    const st = h.fwd.status();
    expect(st.dropped).toBeGreaterThan(10);
    expect(st.dropped).toBeLessThan(25);
    expect(st.queued + st.dropped).toBe(32);
    await h.fwd.tick();
    const msgs = h.events().filter((e) => e.kind === "message");
    expect(msgs.at(-1)?.text?.startsWith("29 ")).toBe(true); // the newest survive
  });

  it("an older hub that 400s message/turn kinds still gets the rest, and the text is held back", async () => {
    const h = harness();
    const t = transcript("old");
    h.claude("old", beta, t, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    append(t, cl.text("a reply", "old-1", NOW));
    h.claude("old", beta, t, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } });
    h.replies.push({ status: 400, body: { ok: false, error: ["events.1.kind: Invalid option"] } });
    await h.send();
    expect(h.fwd.status()).toMatchObject({ queued: 2, lastSendOk: false });
    expect(h.fwd.status().conversationHeldUntil).toBeGreaterThan(h.now());
    h.advance(1000);
    await h.fwd.tick();
    expect(h.bodies.at(-1)?.events.map((e) => e.kind)).toEqual(["prompt", "tool"]);
    append(t, cl.text("held back", "old-2", h.now()));
    h.claude("old", beta, t, { hook_event_name: "Stop" });
    h.advance(1000);
    await h.send();
    expect(h.bodies.at(-1)?.events.map((e) => e.kind)).toEqual(["idle"]);
  });
});

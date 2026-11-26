import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionStore } from "@workmesh/core";
import type { SessionEvent } from "@workmesh/core";
import { HUB_MAX_USAGE_MODELS, hubIngestAcceptSchema, hubIngestRequestSchema } from "@workmesh/protocol";
import type { HubIngestRequest, HubModelUsage, HubProjectRule, HubShareLevel } from "@workmesh/protocol";
import { mapHookInput } from "../src/adapters/claude-code";
import { mapCodexHookInput } from "../src/adapters/codex";
import { ClaudeUsageReader, CodexUsageReader, UsageTotals, mergeUsage } from "../src/hub/agents";
import { HubForwarder } from "../src/hub/forwarder";
import { readStateFile } from "../src/hub/persist";
import { codexLines as cx, usageLines as ul } from "./fixtures/transcripts";

// Full token usage (SPEC §45, B3-7227): every Claude Code main thread, subagent and workflow agent, and every Codex
// thread, summed by model and kind from its own transcript, incrementally, carried across daemon restarts.

const T0 = Date.parse("2026-11-25T14:00:00.000Z");
const NOW = T0 + 3600_000;
const RULE: HubProjectRule = { id: "b3", name: "B3", include: { remotes: ["github.com/b3-fun/"], dirs: [] }, issueKeys: ["B3"] };
const AGENT = "a0123456789abcdef";

let dir: string;
let home: string;
let beta: string;
let projects: string;
let codexDay: string;
let statePath: string;

function fakeRepo(d: string, origin: string): void {
  fs.mkdirSync(path.join(d, ".git"), { recursive: true });
  fs.writeFileSync(path.join(d, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(d, ".git", "config"), `[remote "origin"]\n\turl = ${origin}\n`);
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-usage-"));
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-usage-home-")));
  beta = path.join(home, "Documents", "b3", "b3os-beta");
  fakeRepo(beta, "git@github.com:b3-fun/b3os-beta.git");
  projects = path.join(home, ".claude", "projects", "-Users-dev-b3os-beta");
  codexDay = path.join(home, ".codex", "sessions", "2026", "11", "25");
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(codexDay, { recursive: true });
  statePath = path.join(home, ".local", "state", "workmesh", "hub-forward.json");
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

const write = (name: string, lines: string[]): string => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, lines.map((l) => `${l}\n`).join(""));
  return f;
};
const append = (f: string, lines: string[]): void => fs.appendFileSync(f, lines.map((l) => `${l}\n`).join(""));
const byModel = (models: HubModelUsage[] | undefined) => Object.fromEntries((models ?? []).map((m) => [m.model, m]));
const at = (min: number) => T0 + min * 60_000;

/** A main thread over two models: multi-block messages, one-hour cache writes, lines that never count. */
function mainTranscript(): string[] {
  const m1 = { input: 3, cacheWrite5m: 2_000, cacheWrite1h: 40_000, cacheRead: 0, output: 900 };
  const m2 = { input: 1, cacheRead: 42_000, cacheWrite5m: 500, output: 1_200 };
  const m3 = { input: 2, cacheRead: 30_000, cacheWrite1h: 1_000, output: 300 };
  return [
    ul.derivedFrom("compact"),
    ul.apiRequest(at(1)),
    // One API message written as three lines (thinking, text, tool use): counted once.
    ul.claudeCall("msg_A", m1, at(1), { model: "claude-fable-5-2", block: "thinking" }),
    ul.claudeCall("msg_A", m1, at(1), { model: "claude-fable-5-2", block: "text" }),
    ul.claudeCall("msg_A", m1, at(1), { model: "claude-fable-5-2", block: "tool_use" }),
    ul.apiRequest(at(2)),
    ul.claudeCall("msg_B", m2, at(2), { block: "tool_use" }),
    ul.claudeCall("msg_B", m2, at(2), { block: "tool_use" }),
    // Never counted: an API error, a synthetic message, an old-style sidechain line, Claude Code's own cost record.
    ul.claudeCall("msg_err", { input: 50_000, output: 50_000 }, at(3), { apiError: true }),
    ul.claudeCall("msg_syn", { input: 0, output: 0 }, at(3), { model: "<synthetic>" }),
    ul.claudeCall("msg_side", { input: 7, cacheRead: 7_000, output: 70 }, at(3), { sidechain: true }),
    ul.costState(),
    ul.claudeCall("msg_C", m3, at(4), { block: "text" }),
  ];
}

describe("Claude Code usage reader (SPEC §45)", () => {
  it("sums every kind by model, each API message once, and says when the latest call was made", async () => {
    const r = new ClaudeUsageReader(write("main.jsonl", mainTranscript()), { mainThread: true });
    const got = await r.read();
    expect(got?.more).toBe(false);
    expect(byModel(got?.full?.models)).toEqual({
      "claude-fable-5-2": { model: "claude-fable-5-2", input: 3, cacheRead: 0, cacheWrite: 42_000, cacheWrite1h: 40_000, output: 900, calls: 1 },
      "claude-opus-5-5": { model: "claude-opus-5-5", input: 3, cacheRead: 72_000, cacheWrite: 1_500, cacheWrite1h: 1_000, output: 1_500, calls: 2 },
    });
    // Biggest first; at = the latest counted call (not the error line, not the cost record).
    expect(got?.full?.models.map((m) => m.model)).toEqual(["claude-opus-5-5", "claude-fable-5-2"]);
    expect(got?.full?.at).toBe(at(4));
    // v0.6's figures are unchanged: context now, output summed (synthetic lines included, error lines not).
    expect(got).toMatchObject({ tokensIn: 31_002, tokensOut: 2_400, model: "claude-opus-5-5", tasks: undefined });
  });

  it("a subagent's own transcript (every line a sidechain line) counts", async () => {
    const f = write("agent-sub.jsonl", [
      ul.claudeCall("msg_s1", { input: 4, cacheRead: 100, output: 10 }, at(5), { sidechain: true }),
      ul.claudeCall("msg_s1", { input: 4, cacheRead: 100, output: 10 }, at(5), { sidechain: true, block: "tool_use" }),
      ul.claudeCall("msg_s2", { input: 1, cacheWrite5m: 50, output: 5 }, at(6), { sidechain: true, model: "claude-haiku-5-5" }),
    ]);
    const got = await new ClaudeUsageReader(f).read();
    expect(byModel(got?.full?.models)).toEqual({
      "claude-opus-5-5": { model: "claude-opus-5-5", input: 4, cacheRead: 100, cacheWrite: 0, output: 10, calls: 1 },
      "claude-haiku-5-5": { model: "claude-haiku-5-5", input: 1, cacheRead: 0, cacheWrite: 50, output: 5, calls: 1 },
    });
    // The same file read as a main thread skips them (an old transcript's subagent lines count in their own file).
    expect((await new ClaudeUsageReader(f, { mainThread: true }).read())?.full?.models).toEqual([]);
  });

  it("compaction and a resumed session append to the same file: nothing is counted twice", async () => {
    const f = write("compact.jsonl", [ul.claudeCall("msg_1", { input: 1, cacheRead: 1_000, output: 10 }, at(1))]);
    const r = new ClaudeUsageReader(f, { mainThread: true });
    await r.read();
    append(f, [
      ul.compactBoundary(at(2)),
      ul.compactSummary(at(2)),
      ul.derivedFrom("compact"),
      ul.claudeCall("msg_2", { input: 2, cacheWrite5m: 9_000, output: 20 }, at(3)),
    ]);
    await r.read();
    // The person quits, and later resumes: Claude Code appends a derived-from line and goes on in the same file.
    append(f, [ul.derivedFrom("resume"), ul.claudeCall("msg_3", { input: 3, cacheRead: 9_000, output: 30 }, at(90))]);
    const got = await r.read();
    expect(got?.full?.models).toEqual([{ model: "claude-opus-5-5", input: 6, cacheRead: 10_000, cacheWrite: 9_000, output: 60, calls: 3 }]);
    expect(got?.full?.at).toBe(at(90));
    // A reader that starts over (a forwarder that forgot the session) gets the same totals: the hub credits nothing new.
    expect((await new ClaudeUsageReader(f, { mainThread: true }).read())?.full).toEqual(got?.full);
  });

  it("reads incrementally: complete lines only, and a message split across two reads still counts once", async () => {
    const u = { input: 1, cacheRead: 500, output: 40 };
    const f = write("incr.jsonl", [ul.claudeCall("msg_1", u, at(1), { block: "thinking" })]);
    const r = new ClaudeUsageReader(f, { mainThread: true });
    expect((await r.read())?.full?.models[0]).toMatchObject({ output: 40, calls: 1 });
    const second = ul.claudeCall("msg_1", u, at(1), { block: "text" });
    fs.appendFileSync(f, second.slice(0, 30)); // a line still being written
    expect((await r.read())?.full?.models[0]).toMatchObject({ output: 40, calls: 1 });
    fs.appendFileSync(f, `${second.slice(30)}\n`);
    append(f, [ul.claudeCall("msg_2", u, at(2))]);
    expect((await r.read())?.full?.models[0]).toMatchObject({ input: 2, cacheRead: 1_000, output: 80, calls: 2 });
  });

  it("a long transcript is read in passes of at most maxReadBytes, adding up to the same totals", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => ul.claudeCall(`msg_${i}`, { input: 1, cacheRead: 10, output: 2 }, at(i)));
    const f = write("long.jsonl", lines);
    const r = new ClaudeUsageReader(f, { mainThread: true, maxReadBytes: 16 * 1024 });
    let passes = 0;
    let got = await r.read();
    while (got?.more) {
      passes++;
      got = await r.read();
    }
    expect(passes).toBeGreaterThan(5);
    expect(got?.full?.models).toEqual([{ model: "claude-opus-5-5", input: 200, cacheRead: 2_000, cacheWrite: 0, output: 400, calls: 200 }]);
  });

  it("a restart carries on from the saved state: no line is read again, no call counted twice", async () => {
    const u = { input: 2, cacheRead: 700, cacheWrite1h: 300, output: 50 };
    const f = write("restart.jsonl", [ul.claudeCall("msg_1", u, at(1)), ul.claudeCall("msg_2", u, at(2), { block: "thinking" })]);
    const a = new ClaudeUsageReader(f, { mainThread: true });
    await a.read();
    const saved = JSON.parse(JSON.stringify(a.exportState())) as ReturnType<ClaudeUsageReader["exportState"]>;
    // Proof that the new reader doesn't read the start again: blank it out in place (same size, same inode).
    const size = fs.statSync(f).size;
    const fd = fs.openSync(f, "r+");
    fs.writeSync(fd, Buffer.alloc(size - 1, 0x20), 0, size - 1, 0);
    fs.closeSync(fd);
    // msg_2's second block arrives after the restart, then a new message.
    append(f, [ul.claudeCall("msg_2", u, at(2), { block: "text" }), ul.claudeCall("msg_3", u, at(3))]);
    const b = new ClaudeUsageReader(f, { mainThread: true, state: saved });
    expect((await b.read())?.full).toEqual({
      models: [{ model: "claude-opus-5-5", input: 6, cacheRead: 2_100, cacheWrite: 900, cacheWrite1h: 900, output: 150, calls: 3 }],
      at: at(3),
    });
  });

  it("a replaced or truncated transcript is read again from its start", async () => {
    const f = write("replaced.jsonl", [ul.claudeCall("msg_1", { input: 5, output: 5 }, at(1)), ul.claudeCall("msg_2", { input: 5, output: 5 }, at(2))]);
    const r = new ClaudeUsageReader(f, { mainThread: true });
    expect((await r.read())?.full?.models[0]?.input).toBe(10);
    fs.rmSync(f);
    write("replaced.jsonl", [ul.claudeCall("msg_9", { input: 1, output: 1 }, at(9))]);
    expect((await r.read())?.full).toEqual({ models: [{ model: "claude-opus-5-5", input: 1, cacheRead: 0, cacheWrite: 0, output: 1, calls: 1 }], at: at(9) });
    fs.truncateSync(f, 0);
    expect((await r.read())?.full).toEqual({ models: [] });
  });
});

describe("Codex usage reader (SPEC §45)", () => {
  const rollout = (): string[] => [
    cx.sessionMeta("019b0000-0000-7000-8000-00000000c0de", at(0)),
    ul.codexTurnContext("gpt-6-astra", at(1)),
    ul.codexCount(null, at(1)), // a rate-limit-only update
    ul.codexCount({ input: 10_000, cached: 8_000, output: 300, reasoning: 100 }, at(2), 10_000),
    ul.codexCount({ input: 10_000, cached: 8_000, output: 300, reasoning: 100 }, at(2), 10_000), // repeated: adds nothing
    ul.codexCount({ input: 25_000, cached: 21_000, output: 500, reasoning: 150 }, at(3), 15_000),
    // The person switches model mid-thread: the growth after it is the new model's.
    ul.codexTurnContext("gpt-6.2-astra", at(4)),
    ul.codexCount({ input: 45_000, cached: 39_000, cacheWrite: 1_000, output: 900, reasoning: 350 }, at(5), 20_000),
  ];

  it("credits the growth of the cumulative counters to the model of the latest turn_context", async () => {
    const got = await new CodexUsageReader(write("rollout-a.jsonl", rollout())).read();
    expect(byModel(got?.full?.models)).toEqual({
      "gpt-6-astra": { model: "gpt-6-astra", input: 4_000, cacheRead: 21_000, cacheWrite: 0, output: 500, reasoning: 150, calls: 2 },
      "gpt-6.2-astra": { model: "gpt-6.2-astra", input: 1_000, cacheRead: 18_000, cacheWrite: 1_000, output: 400, reasoning: 200, calls: 1 },
    });
    expect(got?.full?.at).toBe(at(5));
    // v0.6's figures: the last call's input as the context now, the cumulative output.
    expect(got).toMatchObject({ tokensIn: 20_000, tokensOut: 900, model: "gpt-6.2-astra" });
  });

  it("a restart carries on from the saved counters; counters that go down start a new baseline", async () => {
    const lines = rollout();
    const f = write("rollout-b.jsonl", lines.slice(0, 6));
    const a = new CodexUsageReader(f);
    await a.read();
    const b = new CodexUsageReader(f, { state: JSON.parse(JSON.stringify(a.exportState())) });
    append(f, lines.slice(6));
    const fresh = await new CodexUsageReader(write("rollout-b2.jsonl", lines)).read();
    expect((await b.read())?.full).toEqual(fresh?.full);
    // A rollout whose counters restart (a new baseline) adds nothing until they grow again.
    append(f, [ul.codexCount({ input: 100, cached: 0, output: 10 }, at(6)), ul.codexCount({ input: 300, cached: 100, output: 30 }, at(7))]);
    const after = byModel((await b.read())?.full?.models);
    expect(after["gpt-6.2-astra"]).toMatchObject({ input: 1_100, cacheRead: 18_100, output: 420, calls: 2 });
  });
});

describe("totals on the wire (SPEC §45)", () => {
  it("keeps the biggest models within the cap, drops empty parts, and merges a workflow's agents", () => {
    const t = new UsageTotals();
    for (let i = 0; i < HUB_MAX_USAGE_MODELS + 3; i++) t.add(`m-${i}`, { input: i, output: i });
    const wire = t.toWire();
    expect(wire.models).toHaveLength(HUB_MAX_USAGE_MODELS);
    expect(wire.models[0]?.model).toBe(`m-${HUB_MAX_USAGE_MODELS + 2}`);
    expect(wire.models[0]).not.toHaveProperty("cacheWrite1h");
    expect(wire).not.toHaveProperty("at");
    const merged = mergeUsage([
      { models: [{ model: "a", input: 1, cacheRead: 2, cacheWrite: 3, cacheWrite1h: 1, output: 4, calls: 1 }], at: 5 },
      undefined,
      { models: [{ model: "a", input: 1, cacheRead: 0, cacheWrite: 0, output: 1, calls: 1 }, { model: "b", input: 9, cacheRead: 0, cacheWrite: 0, output: 9 }], at: 3 },
    ]);
    expect(merged).toEqual({
      models: [
        { model: "b", input: 9, cacheRead: 0, cacheWrite: 0, output: 9 },
        { model: "a", input: 2, cacheRead: 2, cacheWrite: 3, cacheWrite1h: 1, output: 5, calls: 2 },
      ],
      at: 5,
    });
    expect(mergeUsage([undefined])).toBeUndefined();
    // A saved form with junk reads back without it.
    expect(UsageTotals.from({ "claude-opus-5-5": { input: 1, output: -3, calls: "x" }, "bad model!": { input: 1 } }).toWire()).toEqual({
      models: [{ model: "claude-opus-5-5", input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }],
    });
  });
});

// ------------------------------------------------------------------ through the forwarder

function daemon(clock: { now: number }, share: HubShareLevel = "metadata") {
  const store = new SessionStore();
  const bodies: HubIngestRequest[] = [];
  const raw: string[] = [];
  const fwd = new HubForwarder({
    url: "https://hub.test",
    token: `bp_${"a".repeat(64)}`,
    rule: RULE,
    share,
    listSessions: () => store.list(),
    getSession: (k) => store.get(k),
    fetchImpl: (async (_u: string | URL, init?: RequestInit) => {
      const text = String(init?.body ?? "{}");
      raw.push(text);
      const body = JSON.parse(text) as HubIngestRequest;
      expect(hubIngestRequestSchema.safeParse(body).success).toBe(true);
      expect(hubIngestAcceptSchema.parse(body)).toBeTruthy();
      bodies.push(body);
      return new Response(JSON.stringify({ ok: true, accepted: body.events.length }), { status: 200 });
    }) as typeof fetch,
    now: () => clock.now,
    homeDir: home,
    codexSessionsDir: path.join(home, ".codex", "sessions"),
    statePath,
    structured: true,
    turnRecordWaitMs: 0,
    startupGraceMs: 0,
    seedSessions: (list) => store.restore(list, clock.now),
  });
  const feed = (e: SessionEvent | null): void => {
    if (!e) throw new Error("mapper returned null");
    store.apply(e, clock.now);
    fwd.observe(e);
  };
  const claude = (sessionId: string, input: Record<string, unknown>): void =>
    feed(
      mapHookInput(
        { session_id: sessionId, cwd: beta, transcript_path: path.join(projects, `${sessionId}.jsonl`), permission_mode: "default", ...input },
        clock.now,
        { backgroundWork: () => false, turnEnding: () => "done" },
      ),
    );
  const send = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      await fwd.flushTranscripts();
      await fwd.tick();
      clock.now += 6000;
    }
  };
  const last = (key: string) => bodies.flatMap((b) => b.sessions).filter((s) => s.key === key).at(-1);
  return { store, fwd, bodies, raw, feed, claude, send, last };
}

describe("the forwarder sends usage for every session (SPEC §45)", () => {
  it("a main thread and its subagent each send their own calls, at the metadata level too, with no text", async () => {
    fs.rmSync(statePath, { force: true });
    const clock = { now: NOW };
    const main = path.join(projects, "u1.jsonl");
    fs.writeFileSync(main, `${mainTranscript().join("\n")}\n`);
    const subDir = path.join(projects, "u1", "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    const subFile = path.join(subDir, `agent-${AGENT}.jsonl`);
    fs.writeFileSync(subFile, `${ul.claudeCall("msg_s", { input: 9, cacheRead: 900, output: 90 }, at(10), { sidechain: true, model: "claude-haiku-5-5" })}\n`);
    fs.writeFileSync(path.join(subDir, `agent-${AGENT}.meta.json`), JSON.stringify({ agentType: "Explore", description: "SUBAGENT_TASK" }));

    const d = daemon(clock);
    d.claude("u1", { hook_event_name: "SessionStart", source: "startup" });
    d.claude("u1", { hook_event_name: "UserPromptSubmit", prompt: "PROMPT_TEXT" });
    d.claude("u1", { hook_event_name: "SubagentStart", agent_id: AGENT, agent_type: "Explore" });
    await d.send();

    const m = d.last("claude-code:u1");
    expect(m?.role).toBe("main");
    expect(byModel(m?.usage?.models)).toEqual({
      "claude-fable-5-2": { model: "claude-fable-5-2", input: 3, cacheRead: 0, cacheWrite: 42_000, cacheWrite1h: 40_000, output: 900, calls: 1 },
      "claude-opus-5-5": { model: "claude-opus-5-5", input: 3, cacheRead: 72_000, cacheWrite: 1_500, cacheWrite1h: 1_000, output: 1_500, calls: 2 },
    });
    expect(m?.usage?.at).toBe(at(4));
    // Main threads now report v0.6's figures too.
    expect(m).toMatchObject({ tokensIn: 31_002, tokensOut: 2_400 });
    const s = d.last(`claude-code:u1/${AGENT}`);
    expect(s?.usage).toEqual({ models: [{ model: "claude-haiku-5-5", input: 9, cacheRead: 900, cacheWrite: 0, output: 90, calls: 1 }], at: at(10) });
    const all = d.raw.join("\n");
    for (const text of ["PROMPT_TEXT", "ASSISTANT_TEXT", "TOOL_INPUT", "SUBAGENT_TASK", "COMPACT_SUMMARY_TEXT"]) expect(all).not.toContain(text);

    // More calls: only the growth is new; the totals keep running.
    fs.appendFileSync(main, `${ul.claudeCall("msg_D", { input: 1, cacheRead: 80_000, output: 100 }, at(20))}\n`);
    d.claude("u1", { hook_event_name: "Stop", stop_hook_active: false });
    await d.send();
    expect(byModel(d.last("claude-code:u1")?.usage?.models)["claude-opus-5-5"]).toMatchObject({ input: 4, cacheRead: 152_000, output: 1_600, calls: 3 });
    await d.fwd.stop();
  });

  it("a restarted daemon carries each reader on from the state file, reading nothing twice", async () => {
    fs.rmSync(statePath, { force: true });
    const clock = { now: NOW };
    const main = path.join(projects, "u2.jsonl");
    fs.writeFileSync(main, `${[ul.claudeCall("msg_1", { input: 1, cacheRead: 1_000, output: 10 }, at(1)), ul.claudeCall("msg_2", { input: 1, cacheRead: 2_000, output: 20 }, at(2))].join("\n")}\n`);
    const a = daemon(clock);
    a.claude("u2", { hook_event_name: "SessionStart", source: "startup" });
    a.claude("u2", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    await a.send();
    expect(a.last("claude-code:u2")?.usage?.models[0]).toMatchObject({ cacheRead: 3_000, calls: 2 });
    await a.fwd.stop();

    const saved = readStateFile(statePath) as { sessions: Array<{ key: string; transcript?: string; usageReaders?: Array<{ file: string; main?: boolean; state: { offset: number } }> }> };
    const entry = saved.sessions.find((x) => x.key === "claude-code:u2");
    expect(entry?.transcript).toBe(main);
    expect(entry?.usageReaders).toEqual([expect.objectContaining({ file: main, main: true, state: expect.objectContaining({ offset: fs.statSync(main).size }) })]);

    // While the daemon is down: the start of the file is blanked out in place (a reader that read it again would lose
    // msg_1 and msg_2), and the agent makes another call.
    const size = fs.statSync(main).size;
    const fd = fs.openSync(main, "r+");
    fs.writeSync(fd, Buffer.alloc(size - 1, 0x20), 0, size - 1, 0);
    fs.closeSync(fd);
    fs.appendFileSync(main, `${ul.claudeCall("msg_3", { input: 1, cacheRead: 4_000, output: 40 }, at(3))}\n`);

    clock.now += 10_000;
    const b = daemon(clock);
    b.fwd.restoreState();
    b.claude("u2", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } });
    await b.send();
    expect(b.last("claude-code:u2")?.usage).toEqual({
      models: [{ model: "claude-opus-5-5", input: 3, cacheRead: 7_000, cacheWrite: 0, output: 70, calls: 3 }],
      at: at(3),
    });
    await b.fwd.stop();
  });

  it("a state file from before 0.12.2 (no readers saved) reads each transcript once from its start", async () => {
    fs.rmSync(statePath, { force: true });
    const clock = { now: NOW };
    const main = path.join(projects, "u3.jsonl");
    fs.writeFileSync(main, `${ul.claudeCall("msg_1", { input: 1, cacheRead: 500, output: 5 }, at(1))}\n`);
    const a = daemon(clock);
    a.claude("u3", { hook_event_name: "SessionStart", source: "startup" });
    await a.send();
    await a.fwd.stop();
    const saved = readStateFile(statePath) as { sessions: Array<Record<string, unknown>> };
    for (const s of saved.sessions) {
      delete s.usageReaders;
      delete s.transcript;
      delete s.usage;
    }
    fs.writeFileSync(statePath, JSON.stringify(saved));
    const b = daemon(clock);
    b.fwd.restoreState();
    b.claude("u3", { hook_event_name: "UserPromptSubmit", prompt: "go on" });
    await b.send();
    expect(b.last("claude-code:u3")?.usage?.models).toEqual([{ model: "claude-opus-5-5", input: 1, cacheRead: 500, cacheWrite: 0, output: 5, calls: 1 }]);
    await b.fwd.stop();
  });

  it("a Codex thread sends its rollout's usage by model", async () => {
    fs.rmSync(statePath, { force: true });
    const clock = { now: NOW };
    const id = "019b0000-0000-7000-8000-00000000c0d1";
    const file = path.join(codexDay, `rollout-2026-11-25T14-00-00-${id}.jsonl`);
    fs.writeFileSync(
      file,
      `${[
        cx.sessionMeta(id, at(0)),
        ul.codexTurnContext("gpt-6-astra", at(1)),
        ul.codexCount({ input: 12_000, cached: 9_000, output: 400, reasoning: 120 }, at(2), 12_000),
      ].join("\n")}\n`,
    );
    const d = daemon(clock);
    d.feed(mapCodexHookInput({ hook_event_name: "SessionStart", session_id: id, cwd: beta, transcript_path: file, source: "startup", model: "gpt-6-astra" }, clock.now));
    d.feed(mapCodexHookInput({ hook_event_name: "UserPromptSubmit", session_id: id, cwd: beta, transcript_path: file, prompt: "PROMPT", turn_id: "t1" }, clock.now));
    await d.send();
    expect(d.last(`codex:${id}`)?.usage).toEqual({
      models: [{ model: "gpt-6-astra", input: 3_000, cacheRead: 9_000, cacheWrite: 0, output: 400, reasoning: 120, calls: 1 }],
      at: at(2),
    });
    await d.fwd.stop();
  });
});

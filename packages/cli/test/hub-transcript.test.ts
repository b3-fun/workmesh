import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptClaudeTranscript,
  acceptCodexTranscript,
  findCodexRollout,
  parseClaudeLine,
  parseCodexLine,
  readTail,
  startTail,
  uuidV7DayDirs,
} from "../src/hub/transcript";
import { claudeLines as cl, codexLines as cx } from "./fixtures/transcripts";

let dir: string;
beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentblip-tail-")));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = (name: string, lines: string[] = []): string => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, lines.map((l) => `${l}\n`).join(""));
  return f;
};
const append = (f: string, text: string): void => fs.appendFileSync(f, text);
const texts = (items: Awaited<ReturnType<typeof readTail>>["items"]): string[] =>
  items.flatMap((i) => (i.kind === "message" ? [i.text] : []));

describe("parseClaudeLine: only the agent's own text and the turn record", () => {
  it("emits assistant text blocks with the record's timestamp", () => {
    const items = parseClaudeLine(cl.text("Tests pass; opening the PR.", "u1", 1_000));
    expect(items).toEqual([{ kind: "message", id: "u1:0", ts: 1_000, text: "Tests pass; opening the PR." }]);
  });

  it("never yields thinking, tool calls, tool results, user lines, API copies, sidechains or synthetic errors", () => {
    for (const line of [
      cl.thinking("THINKING_MARKER"),
      cl.toolUse("Bash", { command: "TOOL_INPUT_MARKER", description: "d" }),
      cl.toolResult("TOOL_OUTPUT_MARKER"),
      cl.user("PROMPT_MARKER"),
      cl.apiBlob("API_COPY_MARKER"),
      cl.text("SIDECHAIN_MARKER", "s1", 1, { isSidechain: true }),
      cl.synthetic("API Error: overloaded"),
      cl.text("(no content)", "u2", 1),
      cl.text("   ", "u3", 1),
      "{not json",
      "",
    ]) {
      expect(parseClaudeLine(line), line).toEqual([]);
    }
  });

  it("reads the turn-duration record", () => {
    expect(parseClaudeLine(cl.turnDuration(94_321, 5_000))).toEqual([{ kind: "turnDuration", ts: 5_000, durationMs: 94_321 }]);
  });
});

describe("parseCodexLine (recorded-style rollout lines)", () => {
  it("emits assistant output_text and the task_complete duration", () => {
    expect(parseCodexLine(cx.assistant("Patched vm.rs; cargo test passes.", "msg_1", 2_000))).toEqual([
      { kind: "message", id: "msg_1:0", ts: 2_000, text: "Patched vm.rs; cargo test passes." },
    ]);
    expect(parseCodexLine(cx.taskComplete(27_514, 3_000))).toEqual([{ kind: "turnDuration", ts: 3_000, durationMs: 27_514 }]);
  });

  it("skips reasoning, tool calls and output, developer and user messages, inter-agent messages", () => {
    for (const line of [
      cx.reasoning(),
      cx.functionCall("exec_command", '{"cmd":"TOOL_INPUT_MARKER"}'),
      cx.functionCallOutput("TOOL_OUTPUT_MARKER"),
      cx.developer("DEVELOPER_MARKER"),
      cx.user("PROMPT_MARKER"),
      cx.agentMessage("INTER_AGENT_MARKER"),
      cx.sessionMeta(),
    ]) {
      expect(parseCodexLine(line), line).toEqual([]);
    }
  });
});

describe("readTail", () => {
  it("starts at the file's end: nothing written before sharing is read", async () => {
    const f = file("share-from-now.jsonl", [cl.text("BEFORE_SHARING", "b1", 1)]);
    const tail = startTail(f, "claude-code");
    expect(texts((await readTail(tail)).items)).toEqual([]);
    append(f, `${cl.text("after", "a1", 2)}\n`);
    expect(texts((await readTail(tail)).items)).toEqual(["after"]);
  });

  it("reads appends, holds a partial last line until its newline", async () => {
    const f = file("partial.jsonl");
    const tail = startTail(f, "claude-code");
    const line = cl.text("first half and second half", "p1", 3);
    append(f, line.slice(0, 40));
    expect((await readTail(tail)).items).toEqual([]);
    expect(tail.offset).toBe(0);
    append(f, `${line.slice(40)}\n${cl.text("next", "p2", 4)}\n`);
    expect(texts((await readTail(tail)).items)).toEqual(["first half and second half", "next"]);
    expect((await readTail(tail)).items).toEqual([]); // nothing new
  });

  it("restarts at the new end after truncation or replacement, never re-reading old text", async () => {
    const f = file("rotate.jsonl");
    const tail = startTail(f, "claude-code");
    append(f, `${cl.text("one", "r1", 1)}\n${cl.text("two", "r2", 2)}\n`);
    expect(texts((await readTail(tail)).items)).toEqual(["one", "two"]);
    // Truncated and rewritten shorter: whatever is there now may predate sharing.
    fs.writeFileSync(f, `${cl.text("OLD_COPY", "r3", 3)}\n`);
    const res = await readTail(tail);
    expect(res.reset).toBe("truncated");
    expect(res.items).toEqual([]);
    append(f, `${cl.text("x", "r4", 4)}\n`);
    expect(texts((await readTail(tail)).items)).toEqual(["x"]);

    // Replaced by another file (atomic write + rename: a new inode).
    const g = file("replace.jsonl", [cl.text("start", "r5", 5)]);
    const t2 = startTail(g, "claude-code");
    const tmp = path.join(dir, "replace.tmp");
    fs.writeFileSync(tmp, `${cl.text("start", "r5", 5)}\n${cl.text("COPIED_HISTORY", "r6", 6)}\n${cl.text("MORE_HISTORY", "r7", 7)}\n`);
    fs.renameSync(tmp, g);
    const res2 = await readTail(t2);
    expect(res2.reset).toBe("replaced");
    expect(res2.items).toEqual([]);
    append(g, `${cl.text("fresh", "r8", 8)}\n`);
    expect(texts((await readTail(t2)).items)).toEqual(["fresh"]);
  });

  it("bounds each read and skips a line longer than one read", async () => {
    const f = file("bounded.jsonl");
    const tail = startTail(f, "claude-code");
    const huge = cl.toolResult("X".repeat(5000));
    append(f, `${cl.text("before huge", "h1", 1)}\n${huge}\n${cl.text("after huge", "h2", 2)}\n`);
    const seen: string[] = [];
    let reads = 0;
    for (;;) {
      const res = await readTail(tail, 1024);
      reads++;
      seen.push(...texts(res.items));
      if (!res.more) break;
    }
    expect(seen).toEqual(["before huge", "after huge"]);
    expect(reads).toBeGreaterThan(2);
    expect(tail.offset).toBe(fs.statSync(f).size);
  });

  it("reports an unreadable file instead of throwing", async () => {
    const res = await readTail(startTail(path.join(dir, "missing", "x.jsonl"), "claude-code"));
    expect(res.error).toBeTruthy();
  });
});

describe("transcript paths", () => {
  it("accepts main-thread Claude Code transcripts only", () => {
    expect(acceptClaudeTranscript("/h/.claude/projects/p/s1.jsonl")).toBe("/h/.claude/projects/p/s1.jsonl");
    expect(acceptClaudeTranscript("/h/.claude/projects/p/s1/subagents/agent-a.jsonl")).toBeUndefined();
    expect(acceptClaudeTranscript("relative.jsonl")).toBeUndefined();
    expect(acceptClaudeTranscript(undefined)).toBeUndefined();
  });

  it("accepts a Codex rollout only for its own thread id", () => {
    const id = "01a20de9-e2dc-7af1-8740-767b47aeac91";
    expect(acceptCodexTranscript(`/c/sessions/2026/11/24/rollout-2026-11-24T09-16-01-${id}.jsonl`, id)).toBeTruthy();
    expect(acceptCodexTranscript("/c/sessions/2026/11/24/rollout-2026-11-24T09-16-01-0000-other.jsonl", id)).toBeUndefined();
  });

  it("finds a rollout by UUIDv7 day, by scanning, or reports none (SQLite-only thread)", async () => {
    const sessions = path.join(dir, "codex-sessions");
    const v7 = "019ab5c2-1000-7000-8000-000000000001"; // ms 0x019ab5c21000
    const [day] = uuidV7DayDirs(v7)!;
    fs.mkdirSync(path.join(sessions, day!), { recursive: true });
    const f1 = path.join(sessions, day!, `rollout-2026-11-24T09-00-00-${v7}.jsonl`);
    fs.writeFileSync(f1, "");
    expect(await findCodexRollout(sessions, v7)).toBe(f1);

    const v4 = "0e3b1f2a-9c4d-4e5f-8a6b-7c8d9e0f1a2b";
    fs.mkdirSync(path.join(sessions, "2026", "11", "20"), { recursive: true });
    const f2 = path.join(sessions, "2026", "11", "20", `rollout-2026-11-20T08-00-00-${v4}.jsonl`);
    fs.writeFileSync(f2, "");
    expect(await findCodexRollout(sessions, v4)).toBe(f2);

    expect(await findCodexRollout(sessions, "11111111-2222-7333-8444-555555555555")).toBeUndefined();
    expect(await findCodexRollout(path.join(dir, "no-such-dir"), v4)).toBeUndefined();
    expect(await findCodexRollout(sessions, "../../etc/passwd")).toBeUndefined();
  });
});

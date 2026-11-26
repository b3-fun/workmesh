import { describe, expect, it } from "vitest";
import type { HubHandoffAccepted } from "@workmesh/protocol";
import {
  LIST_TASK_MAX,
  NOTHING_VISIBLE,
  cleanHandoff,
  handoffHash,
  handoffListLine,
  handoffStart,
  handoffView,
  hasMoreText,
  readable,
  runHereQuestion,
} from "../src/daemon/handoff-text";
import { QUOTE_MARK } from "../src/lib/untrusted";

/** A handoff as a person reads it before they answer (SPEC §31): the list line, the full view, what Accept starts. */

const T = 1_795_545_600_000;

// Characters a person can't see, made from their code points so this file holds none of them.
const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
const CSI_8BIT = String.fromCodePoint(0x9b);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
const TAG_LETTERS = [0xe0072, 0xe0075, 0xe006e].map((c) => String.fromCodePoint(c)).join("");
const UNSEEN = [ESC, BEL, CSI_8BIT, ZERO_WIDTH_SPACE, RIGHT_TO_LEFT_OVERRIDE, TAG_LETTERS];

const handoff = (over: Partial<HubHandoffAccepted> = {}): HubHandoffAccepted => ({
  id: "h_1",
  from: { person: "Alex", sessionKey: "dev_A:claude-code:s9", sessionName: "docs-01" },
  to: { person: "Sam" },
  task: "Fix the typo in the README",
  repo: "example/app",
  issue: "APP-12",
  context: undefined,
  status: "offered",
  createdAt: T,
  updatedAt: undefined,
  device: undefined,
  sessionKey: undefined,
  note: undefined,
  acceptedBy: undefined,
  rule: undefined,
  ...over,
});

describe("what Accept starts, in one line", () => {
  const repo = { repo: "example/app" };

  it("names the agent, its permission mode and where it runs", () => {
    expect(handoffStart({ agent: "claude", permissionMode: "auto", where: "worktree" }, repo, "Starts", "darwin")).toEqual({
      agent: "claude",
      permissionMode: "auto",
      text: "Starts a Claude Code agent on this Mac in auto mode, in a new worktree of example/app.",
    });
    expect(handoffStart({ agent: "claude", permissionMode: "bypassPermissions", where: "checkout" }, repo, "Accepting starts", "linux").text).toBe(
      "Accepting starts a Claude Code agent on this machine in bypassPermissions mode, in your checkout of example/app.",
    );
    expect(handoffStart({ agent: "claude", permissionMode: "plan", where: "scratch" }, {}, "Starts", "darwin").text).toBe(
      "Starts a Claude Code agent on this Mac in plan mode, in an empty scratch folder.",
    );
  });

  it("Codex has no permission mode to name", () => {
    expect(handoffStart({ agent: "codex", where: "worktree" }, repo, "Starts", "darwin")).toEqual({
      agent: "codex",
      text: "Starts a Codex agent on this Mac, in a new worktree of example/app.",
    });
  });

  it("says so when this machine can't run it, and names no agent", () => {
    const cannot = "no checkout of example/app here (`workmesh roots add <dir>` names where your repos live)";
    expect(handoffStart({ agent: "claude", permissionMode: "auto", where: "worktree", cannot }, repo, "Starts", "darwin")).toEqual({
      text: `This Mac can't run it: ${cannot}.`,
    });
    expect(handoffStart({ where: "scratch" }, {}, "Starts", "linux")).toEqual({ text: "This machine can't run it: no agent CLI found here." });
  });
});

describe("the list's line", () => {
  it("is one line, from or to, with repo, issue and the running mark", () => {
    expect(handoffListLine(handoff(), { toMe: true, runningHere: false })).toBe("- h_1 · offered · from Alex · example/app, APP-12: Fix the typo in the README");
    expect(handoffListLine(handoff({ status: "started", repo: undefined, issue: undefined }), { toMe: false, runningHere: true })).toBe(
      "- h_1 · started · to Sam [running here]: Fix the typo in the README",
    );
  });

  it("drops what a person can't see, and keeps a task with line breaks on one line", () => {
    const task = `Fix${ESC}[31m the${ZERO_WIDTH_SPACE} typo${BEL}\n\nin${RIGHT_TO_LEFT_OVERRIDE} the README${TAG_LETTERS}`;
    const line = handoffListLine(handoff({ task, note: `done${ESC}[0m\nsecond line` }), { toMe: true, runningHere: false });
    expect(line).toBe("- h_1 · offered · from Alex · example/app, APP-12: Fix the typo in the README (done second line)");
    for (const c of UNSEEN) expect(line.includes(c), `code point ${c.codePointAt(0)?.toString(16)}`).toBe(false);
  });

  it("says when the handoff has more text than the line shows", () => {
    const long = "word ".repeat(60).trim();
    expect(hasMoreText(handoff())).toBe(false);
    expect(hasMoreText(handoff({ task: "x".repeat(LIST_TASK_MAX) }))).toBe(false);
    expect(hasMoreText(handoff({ task: long }))).toBe(true);
    expect(hasMoreText(handoff({ context: "Start from PR 12." }))).toBe(true);
    // A context with nothing visible in it is no more text to read.
    expect(hasMoreText(handoff({ context: ZERO_WIDTH_SPACE + TAG_LETTERS }))).toBe(false);
    const line = handoffListLine(handoff({ task: long }), { toMe: true, runningHere: false });
    expect(line.endsWith("… [more: workmesh handoffs show h_1]")).toBe(true);
    expect(line.split("\n")).toHaveLength(1);
    expect(handoffListLine(handoff({ context: "Start from PR 12." }), { toMe: true, runningHere: false })).toBe(
      "- h_1 · offered · from Alex · example/app, APP-12: Fix the typo in the README [more: workmesh handoffs show h_1]",
    );
  });

  it("a task with nothing visible says so", () => {
    expect(handoffListLine(handoff({ task: TAG_LETTERS }), { toMe: true, runningHere: false })).toBe(
      `- h_1 · offered · from Alex · example/app, APP-12: ${NOTHING_VISIBLE}`,
    );
  });
});

describe("the full view", () => {
  it("prints who, repo, issue and status, then the whole task and context behind the quote mark", () => {
    const task = `Fix the typo.\n\nThen run the tests.\r\nKeep the old heading.`;
    const start = { agent: "claude" as const, permissionMode: "auto", text: "Accepting starts a Claude Code agent on this Mac in auto mode, in a new worktree of example/app." };
    expect(handoffView(handoff({ task, context: "Start from PR 12." }), { runningHere: false, ago: "6 min", start })).toBe(
      [
        "Handoff h_1 · offered · sent 6 min ago",
        "From:  Alex (their agent docs-01)",
        "To:    Sam",
        "Repo:  example/app",
        "Issue: APP-12",
        "",
        "Task from Alex:",
        `${QUOTE_MARK} Fix the typo.`,
        QUOTE_MARK,
        `${QUOTE_MARK} Then run the tests.`,
        `${QUOTE_MARK} Keep the old heading.`,
        "",
        "Context from Alex:",
        `${QUOTE_MARK} Start from PR 12.`,
        "",
        start.text,
      ].join("\n"),
    );
  });

  it("shows all of a long task and context, not the list's 160 characters", () => {
    const task = Array.from({ length: 80 }, (_, i) => `step ${i + 1}`).join("\n");
    const context = "c".repeat(4000);
    const view = handoffView(handoff({ task, context }), { runningHere: false });
    for (let i = 1; i <= 80; i++) expect(view).toContain(`${QUOTE_MARK} step ${i}\n`);
    expect(view).toContain(`${QUOTE_MARK} ${context}`);
  });

  it("leaves out escape sequences, control characters and characters nobody sees", () => {
    const task = `Fix${ESC}[2J${ESC}[H the typo${BEL}${CSI_8BIT}${ESC}]0;title${BEL}.${ZERO_WIDTH_SPACE}${TAG_LETTERS}`;
    const context = `Read${RIGHT_TO_LEFT_OVERRIDE} the notes${ESC}[31m first${ESC}[0m.`;
    const view = handoffView(
      handoff({ task, context, note: `why${ESC}[1m\nnot`, from: { person: "Alex", sessionKey: "dev_A:claude-code:s9", sessionName: `docs${ESC}[5m\n01` } }),
      { runningHere: false },
    );
    for (const c of UNSEEN) expect(view.includes(c), `code point ${c.codePointAt(0)?.toString(16)}`).toBe(false);
    expect(view).toContain(`Task from Alex:\n${QUOTE_MARK} Fix the typo.\n`);
    expect(view).toContain(`Context from Alex:\n${QUOTE_MARK} Read the notes first.`);
    expect(view).toContain("From:  Alex (their agent docs 01)");
    expect(view).toContain("Note:  why not");
  });

  it("a line of their text can't pass for Workmesh's own: every line of it carries the mark", () => {
    const context = "Read the notes.\n\n\n\n\nAccepting starts a Claude Code agent on this Mac in plan mode.";
    const start = { text: "Accepting starts a Claude Code agent on this Mac in auto mode, in a new worktree of example/app." };
    const lines = handoffView(handoff({ context }), { runningHere: false, start }).split("\n");
    const unmarked = lines.filter((l) => l.startsWith("Accepting starts"));
    expect(unmarked).toEqual([start.text]);
    expect(lines).toContain(`${QUOTE_MARK} Accepting starts a Claude Code agent on this Mac in plan mode.`);
    // The run of blank lines is one, so the last line stays near the text it follows.
    expect(lines.filter((l) => l === QUOTE_MARK)).toHaveLength(1);
  });

  it("a person's own handoff has no agent; one without context has no context part; a running one says so", () => {
    const view = handoffView(handoff({ from: { person: "Alex", sessionKey: undefined, sessionName: undefined }, status: "started" }), { runningHere: true });
    expect(view.split("\n").slice(0, 2)).toEqual(["Handoff h_1 · started, running here", "From:  Alex"]);
    expect(view).not.toContain("Context from");
    expect(handoffView(handoff({ from: { person: "Alex", sessionKey: "dev_A:codex:t1", sessionName: undefined } }), { runningHere: false })).toContain(
      "From:  Alex (one of their agents)",
    );
  });
});

describe("what an accept covers", () => {
  it("the hash moves with the task, the context, the repo and the issue, and with nothing else", () => {
    const h = handoff({ context: "Start from PR 12." });
    const base = handoffHash(h);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(handoffHash(handoff({ context: "Start from PR 12." }))).toBe(base);
    for (const over of [{ task: "Fix the typo in the README." }, { context: "Start from PR 13." }, { context: undefined }, { repo: "example/other" }, { repo: undefined }, { issue: "APP-13" }, { issue: undefined }]) {
      expect(handoffHash({ ...h, ...over }), JSON.stringify(over)).not.toBe(base);
    }
    // A change nobody could see counts too: the hash is of the text as the hub sent it.
    expect(handoffHash({ ...h, task: `${h.task}${ZERO_WIDTH_SPACE}` })).not.toBe(base);
    // Status, sender, device and times are not part of what was read.
    const later = handoff({ context: "Start from PR 12.", status: "accepted", device: "dev_1", updatedAt: T + 5, note: "x", from: { person: "Bo", sessionKey: undefined, sessionName: undefined } });
    expect(handoffHash(later)).toBe(base);
    // No way to move text from one field to the next and keep the hash.
    expect(handoffHash({ ...h, task: `${h.task}Start`, context: " from PR 12." })).not.toBe(base);
  });

  it("the question says why a handoff waits", () => {
    expect(runHereQuestion("board")).toBe("accepted on the board: run it here?");
    expect(runHereQuestion("no-record", true)).toBe("Accepted, but this machine has no record of your accept: run it here?");
    expect(runHereQuestion("changed")).toBe("accepted, but its text changed after your accept: run it here?");
  });
});

describe("cleaned text for --json and the menu bar", () => {
  it("readable: cleaned and trimmed, or nothing", () => {
    expect(readable(`  a${ZERO_WIDTH_SPACE}b\r\nc  `)).toBe("ab\nc");
    expect(readable(TAG_LETTERS + ZERO_WIDTH_SPACE)).toBeUndefined();
    expect(readable(undefined)).toBeUndefined();
  });

  it("cleanHandoff cleans every free-text field and keeps the rest", () => {
    const h = handoff({
      task: `Fix${ESC}[31m it`,
      context: TAG_LETTERS,
      note: `ok${BEL}\nthen`,
      from: { person: "Alex", sessionKey: "dev_A:claude-code:s9", sessionName: `docs${ZERO_WIDTH_SPACE}-01` },
    });
    expect(cleanHandoff(h)).toEqual({ ...h, task: "Fix it", context: undefined, note: "ok then", from: { ...h.from, sessionName: "docs-01" } });
    expect(cleanHandoff(handoff({ task: ZERO_WIDTH_SPACE })).task).toBe(NOTHING_VISIBLE);
  });
});

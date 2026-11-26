import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHandoffs } from "../src/commands/coord";
import type { HandoffsDeps } from "../src/commands/coord";
import type { CoordOpResult } from "../src/daemon/coord-ops";

/**
 * `workmesh handoffs` at a terminal (SPEC §31): accepting starts an agent on this machine, so `accept` always shows
 * the whole handoff and asks first. The daemon is a stand-in: nothing here starts one or reads a real config.
 */

const VIEW = [
  "Handoff h_1 · offered · sent 6 min ago",
  "From:  Alex (their agent docs-01)",
  "To:    Sam",
  "Repo:  example/app",
  "",
  "Task from Alex:",
  "│ Fix the typo in the README",
  "",
  "Accepting starts a Claude Code agent on this Mac in auto mode, in a new worktree of example/app.",
].join("\n");

const ACCEPTED: CoordOpResult = { ok: true, text: "Accepted h_1: this machine starts an agent for it." };
const RUNNING: CoordOpResult = { ok: true, text: "Running h_1 here: this machine starts an agent for it." };

/** The full view of a handoff that was accepted on the board and waits for "run it here". */
const WAITING_VIEW = [
  "Handoff h_1 · accepted on the board: run it here? · sent 6 min ago",
  "From:  Alex (their agent docs-01)",
  "To:    Sam",
  "Repo:  example/app",
  "",
  "Task from Alex:",
  "│ Fix the typo in the README",
  "",
  "Running it here starts a Claude Code agent on this Mac in auto mode, in a new worktree of example/app.",
].join("\n");
const WAITING: CoordOpResult = { ok: true, text: WAITING_VIEW, data: { handoff: { id: "h_1" }, canAccept: false, canRun: true } };

function harness(o: { terminal?: boolean; answer?: boolean; show?: CoordOpResult; accept?: CoordOpResult } = {}) {
  const calls: Array<{ op: string; args: Record<string, unknown>; client?: string }> = [];
  // What the person saw, in order: a printed line, or the question.
  const seen: string[] = [];
  const deps: HandoffsDeps = {
    call: async (op, args, caller) => {
      calls.push({ op, args, client: caller.client });
      if (args.action === "show") return o.show ?? { ok: true, text: VIEW, data: { handoff: { id: "h_1" }, canAccept: true } };
      if (args.action === "accept") return o.accept ?? ACCEPTED;
      if (args.action === "run") return o.accept ?? RUNNING;
      if (args.action === "decline") return { ok: true, text: "Declined h_1." };
      return { ok: true, text: "- h_1 · offered · from Alex · example/app: Fix the typo in the README" };
    },
    isTerminal: () => o.terminal ?? true,
    ask: async (question) => {
      seen.push(`? ${question}`);
      return o.answer ?? false;
    },
    print: (line) => seen.push(line),
  };
  return { deps, calls, seen };
}

let exitCode: typeof process.exitCode;
beforeEach(() => {
  exitCode = process.exitCode;
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = exitCode;
});

describe("workmesh handoffs accept", () => {
  it("prints the whole handoff and what starts, then asks, and accepts only on yes", async () => {
    const x = harness({ answer: true });
    await runHandoffs("accept", "h_1", {}, x.deps);
    expect(x.calls).toEqual([
      { op: "handoffs", args: { action: "show", id: "h_1" }, client: "cli" },
      { op: "handoffs", args: { action: "accept", id: "h_1" }, client: "cli" },
    ]);
    // The question comes after the whole view, and the accept after the question.
    expect(x.seen).toEqual([VIEW, "", "? Accept and start an agent?", ACCEPTED.text]);
    expect(process.exitCode).toBeUndefined();
  });

  it("anything but yes accepts nothing", async () => {
    const x = harness({ answer: false });
    await runHandoffs("accept", "h_1", {}, x.deps);
    expect(x.calls.map((c) => c.args.action)).toEqual(["show"]);
    expect(x.seen).toEqual([VIEW, "", "? Accept and start an agent?", "Not accepted. h_1 still waits for you (`workmesh handoffs decline h_1` declines it)."]);
    expect(process.exitCode).toBeUndefined();
  });

  it("without a terminal: refuses, points to the menu bar and the board, and makes no call", async () => {
    const x = harness({ terminal: false, answer: true });
    await runHandoffs("accept", "h_1", {}, x.deps);
    expect(x.calls).toEqual([]);
    expect(x.seen).toEqual([
      "Not accepted: there is no terminal to ask in. `workmesh handoffs accept` shows the whole handoff and asks before it starts an agent. Accept it in your own terminal, in the menu bar or on the board.",
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("no option skips the question: one named yes changes nothing, with or without a terminal", async () => {
    const yes = { yes: true } as Parameters<typeof runHandoffs>[2];
    const piped = harness({ terminal: false, answer: true });
    await runHandoffs("accept", "h_1", yes, piped.deps);
    expect(piped.calls).toEqual([]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    const typed = harness({ terminal: true, answer: false });
    await runHandoffs("accept", "h_1", yes, typed.deps);
    expect(typed.calls.map((c) => c.args.action)).toEqual(["show"]);
    expect(typed.seen[2]).toBe("? Accept and start an agent?");
  });

  it("--json leaves no room for the question, so it accepts nothing", async () => {
    for (const terminal of [true, false]) {
      process.exitCode = undefined;
      const x = harness({ terminal, answer: true });
      await runHandoffs("accept", "h_1", { json: true }, x.deps);
      expect(x.calls).toEqual([]);
      expect(JSON.parse(x.seen.join("\n"))).toEqual({
        ok: false,
        text: "Not accepted: --json leaves no room for the question. `workmesh handoffs accept` shows the whole handoff and asks before it starts an agent. Run it without --json, or accept in the menu bar or on the board.",
      });
      expect(process.exitCode).toBe(1);
    }
  });

  it("doesn't ask about a handoff that isn't waiting for this person, or one it can't show", async () => {
    const taken = harness({ answer: true, show: { ok: true, text: "Handoff h_1 · started, running here", data: { handoff: { id: "h_1" }, canAccept: false } } });
    await runHandoffs("accept", "h_1", {}, taken.deps);
    expect(taken.calls.map((c) => c.args.action)).toEqual(["show"]);
    expect(taken.seen).toEqual(["Handoff h_1 · started, running here", "", "Not accepted: h_1 isn't waiting for your answer."]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    const gone = harness({ answer: true, show: { ok: false, text: "No handoff h_9 for you or from you in the hub's list (`handoffs` lists them)." } });
    await runHandoffs("accept", "h_9", {}, gone.deps);
    expect(gone.calls.map((c) => c.args.action)).toEqual(["show"]);
    expect(gone.seen).toEqual(["No handoff h_9 for you or from you in the hub's list (`handoffs` lists them)."]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    const noId = harness({ answer: true });
    await runHandoffs("accept", undefined, {}, noId.deps);
    expect(noId.calls).toEqual([]);
    expect(noId.seen).toEqual(["`workmesh handoffs accept` needs the handoff's id (`workmesh handoffs` lists them)."]);
    expect(process.exitCode).toBe(1);
  });

  it("the daemon's refusal of an agent caller comes back as the answer, with exit code 1", async () => {
    const refusal = "Handoffs are accepted or declined by a person, on the board, in the menu bar or in their own terminal, not by an agent.";
    const x = harness({ answer: true, accept: { ok: false, text: refusal } });
    await runHandoffs("accept", "h_1", {}, x.deps);
    expect(x.seen.at(-1)).toBe(refusal);
    expect(process.exitCode).toBe(1);
  });
});

describe("workmesh handoffs run (a handoff accepted somewhere else)", () => {
  it("prints the whole handoff and what starts, then asks, and starts only on yes", async () => {
    const x = harness({ answer: true, show: WAITING });
    await runHandoffs("run", "h_1", {}, x.deps);
    expect(x.calls).toEqual([
      { op: "handoffs", args: { action: "show", id: "h_1" }, client: "cli" },
      { op: "handoffs", args: { action: "run", id: "h_1" }, client: "cli" },
    ]);
    expect(x.seen).toEqual([WAITING_VIEW, "", "? Run it here and start an agent?", RUNNING.text]);
    expect(process.exitCode).toBeUndefined();
    const no = harness({ answer: false, show: WAITING });
    await runHandoffs("run", "h_1", {}, no.deps);
    expect(no.calls.map((c) => c.args.action)).toEqual(["show"]);
    expect(no.seen.at(-1)).toBe("Not started. h_1 still waits: this machine or another of yours can run it.");
    expect(process.exitCode).toBeUndefined();
  });

  it("without a terminal, or with --json, nothing starts and no call is made; no option skips the question", async () => {
    const piped = harness({ terminal: false, answer: true, show: WAITING });
    await runHandoffs("run", "h_1", { yes: true } as Parameters<typeof runHandoffs>[2], piped.deps);
    expect(piped.calls).toEqual([]);
    expect(piped.seen).toEqual([
      "Not started: there is no terminal to ask in. `workmesh handoffs run` shows the whole handoff and asks before it starts an agent. Confirm it in your own terminal or in the menu bar.",
    ]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    const json = harness({ terminal: true, answer: true, show: WAITING });
    await runHandoffs("run", "h_1", { json: true }, json.deps);
    expect(json.calls).toEqual([]);
    expect(JSON.parse(json.seen.join("\n"))).toEqual({
      ok: false,
      text: "Not started: --json leaves no room for the question. `workmesh handoffs run` shows the whole handoff and asks before it starts an agent. Run it without --json, or confirm it in the menu bar.",
    });
    expect(process.exitCode).toBe(1);
  });

  it("doesn't ask about a handoff that isn't waiting to run here; an agent caller gets the daemon's refusal", async () => {
    // Offered, not yet accepted: `run` is not the answer for it.
    const offered = harness({ answer: true });
    await runHandoffs("run", "h_1", {}, offered.deps);
    expect(offered.calls.map((c) => c.args.action)).toEqual(["show"]);
    expect(offered.seen.at(-1)).toBe("Not started: h_1 isn't waiting to run on this machine.");
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    // And `accept` is not the answer for one that waits to run here.
    const waiting = harness({ answer: true, show: WAITING });
    await runHandoffs("accept", "h_1", {}, waiting.deps);
    expect(waiting.calls.map((c) => c.args.action)).toEqual(["show"]);
    expect(waiting.seen.at(-1)).toBe("Not accepted: h_1 isn't waiting for your answer.");
    process.exitCode = undefined;
    const noId = harness({ answer: true });
    await runHandoffs("run", undefined, {}, noId.deps);
    expect(noId.calls).toEqual([]);
    expect(noId.seen).toEqual(["`workmesh handoffs run` needs the handoff's id (`workmesh handoffs` lists them)."]);
    process.exitCode = undefined;
    const refusal = "Handoffs are accepted or declined by a person, on the board, in the menu bar or in their own terminal, not by an agent.";
    const agent = harness({ answer: true, show: WAITING, accept: { ok: false, text: refusal } });
    await runHandoffs("run", "h_1", {}, agent.deps);
    expect(agent.seen.at(-1)).toBe(refusal);
    expect(process.exitCode).toBe(1);
  });
});

describe("workmesh handoffs list, show and decline", () => {
  it("each is one call, with no question", async () => {
    for (const terminal of [false, true]) {
      const x = harness({ terminal });
      await runHandoffs(undefined, undefined, {}, x.deps);
      await runHandoffs("show", "h_1", {}, x.deps);
      await runHandoffs("decline", "h_1", { note: "not this week" }, x.deps);
      expect(x.calls.map((c) => c.args)).toEqual([{ action: "list" }, { action: "show", id: "h_1" }, { action: "decline", id: "h_1", note: "not this week" }]);
      expect(x.seen).toEqual(["- h_1 · offered · from Alex · example/app: Fix the typo in the README", VIEW, "Declined h_1."]);
    }
    expect(process.exitCode).toBeUndefined();
  });
});

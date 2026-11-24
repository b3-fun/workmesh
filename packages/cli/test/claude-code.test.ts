import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeDirFromTranscript,
  claudeHookCommand,
  hasBackgroundWork,
  lastTurnEnding,
  mapHookInput,
  textAsksUser,
} from "../src/adapters/claude-code";
import { OUR_COMMAND_RE } from "../src/lib/names";

const input = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  hook_event_name: "PreToolUse",
  session_id: "sess-1",
  cwd: "/Users/dev/projects/workmesh",
  ...over,
});

describe("mapHookInput", () => {
  it("maps SessionStart to a start event with project from cwd basename", () => {
    const event = mapHookInput(input({ hook_event_name: "SessionStart" }), 123);
    expect(event).toEqual({
      source: "claude-code",
      sessionId: "sess-1",
      kind: "start",
      project: "workmesh",
      cwd: "/Users/dev/projects/workmesh",
      ts: 123,
    });
  });

  it("maps UserPromptSubmit to working/thinking", () => {
    const event = mapHookInput(input({ hook_event_name: "UserPromptSubmit" }));
    expect(event?.kind).toBe("working");
    expect(event?.activity).toBe("thinking");
  });

  it.each(["Edit", "Write"])("labels %s with the file basename", (tool) => {
    const event = mapHookInput(
      input({ tool_name: tool, tool_input: { file_path: "/x/y/format.ts" } }),
    );
    expect(event?.kind).toBe("working");
    expect(event?.activity).toBe("editing format.ts");
  });

  it("labels NotebookEdit via notebook_path", () => {
    const event = mapHookInput(
      input({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/x/nb.ipynb" } }),
    );
    expect(event?.activity).toBe("editing nb.ipynb");
  });

  it("falls back to a generic editing label without a file path", () => {
    const event = mapHookInput(input({ tool_name: "Edit", tool_input: {} }));
    expect(event?.activity).toBe("editing files");
  });

  it("labels Bash as running commands", () => {
    expect(mapHookInput(input({ tool_name: "Bash" }))?.activity).toBe("running commands");
  });

  it.each(["Read", "Grep", "Glob"])("labels %s as reading code", (tool) => {
    expect(mapHookInput(input({ tool_name: tool }))?.activity).toBe("reading code");
  });

  it.each(["Task", "Agent"])("labels %s as delegating to subagents", (tool) => {
    expect(mapHookInput(input({ tool_name: tool }))?.activity).toBe(
      "delegating to subagents",
    );
  });

  it("labels Workflow (ultracode) as orchestrating a workflow", () => {
    expect(mapHookInput(input({ tool_name: "Workflow" }))?.activity).toBe(
      "orchestrating a workflow",
    );
  });

  it.each(["WebFetch", "WebSearch"])("labels %s as browsing the web", (tool) => {
    expect(mapHookInput(input({ tool_name: tool }))?.activity).toBe("browsing the web");
  });

  it("labels unknown tools as using {tool}", () => {
    expect(mapHookInput(input({ tool_name: "MagicWand" }))?.activity).toBe(
      "using MagicWand",
    );
  });

  it("maps PreToolUse without a tool_name to a label-less working event", () => {
    const event = mapHookInput(input());
    expect(event?.kind).toBe("working");
    expect(event?.activity).toBeUndefined();
  });

  it("maps PostToolUse to working so approval of a permission prompt flips waiting back", () => {
    // heartbeat would preserve "waiting" after the user approves a permission
    // prompt — tool completion must demote it to working.
    const event = mapHookInput(input({ hook_event_name: "PostToolUse" }));
    expect(event?.kind).toBe("working");
    expect(event?.activity).toBeUndefined();
  });

  it("labels PostToolUse with the completed tool so no stale label is inherited", () => {
    const event = mapHookInput(
      input({ hook_event_name: "PostToolUse", tool_name: "Bash" }),
    );
    expect(event?.kind).toBe("working");
    expect(event?.activity).toBe("running commands");
  });

  it("maps Notification to waiting/needs my input", () => {
    const event = mapHookInput(input({ hook_event_name: "Notification" }));
    expect(event?.kind).toBe("waiting");
    expect(event?.activity).toBe("needs my input");
  });

  it("treats the idle reminder as background work when the session has some", () => {
    const event = mapHookInput(
      input({ hook_event_name: "Notification", notification_type: "idle_prompt" }),
      1,
      { backgroundWork: (id) => id === "sess-1" },
    );
    expect(event?.kind).toBe("working");
    expect(event?.activity).toBe("running in background");
  });

  it("keeps the idle reminder as waiting when nothing runs in the background", () => {
    const event = mapHookInput(
      input({ hook_event_name: "Notification", notification_type: "idle_prompt" }),
      1,
      { backgroundWork: () => false },
    );
    expect(event?.kind).toBe("waiting");
  });

  it("maps an idle reminder after a turn that asked nothing to idle/done", () => {
    const seen: Array<string | undefined> = [];
    const event = mapHookInput(
      input({
        hook_event_name: "Notification",
        notification_type: "idle_prompt",
        transcript_path: "/h/.claude/projects/-x/sess-1.jsonl",
      }),
      1,
      {
        backgroundWork: () => false,
        turnEnding: (p) => {
          seen.push(p);
          return "done";
        },
      },
    );
    expect(event?.kind).toBe("idle");
    expect(event?.activity).toBe("done");
    expect(seen).toEqual(["/h/.claude/projects/-x/sess-1.jsonl"]);
  });

  it("keeps the idle reminder as waiting when the turn ended with a question", () => {
    const event = mapHookInput(
      input({ hook_event_name: "Notification", notification_type: "idle_prompt" }),
      1,
      { backgroundWork: () => false, turnEnding: () => "asks" },
    );
    expect(event?.kind).toBe("waiting");
    expect(event?.activity).toBe("needs my input");
  });

  it("falls back to waiting when the transcript can't be read", () => {
    const event = mapHookInput(
      input({ hook_event_name: "Notification", notification_type: "idle_prompt" }),
      1,
      { backgroundWork: () => false, turnEnding: () => undefined },
    );
    expect(event?.kind).toBe("waiting");
  });

  it("background work wins over the transcript check and is flagged", () => {
    let checked = false;
    const event = mapHookInput(
      input({ hook_event_name: "Notification", notification_type: "idle_prompt" }),
      1,
      {
        backgroundWork: () => true,
        turnEnding: () => {
          checked = true;
          return "done";
        },
      },
    );
    expect(event?.kind).toBe("working");
    expect(event?.background).toBe(true);
    expect(checked).toBe(false);
  });

  it.each(["AskUserQuestion", "ExitPlanMode"])(
    "maps PreToolUse %s to waiting (a dialog blocks on the user)",
    (tool) => {
      const event = mapHookInput(input({ tool_name: tool }));
      expect(event?.kind).toBe("waiting");
      expect(event?.activity).toBe("needs my input");
      const after = mapHookInput(input({ hook_event_name: "PostToolUse", tool_name: tool }));
      expect(after?.kind).toBe("working");
      expect(after?.activity).toBe("thinking");
    },
  );

  it.each(["permission_prompt", "elicitation_dialog"])(
    "keeps %s as waiting even with background work",
    (type) => {
      const event = mapHookInput(
        input({ hook_event_name: "Notification", notification_type: type }),
        1,
        { backgroundWork: () => true, turnEnding: () => "done" },
      );
      expect(event?.kind).toBe("waiting");
      expect(event?.activity).toBe("needs my input");
    },
  );

  it.each(["Stop", "SubagentStop"])("maps %s to idle", (name) => {
    expect(mapHookInput(input({ hook_event_name: name }))?.kind).toBe("idle");
  });

  it("maps SessionEnd to end", () => {
    expect(mapHookInput(input({ hook_event_name: "SessionEnd" }))?.kind).toBe("end");
  });

  it("omits project when cwd is missing", () => {
    const event = mapHookInput({
      hook_event_name: "SessionStart",
      session_id: "s",
    });
    expect(event?.project).toBeUndefined();
  });

  it("returns null for unknown hook events", () => {
    expect(mapHookInput(input({ hook_event_name: "SomethingNew" }))).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(mapHookInput(null)).toBeNull();
    expect(mapHookInput("nope")).toBeNull();
    expect(mapHookInput(42)).toBeNull();
    expect(mapHookInput({ hook_event_name: "Stop" })).toBeNull(); // missing session_id
    expect(mapHookInput({ session_id: "s" })).toBeNull(); // missing event name
  });
});

describe("claudeHookCommand", () => {
  it("writes a quoted absolute invocation that carries one of our names", () => {
    const command = claudeHookCommand();
    // absolute node + entry paths, quoted for spaces, PATH-independent
    expect(command.startsWith(`"${process.execPath}" "`)).toBe(true);
    expect(command.endsWith('" hook claude-code')).toBe(true);
    // install idempotency recognises our command by name (lib/names.ts)
    expect(command).toMatch(OUR_COMMAND_RE);
  });
});

describe("hasBackgroundWork", () => {
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-claude-"));
    fs.mkdirSync(path.join(dir, "sessions"));
    fs.mkdirSync(path.join(dir, "projects", "-Users-dev-proj", "sess-1", "subagents"), { recursive: true });
    return dir;
  };
  const writeSession = (dir: string, pid: number, sessionId: string, status: string) =>
    fs.writeFileSync(path.join(dir, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId, status }));

  it("is true when Claude Code reports background shells (status shell)", () => {
    const dir = setup();
    writeSession(dir, 11, "sess-1", "shell");
    writeSession(dir, 12, "other", "idle");
    expect(hasBackgroundWork("sess-1", Date.now(), dir)).toBe(true);
  });

  it("is false for an idle session with no live subagents", () => {
    const dir = setup();
    writeSession(dir, 11, "sess-1", "idle");
    expect(hasBackgroundWork("sess-1", Date.now(), dir)).toBe(false);
  });

  it("is true while a subagent transcript is fresh, false once it goes quiet", () => {
    const dir = setup();
    writeSession(dir, 11, "sess-1", "idle");
    const file = path.join(dir, "projects", "-Users-dev-proj", "sess-1", "subagents", "agent-a.jsonl");
    fs.writeFileSync(file, "{}\n");
    expect(hasBackgroundWork("sess-1", Date.now(), dir)).toBe(true);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(file, old, old);
    expect(hasBackgroundWork("sess-1", Date.now(), dir)).toBe(false);
  });

  it("counts live workflow agents too", () => {
    const dir = setup();
    const run = path.join(dir, "projects", "-Users-dev-proj", "sess-1", "subagents", "workflows", "wf_1");
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, "agent-b.jsonl"), "{}\n");
    expect(hasBackgroundWork("sess-1", Date.now(), dir)).toBe(true);
  });

  it("is false (not throwing) when Claude's dirs are missing", () => {
    expect(hasBackgroundWork("sess-1", Date.now(), path.join(os.tmpdir(), "ab-missing-xyz"))).toBe(false);
  });
});

describe("claudeDirFromTranscript", () => {
  it("derives the config dir from a transcript path", () => {
    expect(claudeDirFromTranscript("/h/.claude-alt/projects/-Users-x/abc.jsonl")).toBe("/h/.claude-alt");
  });
  it("is undefined for other shapes", () => {
    expect(claudeDirFromTranscript(undefined)).toBeUndefined();
    expect(claudeDirFromTranscript("/tmp/abc.jsonl")).toBeUndefined();
  });
});

describe("textAsksUser", () => {
  it("is false for the fleet-agent turn that waits on a colleague", () => {
    const text = [
      "I've sent An another message about the GitHub App: https://npc-labs.slack.com/archives/D07H47Q131V/p1795469362963969",
      "Before sending, I checked that nothing had been done since the last ask on 11-21.",
      "The message tags him and says #2696 is merged. It gives him three key points:\n- the App must be named exactly `b3iq-fleet-agent-actions`\n- it gets Actions read/write only\n- the three values go into Doppler, never Slack",
      "When he replies, I'll run the release that installs the secrets and check that the agent can make the GitHub calls itself.",
    ].join("\n\n");
    expect(textAsksUser(text)).toBe(false);
  });

  it.each([
    "Done. Want me to ship it?",
    "Tests pass.\n\nShould I merge #12 now",
    "Two options.\n\nWhich do you prefer, A or B?",
    "All green. Let me know if you want changes.",
    "Built it.\n\n**Deploy now?**",
    "Built both.\n\nWhich way should this go?\n\n1. keep the cache\n2. drop it",
    "Done.\n\n> Hey An, draft below.\n\nOK to send? ",
    "Shipped.\n\n## Needs your OK\n\n- **The post in #soc2.** Still waiting on your \"post it\".\n- **A note to Allie.** Draft:\n  > @Allie one more gap.",
    "## Needs you\n\n- approve the deploy\n\n## Done today\n\n- merged #12",
    "Merged. Tell me if you want it handled differently.",
  ])("is true when the message asks: %j", (text) => {
    expect(textAsksUser(text)).toBe(true);
  });

  it.each([
    "Shipped in abc123. Tests pass.",
    "Why did it fail? A stale cache.\n\nFixed in abc123 and deployed.",
    "Deployed. Logs are at https://example.com/logs?run=42 for reference.",
    'I asked An: "Can you install the app?" and will check back.',
    "Sent him this:\n\n> Can you approve #12?",
    "Run `ls?` to see it.",
    "```\nwhat?\n```",
    "Steady is healthy and nothing is waiting on you today.",
    "It doesn't need your approval; merged and deployed.",
    "## Nothing needs you\n\nAll green.",
  ])("is false when the ending asks nothing of the user: %j", (text) => {
    expect(textAsksUser(text)).toBe(false);
  });
});

describe("lastTurnEnding", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-transcript-"));
  let n = 0;
  const write = (entries: unknown[], padBefore = 0): string => {
    const file = path.join(dir, `t${n++}.jsonl`);
    const pad = Array.from({ length: padBefore }, () =>
      JSON.stringify({ type: "api-request", params: "x".repeat(2000) }),
    );
    fs.writeFileSync(file, [...pad, ...entries.map((e) => JSON.stringify(e))].join("\n") + "\n");
    return file;
  };
  const say = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  const prompt = (text: string) => ({ type: "user", message: { role: "user", content: text } });
  const toolUse = (name: string, id: string) => ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name, id, input: {} }] },
  });
  const toolResult = (id: string) => ({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  });
  const system = { type: "system", subtype: "turn_duration", durationMs: 5 };

  it("reads the last assistant text: done vs asks", () => {
    expect(lastTurnEnding(write([prompt("go"), say("Shipped."), system]))).toBe("done");
    expect(lastTurnEnding(write([prompt("go"), say("Shipped. Want me to tag it?"), system]))).toBe("asks");
  });

  it("uses only the last text of the turn, skipping tool calls after it", () => {
    const file = write([prompt("go"), say("Should I start?"), toolUse("Bash", "t1"), toolResult("t1"), say("Done, merged."), system]);
    expect(lastTurnEnding(file)).toBe("done");
  });

  it("treats a pending AskUserQuestion as asking, an answered one as not", () => {
    expect(lastTurnEnding(write([prompt("go"), say("Checking."), toolUse("AskUserQuestion", "q1")]))).toBe("asks");
    expect(
      lastTurnEnding(write([prompt("go"), toolUse("AskUserQuestion", "q1"), toolResult("q1"), say("Picked A, done.")])),
    ).toBe("done");
  });

  it("ignores sidechain and meta entries", () => {
    const file = write([
      prompt("go"),
      say("All done."),
      { ...say("Should I?"), isSidechain: true },
      { type: "user", isMeta: true, message: { role: "user", content: "<system-reminder>" } },
    ]);
    expect(lastTurnEnding(file)).toBe("done");
  });

  it("looks past a compaction summary to the turn's last text", () => {
    const file = write([
      prompt("go"),
      say("Healthy; nothing waiting on you."),
      { type: "user", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: "Summary: …" } },
      { type: "attachment", attachment: {} },
    ]);
    expect(lastTurnEnding(file)).toBe("done");
  });

  it("can't tell when the user spoke last (e.g. an interrupted turn)", () => {
    expect(lastTurnEnding(write([say("Working on it."), prompt("[Request interrupted by user]")]))).toBeUndefined();
  });

  it("looks past a tail full of non-conversation lines (grows the read window)", () => {
    // ~200 KB of api-request lines after the reply: beyond the first 64 KB read
    const file = write([prompt("go"), say("Want me to deploy?")]);
    const pad = Array.from({ length: 100 }, () =>
      JSON.stringify({ type: "api-request", params: "y".repeat(2000) }),
    );
    fs.appendFileSync(file, pad.join("\n") + "\n");
    expect(fs.statSync(file).size).toBeGreaterThan(64 * 1024);
    expect(lastTurnEnding(file)).toBe("asks");
  });

  it("returns undefined for a missing or empty transcript", () => {
    expect(lastTurnEnding(path.join(dir, "nope.jsonl"))).toBeUndefined();
    expect(lastTurnEnding(write([]))).toBeUndefined();
  });
});

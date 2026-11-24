import { afterEach, describe, expect, it, vi } from "vitest";
import { DETAIL_LIMITS, SessionStore, formatStatus, sessionEventSchema } from "@agentblip/core";
import type { SessionEvent } from "@agentblip/core";
import { mapHookInput } from "../src/adapters/claude-code";
import { fitEventBody, responseOk, responseText } from "../src/adapters/detail";
import { Pusher } from "../src/daemon/pusher";
import { createRelaySink } from "../src/sinks/relay";

const NOW = 1_795_545_600_000;
const SECRET = "sk-live-SUPERSECRET-0123456789";
const opts = { backgroundWork: () => false, turnEnding: () => undefined };

function hook(input: Record<string, unknown>): SessionEvent {
  const event = mapHookInput(
    { session_id: "s1", cwd: "/Users/dev/code/app", ...input },
    NOW,
    opts,
  );
  if (!event) throw new Error("mapper returned null");
  return event;
}

describe("Claude Code hook detail (local only)", () => {
  it("carries the raw prompt on UserPromptSubmit", () => {
    const e = hook({ hook_event_name: "UserPromptSubmit", prompt: `deploy with ${SECRET}` });
    expect(e.kind).toBe("working");
    expect(e.detail).toEqual({ hookEvent: "UserPromptSubmit", prompt: `deploy with ${SECRET}` });
  });

  it("carries tool, absolute path and command on PreToolUse", () => {
    const edit = hook({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/Users/dev/code/app/src/vm.rs", old_string: "a", new_string: "b" },
    });
    expect(edit.activity).toBe("editing vm.rs");
    expect(edit.detail).toEqual({
      hookEvent: "PreToolUse",
      tool: "Edit",
      filePath: "/Users/dev/code/app/src/vm.rs",
    });

    const bash = hook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "cargo test --release" },
    });
    expect(bash.detail).toMatchObject({ tool: "Bash", command: "cargo test --release" });
    expect(bash.detail?.filePath).toBeUndefined();
  });

  it("resolves a relative path against the session cwd", () => {
    const e = hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "src/a.ts" } });
    expect(e.detail?.filePath).toBe("/Users/dev/code/app/src/a.ts");
  });

  it("carries shell output and ok on PostToolUse", () => {
    const e = hook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr create --title x" },
      tool_response: { stdout: "https://github.com/b3-fun/x/pull/7\n", stderr: "", interrupted: false },
    });
    expect(e.detail).toMatchObject({
      hookEvent: "PostToolUse",
      tool: "Bash",
      command: "gh pr create --title x",
      toolResponseText: "https://github.com/b3-fun/x/pull/7\n",
      ok: true,
    });
  });

  it("does not copy a non-shell tool's structured output (file contents)", () => {
    const e = hook({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/Users/dev/code/app/.env" },
      tool_response: { type: "text", file: { content: `TOKEN=${SECRET}` } },
    });
    expect(e.detail?.toolResponseText).toBeUndefined();
  });

  it("truncates long fields to the schema caps", () => {
    const long = "x".repeat(DETAIL_LIMITS.prompt * 2);
    const e = hook({ hook_event_name: "UserPromptSubmit", prompt: long });
    expect(e.detail?.prompt?.length).toBeLessThanOrEqual(DETAIL_LIMITS.prompt);
    expect(sessionEventSchema.safeParse(e).success).toBe(true);
  });

  it("reports failures", () => {
    expect(responseOk({ is_error: true })).toBe(false);
    expect(responseOk({ exit_code: 2 })).toBe(false);
    expect(responseOk({ stdout: "ok" })).toBe(true);
    expect(responseOk("plain")).toBeUndefined();
    expect(responseText({ output: "done" })).toBe("done");
  });

  it("fitEventBody drops detail fields before the status fields", () => {
    const big = "é".repeat(DETAIL_LIMITS.toolResponseText);
    const event: SessionEvent = {
      source: "claude-code",
      sessionId: "s1",
      kind: "working",
      activity: "running commands",
      detail: {
        tool: "Bash",
        command: "é".repeat(DETAIL_LIMITS.command),
        prompt: big,
        toolResponseText: big,
        filePaths: Array.from({ length: 10 }, () => `/${"é".repeat(1000)}`),
      },
    };
    const fitted = fitEventBody(event);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(60_000);
    expect(fitted.activity).toBe("running commands");
  });
});

describe("detail never reaches the Slack status path or the agentblip relay", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is dropped by the session store and absent from every relay request", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        const url = String(_url);
        if (url.endsWith("/api/slack/status")) {
          return new Response(JSON.stringify({ readable: true, status: null }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const store = new SessionStore();
    const sink = createRelaySink("https://relay.example", "ab_test");
    const pusher = new Pusher({
      store,
      sink,
      formatOpts: { granularity: "activity", showProject: true },
      debounceMs: 0,
      log: () => {},
    });

    const events = [
      hook({ hook_event_name: "UserPromptSubmit", prompt: `use ${SECRET}` }),
      hook({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: `curl -H "Authorization: Bearer ${SECRET}" https://x` },
      }),
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: `echo ${SECRET}` },
        tool_response: { stdout: SECRET, stderr: "" },
      }),
    ];
    for (const e of events) {
      expect(JSON.stringify(e)).toContain(SECRET); // the hook does carry it locally
      store.apply(e, NOW);
      pusher.notify();
      await pusher.flush();
    }

    const snapshot = store.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    expect(JSON.stringify(snapshot)).not.toContain("detail");
    expect(JSON.stringify(formatStatus(snapshot, { granularity: "activity" }))).not.toContain(SECRET);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain("Authorization");
    }
    await pusher.shutdown();
  });
});

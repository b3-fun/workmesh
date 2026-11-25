import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionEventSchema } from "@workmesh/core";
import {
  CODEX_HOOK_EVENTS,
  areCodexHooksInstalled,
  codexHookCommand,
  codexShellCommand,
  installCodexHooks,
  mapCodexHookInput,
  parsePatchFiles,
} from "../src/adapters/codex";

const NOW = 1_795_545_600_000;
const common = {
  session_id: "019a0f34-537f-79c2-ae15-7ef850da3e3c",
  transcript_path: null,
  cwd: "/Users/dev/b3/b3os-beta",
  model: "gpt-5.5-codex",
  permission_mode: "default",
};

function map(input: Record<string, unknown>) {
  const e = mapCodexHookInput({ ...common, ...input }, NOW);
  if (e) expect(sessionEventSchema.safeParse(e).success).toBe(true);
  return e;
}

const PATCH = [
  "*** Begin Patch",
  "*** Update File: crates/vm/src/vm.rs",
  "@@",
  "-let a = 1;",
  "+let a = 2;",
  "*** Add File: docs/new.md",
  "+hello",
  "*** End Patch",
].join("\n");

describe("mapCodexHookInput", () => {
  it("maps the session lifecycle", () => {
    expect(map({ hook_event_name: "SessionStart", source: "startup" })).toMatchObject({
      source: "codex",
      sessionId: common.session_id,
      kind: "start",
      project: "b3os-beta",
      cwd: common.cwd,
    });
    expect(map({ hook_event_name: "Stop", turn_id: "t", stop_hook_active: false, last_assistant_message: "done, shipped" }))
      .toMatchObject({ kind: "idle" });
    expect(map({ hook_event_name: "Stop", last_assistant_message: "secret plan" })?.activity).toBeUndefined();
    expect(map({ hook_event_name: "SessionEnd", reason: "other" })).toMatchObject({ kind: "end" });
    expect(map({ hook_event_name: "PreCompact" })).toBeNull();
  });

  it("maps a prompt with local-only text", () => {
    expect(map({ hook_event_name: "UserPromptSubmit", turn_id: "t", prompt: "fix B3-7166" })).toMatchObject({
      kind: "working",
      activity: "thinking",
      detail: { hookEvent: "UserPromptSubmit", prompt: "fix B3-7166" },
    });
  });

  it("labels apply_patch with the first file and keeps every path locally", () => {
    const e = map({
      hook_event_name: "PreToolUse",
      turn_id: "t",
      tool_name: "apply_patch",
      tool_use_id: "call_1",
      tool_input: { command: PATCH },
    });
    expect(e).toMatchObject({ kind: "working", activity: "editing vm.rs" });
    expect(e?.detail).toEqual({
      hookEvent: "PreToolUse",
      tool: "apply_patch",
      filePath: "/Users/dev/b3/b3os-beta/crates/vm/src/vm.rs",
      filePaths: ["/Users/dev/b3/b3os-beta/crates/vm/src/vm.rs", "/Users/dev/b3/b3os-beta/docs/new.md"],
    });
  });

  it("labels shell calls 'running commands' whatever Codex names the tool", () => {
    for (const tool_name of ["shell", "Bash", "exec_command", "local_shell"]) {
      const e = map({
        hook_event_name: "PreToolUse",
        tool_name,
        tool_input: { command: ["bash", "-lc", "cargo test -p vm"] },
      });
      expect(e?.activity, tool_name).toBe("running commands");
      expect(e?.detail?.command, tool_name).toBe("cargo test -p vm");
    }
  });

  it("carries shell output and exit status on PostToolUse", () => {
    const ok = map({
      hook_event_name: "PostToolUse",
      tool_name: "shell",
      tool_input: { command: "gh pr create --fill" },
      tool_response: "Exit code: 0\nWall time: 1.2 seconds\nOutput:\nhttps://github.com/b3-fun/b3os-beta/pull/42\n",
    });
    expect(ok?.detail).toMatchObject({ ok: true, command: "gh pr create --fill" });
    expect(ok?.detail?.toolResponseText).toContain("/pull/42");

    const failed = map({
      hook_event_name: "PostToolUse",
      tool_name: "exec_command",
      tool_input: { cmd: "cargo test" },
      tool_response: { output: "error[E0425]", metadata: { exit_code: 101 } },
    });
    expect(failed?.detail).toMatchObject({ ok: false, command: "cargo test", toolResponseText: "error[E0425]" });
  });

  it("maps a question to the person and approval prompts to waiting", () => {
    expect(map({ hook_event_name: "PreToolUse", tool_name: "request_user_input", tool_input: {} })).toMatchObject({
      kind: "waiting",
      activity: "needs my input",
    });
    expect(
      map({ hook_event_name: "PermissionRequest", tool_name: "shell", tool_input: { command: "rm -rf build" } }),
    ).toMatchObject({ kind: "waiting", activity: "needs my input", detail: { command: "rm -rf build" } });
  });

  it("labels other tools generically", () => {
    expect(map({ hook_event_name: "PreToolUse", tool_name: "update_plan", tool_input: {} })?.activity).toBe("planning");
    expect(map({ hook_event_name: "PreToolUse", tool_name: "mcp__linear__get_issue", tool_input: {} })?.activity).toBe(
      "using mcp__linear__get_issue",
    );
  });

  it("rejects payloads without a session id", () => {
    expect(mapCodexHookInput({ hook_event_name: "Stop" }, NOW)).toBeNull();
    expect(mapCodexHookInput("nope", NOW)).toBeNull();
  });
});

describe("codex patch and command helpers", () => {
  it("parses every file a patch touches, including moves", () => {
    expect(parsePatchFiles(`${PATCH}\n*** Update File: a.ts\n*** Move to: b.ts\n*** Delete File: c.ts`)).toEqual([
      "crates/vm/src/vm.rs",
      "docs/new.md",
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });

  it("keeps a different workdir as a leading cd", () => {
    expect(codexShellCommand({ cmd: "git status", workdir: "/Users/dev/b3/x" }, "/Users/dev")).toBe(
      "cd /Users/dev/b3/x && git status",
    );
    expect(codexShellCommand({ cmd: "git status", workdir: "/Users/dev" }, "/Users/dev")).toBe("git status");
    expect(codexShellCommand({ command: ["git", "log", "-1"] }, undefined)).toBe("git log -1");
  });
});

describe("installCodexHooks", () => {
  let dir: string;
  let hooksPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-codex-hooks-"));
    hooksPath = path.join(dir, "hooks.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The shape of a real hooks.json that already has another tool's hooks. */
  const existing = {
    description: "other tools",
    hooks: {
      SessionStart: [
        { matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: "'/x/node' '/x/notify.mjs'", timeout: 5 }] },
      ],
      PreToolUse: [{ matcher: "request_user_input", hooks: [{ type: "command", command: "'/x/node' '/x/notify.mjs'", timeout: 5 }] }],
      Interrupt: [{ hooks: [{ type: "command", command: "'/x/node' '/x/notify.mjs'", timeout: 3 }] }],
    },
  };

  it("merges without touching other entries and backs the file up first", () => {
    fs.writeFileSync(hooksPath, JSON.stringify(existing, null, 2));
    const result = installCodexHooks(hooksPath);
    expect(result.changed).toBe(true);
    expect(result.backupPath).toMatch(/hooks\.json\.workmesh-backup-\d{8}T\d{9}Z$/);
    expect(JSON.parse(fs.readFileSync(result.backupPath!, "utf8"))).toEqual(existing);

    const doc = JSON.parse(fs.readFileSync(hooksPath, "utf8")) as typeof existing & {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>>;
    };
    expect(doc.description).toBe("other tools");
    expect(doc.hooks.Interrupt).toEqual(existing.hooks.Interrupt);
    expect(doc.hooks.SessionStart?.[0]).toEqual(existing.hooks.SessionStart[0]);
    expect(doc.hooks.PreToolUse?.[0]).toEqual(existing.hooks.PreToolUse[0]);
    for (const event of CODEX_HOOK_EVENTS) {
      const ours = doc.hooks[event]?.find((e) => e.hooks.some((h) => h.command === codexHookCommand()));
      expect(ours, event).toBeDefined();
      expect(ours?.matcher, event).toBeUndefined(); // no matcher = every tool / source
      expect(ours?.hooks[0]?.timeout).toBe(event === "SessionEnd" ? 3 : 5);
    }
    expect(areCodexHooksInstalled(hooksPath)).toBe(true);
  });

  it("is idempotent", () => {
    installCodexHooks(hooksPath);
    const first = fs.readFileSync(hooksPath, "utf8");
    expect(installCodexHooks(hooksPath).changed).toBe(false);
    expect(fs.readFileSync(hooksPath, "utf8")).toBe(first);
  });

  it("creates the file when missing and refuses a non-object file", () => {
    expect(installCodexHooks(hooksPath).backupPath).toBeUndefined();
    expect(areCodexHooksInstalled(hooksPath)).toBe(true);
    fs.writeFileSync(hooksPath, "[]");
    expect(() => installCodexHooks(hooksPath)).toThrow(/expected a JSON object/);
    expect(fs.readFileSync(hooksPath, "utf8")).toBe("[]");
  });

  it("does not count the notify hook as the lifecycle hooks", () => {
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node /x/workmesh/dist/index.js hook codex" }] }] } }),
    );
    expect(areCodexHooksInstalled(hooksPath)).toBe(false);
  });
});

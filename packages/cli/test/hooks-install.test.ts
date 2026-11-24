import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_HOOK_EVENTS,
  areClaudeHooksInstalled,
  claudeHookCommand,
  installClaudeHooks,
} from "../src/adapters/claude-code";

let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-hooks-"));
  settingsPath = path.join(dir, "settings.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type Settings = {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  [key: string]: unknown;
};

const readSettings = (): Settings =>
  JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Settings;

describe("installClaudeHooks", () => {
  it("creates settings.json with all hook events when missing", () => {
    const result = installClaudeHooks(settingsPath);
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeUndefined(); // nothing to back up

    const settings = readSettings();
    for (const event of CLAUDE_HOOK_EVENTS) {
      const entries = settings.hooks[event];
      expect(entries).toHaveLength(1);
      expect(entries?.[0]?.hooks[0]?.command).toBe(claudeHookCommand());
    }
    // only tool events take a matcher
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe("*");
    expect(settings.hooks.PostToolUse?.[0]?.matcher).toBe("*");
    expect(settings.hooks.SessionStart?.[0]?.matcher).toBeUndefined();
    expect(settings.hooks.Stop?.[0]?.matcher).toBeUndefined();
    expect(areClaudeHooksInstalled(settingsPath)).toBe(true);
  });

  it("preserves unknown keys and existing hook entries", () => {
    const original = {
      model: "opus",
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    const result = installClaudeHooks(settingsPath);
    expect(result.changed).toBe(true);

    const settings = readSettings();
    expect(settings.model).toBe("opus");
    expect(settings.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe("echo hi");
    expect(settings.hooks.PreToolUse?.[1]?.hooks[0]?.command).toBe(claudeHookCommand());
  });

  it("is idempotent — a second run changes nothing", () => {
    installClaudeHooks(settingsPath);
    const afterFirst = fs.readFileSync(settingsPath, "utf8");

    const second = installClaudeHooks(settingsPath);
    expect(second.changed).toBe(false);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(afterFirst);
  });

  it("repoints a legacy bare-command install to the absolute command, without duplicating it", () => {
    const legacyHooks: Record<string, unknown> = {};
    for (const event of CLAUDE_HOOK_EVENTS) {
      legacyHooks[event] = [
        { hooks: [{ type: "command", command: "agentblip hook claude-code" }] }, // pre-rename bare command
      ];
    }
    const original = JSON.stringify({ hooks: legacyHooks }, null, 2);
    fs.writeFileSync(settingsPath, original);

    const result = installClaudeHooks(settingsPath);
    expect(result.changed).toBe(true);
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    for (const event of CLAUDE_HOOK_EVENTS) {
      expect(after.hooks[event]).toHaveLength(1);
      expect(after.hooks[event]![0]!.hooks[0]!.command).toBe(claudeHookCommand());
    }
    expect(areClaudeHooksInstalled(settingsPath)).toBe(true);
    expect(installClaudeHooks(settingsPath).changed).toBe(false);
  });

  it("repoints an install under the old package path to the new one (agentblip → @b3os/workmesh)", () => {
    const old = '"/usr/local/bin/node" "/usr/local/lib/node_modules/agentblip/dist/index.js" hook claude-code';
    const hooks: Record<string, unknown> = {};
    for (const event of CLAUDE_HOOK_EVENTS) hooks[event] = [{ hooks: [{ type: "command", command: old }] }];
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));
    expect(installClaudeHooks(settingsPath).changed).toBe(true);
    const after = fs.readFileSync(settingsPath, "utf8");
    expect(after).not.toContain("node_modules/agentblip/");
  });

  it("repoints a pre-rename checkout (…/agentblip/packages/cli/dist) to this one", () => {
    const old = '"/opt/homebrew/bin/node" "/Users/you/Documents/agentblip/packages/cli/dist/index.js" hook claude-code';
    const hooks: Record<string, unknown> = {};
    for (const event of CLAUDE_HOOK_EVENTS) {
      hooks[event] = [{ hooks: [{ type: "command", command: old }, { type: "command", command: "other-tool" }] }];
    }
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));
    const result = installClaudeHooks(settingsPath);
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBe(`${settingsPath}.workmesh-backup`);
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    for (const event of CLAUDE_HOOK_EVENTS) {
      expect(after.hooks[event]).toHaveLength(1);
      expect(after.hooks[event]![0]!.hooks.map((h) => h.command)).toEqual([claudeHookCommand(), "other-tool"]);
    }
    expect(installClaudeHooks(settingsPath).changed).toBe(false);
  });

  it("backs up the original file exactly once", () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ model: "opus" }));
    const first = installClaudeHooks(settingsPath);
    expect(first.backupPath).toBe(`${settingsPath}.workmesh-backup`);
    expect(fs.readFileSync(first.backupPath ?? "", "utf8")).toBe(
      JSON.stringify({ model: "opus" }),
    );

    // remove one event so a second install writes again — backup must survive
    const settings = readSettings();
    delete settings.hooks.Stop;
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    installClaudeHooks(settingsPath);
    expect(fs.readFileSync(`${settingsPath}.workmesh-backup`, "utf8")).toBe(
      JSON.stringify({ model: "opus" }),
    );
  });

  it("reports not-installed for partial installs", () => {
    installClaudeHooks(settingsPath);
    const settings = readSettings();
    delete settings.hooks.SessionEnd;
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    expect(areClaudeHooksInstalled(settingsPath)).toBe(false);
  });
});

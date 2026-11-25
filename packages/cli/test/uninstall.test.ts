import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_HOOK_EVENTS, installClaudeHooks, removeClaudeHooks } from "../src/adapters/claude-code";
import { installCodexHooks, installCodexNotify, removeCodexHooks, removeCodexNotify } from "../src/adapters/codex";
import { removeOurHooks, writeBackup } from "../src/lib/hook-files";
import { runUninstall } from "../src/commands/uninstall";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-uninstall-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const other = { type: "command", command: "chat finish-check --quiet" };

describe("removeOurHooks", () => {
  it("drops only our hooks, and only the entries and events we emptied", () => {
    const ours = (c: unknown): boolean => typeof c === "string" && c.includes("workmesh");
    const hooks: Record<string, unknown> = {
      Stop: [{ hooks: [other] }, { hooks: [{ type: "command", command: "/x/workmesh hook" }] }],
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "/x/workmesh hook" }, other] }],
      SessionEnd: [{ hooks: [{ type: "command", command: "/x/workmesh hook" }] }],
      Empty: [],
      Odd: "not a list",
    };
    expect(removeOurHooks(hooks, ours)).toBe(3);
    expect(hooks).toEqual({
      Stop: [{ hooks: [other] }],
      PreToolUse: [{ matcher: "*", hooks: [other] }],
      Empty: [],
      Odd: "not a list",
    });
  });
});

describe("removeClaudeHooks", () => {
  it("undoes an install and keeps the person's own hooks and settings", () => {
    const settingsPath = path.join(dir, "settings.json");
    const original = { model: "opus", hooks: { Stop: [{ hooks: [other] }] } };
    fs.writeFileSync(settingsPath, JSON.stringify(original));
    installClaudeHooks(settingsPath);

    const result = removeClaudeHooks(settingsPath);
    expect(result.removed).toBe(CLAUDE_HOOK_EVENTS.length);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual(original);
    expect(result.backupPath && fs.readFileSync(result.backupPath, "utf8")).toContain("hook claude-code");

    // a second run finds nothing and writes nothing
    const before = fs.readFileSync(settingsPath, "utf8");
    expect(removeClaudeHooks(settingsPath)).toEqual({ removed: 0, settingsPath });
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
  });

  it("drops the hooks key it emptied, and leaves a missing file missing", () => {
    const settingsPath = path.join(dir, "settings.json");
    installClaudeHooks(settingsPath);
    removeClaudeHooks(settingsPath);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({});
    expect(removeClaudeHooks(path.join(dir, "none.json")).removed).toBe(0);
    expect(fs.existsSync(path.join(dir, "none.json"))).toBe(false);
  });
});

describe("Codex removal", () => {
  it("takes our hooks.json entries out and keeps other tools'", () => {
    const hooksPath = path.join(dir, "hooks.json");
    const existing = { hooks: { Stop: [{ hooks: [{ ...other, timeout: 5 }] }] } };
    fs.writeFileSync(hooksPath, JSON.stringify(existing));
    installCodexHooks(hooksPath);
    expect(removeCodexHooks(hooksPath).removed).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(hooksPath, "utf8"))).toEqual(existing);
  });

  it("removes our notify line and its comment, restoring config.toml", () => {
    for (const text of ["", 'model = "o3"\n', '[profiles.x]\nmodel = "o3"\n']) {
      const file = path.join(dir, "config.toml");
      fs.writeFileSync(file, text);
      expect(installCodexNotify(file)).toBe("installed");
      expect(removeCodexNotify(file)).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toBe(text);
    }
  });

  it("leaves another tool's notify alone", () => {
    const file = path.join(dir, "config.toml");
    const text = 'notify = ["/x/Client", "turn-ended"]\n';
    fs.writeFileSync(file, text);
    expect(removeCodexNotify(file)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(text);
  });
});

describe("writeBackup", () => {
  it("never overwrites an earlier backup", () => {
    const file = path.join(dir, "settings.json");
    const now = new Date("2026-11-25T10:30:00.123Z");
    const a = writeBackup(file, "one", now);
    const b = writeBackup(file, "two", now);
    expect(a).toBe(`${file}.workmesh-backup-20261125T103000123Z`);
    expect(b).not.toBe(a);
    expect(fs.readFileSync(a, "utf8")).toBe("one");
    expect(fs.readFileSync(b, "utf8")).toBe("two");
  });
});

describe("workmesh uninstall", () => {
  it("unhooks the chosen Claude dir and Codex, and --no-codex leaves Codex alone", async () => {
    const saved = { HOME: process.env.HOME };
    process.env.HOME = dir;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const clive = path.join(dir, ".clive", "settings.json");
      installClaudeHooks(clive);
      installCodexHooks(path.join(dir, ".codex", "hooks.json"));
      await runUninstall({ claudeDir: path.join(dir, ".clive"), codex: false });
      expect(fs.readFileSync(clive, "utf8")).not.toContain("hook claude-code");
      expect(fs.readFileSync(path.join(dir, ".codex", "hooks.json"), "utf8")).toContain("hook codex-hooks");

      await runUninstall({ claudeDir: path.join(dir, ".clive") });
      expect(fs.readFileSync(path.join(dir, ".codex", "hooks.json"), "utf8")).not.toContain("hook codex-hooks");
    } finally {
      log.mockRestore();
      process.env.HOME = saved.HOME;
    }
  });
});

describe("MCP removal", () => {
  it("takes our Claude Code server out of .claude.json and keeps the rest", async () => {
    const { installClaudeMcp, removeClaudeMcp } = await import("../src/adapters/mcp-install");
    const file = path.join(dir, ".claude.json");
    const original = { numStartups: 7, mcpServers: { other: { type: "stdio", command: "other" } } };
    fs.writeFileSync(file, JSON.stringify(original));
    installClaudeMcp({ file, claudeBin: null });
    expect(removeClaudeMcp(file).removed).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(original);
    expect(removeClaudeMcp(file).removed).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { workmesh: { type: "http", url: "https://someone.else/mcp" } } }));
    expect(removeClaudeMcp(file).removed).toBe(false); // not ours
  });

  it("takes our Codex table out of config.toml, restoring the file", async () => {
    const { installCodexMcp, removeCodexMcp } = await import("../src/adapters/mcp-install");
    const file = path.join(dir, "config.toml");
    for (const text of ["", 'model = "o3"\n', 'model = "o3"\n\n[mcp_servers.linear]\ncommand = "npx"\n']) {
      fs.writeFileSync(file, text);
      expect(installCodexMcp(file).result).toBe("installed");
      expect(removeCodexMcp(file).removed).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toBe(text);
    }
    fs.writeFileSync(file, '[mcp_servers.workmesh]\ncommand = "someone-else"\n');
    expect(removeCodexMcp(file).removed).toBe(false);
  });

  it("notify, MCP table and hooks all come out of one Codex config together", () => {
    const file = path.join(dir, "config.toml");
    const text = 'model = "o3"\n\n[profiles.fast]\nmodel = "x"\n';
    fs.writeFileSync(file, text);
    installCodexNotify(file);
    return import("../src/adapters/mcp-install").then(({ installCodexMcp, removeCodexMcp }) => {
      installCodexMcp(file);
      expect(removeCodexNotify(file)).toBe(true);
      expect(removeCodexMcp(file).removed).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toBe(text);
    });
  });
});

describe("claudeJsonPath", () => {
  it("is ~/.claude.json for the default profile and <dir>/.claude.json for another", async () => {
    const { claudeJsonPath } = await import("../src/adapters/mcp-install");
    expect(claudeJsonPath(path.join(os.homedir(), ".claude"))).toBe(path.join(os.homedir(), ".claude.json"));
    expect(claudeJsonPath(path.join(dir, ".clive"))).toBe(path.join(dir, ".clive", ".claude.json"));
  });

  it("follows Claude Code when CLAUDE_CONFIG_DIR is set, even to ~/.claude", async () => {
    const { claudeJsonPath } = await import("../src/adapters/mcp-install");
    const def = path.join(os.homedir(), ".claude");
    try {
      process.env.CLAUDE_CONFIG_DIR = def;
      expect(claudeJsonPath()).toBe(path.join(def, ".claude.json"));
      expect(claudeJsonPath(def)).toBe(path.join(def, ".claude.json"));
      process.env.CLAUDE_CONFIG_DIR = path.join(dir, ".clive");
      expect(claudeJsonPath()).toBe(path.join(dir, ".clive", ".claude.json"));
      // the default profile named by a flag while the variable points elsewhere: Claude Code run without it
      expect(claudeJsonPath(def)).toBe(path.join(os.homedir(), ".claude.json"));
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });
});

describe("workmesh uninstall and the daemon service", () => {
  it("removes the service setup installed, and --no-service keeps it", async () => {
    vi.resetModules();
    const uninstallService = vi.fn(() => true);
    vi.doMock("../src/lib/service", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/lib/service")>()),
      uninstallService,
    }));
    const saved = { HOME: process.env.HOME };
    process.env.HOME = dir;
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      const { runUninstall: run } = await import("../src/commands/uninstall");
      await run({ claudeDir: path.join(dir, ".clive"), codex: false });
      expect(uninstallService).toHaveBeenCalledTimes(1);
      expect(lines.join("\n")).toContain("daemon service: ");
      expect(lines.join("\n")).toContain("removed");

      lines.length = 0;
      await run({ claudeDir: path.join(dir, ".clive"), codex: false, service: false });
      expect(uninstallService).toHaveBeenCalledTimes(1);
      expect(lines.join("\n")).toContain("kept (--no-service)");
    } finally {
      log.mockRestore();
      process.env.HOME = saved.HOME;
      vi.doUnmock("../src/lib/service");
      vi.resetModules();
    }
  });
});

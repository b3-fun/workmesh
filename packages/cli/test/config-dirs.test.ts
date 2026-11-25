import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeHookCommand, claudeSettingsPath, staleClaudeHookNodes } from "../src/adapters/claude-code";
import { codexConfigPath, codexHooksPath, codexSessionsDir } from "../src/adapters/codex";
import { claudeProjectsDir } from "../src/adapters/workflow";
import { readLiveClaudeSessions } from "../src/daemon/claude-liveness";
import { versionManagedNode } from "../src/lib/hook-files";
import { claudeConfigDir, codexHome } from "../src/lib/paths";
import { codexDecision, installHooksOnly, nodePathWarning, resolveClaudeDir, sharingSummary } from "../src/commands/setup";

let home: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"] as const;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-dirs-"));
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    fn();
  } finally {
    log.mockRestore();
  }
  return lines.join("\n");
}

describe("config dirs", () => {
  it("default to ~/.claude and ~/.codex", () => {
    expect(claudeConfigDir()).toBe(path.join(home, ".claude"));
    expect(claudeSettingsPath()).toBe(path.join(home, ".claude", "settings.json"));
    expect(claudeProjectsDir()).toBe(path.join(home, ".claude", "projects"));
    expect(codexHome()).toBe(path.join(home, ".codex"));
    expect(codexConfigPath()).toBe(path.join(home, ".codex", "config.toml"));
  });

  it("follow CLAUDE_CONFIG_DIR for settings, projects and live sessions", () => {
    const clive = path.join(home, ".clive");
    process.env.CLAUDE_CONFIG_DIR = clive;
    expect(claudeSettingsPath()).toBe(path.join(clive, "settings.json"));
    expect(claudeProjectsDir()).toBe(path.join(clive, "projects"));
    fs.mkdirSync(path.join(clive, "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(clive, "sessions", `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: "s1", status: "busy" }),
    );
    expect(readLiveClaudeSessions()?.get("s1")?.status).toBe("busy");
  });

  it("follow CODEX_HOME for config.toml, hooks.json and sessions alike", () => {
    process.env.CODEX_HOME = path.join(home, "codex-home");
    expect(codexConfigPath()).toBe(path.join(home, "codex-home", "config.toml"));
    expect(codexHooksPath()).toBe(path.join(home, "codex-home", "hooks.json"));
    expect(codexSessionsDir()).toBe(path.join(home, "codex-home", "sessions"));
  });

  it("--claude-dir beats the env var and expands ~", () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(home, ".other");
    expect(resolveClaudeDir("~/.clive")).toBe(path.join(home, ".clive"));
    expect(resolveClaudeDir()).toBe(path.join(home, ".other"));
  });
});

describe("setup --hooks-only", () => {
  it("hooks the --claude-dir profile only and leaves ~/.claude and an undetected Codex alone", () => {
    const out = captureLog(() => installHooksOnly({ claudeDir: path.join(home, ".clive") }));
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".clive", "settings.json"), "utf8")) as {
      hooks: Record<string, unknown>;
    };
    expect(Object.keys(settings.hooks)).toContain("PreToolUse");
    expect(fs.existsSync(path.join(home, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
    expect(out).toContain(path.join(home, ".clive", "settings.json"));
    expect(out).toMatch(/codex: no Codex install found .*--codex/);
  });

  it("hooks the CLAUDE_CONFIG_DIR profile when no flag is given", () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(home, ".clive");
    captureLog(() => installHooksOnly({ codex: false }));
    expect(fs.existsSync(path.join(home, ".clive", "settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude"))).toBe(false);
  });

  it("--no-codex skips a detected Codex; --codex installs one that wasn't found", () => {
    fs.mkdirSync(path.join(home, ".codex"));
    const skipped = captureLog(() => installHooksOnly({ codex: false }));
    expect(skipped).toContain("skipped (--no-codex)");
    expect(fs.readdirSync(path.join(home, ".codex"))).toEqual([]);

    const found = captureLog(() => installHooksOnly({}));
    expect(found).toMatch(/found .*\.codex, installing there \(pass --no-codex/);
    expect(fs.existsSync(path.join(home, ".codex", "hooks.json"))).toBe(true);

    process.env.CODEX_HOME = path.join(home, "elsewhere");
    expect(codexDecision(undefined).install).toBe(true); // CODEX_HOME set counts as an install
    delete process.env.CODEX_HOME;
    fs.rmSync(path.join(home, ".codex"), { recursive: true });
    expect(codexDecision(undefined).install).toBe(false);
    captureLog(() => installHooksOnly({ codex: true }));
    expect(fs.existsSync(path.join(home, ".codex", "hooks.json"))).toBe(true);
  });

  it("prints the sharing level, and how to choose metadata before connecting", () => {
    const out = captureLog(() => installHooksOnly({ codex: false }));
    expect(out).toContain("shares conversation by default");
    expect(out).toContain("--share metadata");
  });
});

describe("sharingSummary", () => {
  const hub = { project: { name: "B3" } } as never;
  it("names the active level and the switch", () => {
    expect(sharingSummary({ hub: { ...(hub as object), share: "conversation" } as never })).toBe(
      "hub: sharing conversation with B3; switch with `workmesh hub share metadata`",
    );
    expect(sharingSummary({ hub: { ...(hub as object), share: "metadata" } as never })).toContain(
      "workmesh hub share conversation",
    );
    // absent share reads as the default, conversation
    expect(sharingSummary({ hub })).toContain("sharing conversation");
  });
});

describe("pinned Node path", () => {
  it("spots version managers", () => {
    expect(versionManagedNode("/home/me/.local/share/nvm/v26.13.0/bin/node")).toBe(true);
    expect(versionManagedNode("/home/me/.nvm/versions/node/v22.1.0/bin/node")).toBe(true);
    expect(versionManagedNode("/Users/me/.volta/tools/image/node/22.0.0/bin/node")).toBe(true);
    expect(versionManagedNode("/home/me/.local/share/fnm/node-versions/v22/installation/bin/node")).toBe(true);
    expect(versionManagedNode("/usr/bin/node")).toBe(false);
    expect(versionManagedNode("/opt/homebrew/bin/node")).toBe(false);
    expect(nodePathWarning("/usr/local/bin/node")).toBeUndefined();
    expect(nodePathWarning("/home/me/.nvm/versions/node/v22.1.0/bin/node")).toContain("setup --hooks-only");
  });

  it("finds hooks whose Node binary is gone", () => {
    const settingsPath = path.join(home, "settings.json");
    const gone = path.join(home, "nvm", "v1", "bin", "node");
    const stale = claudeHookCommand().replace(/^"[^"]+"/, `"${gone}"`);
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: stale }, { type: "command", command: '"/nope/node" other-tool' }] }],
          PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: claudeHookCommand() }] }],
        },
      }),
    );
    expect(staleClaudeHookNodes(settingsPath)).toEqual([gone]);
    expect(staleClaudeHookNodes(path.join(home, "missing.json"))).toEqual([]);
  });
});

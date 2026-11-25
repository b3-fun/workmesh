import fs from "node:fs";
import { claudeSettingsPath, removeClaudeHooks } from "../adapters/claude-code";
import { codexConfigPath, removeCodexHooks, removeCodexNotify } from "../adapters/codex";
import { claudeJsonPath, removeClaudeMcp, removeCodexMcp } from "../adapters/mcp-install";
import { uninstallService } from "../lib/service";
import { bold, dim, errorMessage, green, red } from "../lib/ui";
import { resolveClaudeDir } from "./setup";

export interface UninstallOptions {
  /** Claude Code config dir to unhook (default $CLAUDE_CONFIG_DIR, else ~/.claude). */
  claudeDir?: string;
  /** `--no-codex` leaves Codex's files alone; otherwise our entries come out of them when present. */
  codex?: boolean;
  /** `--no-service` keeps the daemon service (launchd / systemd) that setup installed; otherwise it is removed. */
  service?: boolean;
}

/**
 * `workmesh uninstall`: takes Workmesh's hooks and MCP server out of Claude Code
 * (settings.json, .claude.json) and Codex (hooks.json, config.toml), and removes the daemon service setup installed
 * (only Workmesh's own launchd job or systemd unit; it stops the daemon it ran). Every other hook, server and setting
 * stays; each file it changes is backed up first. Config and hub pairing are left for `workmesh hub disconnect` and
 * `workmesh unlink`. Left in place, the service would start the daemon again at the next login, and would restart it
 * every few seconds once the package is gone.
 */
export function runUninstall(opts: UninstallOptions = {}): Promise<void> {
  console.log(bold("workmesh uninstall"));
  const claudeDir = resolveClaudeDir(opts.claudeDir);
  const settingsPath = claudeSettingsPath(claudeDir);
  try {
    const result = removeClaudeHooks(settingsPath);
    console.log(
      result.removed > 0
        ? `  claude code: ${green(`removed ${result.removed} hook(s) from ${settingsPath}`)}${dim(` (backup: ${result.backupPath})`)}`
        : `  claude code: ${dim(`no Workmesh hooks in ${settingsPath}`)}`,
    );
  } catch (err) {
    console.log(`  claude code: ${red(`could not update ${settingsPath}: ${errorMessage(err)}`)}`);
  }
  try {
    const mcp = removeClaudeMcp(claudeJsonPath(claudeDir));
    console.log(
      mcp.removed
        ? `  claude code mcp: ${green(`removed from ${mcp.path}`)}${dim(` (backup: ${mcp.backupPath})`)}`
        : `  claude code mcp: ${dim(`no Workmesh server in ${mcp.path}`)}`,
    );
  } catch (err) {
    console.log(`  claude code mcp: ${red(`could not update .claude.json: ${errorMessage(err)}`)}`);
  }

  if (opts.codex === false) {
    console.log(`  codex: ${dim("skipped (--no-codex)")}`);
  } else {
    try {
      const result = removeCodexHooks();
      console.log(
        result.removed > 0
          ? `  codex: ${green(`removed ${result.removed} hook(s) from ${result.hooksPath}`)}${dim(` (backup: ${result.backupPath})`)}`
          : `  codex: ${dim(`no Workmesh hooks in ${result.hooksPath}`)}`,
      );
    } catch (err) {
      console.log(`  codex: ${red(`could not update hooks.json: ${errorMessage(err)}`)}`);
    }
    try {
      const file = codexConfigPath();
      const changed = removeCodexNotify(file);
      console.log(
        changed
          ? `  codex notify: ${green(`removed from ${file}`)}`
          : `  codex notify: ${dim(fs.existsSync(file) ? `not ours or not set in ${file}` : `no ${file}`)}`,
      );
    } catch (err) {
      console.log(`  codex notify: ${red(`could not update config.toml: ${errorMessage(err)}`)}`);
    }
    try {
      const mcp = removeCodexMcp();
      console.log(`  codex mcp: ${mcp.removed ? green(`removed from ${mcp.path}`) : dim(`no Workmesh server in ${mcp.path}`)}`);
    } catch (err) {
      console.log(`  codex mcp: ${red(`could not update config.toml: ${errorMessage(err)}`)}`);
    }
  }
  if (opts.service === false) {
    console.log(`  daemon service: ${dim("kept (--no-service)")}`);
  } else {
    try {
      console.log(
        uninstallService()
          ? `  daemon service: ${green("removed (the daemon it ran is stopped)")}`
          : `  daemon service: ${dim("none installed")}`,
      );
    } catch (err) {
      console.log(`  daemon service: ${red(`could not remove: ${errorMessage(err)}`)}`);
    }
  }
  console.log("\nstill on this machine:");
  console.log(`  ${bold("workmesh stop")}             stop a daemon running outside the service (clears your Slack status)`);
  console.log(`  ${bold("workmesh hub disconnect")}   remove the hub token`);
  console.log(`  ${bold("workmesh unlink")}           revoke the Slack relay device`);
  return Promise.resolve();
}

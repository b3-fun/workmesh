import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pkg from "../../package.json";
import {
  claudeSettingsPath,
  hasAnyClaudeHook,
  installClaudeHooks,
  isClaudeWakeInstalled,
  staleClaudeHookNodes,
} from "../adapters/claude-code";
import { hasAnyCodexHook, installCodexHooks, installCodexNotify, isCodexNotifyInstalled } from "../adapters/codex";
import { claudeJsonPath, installClaudeMcp, installCodexMcp, isClaudeMcpInstalled, isCodexMcpInstalled } from "../adapters/mcp-install";
import { autoUpdateSettings, loadConfig, loadConfigSafe, saveConfig } from "../lib/config";
import type { Config } from "../lib/config";
import { getHealth, getUpdateStatus, isDaemonUp, startDaemonInBackground } from "../lib/daemon-client";
import { stopDaemon } from "../lib/daemon-control";
import { PACKAGE_NAME, detectInstall, installCommand, managerBin, tildify } from "../lib/install-method";
import type { InstallInfo } from "../lib/install-method";
import { claudeConfigDir, configPath, stateDir, updateBackupDir } from "../lib/paths";
import { isProcessAlive, readPidFile } from "../lib/pidfile";
import { fetchRegistryInfo, npmRegistry } from "../lib/registry";
import type { RegistryInfo } from "../lib/registry";
import { cliEntry, installService, serviceKind, serviceStatus } from "../lib/service";
import { markSetup, readUpdateState, writeUpdateState } from "../lib/update-state";
import type { LastUpdate } from "../lib/update-state";
import { compareVersions, isNewer, parseVersion, withinScope } from "../lib/versions";
import { bold, dim, errorMessage, green, red, sleep, yellow } from "../lib/ui";

/**
 * `workmesh update` (SPEC §41): one command keeps a machine current, so a release no longer needs a message to every
 * teammate. It finds how Workmesh was installed, installs the newest release the same way, has the NEW version re-run
 * the setup steps that changed (hooks, MCP registration, service definition) and restart the daemon, and rolls back to
 * the previous version when the new one fails the core checks. It prints each step. Run again, it changes nothing that
 * is already current. A git checkout, a project dependency or npx is left alone: it says what to do instead.
 */

export interface UpdateOptions {
  /** Report only: what's installed, what's out, whether setup is pending. */
  check?: boolean;
  json?: boolean;
  /** A specific version instead of `latest`. */
  to?: string;
  /** `on` / `off`: the daemon installs releases on its own, daily. */
  auto?: string;
  /** With `--auto on`: minor releases too (default: patch releases only). */
  minor?: boolean;
  /** Started by the daemon (auto-update): only within the person's scope. */
  autoRun?: boolean;
  /** Internal: run by the newly installed version to finish its setup (exit 2 when its checks fail). */
  finish?: boolean;
  /** Internal, with --finish: the version this update came from. */
  from?: string;
}

/** Exit codes: 0 done (or nothing to do), 1 failed (rolled back when it got that far), 3 can't update this install. */
export const EXIT_FAILED = 1;
export const EXIT_CHECKS_FAILED = 2;
export const EXIT_CANT_UPDATE = 3;

/** What the finishing steps did and found. */
export interface FinishResult {
  ok: boolean;
  /** One line per step. */
  steps: string[];
  /** Core checks that failed. */
  failures: string[];
}

export interface UpdateDeps {
  current?: string;
  entry?: string;
  detect?: (entry: string) => InstallInfo;
  registry?: (info: InstallInfo) => Promise<RegistryInfo>;
  /** Runs the package manager; resolves to its exit code. */
  install?: (info: InstallInfo, spec: string) => Promise<number>;
  /** The version now installed at the package dir (re-read after the install). */
  installedVersion?: (info: InstallInfo) => string | undefined;
  /** Runs the NEW version's `update --finish`; resolves to its exit code. */
  runNewFinish?: (from: string) => number;
  /** This (old or current) version's finishing steps, in process. */
  finish?: (version: string) => Promise<FinishResult>;
  backup?: (info: InstallInfo, version: string) => string | undefined;
  restore?: (info: InstallInfo, version: string, backup: string | undefined) => Promise<boolean>;
  /** The running daemon's version, if one answers. */
  daemonVersion?: () => Promise<string | undefined>;
  now?: () => number;
  out?: (line: string) => void;
}

const lockPath = () => path.join(stateDir(), "update.lock");

/** One update at a time on a machine: a lock file naming the pid (a dead one's lock is taken over). */
function takeLock(): boolean {
  const file = lockPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const held = readPidFile(file);
  if (held !== undefined && held !== process.pid && isProcessAlive(held)) return false;
  fs.writeFileSync(file, `${process.pid}\n`, { mode: 0o600 });
  return true;
}

function releaseLock(): void {
  if (readPidFile(lockPath()) === process.pid) fs.rmSync(lockPath(), { force: true });
}

/** A child's output, indented under the step that runs it. */
function pipeLines(stream: NodeJS.ReadableStream | null, out: (line: string) => void): void {
  if (!stream) return;
  let buf = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r/g, "").replace(/\x1b\[[0-9;]*m/g, "");
      buf = buf.slice(i + 1);
      if (line.trim()) out(dim(`    ${line}`));
    }
  });
  stream.on("end", () => {
    if (buf.trim()) out(dim(`    ${buf.trim()}`));
  });
}

/** PATH with this Node's directory first, so a package manager's `#!/usr/bin/env node` finds it (menu bar, launchd). */
function childEnv(): NodeJS.ProcessEnv {
  const dir = path.dirname(process.execPath);
  const parts = (process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(path.delimiter).filter((p) => p && p !== dir);
  return { ...process.env, PATH: [dir, ...parts].join(path.delimiter), NO_COLOR: "1", npm_config_update_notifier: "false" };
}

async function defaultInstall(info: InstallInfo, spec: string, out: (line: string) => void): Promise<number> {
  const c = installCommand(info, spec);
  if (!c) return 1;
  out(dim(`  $ ${[path.basename(c.cmd), ...c.args].join(" ")}`));
  return new Promise((resolve) => {
    const child = spawn(c.cmd, c.args, { stdio: ["ignore", "pipe", "pipe"], env: childEnv() });
    pipeLines(child.stdout, out);
    pipeLines(child.stderr, out);
    const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
    child.on("error", (err) => {
      out(red(`    ${errorMessage(err)}`));
      clearTimeout(timer);
      resolve(127);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

function readInstalledVersion(info: InstallInfo): string | undefined {
  if (!info.packageDir) return undefined;
  try {
    const v = (JSON.parse(fs.readFileSync(path.join(info.packageDir, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** npm: a copy of the installed package, kept until the new version passes its checks (offline, exact rollback). */
function defaultBackup(info: InstallInfo, version: string): string | undefined {
  if (info.method !== "npm" || !info.packageDir) return undefined;
  const dest = path.join(updateBackupDir(), version);
  fs.rmSync(updateBackupDir(), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.cpSync(info.packageDir, dest, { recursive: true, verbatimSymlinks: true });
  return dest;
}

/** Puts `version` back: the npm copy when there is one, else the package manager installs it again. */
async function defaultRestore(info: InstallInfo, version: string, backup: string | undefined, out: (line: string) => void): Promise<boolean> {
  if (backup && info.packageDir && fs.existsSync(path.join(backup, "package.json"))) {
    const aside = `${info.packageDir}.failed-${Date.now()}`;
    try {
      if (fs.existsSync(info.packageDir)) fs.renameSync(info.packageDir, aside);
      fs.cpSync(backup, info.packageDir, { recursive: true, verbatimSymlinks: true });
      fs.rmSync(aside, { recursive: true, force: true });
      out(dim(`  restored ${version} from ${tildify(backup)}`));
      return readInstalledVersion(info) === version;
    } catch (err) {
      out(red(`  couldn't restore the copy: ${errorMessage(err)}`));
      if (!fs.existsSync(info.packageDir) && fs.existsSync(aside)) fs.renameSync(aside, info.packageDir);
    }
  }
  const code = await defaultInstall(info, `${PACKAGE_NAME}@${version}`, out);
  return code === 0 && (info.packageDir ? readInstalledVersion(info) === version : true);
}

/** The new version's own `update --finish`, so its setup code (which knows its hooks and tools) runs. */
function defaultRunNewFinish(entry: string, from: string): number {
  const r = spawnSync(process.execPath, [entry, "update", "--finish", "--from", from], { stdio: "inherit", env: { ...process.env, ...(process.stdout.isTTY ? {} : { NO_COLOR: "1" }) }, timeout: 5 * 60_000 });
  return r.status ?? EXIT_FAILED;
}

async function runningDaemonVersion(config: Config): Promise<string | undefined> {
  try {
    return (await getHealth(config.port)).version ?? "an older version";
  } catch {
    return undefined;
  }
}

/** Waits for the daemon to answer on `version`. */
async function waitForDaemonVersion(port: number, version: string, timeoutMs: number): Promise<string | undefined> {
  const until = Date.now() + timeoutMs;
  let seen: string | undefined;
  while (Date.now() < until) {
    try {
      seen = (await getHealth(port)).version ?? "an older version";
      if (seen === version) return seen;
    } catch {
      seen = undefined;
    }
    await sleep(300);
  }
  return seen;
}

/**
 * The setup steps a version re-runs on a machine it was just installed on, keeping what the person chose: hooks only
 * where Workmesh's hooks are installed (the wake hook only if it was), MCP only where it was registered, the service
 * only if it is installed. Then the daemon restarts on this version and the core checks run.
 */
export async function finishSetup(version: string, out: (line: string) => void = console.log): Promise<FinishResult> {
  const steps: string[] = [];
  const failures: string[] = [];
  const say = (line: string) => {
    steps.push(line);
    out(`  ${line}`);
  };
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    failures.push(`config: ${errorMessage(err)}`);
    config = loadConfigSafe();
  }
  const claudeDir = config.adapters.claudeCode.configDir ?? claudeConfigDir();
  const settingsPath = claudeSettingsPath(claudeDir);
  const hadClaudeHooks = hasAnyClaudeHook(settingsPath);
  if (hadClaudeHooks) {
    try {
      const r = installClaudeHooks(settingsPath, { wake: isClaudeWakeInstalled(settingsPath) });
      say(`claude code hooks: ${r.changed ? green(`updated in ${tildify(settingsPath)}`) : dim("current")}`);
    } catch (err) {
      failures.push(`claude code hooks: ${errorMessage(err)}`);
    }
  }
  const claudeJson = claudeJsonPath(claudeDir);
  const hadClaudeMcp = isClaudeMcpInstalled(claudeJson);
  if (hadClaudeMcp) {
    try {
      const r = installClaudeMcp({ file: claudeJson, claudeBin: null });
      say(`claude code mcp: ${r.result === "already-installed" ? dim("current") : r.result === "manual" ? yellow(r.detail ?? "left as is") : green("repointed")}`);
    } catch (err) {
      failures.push(`claude code mcp: ${errorMessage(err)}`);
    }
  }
  if (hasAnyCodexHook()) {
    try {
      const r = installCodexHooks();
      say(`codex hooks: ${r.changed ? green("updated (trust the new ones in Codex with /hooks)") : dim("current")}`);
      if (isCodexNotifyInstalled()) installCodexNotify();
    } catch (err) {
      failures.push(`codex hooks: ${errorMessage(err)}`);
    }
  }
  const hadCodexMcp = isCodexMcpInstalled();
  if (hadCodexMcp) {
    try {
      const r = installCodexMcp();
      say(`codex mcp: ${r.result === "already-installed" ? dim("current") : r.result === "manual" ? yellow(r.detail ?? "left as is") : green("repointed")}`);
    } catch (err) {
      failures.push(`codex mcp: ${errorMessage(err)}`);
    }
  }

  // The daemon: stopped cleanly (it saves its hub state), then started on this version, by its service when it has one.
  const wasUp = await isDaemonUp(config.port);
  const svc = serviceKind() ? serviceStatus() : undefined;
  const expectDaemon = wasUp || Boolean(svc?.installed);
  if (expectDaemon) {
    const stopped = await stopDaemon();
    if (stopped.kind === "stuck") failures.push(`daemon: pid ${stopped.pid} won't exit`);
    let how = "restarted";
    if (svc?.installed) {
      try {
        const r = installService();
        how = r.wrote ? `restarted under ${r.kind} (service definition updated)` : `restarted under ${r.kind}`;
      } catch (err) {
        failures.push(`daemon service: ${errorMessage(err)}`);
        if (!(await startDaemonInBackground(config))) failures.push("daemon: didn't start");
        how = "restarted in the background (the service didn't take it)";
      }
    } else if (!(await startDaemonInBackground(config))) {
      failures.push("daemon: didn't start");
    }
    const seen = await waitForDaemonVersion(config.port, version, 20_000);
    if (seen === version) say(`daemon: ${green(`${how}, running ${version}`)}`);
    else failures.push(seen ? `daemon: answers as ${seen}, not ${version}` : `daemon: not answering on 127.0.0.1:${config.port} after the restart`);
  } else {
    say(`daemon: ${dim("not running; hooks start it on the next agent event")}`);
  }

  // Core checks (doctor's local ones): nothing here depends on the network.
  if (hadClaudeHooks) {
    const stale = staleClaudeHookNodes(settingsPath);
    if (!hasAnyClaudeHook(settingsPath)) failures.push(`claude code hooks: missing from ${settingsPath}`);
    else if (stale.length) failures.push(`claude code hooks: run ${stale.join(", ")}, which no longer exists`);
  }
  if (hadClaudeMcp && !isClaudeMcpInstalled(claudeJson)) failures.push(`claude code mcp: no longer registered in ${claudeJson}`);
  if (hadCodexMcp && !isCodexMcpInstalled()) failures.push("codex mcp: no longer registered");
  const smoke = spawnSync(process.execPath, [cliEntry(), "--version"], { encoding: "utf8", timeout: 15_000 });
  if (smoke.status !== 0 || smoke.stdout.trim() !== version) failures.push(`cli: \`workmesh --version\` printed ${JSON.stringify(smoke.stdout.trim() || smoke.stderr.trim().slice(0, 120))}`);

  const ok = failures.length === 0;
  if (ok) markSetup(version);
  for (const f of failures) out(`  ${red("✗")} ${f}`);
  return { ok, steps, failures };
}

function installWhere(info: InstallInfo): string {
  switch (info.method) {
    case "npm":
      return `npm, global${info.prefix ? ` (${tildify(info.prefix)})` : ""}`;
    case "git":
      return `git checkout (${tildify(info.gitRoot ?? info.entry)})`;
    case "local":
      return "a project dependency";
    case "unknown":
      return `unknown (${tildify(info.entry)})`;
    default:
      return `${info.method}, global`;
  }
}

/** `workmesh update --auto on|off [--minor]`. */
function setAuto(value: string, minor: boolean | undefined, out: (line: string) => void): void {
  const v = value.trim().toLowerCase();
  if (v !== "on" && v !== "off") throw new Error(`--auto takes on or off, not ${value}`);
  const config = loadConfig();
  const scope = minor ? "minor" : (config.update?.scope ?? "patch");
  config.update = v === "on" ? { auto: true, scope: minor === undefined ? scope : minor ? "minor" : "patch" } : { ...config.update, auto: false };
  saveConfig(config);
  const s = autoUpdateSettings(config);
  out(
    s.enabled
      ? `${green("auto-update on")}: the daemon installs ${s.scope === "patch" ? "patch releases (0.12.0 → 0.12.1)" : "patch and minor releases (0.12 → 0.13)"} on its own, at most once a day ${dim(`(${configPath()})`)}`
      : `${green("auto-update off")}: \`workmesh update\` when you want one`,
  );
}

export async function runUpdate(opts: UpdateOptions = {}, deps: UpdateDeps = {}): Promise<void> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const current = deps.current ?? pkg.version;
  if (opts.auto !== undefined) {
    setAuto(opts.auto, opts.minor, out);
    return;
  }
  if (opts.finish) {
    out(bold(`finishing ${current}`) + (opts.from ? dim(` (from ${opts.from})`) : ""));
    const r = await (deps.finish ?? ((v) => finishSetup(v, out)))(current);
    if (!r.ok) process.exitCode = EXIT_CHECKS_FAILED;
    return;
  }

  const entry = deps.entry ?? cliEntry();
  const info = (deps.detect ?? ((e) => detectInstall(e)))(entry);
  const config = loadConfigSafe();
  const daemonVersion = await (deps.daemonVersion ?? (() => runningDaemonVersion(config)))();
  const state = readUpdateState();
  const pending = state.setup !== current || (daemonVersion !== undefined && daemonVersion !== current);

  let reg: RegistryInfo | undefined;
  let regError: string | undefined;
  if (info.canUpdate || opts.check) {
    try {
      reg = await (deps.registry ?? (async () => fetchRegistryInfo(await npmRegistry(managerBin("npm")))))(info);
    } catch (err) {
      regError = errorMessage(err);
    }
  }
  const target = opts.to ?? reg?.latest;

  if (opts.check) {
    const report = {
      current,
      latest: reg?.latest,
      available: isNewer(reg?.latest, current),
      install: { method: info.method, canUpdate: info.canUpdate, ...(info.hint ? { hint: info.hint } : {}) },
      daemon: daemonVersion,
      setupPending: pending,
      ...(state.last ? { last: state.last } : {}),
      ...(regError ? { error: regError } : {}),
    };
    if (opts.json) {
      out(JSON.stringify(report, null, 2));
      return;
    }
    out(`Workmesh ${current} ${dim(`(${installWhere(info)})`)}`);
    if (regError) out(yellow(`  couldn't read the registry: ${regError}`));
    else if (report.available) out(`  ${bold(`${reg!.latest} available`)}: ${info.canUpdate ? "`workmesh update`" : (info.hint ?? "")}`);
    else out(`  ${green("up to date")}${reg ? dim(` (latest is ${reg.latest})`) : ""}`);
    if (daemonVersion && daemonVersion !== current) out(yellow(`  the daemon still runs ${daemonVersion}: \`workmesh update\` restarts it on ${current}`));
    else if (pending && info.canUpdate && !report.available) out(yellow(`  setup for ${current} hasn't run on this machine: \`workmesh update\``));
    return;
  }

  out(bold("workmesh update"));
  out(`  installed: ${current} ${dim(`(${installWhere(info)})`)}`);
  if (!info.canUpdate) {
    out(`  ${yellow(info.hint ?? "this install can't be updated by Workmesh")}`);
    process.exitCode = EXIT_CANT_UPDATE;
    return;
  }
  if (!reg || !target) {
    out(red(`  couldn't read the npm registry: ${regError ?? "no version"}`));
    process.exitCode = EXIT_FAILED;
    return;
  }
  if (opts.to) {
    if (!parseVersion(opts.to)) throw new Error(`--to takes a version like 0.12.1, not ${opts.to}`);
    if (!reg.versions.includes(opts.to)) throw new Error(`${PACKAGE_NAME}@${opts.to} isn't on the registry`);
    if (compareVersions(opts.to, "0.12.0") < 0) throw new Error("versions before 0.12.0 can't finish an update; install one with npm directly");
  }
  out(`  latest:    ${reg.latest}${opts.to ? dim(`; installing ${opts.to} as asked`) : ""}`);

  if (opts.autoRun) {
    const s = autoUpdateSettings(config);
    if (!s.enabled || !withinScope(current, target, s.scope)) {
      out(dim(`  auto-update ${s.enabled ? `takes ${s.scope} releases only` : "is off"}: nothing to do`));
      return;
    }
  }

  if (!takeLock()) {
    out(yellow("  another `workmesh update` is running on this machine; try again when it's done"));
    process.exitCode = EXIT_FAILED;
    return;
  }
  try {
    if (target === current || (!opts.to && !isNewer(target, current))) {
      if (!pending) {
        out(green(`Workmesh ${current} is up to date.`));
        return;
      }
      out(`  ${current} is the latest; finishing its setup on this machine`);
      const r = await (deps.finish ?? ((v) => finishSetup(v, out)))(current);
      out(r.ok ? green(`Workmesh ${current} is set up and running.`) : red(`Workmesh ${current}: ${r.failures.length} check(s) failed (above). \`workmesh doctor\` says more.`));
      if (!r.ok) process.exitCode = EXIT_FAILED;
      return;
    }

    const now = deps.now ?? Date.now;
    const record = (last: Omit<LastUpdate, "at" | "from" | "to">) =>
      writeUpdateState({ last: { at: now(), from: current, to: target, ...last, ...(opts.autoRun ? { auto: true } : {}) } });

    // 1. Keep the running version, so a failed update can go back to it.
    let backup: string | undefined;
    try {
      backup = (deps.backup ?? defaultBackup)(info, current);
      if (backup) out(dim(`  kept a copy of ${current} in ${tildify(backup)}`));
    } catch (err) {
      out(yellow(`  couldn't keep a copy of ${current} (${errorMessage(err)}); a rollback reinstalls it from the registry`));
    }
    record({ ok: false, message: `installing ${target}` });

    // 2. Install the new version the way this one was installed.
    out(bold(`\ninstalling ${target}`));
    const code = await (deps.install ?? ((i, spec) => defaultInstall(i, spec, out)))(info, `${PACKAGE_NAME}@${target}`);
    const installed = (deps.installedVersion ?? readInstalledVersion)(info);
    if (code !== 0 || (installed !== undefined && installed !== target)) {
      out(red(`  the install failed (${code !== 0 ? `exit ${code}` : `found ${installed}, wanted ${target}`})`));
      if (installed !== undefined && installed !== current) {
        out(`  putting ${current} back`);
        await (deps.restore ?? ((i, v, b) => defaultRestore(i, v, b, out)))(info, current, backup);
      }
      record({ ok: false, message: `the install of ${target} failed; ${current} stays` });
      out(red(`Workmesh stays on ${current}.`));
      process.exitCode = EXIT_FAILED;
      return;
    }

    // 3. The new version finishes its own setup and runs its checks.
    out(bold(`\nsetting up ${target}`));
    const finishCode = (deps.runNewFinish ?? ((from) => defaultRunNewFinish(info.entry, from)))(current);
    if (finishCode === 0) {
      record({ ok: true, message: `updated ${current} → ${target}` });
      out("");
      out(green(`Workmesh ${target} is installed and running.`));
      out(dim(`  agent sessions started before now keep ${current}'s Workmesh tools until they restart; each is told once`));
      return;
    }

    // 4. Rollback: the previous version back, its own setup, its daemon.
    out(red(`\n${target} failed its checks: rolling back to ${current}`));
    const restored = await (deps.restore ?? ((i, v, b) => defaultRestore(i, v, b, out)))(info, current, backup);
    const back = await (deps.finish ?? ((v) => finishSetup(v, out)))(current);
    const message = restored && back.ok ? `${target} failed its checks; rolled back to ${current}` : `${target} failed its checks; the rollback to ${current} ${restored ? "left failing checks" : "failed"}`;
    record({ ok: false, rolledBack: restored, message });
    out(restored && back.ok ? yellow(`Rolled back: Workmesh ${current} is running again.`) : red(`${message}. \`workmesh doctor\` says what's wrong; \`npm i -g ${PACKAGE_NAME}@${current}\` reinstalls it.`));
    process.exitCode = EXIT_FAILED;
  } finally {
    releaseLock();
  }
}

/** For `status` and `doctor`: "0.12.1 available: `workmesh update`", from the daemon's check, when there is one. */
export async function updateNotice(port: number): Promise<{ text: string; latest: string } | undefined> {
  try {
    const u = await getUpdateStatus(port);
    if (!u.available || !u.latest) return undefined;
    return { latest: u.latest, text: `${u.latest} available: \`workmesh update\`` };
  } catch {
    return undefined;
  }
}

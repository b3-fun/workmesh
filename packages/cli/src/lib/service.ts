import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The daemon as an OS service (SPEC §24): launchd on macOS, a systemd --user
 * unit on Linux. A crash or kill brings it back within seconds, a login or
 * reboot starts it, and `workmesh stop` (a clean exit) leaves it stopped until
 * the next start, hook or login. Hooks still start a daemon when none answers
 * (they ask the service to, when it is installed).
 */

export const LAUNCHD_LABEL = "org.npclabs.workmesh.daemon";
export const SYSTEMD_UNIT = "workmesh.service";
/** Set in the service's environment so the daemon knows it runs under the service manager. */
export const SERVICE_ENV = "WORKMESH_SERVICE";

export type ServiceKind = "launchd" | "systemd";

export interface ServiceStatus {
  kind: ServiceKind | null;
  /** The plist or unit file exists. */
  installed: boolean;
  /** The service manager has it loaded. */
  loaded: boolean;
  /** Its running process, when the manager reports one. */
  pid?: number;
  file?: string;
  /** What the file runs: `[node, entry]`. */
  program?: string[];
}

/** Runs a service-manager command; injected in tests. Throws on a non-zero exit. */
export type Runner = (cmd: string, args: string[]) => string;

const defaultRunner: Runner = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });

/** `WORKMESH_NO_SERVICE=1` turns the service off (tests; a machine that manages the daemon its own way). */
export function serviceKind(platform: NodeJS.Platform = process.platform): ServiceKind | null {
  if (process.env.WORKMESH_NO_SERVICE === "1" && platform === process.platform) return null;
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return null;
}

export function launchAgentPath(home = os.homedir()): string {
  return path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function serviceLogPath(home = os.homedir()): string {
  return path.join(home, "Library", "Logs", "workmesh-daemon.log");
}

export function systemdUnitPath(home = os.homedir()): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "systemd", "user", SYSTEMD_UNIT);
}

/**
 * The node binary a service should run: the one on PATH when it is the same
 * program as this process (Homebrew's /opt/homebrew/bin/node survives upgrades;
 * its Cellar path doesn't), else this process's own.
 */
export function stableNodePath(execPath = process.execPath, pathEnv = process.env.PATH ?? ""): string {
  let real: string;
  try {
    real = fs.realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "node");
    try {
      if (fs.realpathSync(candidate) === real) return candidate;
    } catch {
      // not here
    }
  }
  return execPath;
}

/** The CLI entry this process runs (dist/index.js in a build). */
export function cliEntry(): string {
  return fileURLToPath(import.meta.url);
}

/** Environment the service carries over: a sane PATH (for `gh`) and the directories Workmesh reads. */
export function serviceEnv(node: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const dirs = [path.dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const out: Record<string, string> = { PATH: [...new Set(dirs)].join(":"), [SERVICE_ENV]: "1" };
  for (const k of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "WORKMESH_CONFIG"]) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderPlist(opts: { node: string; entry: string; env: Record<string, string>; log: string }): string {
  const env = Object.entries(opts.env)
    .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(opts.node)}</string>
    <string>${xml(opts.entry)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(opts.log)}</string>
  <key>StandardErrorPath</key><string>${xml(opts.log)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(opts: { node: string; entry: string; env: Record<string, string> }): string {
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const env = Object.entries(opts.env)
    .map(([k, v]) => `Environment=${q(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=Workmesh daemon (agent sessions to your team's board and Slack status)
After=network-online.target

[Service]
ExecStart=${q(opts.node)} ${q(opts.entry)} start
${env}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0);
const launchdTarget = () => `gui/${uid()}/${LAUNCHD_LABEL}`;

/** The ProgramArguments of an installed plist (node, entry), read back for doctor. */
function plistProgram(text: string): string[] | undefined {
  const m = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  if (!m) return undefined;
  return [...m[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
}

export function serviceStatus(opts: { home?: string; run?: Runner; kind?: ServiceKind | null } = {}): ServiceStatus {
  const kind = opts.kind === undefined ? serviceKind() : opts.kind;
  const run = opts.run ?? defaultRunner;
  const home = opts.home ?? os.homedir();
  if (kind === "launchd") {
    const file = launchAgentPath(home);
    let text: string | undefined;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      // not installed
    }
    let loaded = false;
    let pid: number | undefined;
    if (text !== undefined) {
      try {
        const out = run("launchctl", ["print", launchdTarget()]);
        loaded = true;
        const m = /^\s*pid = (\d+)/m.exec(out);
        if (m) pid = Number(m[1]);
      } catch {
        // not loaded
      }
    }
    return { kind, installed: text !== undefined, loaded, pid, file, program: text ? plistProgram(text)?.slice(0, 2) : undefined };
  }
  if (kind === "systemd") {
    const file = systemdUnitPath(home);
    const installed = fs.existsSync(file);
    let loaded = false;
    let pid: number | undefined;
    if (installed) {
      try {
        const out = run("systemctl", ["--user", "show", SYSTEMD_UNIT, "-p", "ActiveState", "-p", "MainPID"]);
        loaded = /ActiveState=(active|activating|reloading)/.test(out);
        const m = /MainPID=(\d+)/.exec(out);
        if (m && m[1] !== "0") pid = Number(m[1]);
      } catch {
        // systemd --user unavailable
      }
    }
    return { kind, installed, loaded, pid, file };
  }
  return { kind: null, installed: false, loaded: false };
}

export interface InstallResult {
  kind: ServiceKind;
  file: string;
  /** The file was written (new or changed). */
  wrote: boolean;
}

/**
 * Writes the service file and (re)loads it, which starts the daemon. The
 * caller stops a daemon that runs outside the service first (one daemon only).
 */
export function installService(
  opts: { home?: string; run?: Runner; kind?: ServiceKind | null; node?: string; entry?: string; env?: NodeJS.ProcessEnv } = {},
): InstallResult {
  const kind = opts.kind === undefined ? serviceKind() : opts.kind;
  if (!kind) throw new Error(`no service manager support on ${process.platform}`);
  const run = opts.run ?? defaultRunner;
  const home = opts.home ?? os.homedir();
  const node = opts.node ?? stableNodePath();
  const entry = opts.entry ?? cliEntry();
  const env = serviceEnv(node, opts.env);
  if (kind === "launchd") {
    const file = launchAgentPath(home);
    const log = serviceLogPath(home);
    const text = renderPlist({ node, entry, env, log });
    const wrote = writeIfChanged(file, text);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    // bootout first: a loaded job keeps its old definition until it is unloaded.
    try {
      run("launchctl", ["bootout", launchdTarget()]);
    } catch {
      // wasn't loaded
    }
    run("launchctl", ["bootstrap", `gui/${uid()}`, file]);
    return { kind, file, wrote };
  }
  const file = systemdUnitPath(home);
  const wrote = writeIfChanged(file, renderSystemdUnit({ node, entry, env }));
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
  return { kind, file, wrote };
}

/** Unloads the service (stopping the daemon it runs) and removes its file. */
export function uninstallService(opts: { home?: string; run?: Runner; kind?: ServiceKind | null } = {}): boolean {
  const kind = opts.kind === undefined ? serviceKind() : opts.kind;
  const run = opts.run ?? defaultRunner;
  const home = opts.home ?? os.homedir();
  if (kind === "launchd") {
    const file = launchAgentPath(home);
    const had = fs.existsSync(file);
    try {
      run("launchctl", ["bootout", launchdTarget()]);
    } catch {
      // not loaded
    }
    fs.rmSync(file, { force: true });
    return had;
  }
  if (kind === "systemd") {
    const file = systemdUnitPath(home);
    const had = fs.existsSync(file);
    try {
      run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    } catch {
      // not loaded
    }
    fs.rmSync(file, { force: true });
    try {
      run("systemctl", ["--user", "daemon-reload"]);
    } catch {
      // best effort
    }
    return had;
  }
  return false;
}

/**
 * Asks the service manager to start the daemon (no-op when it runs). False
 * when no service is installed or the manager refused: the caller spawns one.
 */
export function startService(opts: { home?: string; run?: Runner; kind?: ServiceKind | null } = {}): boolean {
  const st = serviceStatus(opts);
  if (!st.installed || !st.kind) return false;
  const run = opts.run ?? defaultRunner;
  try {
    if (st.kind === "launchd") {
      if (!st.loaded) run("launchctl", ["bootstrap", `gui/${uid()}`, st.file!]);
      else run("launchctl", ["kickstart", launchdTarget()]);
    } else {
      run("systemctl", ["--user", "start", SYSTEMD_UNIT]);
    }
    return true;
  } catch {
    return false;
  }
}

function writeIfChanged(file: string, text: string): boolean {
  try {
    if (fs.readFileSync(file, "utf8") === text) return false;
  } catch {
    // new
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o644 });
  return true;
}

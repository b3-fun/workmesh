import { loadConfigSafe } from "../lib/config";
import { isDaemonUp, waitForDaemon } from "../lib/daemon-client";
import { stopDaemon } from "../lib/daemon-control";
import {
  ServiceUnavailableError,
  enableLinger,
  installService,
  probeSystemdUser,
  serviceKind,
  serviceLogPath,
  serviceStatus,
  uninstallService,
} from "../lib/service";
import type { Runner, SystemdUser } from "../lib/service";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { bold, confirm, dim, errorMessage, green, red, sleep, yellow } from "../lib/ui";

export interface ServiceInstallOptions {
  /** Linux: turn lingering on when it is off (default true; `--no-linger`). */
  linger?: boolean;
  /** Tests: the systemd commands, and logind's linger dir. */
  run?: Runner;
  lingerDir?: string;
  /**
   * When logind refuses a user lingering on their own (no polkit, as on a minimal Debian): offer
   * `sudo loginctl enable-linger <user>` and run it with the terminal (true when it worked). Default: ask in a terminal,
   * never without one. Tests pass their own.
   */
  sudoLinger?: (user: string) => Promise<boolean>;
}

/** Asks, then runs `sudo loginctl enable-linger <user>` in this terminal (sudo prompts for the password itself). */
async function askSudoLinger(user: string): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false;
  console.log(dim(`  logind wants an admin to turn lingering on here (it keeps the daemon running after you log out)`));
  if (!(await confirm(`  Run \`sudo loginctl enable-linger ${user}\` now?`, true))) return false;
  const r = spawnSync("sudo", ["loginctl", "enable-linger", user], { stdio: "inherit", timeout: 120_000 });
  return r.status === 0;
}

/** What the Linux steps found, for `init`'s summary. */
export interface LinuxServiceOutcome {
  systemd: SystemdUser;
  /** Lingering was turned on just now. */
  lingerEnabled?: boolean;
  lingerError?: string;
}

/** The fix for a daemon that stops at logout, in one line. */
export const LINGER_FIX = "sudo loginctl enable-linger $USER";

/**
 * Linux, before installing the unit: lingering on (unless `--no-linger`), so the daemon keeps running after the last
 * logout and starts at boot. Without it systemd stops the daemon ~10 s after you leave an SSH box, and the board shows
 * you offline (Mitch's `b3-box`, 11-25). Turning it on also starts the user manager when there was none (su, cron).
 */
export async function prepareSystemd(opts: ServiceInstallOptions = {}): Promise<LinuxServiceOutcome> {
  const probe = () => probeSystemdUser({ run: opts.run, lingerDir: opts.lingerDir });
  let systemd = probe();
  if (!systemd.systemctl) return { systemd };
  if (systemd.linger !== false || opts.linger === false) return { systemd };
  const res = enableLinger({ run: opts.run });
  if (!res.ok) {
    const user = os.userInfo().username;
    if (!(await (opts.sudoLinger ?? askSudoLinger)(user))) return { systemd, lingerError: res.error };
  }
  // logind starts the user manager now; give it a few seconds to answer.
  for (let i = 0; i < 20; i++) {
    systemd = probe();
    if (systemd.manager) break;
    await sleep(250);
  }
  return { systemd: { ...systemd, linger: true }, lingerEnabled: true };
}

/** Prints what lingering means for this machine (init and `service install`). */
export function printLinger(o: LinuxServiceOutcome): void {
  if (!o.systemd.systemctl) return;
  if (o.lingerEnabled) {
    console.log(`  lingering: ${green("on")} ${dim("(loginctl enable-linger: the daemon keeps running after you log out and starts at boot; `loginctl disable-linger` undoes it)")}`);
  } else if (o.systemd.linger === true) {
    console.log(`  lingering: ${green("on")} ${dim("(the daemon keeps running after you log out)")}`);
  } else if (o.systemd.linger === false) {
    console.log(
      `  lingering: ${yellow("off")}: systemd stops the daemon when you log out, and the board shows you offline.` +
        `${o.lingerError ? dim(` (loginctl said: ${o.lingerError})`) : ""}\n  fix: ${bold(LINGER_FIX)}`,
    );
  }
}

/**
 * `workmesh service install`: run the daemon under launchd (macOS) or a
 * systemd --user unit (Linux), so a crash, kill, reboot or wake brings it back
 * (SPEC §24). A daemon already running outside the service is stopped first,
 * cleanly (it saves its hub state), so exactly one runs.
 */
export async function runServiceInstall(opts: ServiceInstallOptions = {}): Promise<boolean> {
  const kind = serviceKind();
  if (!kind) {
    console.log(dim(`  daemon service: not available on ${process.platform}; hooks start the daemon when needed`));
    return false;
  }
  const config = loadConfigSafe();
  let probe: SystemdUser | undefined;
  if (kind === "systemd") {
    const linux = await prepareSystemd(opts);
    probe = linux.systemd;
    printLinger(linux);
    if (!probe.systemctl) {
      console.log(`  daemon service: ${dim("none (no systemd on this machine): the daemon runs in the background; after a reboot the next agent event starts it")}`);
      return false;
    }
    if (!probe.manager) {
      console.log(`  daemon service: ${yellow(`no systemd user session (${probe.error ?? "systemctl --user failed"})`)}: the daemon runs in the background instead`);
      console.log(`  fix: ${bold(LINGER_FIX)}, then ${bold("workmesh service install")}`);
      return false;
    }
  }
  try {
    const before = serviceStatus();
    // A daemon the service doesn't own (started by a hook or by hand): stop it, so the service's is the only one.
    if (!before.pid || !before.loaded) {
      const stopped = await stopDaemon();
      if (stopped.kind === "stuck") throw new Error(`daemon pid ${stopped.pid} won't exit`);
    }
    const res = installService({ ...(opts.run ? { run: opts.run } : {}), ...(probe ? { probe } : {}) });
    const up = await waitForDaemon(config.port, 10_000);
    const where = kind === "launchd" ? `launchd ${dim(`(${res.file}, log ${serviceLogPath()})`)}` : `systemd --user ${dim(`(${res.file})`)}`;
    console.log(`  daemon service: ${up ? green("installed, running") : yellow("installed, not answering yet")} under ${where}`);
    return up;
  } catch (err) {
    if (err instanceof ServiceUnavailableError) {
      console.log(`  daemon service: ${yellow(err.message)}${err.fix ? `\n  fix: ${err.fix}` : ""}`);
      return false;
    }
    console.log(`  daemon service: ${red(`could not install: ${errorMessage(err)}`)}`);
    if (!(await isDaemonUp(config.port))) console.log(dim("  hooks will start a daemon on the next agent event"));
    return false;
  }
}

export async function runServiceUninstall(): Promise<void> {
  const had = uninstallService();
  console.log(had ? green("daemon service removed (the daemon it ran is stopped)") : dim("no daemon service installed"));
}

export async function runServiceStatus(opts: { json?: boolean } = {}): Promise<void> {
  const st = serviceStatus();
  if (opts.json) {
    console.log(JSON.stringify(st, null, 2));
    return;
  }
  if (!st.kind) console.log(dim(`no service manager support on ${process.platform}`));
  else if (!st.installed) console.log(yellow(`not installed — run \`workmesh service install\``));
  else console.log(`${st.kind}: ${st.loaded ? green(st.pid ? `running (pid ${st.pid})` : "loaded, not running") : yellow("installed, not loaded")} ${dim(st.file ?? "")}`);
}

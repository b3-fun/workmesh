import { loadConfigSafe } from "../lib/config";
import { isDaemonUp, waitForDaemon } from "../lib/daemon-client";
import { stopDaemon } from "../lib/daemon-control";
import { installService, serviceKind, serviceLogPath, serviceStatus, uninstallService } from "../lib/service";
import { dim, errorMessage, green, red, yellow } from "../lib/ui";

/**
 * `workmesh service install`: run the daemon under launchd (macOS) or a
 * systemd --user unit (Linux), so a crash, kill, reboot or wake brings it back
 * (SPEC §24). A daemon already running outside the service is stopped first,
 * cleanly (it saves its hub state), so exactly one runs.
 */
export async function runServiceInstall(): Promise<boolean> {
  const kind = serviceKind();
  if (!kind) {
    console.log(dim(`  daemon service: not available on ${process.platform}; hooks start the daemon when needed`));
    return false;
  }
  const config = loadConfigSafe();
  try {
    const before = serviceStatus();
    // A daemon the service doesn't own (started by a hook or by hand): stop it, so the service's is the only one.
    if (!before.pid || !before.loaded) {
      const stopped = await stopDaemon();
      if (stopped.kind === "stuck") throw new Error(`daemon pid ${stopped.pid} won't exit`);
    }
    const res = installService();
    const up = await waitForDaemon(config.port, 10_000);
    const where = kind === "launchd" ? `launchd ${dim(`(${res.file}, log ${serviceLogPath()})`)}` : `systemd --user ${dim(`(${res.file})`)}`;
    console.log(`  daemon service: ${up ? green("installed, running") : yellow("installed, not answering yet")} under ${where}`);
    return up;
  } catch (err) {
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

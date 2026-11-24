import { loadConfigSafe } from "../lib/config";
import { isDaemonUp } from "../lib/daemon-client";
import { STOP_GRACE_MS, stopDaemon } from "../lib/daemon-control";
import { dim, green, yellow } from "../lib/ui";

/**
 * `workmesh stop`: returns once the daemon's process is gone (SIGKILL after
 * 5 s), so `workmesh stop && workmesh start --detach` can't race it. Returns
 * whether nothing is left running.
 */
export async function runStop(): Promise<boolean> {
  const outcome = await stopDaemon();
  switch (outcome.kind) {
    case "stopped": {
      const what = outcome.legacy ? "daemon started before the rename (agentblip)" : "daemon";
      console.log(green(`${what} stopped (pid ${outcome.pid})`));
      if (outcome.killed) {
        console.log(yellow(`  it didn't exit within ${STOP_GRACE_MS / 1000}s, so it was killed; Slack clears the status when it expires`));
      }
      return true;
    }
    case "stuck":
      console.log(yellow(`daemon (pid ${outcome.pid}) is still running after SIGKILL`));
      process.exitCode = 1;
      return false;
    case "stale":
    case "not-running": {
      const config = loadConfigSafe();
      if (await isDaemonUp(config.port)) {
        console.log(
          yellow(`a daemon is answering on 127.0.0.1:${config.port} but no pidfile names it — stop it manually`),
        );
        process.exitCode = 1;
        return false;
      }
      console.log(dim(outcome.kind === "stale" ? "daemon not running (stale pidfile removed)" : "daemon not running"));
      return true;
    }
  }
}

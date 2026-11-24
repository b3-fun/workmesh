import fs from "node:fs";
import { SessionStore, formatStatus } from "@workmesh/core";
import type { SessionEvent } from "@workmesh/core";
import { codexSessionsDir, createCodexWatcher } from "../adapters/codex";
import type { CodexWatcher } from "../adapters/codex";
import { claudeProjectsDir, createWorkflowWatcher } from "../adapters/workflow";
import type { WorkflowWatcher } from "../adapters/workflow";
import { formatOptionsFromConfig, hubShareLevel, readHubConfig, safeConfig, saveConfig } from "../lib/config";
import type { Config, HubConfig } from "../lib/config";
import { HubForwarder } from "../hub/forwarder";
import { createDaemonSecret, mirrorLegacySecret } from "../lib/daemon-auth";
import { loadOwnershipState, saveOwnershipState } from "../lib/ownership-state";
import { stateDir } from "../lib/paths";
import { findRunningDaemon } from "../lib/daemon-control";
import { readPidFile, removePidFile, writePidFile } from "../lib/pidfile";
import { createSink } from "../sinks";
import { ClaudeLiveness, readLiveClaudeSessions } from "./claude-liveness";
import { Pusher } from "./pusher";
import { createDaemonServer } from "./server";

/** How often the daemon checks Claude Code's session files for liveness. */
const CLAUDE_LIVENESS_INTERVAL_MS = 15_000;

export interface RunDaemonOptions {
  /** How long to wait for a daemon that is still shutting down. */
  exitWaitMs?: number;
}

/** Runs the daemon in the foreground until SIGINT/SIGTERM. */
export async function runDaemon(config: Config, opts: RunDaemonOptions = {}): Promise<void> {
  // A pidfile whose process is gone (or was reused by another program) is
  // ignored; a daemon still shutting down gets a few seconds to finish.
  const existingPid = await findRunningDaemon({ exitWaitMs: opts.exitWaitMs });
  if (existingPid !== undefined) {
    throw new Error(`daemon already running (pid ${existingPid}) — \`workmesh stop\` first`);
  }
  fs.mkdirSync(stateDir(), { recursive: true });

  const log = (message: string): void => {
    console.log(`[${new Date().toISOString()}] ${message}`);
  };

  const store = new SessionStore();
  const sink = createSink(config);
  // Mutable so the menu bar app / POST /config can retune formatting live; the
  // getState/getConfig closures below read these variables, not a snapshot.
  let liveConfig = config;
  let formatOpts = formatOptionsFromConfig(config);
  const pusher = new Pusher({
    store,
    sink,
    formatOpts,
    policy: config.statusPolicy,
    // Survives restarts: a crash while a foreign status was displaced must
    // still restore it. Corrupt/missing file falls back to the empty state.
    initialOwnership: loadOwnershipState(),
    persistOwnership: (state) => saveOwnershipState(state),
    debounceMs: config.debounceMs,
    log,
  });

  // Hub forward (team hub, apps/hub): runs beside the pusher, on its own timer; rebuilt
  // when `workmesh hub connect|disconnect|include|exclude` asks for a reload.
  let forwarder: HubForwarder | undefined;
  const startForwarder = (hub: HubConfig | undefined): void => {
    const previous = forwarder;
    forwarder = undefined;
    if (previous) void previous.stop().catch(() => {});
    if (!hub) return;
    forwarder = new HubForwarder({
      url: hub.url,
      token: hub.deviceToken,
      rule: hub.project,
      includeDirs: hub.includeDirs,
      excludeDirs: hub.excludeDirs,
      listSessions: () => store.list(),
      getSession: (key) => store.get(key),
      log,
      share: hubShareLevel(hub),
      codexSessionsDir: config.adapters.codex.sessionsDir,
    });
    forwarder.start();
    log(`hub forward on: ${hub.url} (project ${hub.project.name}, sharing ${hubShareLevel(hub)})`);
  };

  const hidden = new Set(config.hideProjects ?? []);
  const applyEvent = (event: SessionEvent): void => {
    // A hidden project contributes no project text anywhere, its path and
    // hook detail included.
    const clean =
      event.project !== undefined && hidden.has(event.project)
        ? { ...event, project: undefined, cwd: undefined, detail: undefined }
        : event;
    store.apply(clean);
    pusher.notify();
    forwarder?.observe(clean);
  };

  // Written before listen: the file must exist by the time /health answers,
  // and a stale secret from a failed start is harmless.
  const secret = createDaemonSecret();
  mirrorLegacySecret(secret);

  const server = createDaemonServer({
    secret,
    applyEvent,
    getState: () => {
      store.sweep();
      const snapshot = store.snapshot();
      return {
        snapshot,
        formatted: formatStatus(snapshot, formatOpts),
        paused: pusher.paused,
        pausedUntil: pusher.paused ? pusher.pausedUntil : undefined,
        lastError: pusher.lastError,
      };
    },
    getLastError: () => pusher.lastError,
    getOwnership: () => pusher.ownershipSummary(),
    pause: (until) => {
      log(until === undefined ? "paused via API" : `snoozed via API until ${new Date(until).toISOString()}`);
      return pusher.pause(until);
    },
    resume: () => {
      pusher.resume();
    },
    dismiss: (key) => {
      const removed = store.remove(key);
      if (removed) {
        log(`dismissed ${key} via API`);
        pusher.notify();
      }
      return removed;
    },
    getConfig: () => safeConfig(liveConfig),
    getHub: () => (forwarder ? { enabled: true, ...forwarder.status() } : { enabled: false }),
    reloadHub: () => {
      const hub = readHubConfig();
      if (hub === "unreadable") throw new Error("config file is unreadable — hub settings unchanged");
      liveConfig = { ...liveConfig, hub };
      startForwarder(hub);
      if (!hub) log("hub forward off");
      return forwarder ? { enabled: true, ...forwarder.status() } : { enabled: false };
    },
    setConfig: (patch) => {
      // `workmesh hub …` writes the hub section while the daemon runs: take
      // it from disk so saving a live patch never drops a pairing.
      const hubOnDisk = readHubConfig();
      liveConfig = {
        ...liveConfig,
        ...patch,
        hub: hubOnDisk === "unreadable" ? liveConfig.hub : hubOnDisk,
      };
      formatOpts = formatOptionsFromConfig(liveConfig);
      pusher.applyConfig(formatOpts, liveConfig.statusPolicy);
      saveConfig(liveConfig);
      log(`config updated via API: ${Object.keys(patch).join(", ") || "(none)"}`);
      return safeConfig(liveConfig);
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  // Only now — after the sink was created and the port is bound — claim the
  // pidfile: a failed or racing start must never clobber the live daemon's.
  writePidFile(process.pid);

  try {
    pusher.start();
    startForwarder(config.hub);

    let watcher: CodexWatcher | undefined;
    const sessionsDir = config.adapters.codex.sessionsDir ?? codexSessionsDir();
    if (config.adapters.codex.enabled && fs.existsSync(sessionsDir)) {
      watcher = createCodexWatcher(sessionsDir, applyEvent, log);
      log(`watching codex sessions in ${sessionsDir}`);
    }

    let wfWatcher: WorkflowWatcher | undefined;
    const projectsDir = config.adapters.workflow.projectsDir ?? claudeProjectsDir();
    if (config.adapters.workflow.enabled && fs.existsSync(projectsDir)) {
      wfWatcher = createWorkflowWatcher(projectsDir, applyEvent, log);
      log(`watching Claude Code workflows in ${projectsDir}`);
    }

    // End Claude Code sessions whose process died without a SessionEnd, keep
    // ones Claude Code reports busy from going stale mid tool call, and pick
    // up session names for the menu bar.
    let livenessTimer: NodeJS.Timeout | undefined;
    if (config.adapters.claudeCode.enabled) {
      const liveness = new ClaudeLiveness();
      const checkLiveness = (): void => {
        const now = Date.now();
        const actions = liveness.step(store.list(), readLiveClaudeSessions(), now);
        for (const [key, name] of actions.names) store.annotate(key, { name });
        for (const key of actions.touch) store.touch(key, now);
        for (const key of actions.reap) {
          store.remove(key);
          log(`ended ${key}: its Claude Code process is gone`);
        }
        if (actions.reap.length > 0) pusher.notify();
      };
      livenessTimer = setInterval(checkLiveness, CLAUDE_LIVENESS_INTERVAL_MS);
      livenessTimer.unref();
    }

    log(
      `Workmesh daemon listening on 127.0.0.1:${config.port} (sink: ${sink.name}, granularity: ${config.granularity}, statusPolicy: ${config.statusPolicy})`,
    );

    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      log(`${signal} received — clearing status and shutting down`);
      void (async () => {
        if (livenessTimer) clearInterval(livenessTimer);
        server.close();
        try {
          await watcher?.close();
          await wfWatcher?.close();
        } catch {
          // best effort
        }
        try {
          await Promise.all([pusher.shutdown(), forwarder?.stop()]);
        } catch {
          // best effort
        }
        // Only our own claim: a daemon started right after ours closed its
        // port may already have written its pid.
        if (readPidFile() === process.pid) removePidFile();
        process.exit(0);
      })();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("unhandledRejection", (reason) => {
      log(`unhandled rejection: ${String(reason)}`);
    });
  } catch (err) {
    // Startup failed after the pidfile was claimed — clean up, but only our
    // own claim (a concurrent daemon may have re-written it).
    if (readPidFile() === process.pid) removePidFile();
    throw err;
  }
}

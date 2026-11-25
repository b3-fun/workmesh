import fs from "node:fs";
import pkg from "../../package.json";
import { SessionStore, formatStatus } from "@workmesh/core";
import type { SessionEvent } from "@workmesh/core";
import { codexSessionsDir, createCodexWatcher } from "../adapters/codex";
import type { CodexWatcher } from "../adapters/codex";
import { claudeProjectsDir, createWorkflowWatcher } from "../adapters/workflow";
import type { WorkflowWatcher } from "../adapters/workflow";
import {
  delegateSettings,
  formatOptionsFromConfig,
  hubShareLevel,
  hubStickyShare,
  loadConfigSafe,
  readHubConfig,
  safeConfig,
  saveConfig,
} from "../lib/config";
import type { Config, HubConfig } from "../lib/config";
import { HubForwarder } from "../hub/forwarder";
import { TeamPoller } from "../hub/team";
import { CoordClient } from "../hub/coord";
import { CoordHooks } from "./coord-hooks";
import { runCoordOp } from "./coord-ops";
import { Delegate } from "./delegate";
import { CheckoutIndex, HandoffRunner } from "./handoff-runner";
import { codexWaker } from "./codex-wake";
import type { CoordSummary } from "./server";
import { readGithubLogin } from "../lib/github";
import { createDaemonSecret, mirrorLegacySecret } from "../lib/daemon-auth";
import { loadOwnershipState, saveOwnershipState } from "../lib/ownership-state";
import { checkoutsPath, handoffsDir, hubForwardStatePath, stateDir } from "../lib/paths";
import { removeStateFile } from "../hub/persist";
import { findRunningDaemon, takeStopRequest } from "../lib/daemon-control";
import { SERVICE_ENV } from "../lib/service";
import { readPidFile, removePidFile, writePidFile } from "../lib/pidfile";
import { createSink } from "../sinks";
import { ClaudeLiveness, claudeConfigDir, readLiveClaudeSessions } from "./claude-liveness";
import type { ClaudeProcess } from "./claude-liveness";
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
  let existingPid = await findRunningDaemon({ exitWaitMs: opts.exitWaitMs });
  if (existingPid !== undefined && process.env[SERVICE_ENV]) {
    // Under launchd / systemd (SPEC §24) while another daemon (a hook's, or one started by hand) has the port:
    // wait for it to go, then take over. Exiting instead would have the service restart this one every 10 s.
    console.log(`[${new Date().toISOString()}] daemon pid ${existingPid} is running; the service's daemon waits for it to exit`);
    while (existingPid !== undefined) {
      await new Promise((r) => setTimeout(r, 5000));
      existingPid = await findRunningDaemon({ exitWaitMs: 0 });
    }
  }
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
  // v0.5: the team view for the menu bar (GET /relay/team), beside the forwarder.
  let teamPoller: TeamPoller | undefined;
  // v1 (SPEC §21, §23): leases, holds, claims, messages (GET /relay/sync), read by hooks from memory.
  let coord: CoordClient | undefined;
  // v0.6: the GitHub login `gh` reports, read once per start (the config's copy from `hub connect` until then).
  let githubLogin: string | undefined;
  let githubRead = false;
  // v0.10 (SPEC §24): Claude Code's live processes, from the liveness check below; the forwarder reports `alive`.
  const claudeOn = config.adapters.claudeCode.enabled;
  // One Claude Code config dir for liveness, the MCP caller lookup and workflows: the config's
  // (`setup --claude-dir`), else $CLAUDE_CONFIG_DIR, else ~/.claude.
  const claudeDir = config.adapters.claudeCode.configDir ?? claudeConfigDir();
  let liveClaude: Map<string, ClaudeProcess> | undefined = claudeOn ? readLiveClaudeSessions(claudeDir) : undefined;
  // v2 Delegate (SPEC §31): the settings are read from disk (at most every 2 s), so `workmesh roots|wake|handoffs`
  // apply without a restart.
  let settingsCache: { at: number; v: ReturnType<typeof delegateSettings> } | undefined;
  const settings = (): ReturnType<typeof delegateSettings> => {
    const now = Date.now();
    if (!settingsCache || now - settingsCache.at > 2000) settingsCache = { at: now, v: delegateSettings(loadConfigSafe()) };
    return settingsCache.v;
  };
  const checkouts = new CheckoutIndex(checkoutsPath());
  const runner = new HandoffRunner({
    coord: () => coord,
    settings: () => ({ ...settings(), share: liveConfig.hub ? hubShareLevel(liveConfig.hub) : "metadata" }),
    checkouts,
    dir: handoffsDir(),
    log,
  });
  const delegate = new Delegate({
    coord: () => coord,
    getSession: (key) => store.get(key),
    isShared: (key) => forwarder?.isShared(key) ?? false,
    repoOf: (dir) => forwarder?.classify(dir)?.repo,
    settings,
    runner,
    codexWake: config.adapters.codex.enabled ? codexWaker({ log }) : undefined,
    log,
  });
  /** The cwd each session last reported (the checkout index learns a repo's checkout once per session and dir). */
  const lastCwd = new Map<string, string>();

  const startForwarder = (hub: HubConfig | undefined): void => {
    const previous = forwarder;
    forwarder = undefined;
    // A forwarder being replaced (hub include/exclude/connect) hands its state over in memory.
    const carried = previous?.exportState();
    previous?.detachState();
    if (previous) void previous.stop().catch(() => {});
    teamPoller?.stop();
    teamPoller = undefined;
    coord?.stop();
    coord = undefined;
    if (!hub) {
      // Disconnected: nothing to carry on with.
      removeStateFile(hubForwardStatePath());
      return;
    }
    const fwd = new HubForwarder({
      url: hub.url,
      token: hub.deviceToken,
      rule: hub.project,
      // Handoffs with no repo run in Workmesh's own scratch dirs, shared so they show on the board (SPEC §31).
      includeDirs: [...hub.includeDirs, handoffsDir()],
      excludeDirs: hub.excludeDirs,
      listSessions: () => store.list(),
      getSession: (key) => store.get(key),
      log,
      share: hubShareLevel(hub),
      stickyShare: hubStickyShare(hub),
      codexSessionsDir: config.adapters.codex.sessionsDir,
      github: githubLogin ?? hub.github,
      // v0.10 liveness and persistence (SPEC §24)
      client: `workmesh/${pkg.version}`,
      statePath: hubForwardStatePath(),
      aliveOf: (s) => (s.source === "claude-code" && liveClaude?.has(s.sessionId) ? true : undefined),
      isGone: (s) => s.source === "claude-code" && liveClaude !== undefined && !liveClaude.has(s.sessionId),
      seedSessions: (list) => {
        if (store.restore(list) > 0) pusher.notify();
      },
    });
    if (carried) fwd.restoreState({ state: carried });
    forwarder = fwd;
    teamPoller = new TeamPoller({
      url: hub.url,
      token: hub.deviceToken,
      log,
      // A hub that serves the team view reads v0.6 structure: subagents go as their own sessions.
      onAvailability: (available) => {
        fwd.setStructured(available);
        log(available ? "hub: team view on; sending subagents as sessions" : "hub: no team view; subagents fold into their sessions");
      },
    });
    teamPoller.start();
    coord = new CoordClient({
      url: hub.url,
      token: hub.deviceToken,
      deviceId: hub.deviceId,
      person: hub.person?.name,
      active: () => fwd.hasLiveShared(),
      log,
      onSync: (next, previous) => delegate.onSync(next, previous),
    });
    coord.start();
    runner.start();
    if (!githubRead) {
      githubRead = true;
      void readGithubLogin().then((login) => {
        if (!login) return;
        githubLogin = login;
        forwarder?.setGithub(login);
      });
    }
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
    const key = `${clean.source}:${clean.sessionId}`;
    if (clean.cwd && forwarder && lastCwd.get(key) !== clean.cwd) {
      lastCwd.set(key, clean.cwd);
      if (lastCwd.size > 2000) lastCwd.clear();
      const target = forwarder.classify(clean.cwd);
      if (target?.repo) checkouts.observe(clean.cwd, target.repo);
    }
    delegate.observe(clean);
  };

  // v1: hooks get refusals and context from the cached coordination state (never a network call).
  const coordHooks = new CoordHooks({
    coord: () => coord,
    classify: (p) => forwarder?.classify(p),
    isShared: (key) => forwarder?.isShared(key) ?? false,
    projectName: () => liveConfig.hub?.project.name,
    // v3 (SPEC §36): which memories a session started with, reported in the background (a failure is dropped).
    memoriesUsed: (key, ids) => {
      void coord?.memoryUsed(key, ids);
    },
  });
  const applyHookEvent = (event: SessionEvent, hook: string) => {
    let deny: string | undefined;
    try {
      deny = coordHooks.refuse(event, hook);
    } catch {
      deny = undefined; // fail open
    }
    if (!deny) {
      try {
        // v2: an action this person gated waits for an approval (SPEC §31).
        deny = delegate.gateRefusal(event, hook);
      } catch {
        deny = undefined; // fail open
      }
    }
    if (deny) {
      // The tool won't run: keep the session alive, but nothing about the refused call goes anywhere.
      applyEvent({ ...event, kind: "heartbeat", activity: undefined, detail: undefined });
      log(`refused ${event.detail?.tool ?? "a tool"} in ${event.source}:${event.sessionId.slice(0, 8)}: ${deny.slice(0, 80)}`);
    } else {
      applyEvent(event);
      if (forwarder?.isShared(`${event.source}:${event.sessionId}`)) coord?.poke();
    }
    return coordHooks.answer(event, hook, deny);
  };

  /** v1: holds on this machine's agents and messages waiting for them, for the menu bar. */
  const coordSummary = (): CoordSummary | undefined => {
    if (!coord) return undefined;
    const view = coord.view();
    const nameOf = (local: string | undefined): string | undefined =>
      local ? store.get(CoordClient.family(local))?.name : undefined;
    const holds: CoordSummary["holds"] = [];
    for (const h of view.state?.holds ?? []) {
      const local = coord.localKey(h.sessionKey);
      if (local === undefined || !coord.holdFor(local)) continue;
      holds.push({ session: local, name: nameOf(local), by: h.by, reason: h.reason, since: h.since });
    }
    const unread = coord
      .inboxItems()
      .filter((m) => !m.delivered)
      .map((m) => ({
        id: m.id,
        session: m.localKey,
        name: nameOf(m.localKey),
        from: m.from.person,
        fromSession: m.from.sessionName,
        text: m.text.slice(0, 500),
        ts: m.ts,
        delivered: m.delivered,
      }));
    return { available: view.available, holds, unread };
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
    getTeam: (open) => {
      const hub = liveConfig.hub;
      if (!forwarder || !teamPoller || !hub) return { enabled: false };
      if (open) teamPoller.markOpen();
      const st = forwarder.status();
      const view = teamPoller.view();
      return {
        enabled: true,
        hubUrl: hub.url,
        boardUrl: hub.url,
        hubName: hub.project.name,
        deviceId: hub.deviceId,
        share: st.share,
        connected: !st.halted && st.lastSendOk === true,
        halted: st.halted || view.halted,
        available: view.available,
        fetchedAt: view.fetchedAt,
        error: view.error,
        pollMs: view.pollMs,
        team: view.team,
        coord: coordSummary(),
        delegate: delegate.summary((local) => store.get(local)?.name),
      };
    },
    applyHookEvent,
    coordOp: (req) =>
      runCoordOp(req, {
        coord: () => coord,
        hub: () => liveConfig.hub,
        getSession: (key) => store.get(key),
        listSessions: () => store.list(),
        classify: (p) => forwarder?.classify(p),
        isShared: (key) => forwarder?.isShared(key) ?? false,
        claudeSessions: () => readLiveClaudeSessions(claudeDir),
        onAccepted: (h) => delegate.accepted(h),
        runningHandoffs: () => runner.running(),
      }),
    wakeWait: (session, timeoutMs, signal) => delegate.wait(session, timeoutMs, signal),
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
      const onDisk = hubOnDisk === "unreadable" ? liveConfig : loadConfigSafe();
      liveConfig = {
        ...liveConfig,
        ...patch,
        hub: hubOnDisk === "unreadable" ? liveConfig.hub : hubOnDisk,
        // v2 sections the CLI writes while the daemon runs (roots, wake, gates).
        handoffs: onDisk.handoffs,
        wake: onDisk.wake,
        gates: onDisk.gates,
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
    const projectsDir = config.adapters.workflow.projectsDir ?? claudeProjectsDir(claudeDir);
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
        const live = readLiveClaudeSessions(claudeDir);
        liveClaude = live;
        const actions = liveness.step(store.list(), live, now);
        for (const [key, name] of actions.names) store.annotate(key, { name });
        for (const key of actions.touch) store.touch(key, now);
        for (const key of actions.reap) {
          store.remove(key);
          delegate.sessionGone(key);
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
          teamPoller?.stop();
          coord?.stop();
          runner.stop();
          checkouts.save();
          await Promise.all([pusher.shutdown(), forwarder?.stop()]);
        } catch {
          // best effort
        }
        // Only our own claim: a daemon started right after ours closed its
        // port may already have written its pid.
        if (readPidFile() === process.pid) removePidFile();
        // Under launchd / systemd (SPEC §24): a SIGTERM that isn't `workmesh stop` (a kill, a crash
        // handler) exits non-zero, so the service brings the daemon back.
        const stopped = takeStopRequest(process.pid);
        process.exit(process.env[SERVICE_ENV] && signal === "SIGTERM" && !stopped ? 75 : 0);
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

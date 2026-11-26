import os from "node:os";
import path from "node:path";
import { APP_NAME, LEGACY_APP_NAME } from "./names";

function configBase(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function stateBase(): string {
  return process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
}

/**
 * Claude Code's config dir: $CLAUDE_CONFIG_DIR, else ~/.claude. Claude Code
 * reads its settings, sessions and projects from here, so hook installs, the
 * workflow watcher and the liveness probe all resolve it the same way.
 */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/** Codex's home: $CODEX_HOME, else ~/.codex (hooks.json, config.toml, sessions). */
export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/** ~/.config/workmesh (XDG_CONFIG_HOME respected). */
export function configDir(): string {
  return path.join(configBase(), APP_NAME);
}

/** ~/.local/state/workmesh (XDG_STATE_HOME respected). */
export function stateDir(): string {
  return path.join(stateBase(), APP_NAME);
}

/** The config dir before the rename; read once by lib/migrate.ts. */
export function legacyConfigDir(): string {
  return path.join(configBase(), LEGACY_APP_NAME);
}

/** The state dir before the rename; read once by lib/migrate.ts. */
export function legacyStateDir(): string {
  return path.join(stateBase(), LEGACY_APP_NAME);
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function pidFilePath(): string {
  return path.join(stateDir(), "daemon.pid");
}

/** Where a daemon started before the rename (agentblip) wrote its pid. */
export function legacyPidFilePath(): string {
  return path.join(legacyStateDir(), "daemon.pid");
}

export function spawnLockPath(): string {
  return path.join(stateDir(), "daemon.spawn.lock");
}

export function logFilePath(): string {
  return path.join(stateDir(), "daemon.log");
}

/** Per-daemon bearer secret required by the loopback API (0600). */
export function daemonSecretPath(): string {
  return path.join(stateDir(), "daemon.secret");
}

/**
 * The secret's pre-rename path. Readers built before the rename (agentblip.app,
 * Sean's desk clock, hooks of an older install) look here, so the daemon keeps a
 * copy while that directory exists.
 */
export function legacyDaemonSecretPath(): string {
  return path.join(legacyStateDir(), "daemon.secret");
}

/** Timestamp of the last failed autostart — hooks skip re-spawning while fresh. */
export function startFailedMarkerPath(): string {
  return path.join(stateDir(), "daemon.start-failed");
}

/** Persisted OwnershipState — survives daemon restarts/crashes. */
export function ownershipStatePath(): string {
  return path.join(stateDir(), "ownership.json");
}

/**
 * v0.10: `workmesh stop` names the pid it is stopping here before SIGTERM, so a
 * daemon under launchd / systemd exits 0 (stay stopped) for a stop and non-zero
 * (bring me back) for any other SIGTERM.
 */
export function stopRequestPath(): string {
  return path.join(stateDir(), "daemon.stop-requested");
}

/** v0.10: the hub forwarder's saved state (shared sessions, transcript offsets, unsent queue), 0600 (SPEC §24). */
export function hubForwardStatePath(): string {
  return path.join(stateDir(), "hub-forward.json");
}

/** v2 (SPEC §31): handoff runs (logs, exit codes, the running list) and scratch dirs for handoffs with no repo. */
export function handoffsDir(): string {
  return path.join(stateDir(), "handoffs");
}

/** v2 (SPEC §31): the ids of the handoffs that were accepted on this machine (0600). Only those are started here. */
export function acceptedHandoffsPath(): string {
  return path.join(stateDir(), "handoffs-accepted.json");
}

/** v2: the main checkout of each shared repo this machine's sessions worked in (for handoffs). */
export function checkoutsPath(): string {
  return path.join(stateDir(), "checkouts.json");
}

/** 0.12 (SPEC §41): what `workmesh update` last did and the version whose setup steps last ran here (0600). */
export function updateStatePath(): string {
  return path.join(stateDir(), "update.json");
}

/** 0.12: the daemon's last update check (newest version, where it read it, the menu bar release), 0600. */
export function updateCheckPath(): string {
  return path.join(stateDir(), "update-check.json");
}

/** 0.12: the version each agent session started under, and which sessions were told about an update (0600). */
export function sessionVersionsPath(): string {
  return path.join(stateDir(), "session-versions.json");
}

/** 0.12: the copy of the installed package `workmesh update` keeps until the new version passes its checks. */
export function updateBackupDir(): string {
  return path.join(stateDir(), "update", "previous");
}

/** 0.12: output of updates the daemon starts on its own (`workmesh update --auto on`). */
export function updateLogPath(): string {
  return path.join(stateDir(), "update.log");
}

import os from "node:os";
import path from "node:path";
import { APP_NAME, LEGACY_APP_NAME } from "./names";

function configBase(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function stateBase(): string {
  return process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
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

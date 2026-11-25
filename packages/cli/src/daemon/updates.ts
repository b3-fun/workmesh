import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { InstallInfo, InstallMethod } from "../lib/install-method";
import type { LastUpdate, MenubarRelease, UpdateCheck } from "../lib/update-state";
import { readUpdateCheck, writeUpdateCheck } from "../lib/update-state";
import { compareVersions, isNewer, parseVersion, withinScope } from "../lib/versions";
import type { UpdateScope } from "../lib/versions";

/**
 * Update notices and opt-in auto-update in the daemon (SPEC §41). The newest version comes from the hub's
 * `latestClient` on `/relay/team` (SPEC §40) when the machine is paired, else from the npm registry at most every
 * 6 h; the menu bar's release zip from GitHub at most every 6 h (macOS). `GET /update` serves the result for the menu
 * bar, `status` and `doctor`. With `update.auto` on, the daemon starts `workmesh update --auto-run` at most once a day
 * for a release within the person's scope, and never again for a version that failed and was rolled back.
 */

export const NPM_EVERY_MS = 6 * 3600_000;
export const MENUBAR_EVERY_MS = 6 * 3600_000;
export const AUTO_EVERY_MS = 24 * 3600_000;
/** First look a minute after start (not in the start's own rush), then every 15 minutes. */
export const FIRST_TICK_MS = 60_000;
export const TICK_MS = 15 * 60_000;

/** `GET /update`: what the menu bar, `status` and `doctor` read. */
export interface UpdateStatus {
  current: string;
  latest?: string;
  available: boolean;
  checkedAt?: number;
  source?: "hub" | "npm";
  install: { method: InstallMethod; canUpdate: boolean; hint?: string };
  /** argv that runs the update (node, the CLI, `update`), when this install can update itself. */
  run?: string[];
  auto: { enabled: boolean; scope: UpdateScope };
  last?: LastUpdate;
  /** macOS: the latest release's menu bar app (SHA-256 from GitHub). */
  menubar?: MenubarRelease;
}

export interface UpdateCheckerDeps {
  current: string;
  install: () => InstallInfo;
  /** The hub's `latestClient` and when the team view was read; undefined when not paired or the hub has none. */
  hubLatest: () => { version: string; at?: number } | undefined;
  settings: () => { enabled: boolean; scope: UpdateScope };
  /** The registry's latest version. */
  fetchNpm: () => Promise<string>;
  /** The latest release's menu bar zip; absent off macOS. */
  fetchMenubar?: () => Promise<MenubarRelease | undefined>;
  /** Starts `workmesh update --auto-run` in the background; true when it started. */
  startAuto: (to: string) => boolean;
  /** What `workmesh update` last did (update.json). */
  lastRun: () => LastUpdate | undefined;
  /** argv for `run`. */
  runArgv: string[];
  file?: string;
  now?: () => number;
  log?: (message: string) => void;
}

export class UpdateChecker {
  private readonly deps: UpdateCheckerDeps;
  private readonly now: () => number;
  private check: UpdateCheck;
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;

  constructor(deps: UpdateCheckerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.check = readUpdateCheck(deps.file);
  }

  start(): void {
    this.stop();
    const loop = (ms: number) => {
      this.timer = setTimeout(() => {
        void this.tick().finally(() => loop(TICK_MS));
      }, ms);
      this.timer.unref();
    };
    loop(FIRST_TICK_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The newest version known, from the hub or npm, whichever is newer (the hub on a tie). */
  private latest(): { version?: string; at?: number; source?: "hub" | "npm" } {
    const hub = this.deps.hubLatest();
    const npm = this.check.npmLatest;
    if (hub && parseVersion(hub.version) && (!npm || compareVersions(hub.version, npm) >= 0)) {
      return { version: hub.version, at: hub.at, source: "hub" };
    }
    if (npm) return { version: npm, at: this.check.checkedAt, source: "npm" };
    return {};
  }

  /** One look: npm when the hub gives no version (≤ every 6 h), GitHub for the menu bar (≤ every 6 h), auto-update. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    const now = this.now();
    let dirty = false;
    // npm when the hub gives no version, or one older than this relay (a hub that hasn't read npm since a release).
    const hub = this.deps.hubLatest();
    const hubKnows = hub !== undefined && compareVersions(hub.version, this.deps.current) >= 0;
    if (!hubKnows && now - (this.check.npmAt ?? 0) >= NPM_EVERY_MS) {
      this.check.npmAt = now;
      dirty = true;
      try {
        const v = await this.deps.fetchNpm();
        if (parseVersion(v)) {
          this.check.npmLatest = v;
          this.check.checkedAt = this.now();
        }
      } catch (err) {
        this.deps.log?.(`update check: npm registry unreadable (${err instanceof Error ? err.message : String(err)}); next try in 6 h`);
      }
    }
    if (this.deps.fetchMenubar && now - (this.check.menubarAt ?? 0) >= MENUBAR_EVERY_MS) {
      this.check.menubarAt = now;
      dirty = true;
      try {
        const rel = await this.deps.fetchMenubar();
        if (rel) this.check.menubar = rel;
      } catch (err) {
        this.deps.log?.(`update check: GitHub release unreadable (${err instanceof Error ? err.message : String(err)}); next try in 6 h`);
      }
    }
    const l = this.latest();
    if (l.version && (l.version !== this.check.latest || l.source !== this.check.source)) {
      this.check.latest = l.version;
      this.check.source = l.source;
      if (l.at) this.check.checkedAt = l.at;
      dirty = true;
      if (isNewer(l.version, this.deps.current)) this.deps.log?.(`update: Workmesh ${l.version} is out (this is ${this.deps.current}; from ${l.source})`);
    }
    if (this.autoDue(now)) {
      const to = l.version!;
      this.check.autoAt = now;
      this.check.autoTo = to;
      dirty = true;
      const started = this.deps.startAuto(to);
      this.deps.log?.(started ? `auto-update: started workmesh update to ${to}` : `auto-update: could not start the update to ${to}`);
    }
    if (dirty) writeUpdateCheck(this.check, this.deps.file);
  }

  /** Auto-update is on, this install can update, a release within scope is out, and none was tried in 24 h. */
  autoDue(now = this.now()): boolean {
    const s = this.deps.settings();
    if (!s.enabled) return false;
    const install = this.deps.install();
    if (!install.canUpdate) return false;
    const to = this.latest().version;
    if (!to || !withinScope(this.deps.current, to, s.scope)) return false;
    if (now - (this.check.autoAt ?? 0) < AUTO_EVERY_MS) return false;
    // A version that failed its checks and was rolled back is never retried on its own; a newer one is.
    const last = this.deps.lastRun();
    if (last && !last.ok && last.to === to) return false;
    return true;
  }

  status(): UpdateStatus {
    const install = this.deps.install();
    const l = this.latest();
    const last = this.deps.lastRun();
    return {
      current: this.deps.current,
      ...(l.version ? { latest: l.version } : {}),
      available: isNewer(l.version, this.deps.current),
      ...(l.at ?? this.check.checkedAt ? { checkedAt: l.at ?? this.check.checkedAt } : {}),
      ...(l.source ? { source: l.source } : {}),
      install: { method: install.method, canUpdate: install.canUpdate, ...(install.hint ? { hint: install.hint } : {}) },
      ...(install.canUpdate ? { run: this.deps.runArgv } : {}),
      auto: this.deps.settings(),
      ...(last ? { last } : {}),
      ...(this.deps.fetchMenubar && this.check.menubar ? { menubar: this.check.menubar } : {}),
    };
  }
}

/**
 * Starts `workmesh update --auto-run` so that it outlives the daemon it restarts: on Linux in its own transient
 * systemd unit (stopping workmesh.service kills everything in its cgroup), elsewhere as a detached process in its own
 * session (launchd only cleans up the job's process group). Output goes to `log`.
 */
export function spawnDetachedUpdate(argv: string[], log: string, baseEnv: NodeJS.ProcessEnv = process.env): boolean {
  const [cmd, ...args] = argv;
  // The update isn't the service's daemon: it must not inherit the daemon's marker.
  const { WORKMESH_SERVICE: _service, ...env } = baseEnv;
  if (!cmd) return false;
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    if (process.platform === "linux" && _service) {
      const keep = ["HOME", "PATH", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "WORKMESH_CONFIG", "npm_config_registry", "WORKMESH_REGISTRY"];
      const setenv = keep.flatMap((k) => (env[k] ? [`--setenv=${k}=${env[k]}`] : []));
      const r = spawnSync(
        "systemd-run",
        ["--user", "--collect", "--quiet", `--unit=workmesh-update-${Date.now()}`, ...setenv, `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, cmd, ...args],
        { stdio: "ignore", timeout: 15_000, env },
      );
      if (r.status === 0) return true;
    }
    const fd = fs.openSync(log, "a", 0o600);
    const child = spawn(cmd, args, { detached: true, stdio: ["ignore", fd, fd], env: { ...env, NO_COLOR: "1" } });
    child.on("error", () => {});
    child.unref();
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

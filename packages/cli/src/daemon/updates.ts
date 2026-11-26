import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { InstallInfo, InstallMethod } from "../lib/install-method";
import type { MenubarRead } from "../lib/registry";
import { RELEASE_KEYS } from "../lib/release-keys";
import type { LastUpdate, MenubarHeld, MenubarRelease, UpdateCheck } from "../lib/update-state";
import { readUpdateCheck, writeUpdateCheck } from "../lib/update-state";
import { compareVersions, isNewer, parseVersion, withinScope } from "../lib/versions";
import type { UpdateScope } from "../lib/versions";

/**
 * Update notices and opt-in auto-update in the daemon (SPEC §41). The newest version comes from the hub's
 * `latestClient` on `/relay/team` (SPEC §40) when the machine is paired, else from the npm registry at most every
 * 6 h; the menu bar's release zip from GitHub at most every 6 h (macOS). `GET /update` serves the result for the menu
 * bar, `status` and `doctor`. With `update.auto` on, the daemon starts `workmesh update --auto-run` at most once a day
 * for a release within the person's scope, and never again for a version that failed and was rolled back.
 *
 * Two rules keep a bad release from spreading on its own. A release is offered, and installed by auto-update, only
 * once it is older than the waiting time (`update.waitHours`, a day by default). And with maintainer keys pinned
 * (`lib/release-keys.ts`), the menu bar's zip is offered only from a release whose signed list names it.
 */

export const NPM_EVERY_MS = 6 * 3600_000;
export const MENUBAR_EVERY_MS = 6 * 3600_000;
export const AUTO_EVERY_MS = 24 * 3600_000;
/** First look a minute after start (not in the start's own rush), then every 15 minutes. */
export const FIRST_TICK_MS = 60_000;
export const TICK_MS = 15 * 60_000;

/**
 * When a release may be offered (SPEC §41, "Waiting time"): once it is older than the waiting time. Its age counts
 * from the publish time its source gives (npm for a version, GitHub for a release) or from when this daemon first saw
 * it, whichever is earlier. A release can't be seen before it is out, so a publish time that is missing, or later than
 * the first sight, never holds a release longer than the waiting time.
 */
export function releaseDue(r: { publishedAt?: number; seenAt?: number; waitMs: number; now: number }): { due: boolean; since: number; until: number } {
  const since = Math.min(r.publishedAt ?? Infinity, r.seenAt ?? r.now);
  const until = since + Math.max(0, r.waitMs);
  return { due: r.now >= until, since, until };
}

/** `GET /update`: what the menu bar, `status` and `doctor` read. */
export interface UpdateStatus {
  current: string;
  /** The newest version known, offered yet or not. */
  latest?: string;
  /** True once `latest` is newer than `current` and older than the waiting time: the menu bar, `status` and `doctor` offer it. */
  available: boolean;
  /** Set while `latest` is newer but younger than the waiting time: not offered until `until` (`since`: when it came out). */
  waiting?: { version: string; since: number; until: number };
  /** Hours a release waits before it is offered or installed on its own (config `update.waitHours`; 0: no wait). */
  waitHours: number;
  checkedAt?: number;
  source?: "hub" | "npm";
  install: { method: InstallMethod; canUpdate: boolean; hint?: string };
  /** argv that runs the update (node, the CLI, `update`), when this install can update itself. */
  run?: string[];
  auto: { enabled: boolean; scope: UpdateScope };
  last?: LastUpdate;
  /** Release signing: on once this version pins a maintainer key (`lib/release-keys.ts`). */
  signing: { on: boolean };
  /**
   * macOS: the latest release's menu bar app, once it may be offered. Its SHA-256 comes from the release's signed list
   * when signing is on (`signed`), else from GitHub.
   */
  menubar?: MenubarRelease;
  /** macOS: why the latest release's menu bar app is not offered (the signing check failed, or it is still waiting). */
  menubarHeld?: MenubarHeld;
}

export interface UpdateCheckerDeps {
  current: string;
  install: () => InstallInfo;
  /** The hub's `latestClient` and when the team view was read; undefined when not paired or the hub has none. */
  hubLatest: () => { version: string; at?: number } | undefined;
  settings: () => { enabled: boolean; scope: UpdateScope };
  /** Hours a release must be out before it is offered or installed on its own (config `update.waitHours`). */
  waitHours: () => number;
  /** The registry's latest version, and the publish times it gives. */
  fetchNpm: () => Promise<{ latest: string; published?: Record<string, number> }>;
  /** The latest release's menu bar zip, checked against the pinned keys; absent off macOS. */
  fetchMenubar?: () => Promise<MenubarRead>;
  /** Whether release signing is on (default: this version pins a key). */
  signing?: boolean;
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
  private readonly signing: boolean;
  private check: UpdateCheck;
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;

  constructor(deps: UpdateCheckerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.signing = deps.signing ?? RELEASE_KEYS.length > 0;
    this.check = readUpdateCheck(deps.file);
    // What an earlier version saved was checked by its rules. An offer no maintainer key vouched for is not served
    // once signing is on, and a hold from the signing check means nothing once it is off: read the release again.
    const stale = this.signing ? this.check.menubar !== undefined && !this.check.menubar.signed : this.check.menubarHeld !== undefined;
    if (stale) {
      delete this.check.menubar;
      delete this.check.menubarHeld;
      delete this.check.menubarAt;
    }
    // An offer saved by a version from before the waiting time has no age on record: read the release again for it.
    if (this.check.menubar && this.menubarSeenAt(this.check.menubar) === undefined) delete this.check.menubarAt;
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

  /** The waiting time in hours: what config says, never negative. */
  private waitHours(): number {
    const hours = this.deps.waitHours();
    return Number.isFinite(hours) && hours > 0 ? hours : 0;
  }

  private waitMs(): number {
    return this.waitHours() * 3600_000;
  }

  /** When this daemon first saw this zip (this version with this hash), if it has. */
  private menubarSeenAt(m: MenubarRelease): number | undefined {
    const s = this.check.menubarSeen;
    return s && s.version === m.version && s.sha256 === m.sha256 ? s.at : undefined;
  }

  /** Whether `version` is newer than this relay, and whether it is old enough to offer (`releaseDue`). */
  private offer(version: string | undefined, now: number): { newer: boolean; due: boolean; since: number; until: number } {
    const { published, seen } = this.check;
    return {
      newer: isNewer(version, this.deps.current),
      ...releaseDue({
        publishedAt: version !== undefined && published?.version === version ? published.at : undefined,
        seenAt: version !== undefined && seen?.version === version ? seen.at : undefined,
        waitMs: this.waitMs(),
        now,
      }),
    };
  }

  /** The menu bar's release when it may be offered, else why not. */
  private menubar(now: number): { release?: MenubarRelease; held?: MenubarHeld } {
    if (!this.deps.fetchMenubar) return {};
    const m = this.check.menubar;
    if (m && (!this.signing || m.signed)) {
      const seenAt = this.menubarSeenAt(m);
      // No age at all: an offer saved by a version from before the waiting time, served as it was until it is read again.
      if (m.publishedAt === undefined && seenAt === undefined) return { release: m };
      const d = releaseDue({ publishedAt: m.publishedAt, seenAt, waitMs: this.waitMs(), now });
      if (d.due) return { release: m };
      return { held: { version: m.version, reason: "waiting", detail: `it is younger than the ${this.waitHours()} h waiting time for new releases`, until: d.until } };
    }
    return this.signing && this.check.menubarHeld ? { held: this.check.menubarHeld } : {};
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
    // And for a newer version the hub named while the waiting time still holds it: the hub sends no publish time, and
    // without one the wait counts from when this daemon first saw the version.
    const hub = this.deps.hubLatest();
    const hubKnows = hub !== undefined && compareVersions(hub.version, this.deps.current) >= 0;
    const hubOffer = hubKnows ? this.offer(hub.version, now) : undefined;
    const hubAge = hubOffer !== undefined && hubOffer.newer && !hubOffer.due && this.check.published?.version !== hub?.version;
    let published: Record<string, number> = {};
    if ((!hubKnows || hubAge) && now - (this.check.npmAt ?? 0) >= NPM_EVERY_MS) {
      this.check.npmAt = now;
      dirty = true;
      try {
        const r = await this.deps.fetchNpm();
        if (parseVersion(r.latest)) {
          this.check.npmLatest = r.latest;
          this.check.checkedAt = this.now();
        }
        published = r.published ?? {};
      } catch (err) {
        this.deps.log?.(`update check: npm registry unreadable (${err instanceof Error ? err.message : String(err)}); next try in 6 h`);
      }
    }
    if (this.deps.fetchMenubar && now - (this.check.menubarAt ?? 0) >= MENUBAR_EVERY_MS) {
      this.check.menubarAt = now;
      dirty = true;
      try {
        const r = await this.deps.fetchMenubar();
        if (r.kind === "offer") {
          if (this.menubarSeenAt(r.release) === undefined) this.check.menubarSeen = { version: r.release.version, sha256: r.release.sha256, at: now };
          this.check.menubar = r.release;
          delete this.check.menubarHeld;
        } else if (r.kind === "held") {
          // A release that fails the signing check offers nothing, the app of an earlier release included.
          delete this.check.menubar;
          this.check.menubarHeld = r.held;
          this.deps.log?.(`update check: the menu bar app${r.held.version ? ` in release ${r.held.version}` : ""} is not offered: ${r.held.detail}`);
        } else {
          delete this.check.menubarHeld;
        }
      } catch (err) {
        this.deps.log?.(`update check: GitHub release unreadable (${err instanceof Error ? err.message : String(err)}); next try in 6 h`);
      }
    }
    const l = this.latest();
    if (l.version) {
      // When this daemon first saw the newest version, and the registry's publish time for it when it gave one.
      if (this.check.seen?.version !== l.version) {
        this.check.seen = { version: l.version, at: now };
        dirty = true;
      }
      const at = published[l.version];
      if (at !== undefined && (this.check.published?.version !== l.version || this.check.published.at !== at)) {
        this.check.published = { version: l.version, at };
        dirty = true;
      }
    }
    if (l.version && (l.version !== this.check.latest || l.source !== this.check.source)) {
      this.check.latest = l.version;
      this.check.source = l.source;
      if (l.at) this.check.checkedAt = l.at;
      dirty = true;
      const o = this.offer(l.version, now);
      const wait = o.due ? "" : `; offered from ${new Date(o.until).toISOString()}, new releases wait ${this.waitHours()} h`;
      if (o.newer) this.deps.log?.(`update: Workmesh ${l.version} is out (this is ${this.deps.current}; from ${l.source}${wait})`);
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

  /**
   * Auto-update is on, this install can update, a release within scope is out and older than the waiting time, and
   * none was tried in 24 h.
   */
  autoDue(now = this.now()): boolean {
    const s = this.deps.settings();
    if (!s.enabled) return false;
    const install = this.deps.install();
    if (!install.canUpdate) return false;
    const to = this.latest().version;
    if (!to || !withinScope(this.deps.current, to, s.scope)) return false;
    if (!this.offer(to, now).due) return false;
    if (now - (this.check.autoAt ?? 0) < AUTO_EVERY_MS) return false;
    // A version that failed its checks and was rolled back is never retried on its own; a newer one is.
    const last = this.deps.lastRun();
    if (last && !last.ok && last.to === to) return false;
    return true;
  }

  status(): UpdateStatus {
    const now = this.now();
    const install = this.deps.install();
    const l = this.latest();
    const last = this.deps.lastRun();
    const o = this.offer(l.version, now);
    const menubar = this.menubar(now);
    return {
      current: this.deps.current,
      ...(l.version ? { latest: l.version } : {}),
      available: o.newer && o.due,
      ...(l.version && o.newer && !o.due ? { waiting: { version: l.version, since: o.since, until: o.until } } : {}),
      waitHours: this.waitHours(),
      ...(l.at ?? this.check.checkedAt ? { checkedAt: l.at ?? this.check.checkedAt } : {}),
      ...(l.source ? { source: l.source } : {}),
      install: { method: install.method, canUpdate: install.canUpdate, ...(install.hint ? { hint: install.hint } : {}) },
      ...(install.canUpdate ? { run: this.deps.runArgv } : {}),
      auto: this.deps.settings(),
      ...(last ? { last } : {}),
      signing: { on: this.signing },
      ...(menubar.release ? { menubar: menubar.release } : {}),
      ...(menubar.held ? { menubarHeld: menubar.held } : {}),
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

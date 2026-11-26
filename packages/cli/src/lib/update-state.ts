import { readStateFile, writeStateFile } from "../hub/persist";
import { parseVersion } from "./versions";
import { updateCheckPath, updateStatePath } from "./paths";

/**
 * The small state files behind keeping current (SPEC §41). `update.json` is the CLI's (what `workmesh update` last
 * did, and the version whose setup steps last ran on this machine); `update-check.json` is the daemon's (the newest
 * version it knows of, where from, and the menu bar's release). Both 0600, written atomically, read leniently.
 */

export interface LastUpdate {
  at: number;
  ok: boolean;
  from: string;
  to: string;
  rolledBack?: boolean;
  /** One line: what happened. */
  message?: string;
  /** The daemon started it (`--auto on`). */
  auto?: boolean;
}

export interface UpdateState {
  /** The version whose setup steps (hooks, MCP, service, daemon restart) last ran here. */
  setup?: string;
  setupAt?: number;
  last?: LastUpdate;
}

export interface MenubarRelease {
  version: string;
  url: string;
  /**
   * 64 lowercase hex: the zip's SHA-256. From the release's signed list when `signed`, else the digest GitHub lists
   * for the asset.
   */
  sha256: string;
  size?: number;
  releaseUrl: string;
  /** A pinned maintainer key signed the list this hash came from (SPEC §41, "Signed releases"). */
  signed?: true;
  /** When GitHub says the release went out, or its zip last changed if that is later (ms). */
  publishedAt?: number;
}

/**
 * Why the latest release's menu bar app is not offered: its list is missing, not signed by a pinned key, not a list,
 * for another version, or names another file than the one GitHub serves; or the release is younger than the waiting
 * time (`until` says when it is offered).
 */
export type MenubarHeldReason = "unsigned" | "bad-signature" | "bad-list" | "wrong-version" | "hash-mismatch" | "waiting";

export interface MenubarHeld {
  version?: string;
  reason: MenubarHeldReason;
  /** One plain sentence, for `status` and `doctor`. */
  detail: string;
  until?: number;
}

const HELD_REASONS: readonly MenubarHeldReason[] = ["unsigned", "bad-signature", "bad-list", "wrong-version", "hash-mismatch", "waiting"];

/** A version and a moment that belongs to it (first seen, published). */
export interface VersionTime {
  version: string;
  at: number;
}

export interface UpdateCheck {
  latest?: string;
  source?: "hub" | "npm";
  checkedAt?: number;
  /** Last npm registry attempt (successful or not): at most one every 6 h. */
  npmAt?: number;
  /** The newest version npm itself reported (kept apart from the hub's). */
  npmLatest?: string;
  /** When this daemon first saw the newest version it knows: its age when the registry gives no publish time. */
  seen?: VersionTime;
  /** When the registry says that version was published. */
  published?: VersionTime;
  menubar?: MenubarRelease;
  /** When this daemon first saw `menubar`'s version with this hash. */
  menubarSeen?: VersionTime & { sha256: string };
  /** Why the latest release's menu bar app is not offered (a release that failed the signing check). */
  menubarHeld?: MenubarHeld;
  /** Last GitHub release read attempt. */
  menubarAt?: number;
  /** Last update the daemon started on its own, and to which version. */
  autoAt?: number;
  autoTo?: string;
}

const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const ver = (v: unknown): string | undefined => (typeof v === "string" && parseVersion(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function readLast(v: unknown): LastUpdate | undefined {
  const o = obj(v);
  const at = num(o?.at);
  const from = str(o?.from, 40);
  const to = str(o?.to, 40);
  if (!o || at === undefined || !from || !to || typeof o.ok !== "boolean") return undefined;
  return {
    at,
    ok: o.ok,
    from,
    to,
    ...(o.rolledBack === true ? { rolledBack: true } : {}),
    ...(str(o.message, 500) ? { message: str(o.message, 500) } : {}),
    ...(o.auto === true ? { auto: true } : {}),
  };
}

export function readUpdateState(file = updateStatePath()): UpdateState {
  const o = obj(readStateFile(file));
  if (!o) return {};
  const out: UpdateState = {};
  const setup = ver(o.setup);
  if (setup) out.setup = setup;
  const setupAt = num(o.setupAt);
  if (setupAt !== undefined) out.setupAt = setupAt;
  const last = readLast(o.last);
  if (last) out.last = last;
  return out;
}

export function writeUpdateState(patch: Partial<UpdateState>, file = updateStatePath()): UpdateState {
  const next = { ...readUpdateState(file), ...patch };
  try {
    writeStateFile(file, next);
  } catch {
    // best effort: a read-only state dir only costs the record
  }
  return next;
}

/** Records that `version`'s setup steps ran on this machine (init, setup, update). */
export function markSetup(version: string, now = Date.now(), file = updateStatePath()): void {
  writeUpdateState({ setup: version, setupAt: now }, file);
}

const SHA256_RE = /^[0-9a-f]{64}$/;

export function readMenubarRelease(v: unknown): MenubarRelease | undefined {
  const o = obj(v);
  const version = ver(o?.version);
  const url = str(o?.url, 500);
  const sha256 = str(o?.sha256, 64);
  const releaseUrl = str(o?.releaseUrl, 500);
  if (!o || !version || !url || !sha256 || !SHA256_RE.test(sha256) || !releaseUrl) return undefined;
  const size = num(o.size);
  const publishedAt = num(o.publishedAt);
  return {
    version,
    url,
    sha256,
    releaseUrl,
    ...(size !== undefined ? { size } : {}),
    ...(o.signed === true ? { signed: true as const } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  };
}

export function readMenubarHeld(v: unknown): MenubarHeld | undefined {
  const o = obj(v);
  const reason = HELD_REASONS.find((r) => r === o?.reason);
  const detail = str(o?.detail, 500);
  if (!o || !reason || !detail) return undefined;
  const version = ver(o.version);
  const until = num(o.until);
  return { reason, detail, ...(version ? { version } : {}), ...(until !== undefined ? { until } : {}) };
}

function readVersionTime(v: unknown): VersionTime | undefined {
  const o = obj(v);
  const version = ver(o?.version);
  const at = num(o?.at);
  return version && at !== undefined ? { version, at } : undefined;
}

export function readUpdateCheck(file = updateCheckPath()): UpdateCheck {
  const o = obj(readStateFile(file));
  if (!o) return {};
  const out: UpdateCheck = {};
  const latest = ver(o.latest);
  if (latest) out.latest = latest;
  if (o.source === "hub" || o.source === "npm") out.source = o.source;
  for (const k of ["checkedAt", "npmAt", "menubarAt", "autoAt"] as const) {
    const n = num(o[k]);
    if (n !== undefined) out[k] = n;
  }
  const npmLatest = ver(o.npmLatest);
  if (npmLatest) out.npmLatest = npmLatest;
  const autoTo = ver(o.autoTo);
  if (autoTo) out.autoTo = autoTo;
  const seen = readVersionTime(o.seen);
  if (seen) out.seen = seen;
  const published = readVersionTime(o.published);
  if (published) out.published = published;
  const menubar = readMenubarRelease(o.menubar);
  if (menubar) out.menubar = menubar;
  const menubarSeen = readVersionTime(o.menubarSeen);
  const seenSha = str(obj(o.menubarSeen)?.sha256, 64);
  if (menubarSeen && seenSha && SHA256_RE.test(seenSha)) out.menubarSeen = { ...menubarSeen, sha256: seenSha };
  const menubarHeld = readMenubarHeld(o.menubarHeld);
  if (menubarHeld) out.menubarHeld = menubarHeld;
  return out;
}

export function writeUpdateCheck(value: UpdateCheck, file = updateCheckPath()): void {
  try {
    writeStateFile(file, value);
  } catch {
    // best effort
  }
}

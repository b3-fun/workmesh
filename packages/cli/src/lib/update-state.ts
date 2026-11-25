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
  /** 64 lowercase hex: the release asset's SHA-256 digest. */
  sha256: string;
  size?: number;
  releaseUrl: string;
}

export interface UpdateCheck {
  latest?: string;
  source?: "hub" | "npm";
  checkedAt?: number;
  /** Last npm registry attempt (successful or not): at most one every 6 h. */
  npmAt?: number;
  /** The newest version npm itself reported (kept apart from the hub's). */
  npmLatest?: string;
  menubar?: MenubarRelease;
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
  return { version, url, sha256, releaseUrl, ...(size !== undefined ? { size } : {}) };
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
  const menubar = readMenubarRelease(o.menubar);
  if (menubar) out.menubar = menubar;
  return out;
}

export function writeUpdateCheck(value: UpdateCheck, file = updateCheckPath()): void {
  try {
    writeStateFile(file, value);
  } catch {
    // best effort
  }
}

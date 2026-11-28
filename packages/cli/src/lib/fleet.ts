import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  HubCapacityBucket,
  HubCapacityProvider,
  HubCapacityReport,
  HubCapacityShareLevel,
  HubPoolMode,
  HubQuotaMode,
  HubTaskKind,
} from "@workmesh/protocol";
import { HUB_CAPACITY_BUCKETS, HUB_CAPACITY_PROVIDERS, HUB_QUOTA_MODES } from "@workmesh/protocol";

/**
 * Reads qswap's secret-free `~/.ai-quota-swap/fleet_status.json` snapshot.
 * Cached by mtime so daemon ticks, pool-rule checks, and MCP `fleet_status` stay sub-millisecond.
 */

export interface FleetProviderStatus {
  id: HubCapacityProvider;
  displayName: string;
  cli: string;
  harnessAgent: string;
  installed: boolean;
  quotaMode: HubQuotaMode;
  headroomPct: number | null;
  poolHeadroomPct: number | null;
  bucket: HubCapacityBucket;
  tight: boolean;
  nextResetAt?: string | null;
  resetsInSec?: number | null;
  resetCountdown?: string | null;
  expiringResets: Array<{ kind: string; scope: string; count: number; endsAt?: string | null; endsInSec?: number | null }>;
  todayCostUsd?: number;
  sevenDayCostUsd?: number;
  models?: string[];
}

export interface FleetRouteChoice {
  provider: HubCapacityProvider;
  score: number;
  headroomPct: number | null;
  bucket: HubCapacityBucket;
  reason: string;
  cli: string;
  harnessAgent: string;
  expiringCredits: number;
  resetsInSec: number | null;
}

export interface FleetSnapshot {
  schemaVersion: number;
  updatedAt: string;
  updatedAtMs: number;
  todayUsd: number | null;
  sevenDayUsd: number | null;
  providers: Partial<Record<HubCapacityProvider, FleetProviderStatus>>;
  recommendations: Partial<Record<HubTaskKind, FleetRouteChoice[]>>;
  alerts: Array<{ kind: string; provider: string; message: string; headroomPct?: number; resetsInSec?: number; count?: number }>;
}

const VALID_PROVIDERS = new Set<string>(HUB_CAPACITY_PROVIDERS);
const VALID_BUCKETS = new Set<string>(HUB_CAPACITY_BUCKETS);
const VALID_QUOTA_MODES = new Set<string>(HUB_QUOTA_MODES);

export function defaultFleetStatusPath(home = os.homedir()): string {
  return process.env.QSWAP_FLEET_STATUS?.trim() || path.join(home, ".ai-quota-swap", "fleet_status.json");
}

let cached: { file: string; mtimeMs: number; snap: FleetSnapshot } | undefined;

export function readFleetStatus(file = defaultFleetStatusPath()): FleetSnapshot | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  if (cached && cached.file === file && cached.mtimeMs === stat.mtimeMs) return cached.snap;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || typeof raw.providers !== "object" || !raw.providers) return undefined;
    const providers: Partial<Record<HubCapacityProvider, FleetProviderStatus>> = {};
    for (const [key, val] of Object.entries(raw.providers as Record<string, unknown>)) {
      if (!VALID_PROVIDERS.has(key) || !val || typeof val !== "object") continue;
      const v = val as Record<string, unknown>;
      const bucket = typeof v.bucket === "string" && VALID_BUCKETS.has(v.bucket) ? (v.bucket as HubCapacityBucket) : "unavailable";
      const quotaMode = typeof v.quotaMode === "string" && VALID_QUOTA_MODES.has(v.quotaMode) ? (v.quotaMode as HubQuotaMode) : "inferred";
      providers[key as HubCapacityProvider] = {
        id: key as HubCapacityProvider,
        displayName: typeof v.displayName === "string" ? v.displayName : key,
        cli: typeof v.cli === "string" ? v.cli : key,
        harnessAgent: typeof v.harnessAgent === "string" ? v.harnessAgent : key,
        installed: Boolean(v.installed),
        quotaMode,
        headroomPct: typeof v.headroomPct === "number" ? v.headroomPct : null,
        poolHeadroomPct: typeof v.poolHeadroomPct === "number" ? v.poolHeadroomPct : null,
        bucket,
        tight: Boolean(v.tight),
        nextResetAt: typeof v.nextResetAt === "string" ? v.nextResetAt : null,
        resetsInSec: typeof v.resetsInSec === "number" ? v.resetsInSec : null,
        resetCountdown: typeof v.resetCountdown === "string" ? v.resetCountdown : null,
        expiringResets: Array.isArray(v.expiringResets)
          ? (v.expiringResets as FleetProviderStatus["expiringResets"])
          : [],
        ...(typeof v.todayCostUsd === "number" ? { todayCostUsd: v.todayCostUsd } : {}),
        ...(typeof v.sevenDayCostUsd === "number" ? { sevenDayCostUsd: v.sevenDayCostUsd } : {}),
        ...(Array.isArray(v.models) ? { models: v.models.filter((m): m is string => typeof m === "string") } : {}),
      };
    }
    const snap: FleetSnapshot = {
      schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(stat.mtimeMs).toISOString(),
      updatedAtMs: typeof raw.updatedAtMs === "number" ? raw.updatedAtMs : Math.round(stat.mtimeMs),
      todayUsd: typeof raw.todayUsd === "number" ? raw.todayUsd : null,
      sevenDayUsd: typeof raw.sevenDayUsd === "number" ? raw.sevenDayUsd : null,
      providers,
      recommendations:
        raw.recommendations && typeof raw.recommendations === "object"
          ? (raw.recommendations as FleetSnapshot["recommendations"])
          : {},
      alerts: Array.isArray(raw.alerts) ? (raw.alerts as FleetSnapshot["alerts"]) : [],
    };
    cached = { file, mtimeMs: stat.mtimeMs, snap };
    return snap;
  } catch {
    return undefined;
  }
}

export function resetFleetCache(): void {
  cached = undefined;
}

export function expiringCreditsOf(p: FleetProviderStatus): number {
  return p.expiringResets.reduce((sum, g) => sum + (typeof g.count === "number" && g.count > 0 ? g.count : 0), 0);
}

/** True when unused quota resets within 12h or the provider holds expiring reset credits. */
export function hasExpiringValue(p: FleetProviderStatus): boolean {
  if (expiringCreditsOf(p) > 0) return true;
  return typeof p.resetsInSec === "number" && p.resetsInSec > 0 && p.resetsInSec <= 12 * 3600;
}

/**
 * Pick the best provider from a fleet snapshot for a task kind, honoring an optional allowlist and headroom floor.
 */
export function pickBestProvider(
  fleet: FleetSnapshot | undefined,
  opts: {
    taskKind?: HubTaskKind;
    allowed?: readonly HubCapacityProvider[];
    caller?: string;
    minHeadroom?: number;
    expiringFloor?: number;
  } = {},
): FleetRouteChoice | undefined {
  if (!fleet) return undefined;
  const kind: HubTaskKind = opts.taskKind ?? "coding";
  const allowSet = opts.allowed && opts.allowed.length > 0 ? new Set(opts.allowed) : undefined;
  const recs = fleet.recommendations[kind] ?? fleet.recommendations.coding ?? [];

  const eligible = (pid: HubCapacityProvider): boolean => {
    if (allowSet && !allowSet.has(pid)) return false;
    const p = fleet.providers[pid];
    if (!p || !p.installed || p.bucket === "unavailable" || p.bucket === "exhausted") return false;
    const floor = hasExpiringValue(p) && opts.expiringFloor !== undefined ? opts.expiringFloor : (opts.minHeadroom ?? 0);
    if (p.headroomPct !== null && p.headroomPct < floor) return false;
    return true;
  };

  for (const choice of recs) {
    if (!eligible(choice.provider)) continue;
    if (kind === "review" && opts.caller && choice.provider === opts.caller) continue;
    return choice;
  }
  // Second pass if review had only the caller eligible.
  for (const choice of recs) {
    if (eligible(choice.provider)) return choice;
  }
  // Fallback directly over providers map if recommendations wasn't populated.
  for (const pid of HUB_CAPACITY_PROVIDERS) {
    if (!eligible(pid)) continue;
    const p = fleet.providers[pid]!;
    return {
      provider: pid,
      score: (p.headroomPct ?? 50) / 100,
      headroomPct: p.headroomPct,
      bucket: p.bucket,
      reason: p.headroomPct !== null ? `${Math.round(p.headroomPct)}% free` : p.bucket,
      cli: p.cli,
      harnessAgent: p.harnessAgent,
      expiringCredits: expiringCreditsOf(p),
      resetsInSec: p.resetsInSec ?? null,
    };
  }
  return undefined;
}

/**
 * Build the opt-in wire capacity report for `POST /relay/ingest` (SPEC §57).
 * Returns undefined when `share === "off"` or when no fleet snapshot exists.
 */
export function buildCapacityReport(
  fleet: FleetSnapshot | undefined,
  share: HubCapacityShareLevel,
  poolModesByProvider: Partial<Record<HubCapacityProvider, HubPoolMode[]>> = {},
): HubCapacityReport | undefined {
  if (share === "off" || !fleet) return undefined;
  const providers: HubCapacityReport["providers"] = [];
  for (const pid of HUB_CAPACITY_PROVIDERS) {
    const p = fleet.providers[pid];
    if (!p || !p.installed) continue;
    const modes = poolModesByProvider[pid];
    const credits = expiringCreditsOf(p);
    providers.push({
      id: pid,
      bucket: p.bucket,
      ...(share === "detailed" && p.headroomPct !== null ? { headroomPct: Math.max(0, Math.min(100, p.headroomPct)) } : {}),
      ...(typeof p.resetsInSec === "number" && p.resetsInSec >= 0 ? { resetsInSec: Math.round(p.resetsInSec) } : {}),
      ...(credits > 0 ? { expiringCredits: credits } : {}),
      ...(modes && modes.length > 0 ? { acceptsPool: modes } : {}),
      quotaMode: p.quotaMode,
    });
  }
  return {
    share,
    updatedAt: Math.round(fleet.updatedAtMs),
    ...(share === "detailed" && typeof fleet.todayUsd === "number" ? { todayUsd: Math.max(0, fleet.todayUsd) } : {}),
    ...(share === "detailed" && typeof fleet.sevenDayUsd === "number" ? { sevenDayUsd: Math.max(0, fleet.sevenDayUsd) } : {}),
    providers,
  };
}

/** Human-readable multi-provider fleet summary for CLI and MCP `fleet_status`. */
export function formatFleetSummary(fleet: FleetSnapshot | undefined): string {
  if (!fleet) {
    return "No qswap fleet snapshot found (~/.ai-quota-swap/fleet_status.json). Run `qswap where` or start the qswap menu bar.";
  }
  const lines = ["Fleet capacity (from qswap):"];
  for (const pid of HUB_CAPACITY_PROVIDERS) {
    const p = fleet.providers[pid];
    if (!p || !p.installed) continue;
    const hr = p.headroomPct !== null ? `${p.headroomPct.toFixed(0)}% free` : p.bucket;
    const extras: string[] = [p.bucket, hr];
    if (p.resetCountdown) extras.push(`resets in ${p.resetCountdown}`);
    const credits = expiringCreditsOf(p);
    if (credits > 0) extras.push(`${credits} reset credit${credits === 1 ? "" : "s"}`);
    if (p.models?.length) extras.push(p.models[0]!);
    lines.push(`- ${p.displayName} (${p.id}): ${extras.join(" · ")}`);
  }
  const topCoding = fleet.recommendations.coding?.[0];
  const topReview = fleet.recommendations.review?.[0];
  if (topCoding) lines.push(`Best for coding: ${topCoding.provider} (${topCoding.reason})`);
  if (topReview) lines.push(`Best for review: ${topReview.provider} (${topReview.reason})`);
  if (fleet.alerts.length > 0) {
    for (const a of fleet.alerts) lines.push(`Heads up: ${a.message}`);
  }
  return lines.join("\n");
}

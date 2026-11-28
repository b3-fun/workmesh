import type {
  HubCapacityProvider,
  HubHandoffAccepted,
  HubPoolMode,
  HubTaskKind,
} from "@workmesh/protocol";
import { HUB_CAPACITY_PROVIDERS } from "@workmesh/protocol";
import { hasExpiringValue, pickBestProvider } from "../lib/fleet";
import type { FleetSnapshot } from "../lib/fleet";

/**
 * Opt-in local delegation pool rules (SPEC §58).
 *
 * Allows a machine owner to opt in (at their own terminal only — never set by the hub or an agent)
 * to automatically accept and execute teammates' delegated tasks (both `readonly` and `worktree` PR
 * tasks) on selected subscriptions when live `qswap` headroom stays above their reserve floor.
 */

export interface PoolRule {
  /** `"team"` for any teammate on the hub, or an exact teammate email. */
  from: string;
  /** Which providers/subscriptions this rule may use on this machine. */
  providers: HubCapacityProvider[];
  /** Allowed execution modes: `"readonly"` and/or `"worktree"`. */
  modes: HubPoolMode[];
  /** Optional repo filter: `"owner/name"` or `"owner/*"`. Absent = any shared repo. */
  repo?: string;
  /** Keep at least this % headroom for the machine owner (0–95, default 30). */
  minHeadroom: number;
  /** Lower floor when quota resets within 12h or has expiring reset credits (0–95, default 10). */
  expiringFloor: number;
  /** Max pooled tasks accepted per local day under this rule (1–100). */
  perDay: number;
}

export interface PoolSettings {
  enabled: boolean;
  rules: PoolRule[];
}

export const POOL_RULES_MAX = 20;
export const POOL_RULE_PER_DAY_MAX = 100;

export function poolRuleKey(r: PoolRule): string {
  return `pool|${r.from.toLowerCase()}|${(r.repo ?? "*").toLowerCase()}|${[...r.providers].sort().join(",")}|${[...r.modes].sort().join(",")}|${r.minHeadroom}|${r.perDay}`;
}

export function poolRuleWords(r: PoolRule): string {
  const who = r.from.toLowerCase() === "team" ? "teammates" : r.from;
  const provs = r.providers.join(", ");
  const modes = r.modes.join("+");
  const repo = r.repo ? ` in ${r.repo}` : "";
  return `${who} on ${provs} (${modes}${repo}, >=${r.minHeadroom}% free, max ${r.perDay}/day)`;
}

function repoMatches(pattern: string | undefined, repo: string | undefined): boolean {
  if (!pattern) return true;
  if (!repo) return false;
  const p = pattern.toLowerCase();
  const r = repo.toLowerCase();
  if (p === r) return true;
  if (p.endsWith("/*")) return r.startsWith(p.slice(0, -1));
  return false;
}

/**
 * Compute which pool modes each provider accepts across the active pool rules and live fleet headroom.
 * Used to advertise `acceptsPool` on opt-in capacity heartbeats.
 */
export function advertisedPoolModes(
  pool: PoolSettings,
  fleet: FleetSnapshot | undefined,
): Partial<Record<HubCapacityProvider, HubPoolMode[]>> {
  if (!pool.enabled || pool.rules.length === 0) return {};
  const out: Partial<Record<HubCapacityProvider, HubPoolMode[]>> = {};
  for (const pid of HUB_CAPACITY_PROVIDERS) {
    const p = fleet?.providers[pid];
    const modes = new Set<HubPoolMode>();
    for (const rule of pool.rules) {
      if (!rule.providers.includes(pid)) continue;
      if (p) {
        if (!p.installed || p.bucket === "unavailable" || p.bucket === "exhausted") continue;
        const floor = hasExpiringValue(p) ? rule.expiringFloor : rule.minHeadroom;
        if (p.headroomPct !== null && p.headroomPct < floor) continue;
      }
      for (const m of rule.modes) modes.add(m);
    }
    if (modes.size > 0) out[pid] = [...modes];
  }
  return out;
}

export interface PoolMatch {
  rule: PoolRule;
  provider: HubCapacityProvider;
  reason: string;
}

/**
 * Find the first local pool rule that accepts a teammate's handoff right now, plus the chosen provider
 * based on live `qswap` headroom & expiry urgency.
 */
export function matchPoolRule(
  pool: PoolSettings,
  h: Pick<HubHandoffAccepted, "from" | "repo" | "mode" | "preferredAgent" | "taskKind" | "pool">,
  fleet: FleetSnapshot | undefined,
  usedToday: (key: string) => number,
): PoolMatch | undefined {
  if (!pool.enabled || pool.rules.length === 0) return undefined;
  const fromEmail = h.from.email?.toLowerCase();
  if (!fromEmail) return undefined;
  const mode: HubPoolMode = h.mode ?? "worktree";
  const taskKind: HubTaskKind = h.taskKind ?? "coding";

  for (const r of pool.rules) {
    const ruleFrom = r.from.toLowerCase();
    if (ruleFrom !== "team" && ruleFrom !== fromEmail) continue;
    if (!repoMatches(r.repo, h.repo)) continue;
    if (!r.modes.includes(mode)) continue;
    if (usedToday(poolRuleKey(r)) >= r.perDay) continue;

    // If the handoff asked for a specific provider, check if this rule permits it with sufficient headroom.
    const preferred =
      h.preferredAgent && h.preferredAgent !== "harness"
        ? (h.preferredAgent as HubCapacityProvider)
        : undefined;
    const allowed: HubCapacityProvider[] = preferred
      ? (r.providers.includes(preferred) ? [preferred] : [])
      : r.providers;
    if (allowed.length === 0) continue;

    if (fleet) {
      const picked = pickBestProvider(fleet, {
        taskKind,
        allowed,
        minHeadroom: r.minHeadroom,
        expiringFloor: r.expiringFloor,
      });
      if (!picked) continue;
      return { rule: r, provider: picked.provider, reason: picked.reason };
    }
    // No fleet_status.json yet: allow only if rule has minHeadroom === 0.
    if (r.minHeadroom === 0 && allowed[0]) {
      return { rule: r, provider: allowed[0], reason: "pool rule (no quota floor)" };
    }
  }
  return undefined;
}

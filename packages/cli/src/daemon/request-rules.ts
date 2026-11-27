import type { HubHandoffAccepted, HubRequestSize } from "@workmesh/protocol";
import { HUB_REQUEST_SIZES } from "@workmesh/protocol";

/**
 * Standing rules for requests (docs/SPEC.md §56). A request is work a teammate without a relay asked for (a PM, ops,
 * design); the hub offers it as a handoff in their name (§55). The person at this machine may let it accept some of
 * them with no click: from one person (by exact email), optionally in one repo, up to a size, at most so many a day.
 * The rules live in this machine's config and only the person adds them, at its terminal with a yes
 * (`workmesh handoffs rule add`): never the hub, never a requester, never an agent. The machine checks every rule
 * itself, against the handoff as the hub lists it, and counts its own accepts.
 */

export interface RequestRule {
  /** Whose requests: an exact email. */
  from: string;
  /** Only in this repo (`owner/name`); absent: any repo. */
  repo?: string;
  /** Up to this size; a request with no size estimate never matches. */
  maxSize: HubRequestSize;
  /** At most this many a day (this machine's local day). */
  perDay: number;
}

export const REQUEST_RULES_MAX = 20;
export const REQUEST_RULE_PER_DAY_MAX = 50;

const sizeRank = (s: HubRequestSize | undefined): number => (s ? HUB_REQUEST_SIZES.indexOf(s) : -1);

/** The rule in words, as the hub, the board and this machine's notices say it. */
export function ruleWords(r: RequestRule): string {
  const size = r.maxSize === "large" ? "requests of any size" : r.maxSize === "medium" ? "small and medium requests" : "small requests";
  return `${size} from ${r.from}${r.repo ? ` in ${r.repo}` : ""}, at most ${r.perDay} a day`;
}

/** A rule's identity, for counting its accepts (the same rule written again counts as the same rule). */
export function ruleKey(r: RequestRule): string {
  return `${r.from.toLowerCase()}|${(r.repo ?? "").toLowerCase()}|${r.maxSize}|${r.perDay}`;
}

/**
 * The first rule that takes this handoff, or undefined. Only a request (`request` on the handoff) sent by someone with
 * an email the hub gave (`from.email`, §48) can match, and only by that exact email: a display name never does. The
 * repo must be the rule's when it names one, and the hub's size estimate must be at most the rule's. `used(key)`
 * says how many the rule accepted today; a rule at its count is skipped.
 */
export function matchRule(
  rules: readonly RequestRule[],
  h: Pick<HubHandoffAccepted, "request" | "from" | "repo">,
  used: (key: string) => number,
): RequestRule | undefined {
  if (!h.request) return undefined;
  const from = h.from.email?.toLowerCase();
  if (!from) return undefined;
  for (const r of rules) {
    if (r.from.toLowerCase() !== from) continue;
    if (r.repo && r.repo.toLowerCase() !== (h.repo ?? "").toLowerCase()) continue;
    if (sizeRank(h.request.size) < 0 || sizeRank(h.request.size) > sizeRank(r.maxSize)) continue;
    if (used(ruleKey(r)) >= r.perDay) continue;
    return r;
  }
  return undefined;
}

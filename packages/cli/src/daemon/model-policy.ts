import { HUB_EFFORTS } from "@workmesh/protocol";
import type { HubAgent, HubEffort, HubModelSuggestionAccepted, HubRequestSize } from "@workmesh/protocol";

/**
 * Model choice per handoff, this machine's side (docs/SPEC.md §67, B3-7275). A handoff, a review or a request may
 * carry a suggestion of the agent CLI, model and effort to run it on (§66): the sender's, or the project's (an admin's
 * defaults by a request's size, or for reviews). **This machine decides.** Its person's policy (`handoffs.models` in
 * the config, set only at this machine's terminal) lists the agents and models it runs, cheapest first, the default
 * for each size, and a ceiling: the most a suggestion from anyone else may ask for. A suggestion above the ceiling is
 * lowered; one this machine can't follow is set aside; and the accept card says which ("Asked for Opus; runs on
 * Sonnet, your ceiling"). With no policy, a suggestion is shown and never followed: the run is what it always was.
 *
 * Pure: the runner (daemon/handoff-runner.ts) calls it for the card a person reads before they accept, and again when
 * it starts the run, so the card shows the model that runs.
 */

export interface ModelChoice {
  agent?: HubAgent;
  model?: string;
  effort?: HubEffort;
}

/** The sizes a default can be set for: a request's three (§55), a review, and everything else. */
export const MODEL_SLOTS = ["small", "medium", "large", "review", "other"] as const;
export type ModelSlot = (typeof MODEL_SLOTS)[number];

/** `handoffs.models` in the config. */
export interface ModelPolicy {
  /** The agents this machine runs handoffs on, each with its models, cheapest first. An agent left out isn't used. */
  allow?: Partial<Record<HubAgent, string[]>>;
  /** The most a suggestion from someone else (or the project) may ask for: a model per agent, and an effort. */
  ceiling?: Partial<Record<HubAgent, string>> & { effort?: HubEffort };
  /** What runs when nothing is suggested, per size (`other`: a handoff that isn't a request or a review). */
  defaults?: Partial<Record<ModelSlot, ModelChoice>>;
}

export interface ModelResolution {
  agent: HubAgent;
  /** Absent: the agent's own default model. */
  model?: string;
  effort?: HubEffort;
  /** The suggestion, as the hub listed it. */
  asked?: ModelChoice;
  /** Every suggested field ran as asked (only when something was suggested). */
  followed?: boolean;
  /** Something suggested ran lower than asked: the ceiling, or a model this machine doesn't run. */
  lowered?: boolean;
  /** One sentence for the accept card when the run differs from the suggestion, e.g. "Asked for Opus; runs on Sonnet, your ceiling." */
  note?: string;
}

export const AGENT_NAMES: Record<HubAgent, string> = { claude: "Claude Code", codex: "Codex" };
const AGENTS: readonly HubAgent[] = ["claude", "codex"];
const ALIASES: Record<string, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable" };

/** A model as a person reads it: Claude Code's aliases capitalised, anything else as written. */
export function modelWords(model: string): string {
  return ALIASES[model.toLowerCase()] ?? model;
}

const effortRank = (e: HubEffort): number => HUB_EFFORTS.indexOf(e);

const tokens = (m: string): string[] => m.toLowerCase().split(/[-_.:/[\]\s]+/).filter(Boolean);

/**
 * Whether two model names mean the same model: the same name (any case), or an alias (`opus`) and a full id that
 * carries it as one of its words (`claude-opus-5-5`). `gpt-5.5` and `gpt-5.5-mini` are different models.
 */
export function sameModel(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const st = tokens(short);
  return st.length === 1 && tokens(long).includes(st[0]!);
}

/** The model's place in this agent's list (cheapest first), or -1. */
function rankOf(list: readonly string[], model: string): number {
  return list.findIndex((m) => sameModel(m, model));
}

/** Which default a handoff gets: a review's, a request's by its size, or everyone else's. */
export function slotOf(h: { kind?: string | undefined; request?: { size?: HubRequestSize | undefined } | undefined }): ModelSlot {
  if (h.kind === "review") return "review";
  return h.request?.size ?? "other";
}

/** "Opus at high effort", "Codex", "max effort": a choice in words. */
export function choiceWords(c: ModelChoice, withAgent = false): string {
  const parts: string[] = [];
  if (c.model) parts.push(modelWords(c.model));
  else if (c.agent && (withAgent || !c.effort)) parts.push(withAgent ? `${AGENT_NAMES[c.agent]}'s default model` : AGENT_NAMES[c.agent]);
  if (c.effort) parts.push(parts.length ? `at ${c.effort} effort` : `${c.effort} effort`);
  return parts.join(" ");
}

export interface ResolveInput {
  /** This machine's policy; absent: suggestions are shown, never followed. */
  policy: ModelPolicy | undefined;
  suggest: HubModelSuggestionAccepted | undefined;
  slot: ModelSlot;
  /** The handoff is the person's own (`fromMe`, SPEC §49): their suggestion may go up to the top of their list. */
  fromMe: boolean;
  installed: (agent: HubAgent) => boolean;
  /** What ran before model choice: `handoffs.agent` and `handoffs.model` (a review's own settings for a review). */
  base: ModelChoice;
}

/**
 * What runs a handoff here: the agent (installed here), the model and the effort, and how that compares with the
 * suggestion. Undefined when no agent this machine may use is installed.
 */
export function resolveModel(i: ResolveInput): ModelResolution | undefined {
  const asked = askedOf(i.suggest);
  const policy = i.policy;
  if (!policy) {
    // Before model choice, and with no policy: the person's own agent and model, as always.
    const order: HubAgent[] = i.base.agent ? [i.base.agent] : [...AGENTS];
    const agent = order.find((a) => i.installed(a));
    if (!agent) return undefined;
    const out: ModelResolution = { agent, ...(i.base.model ? { model: i.base.model } : {}) };
    if (!asked) return out;
    const same = sameChoice(asked, out);
    return {
      ...out,
      asked,
      followed: same,
      ...(same ? {} : { note: `Asked for ${choiceWords(asked)}; runs on ${runWords(out)}: no model policy here (\`workmesh handoffs models\`).` }),
    };
  }

  const allowed = (a: HubAgent): boolean => (policy.allow ? policy.allow[a] !== undefined : true) && i.installed(a);
  const start = policy.defaults?.[i.slot] ?? policy.defaults?.other ?? i.base;
  const firstAgent = [start.agent, i.base.agent, ...AGENTS].find((a): a is HubAgent => a !== undefined && allowed(a));
  if (!firstAgent) return undefined;
  let agent: HubAgent = firstAgent;
  // The default's model belongs to the default's agent.
  let model: string | undefined = start.agent === undefined || start.agent === agent ? start.model : undefined;
  let effort: HubEffort | undefined = start.effort;
  if (!asked) return { agent, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };

  const capped = !i.fromMe || i.suggest?.source === "project";
  const reasons: string[] = [];
  let lowered = false;
  let followed = true;

  if (asked.agent && asked.agent !== agent) {
    if (allowed(asked.agent)) {
      agent = asked.agent;
      model = policy.defaults?.[i.slot]?.agent === agent ? policy.defaults[i.slot]?.model : undefined;
    } else {
      followed = false;
      reasons.push(i.installed(asked.agent) ? `${AGENT_NAMES[asked.agent]} isn't on your list` : `${AGENT_NAMES[asked.agent]} isn't installed here`);
    }
  }
  // A model suggested for another agent than the one that runs means nothing here.
  if (asked.model && (!asked.agent || asked.agent === agent)) {
    const list = policy.allow?.[agent] ?? [];
    const rank = rankOf(list, asked.model);
    if (rank < 0) {
      followed = false;
      lowered = true;
      reasons.push(`${modelWords(asked.model)} isn't on your list`);
    } else {
      const ceiling = capped && policy.ceiling?.[agent] ? rankOf(list, policy.ceiling[agent]!) : -1;
      if (ceiling >= 0 && rank > ceiling) {
        model = list[ceiling];
        followed = false;
        lowered = true;
        reasons.push("your ceiling");
      } else {
        // The person's own words for it go on the command line, never the hub's.
        model = list[rank];
      }
    }
  }
  if (asked.effort) {
    const top = capped ? policy.ceiling?.effort : undefined;
    if (top && effortRank(asked.effort) > effortRank(top)) {
      effort = top;
      followed = false;
      lowered = true;
      if (!reasons.includes("your ceiling")) reasons.push("your ceiling");
    } else {
      effort = asked.effort;
    }
  }
  const out: ModelResolution = { agent, ...(model ? { model } : {}), ...(effort ? { effort } : {}), asked, followed, ...(lowered ? { lowered } : {}) };
  if (!followed) {
    const why = reasons.length === 1 && reasons[0] === "your ceiling" ? ", your ceiling" : reasons.length ? `: ${reasons.join("; ")}` : "";
    out.note = `Asked for ${choiceWords(asked)}; runs on ${runWords(out)}${why}.`;
  }
  return out;
}

/** The suggestion's fields, or undefined when it names nothing. */
function askedOf(s: HubModelSuggestionAccepted | undefined): ModelChoice | undefined {
  if (!s) return undefined;
  const c: ModelChoice = { ...(s.agent ? { agent: s.agent } : {}), ...(s.model ? { model: s.model } : {}), ...(s.effort ? { effort: s.effort } : {}) };
  return c.agent || c.model || c.effort ? c : undefined;
}

/** Whether a run is what was asked, field by field (an unasked field doesn't count). */
function sameChoice(asked: ModelChoice, run: ModelChoice): boolean {
  if (asked.agent && asked.agent !== run.agent) return false;
  if (asked.model && !(run.model && sameModel(asked.model, run.model))) return false;
  if (asked.effort && asked.effort !== run.effort) return false;
  return true;
}

/** "Sonnet at high effort", "Codex's default model": what runs, in words. */
export function runWords(r: ModelChoice & { agent: HubAgent }): string {
  return choiceWords({ agent: r.agent, ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}) }, true);
}

/** The policy in words, one line per part, for `workmesh handoffs models`. */
export function policyLines(p: ModelPolicy | undefined): string[] {
  if (!p) return ["No model policy: suggestions are shown on the accept card, and handoffs run on handoffs.agent / handoffs.model as before."];
  const lines: string[] = [];
  if (p.allow) {
    for (const a of AGENTS) {
      const list = p.allow[a];
      if (list === undefined) continue;
      lines.push(`${AGENT_NAMES[a]}: ${list.length ? list.map(modelWords).join(" < ") : "its default model only"}`);
    }
  } else {
    lines.push("Agents: any installed here; a suggested model isn't followed (no list of models).");
  }
  const ceil = AGENTS.filter((a) => p.ceiling?.[a]).map((a) => `${AGENT_NAMES[a]} ${modelWords(p.ceiling![a]!)}`);
  if (ceil.length || p.ceiling?.effort) {
    lines.push(`Ceiling for others' suggestions: ${[...ceil, ...(p.ceiling?.effort ? [`${p.ceiling.effort} effort`] : [])].join(", ")}`);
  } else {
    lines.push("Ceiling for others' suggestions: the top of each list");
  }
  for (const s of MODEL_SLOTS) {
    const d = p.defaults?.[s];
    if (!d) continue;
    const what = d.agent ? `${AGENT_NAMES[d.agent]}${d.model || d.effort ? `, ${choiceWords({ ...(d.model ? { model: d.model } : {}), ...(d.effort ? { effort: d.effort } : {}) })}` : ""}` : choiceWords(d) || "the agent's default";
    lines.push(`Default for ${s === "other" ? "other handoffs" : s === "review" ? "reviews" : `${s} requests`}: ${what}`);
  }
  return lines;
}

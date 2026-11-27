import fs from "node:fs";
import { delegateSettings, loadConfig, requestRuleSchema, saveConfig, type Config } from "../lib/config";
import { REQUEST_RULES_MAX, ruleWords, type RequestRule } from "../daemon/request-rules";
import { checkoutsPath } from "../lib/paths";
import { bold, confirm, dim, green, yellow } from "../lib/ui";
import { resolveDir } from "./hub";

/**
 * `workmesh roots [add|remove] [dir]` (SPEC §31): where this machine's repos live, so an accepted handoff finds its
 * repo's checkout. Besides these, every shared repo a session here worked in counts.
 */
export async function runRoots(action?: string, dir?: string): Promise<void> {
  const config = loadConfig();
  const roots = delegateSettings(config).roots;
  if (action === undefined || action === "list") {
    if (roots.length === 0) console.log(dim("no roots yet: `workmesh roots add ~/code` (handoffs also find repos your sessions worked in)"));
    for (const r of roots) console.log(r);
    try {
      const known = Object.keys(JSON.parse(fs.readFileSync(checkoutsPath(), "utf8")) as Record<string, unknown>);
      if (known.length > 0) console.log(dim(`checkouts seen in sessions: ${known.sort().join(", ")}`));
    } catch {
      // none yet
    }
    return;
  }
  if (!dir) throw new Error(`\`workmesh roots ${action}\` needs a directory`);
  const abs = resolveDir(dir);
  if (action === "add") {
    if (!fs.existsSync(abs)) console.log(yellow(`  note: ${abs} does not exist (yet)`));
    config.handoffs = { ...(config.handoffs ?? { roots: [] }), roots: [...new Set([...roots, abs])] };
    saveConfig(config);
    console.log(green(`handoffs look for repos under ${bold(abs)} (the dir, its children and grandchildren)`));
    return;
  }
  if (action === "remove" || action === "rm") {
    config.handoffs = { ...(config.handoffs ?? { roots: [] }), roots: roots.filter((r) => r !== abs) };
    saveConfig(config);
    console.log(green(`removed ${abs}`));
    return;
  }
  throw new Error(`unknown action "${action}" — use add, remove or list`);
}

/** `workmesh handoffs policy [ask|auto-self|never]`: show or set which handoffs this machine takes without a click (default `ask`: none). */
export async function runHandoffPolicy(value?: string): Promise<void> {
  const config = loadConfig();
  const s = delegateSettings(config);
  const words: Record<string, string> = {
    ask: "every handoff waits for your Accept (menu bar, board or your terminal), your own too",
    "auto-self":
      "handoffs you send yourself start here with no click; teammates' wait for your Accept. " +
      "This trusts every machine and token of yours: each of them, and any agent running there, can start an agent on this machine",
    never: "this machine runs no handoffs (decline or accept them elsewhere)",
  };
  if (value === undefined) {
    console.log(`${bold(s.accept)} — ${words[s.accept]}`);
    return;
  }
  const v = value.trim().toLowerCase();
  if (v !== "ask" && v !== "auto-self" && v !== "never") throw new Error(`unknown policy "${value}" — use ask, auto-self or never`);
  config.handoffs = { ...(config.handoffs ?? { roots: [] }), accept: v };
  saveConfig(config);
  console.log(green(`handoffs: ${v}`));
  console.log(`  ${words[v]}`);
}

/** What `workmesh handoffs rule` needs around it. Tests pass their own. */
export interface RuleDeps {
  load: () => Config;
  save: (c: Config) => void;
  /** Input and output are a terminal, so the person can be shown the rule and asked. */
  isTerminal: () => boolean;
  ask: (question: string) => Promise<boolean>;
  print: (line: string) => void;
}

const ruleDeps: RuleDeps = {
  load: () => loadConfig(),
  save: (c) => saveConfig(c),
  isTerminal: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask: (q) => confirm(q, false),
  print: (line) => console.log(line),
};

/**
 * `workmesh handoffs rule [list | add | remove <n>]` (SPEC §56): standing rules for requests, the work teammates
 * without a relay ask for. A rule lets this machine accept, and start, a request from one person (by exact email),
 * optionally in one repo, up to a size, at most so many a day, with no click. Adding one prints it and asks; no option
 * skips the question, and with no terminal (an agent's shell, `--json`) nothing is added. Removing one never asks:
 * it only takes away.
 */
export async function runRequestRule(
  action: string | undefined,
  n: string | undefined,
  opts: { from?: string; repo?: string; size?: string; perDay?: string },
  deps: RuleDeps = ruleDeps,
): Promise<void> {
  const config = deps.load();
  const rules = delegateSettings(config).requestRules;
  const write = (next: RequestRule[]) => {
    config.handoffs = { ...(config.handoffs ?? { roots: [] }), requestRules: next };
    deps.save(config);
  };
  if (action === undefined || action === "list") {
    if (!rules.length) deps.print(dim("no standing rules: every request waits for your Accept (`workmesh handoffs rule add --from <email>`)"));
    rules.forEach((r, i) => deps.print(`${i + 1}. ${ruleWords(r)}`));
    return;
  }
  if (action === "remove" || action === "rm") {
    const i = Number(n) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= rules.length) throw new Error(`\`workmesh handoffs rule remove <n>\` takes a rule's number (1–${rules.length || 1}; \`workmesh handoffs rule\` lists them)`);
    const gone = rules[i]!;
    write(rules.filter((_, j) => j !== i));
    deps.print(green(`removed: ${ruleWords(gone)}`));
    return;
  }
  if (action !== "add") throw new Error(`unknown action "${action}" — use list, add or remove`);
  const parsed = requestRuleSchema.safeParse({
    from: opts.from,
    ...(opts.repo ? { repo: opts.repo } : {}),
    maxSize: (opts.size ?? "small").toLowerCase(),
    perDay: Number(opts.perDay ?? 3),
  });
  if (!parsed.success) {
    throw new Error(
      "a rule needs --from <email> (the requester's exact email), and takes --repo <owner/name>, --size small|medium|large (default small) and --per-day <1–50> (default 3)",
    );
  }
  const rule = parsed.data;
  if (rules.length >= REQUEST_RULES_MAX) throw new Error(`at most ${REQUEST_RULES_MAX} rules; remove one first`);
  if (!deps.isTerminal()) {
    deps.print(`Not added: there is no terminal to ask in. Add a standing rule in your own terminal: it starts agents on this machine with no click.`);
    return;
  }
  deps.print(`This machine will accept, and start an agent for, ${bold(ruleWords(rule))}, with no click from you.`);
  deps.print(dim("The hub says who sent a request and how big it looks; this machine checks the email, repo, size and count itself."));
  if (!(await deps.ask("Add this standing rule?"))) {
    deps.print("Not added.");
    return;
  }
  write([...rules, rule]);
  deps.print(green(`added: ${ruleWords(rule)}`));
}

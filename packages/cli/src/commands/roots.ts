import fs from "node:fs";
import { delegateSettings, loadConfig, saveConfig } from "../lib/config";
import { checkoutsPath } from "../lib/paths";
import { bold, dim, green, yellow } from "../lib/ui";
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

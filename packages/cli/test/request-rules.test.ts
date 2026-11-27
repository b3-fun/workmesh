import { describe, expect, it } from "vitest";
import { runRequestRule, type RuleDeps } from "../src/commands/roots";
import { matchRule, ruleWords } from "../src/daemon/request-rules";
import { configSchema, delegateSettings, type Config } from "../src/lib/config";

/**
 * Standing rules for requests (SPEC §56) live in this machine's config and only the person adds them, at a terminal
 * with a yes: never the hub, a requester or an agent (an agent's shell has no terminal). Nothing here reads a real
 * config.
 */

function harness(o: { terminal?: boolean; answer?: boolean; config?: Partial<Config> } = {}) {
  let config = configSchema.parse({ ...o.config });
  const lines: string[] = [];
  const asked: string[] = [];
  const deps: RuleDeps = {
    load: () => structuredClone(config),
    save: (c) => {
      config = c;
    },
    isTerminal: () => o.terminal ?? true,
    ask: async (q) => {
      asked.push(q);
      return o.answer ?? true;
    },
    print: (l) => lines.push(l),
  };
  return { deps, lines, asked, rules: () => delegateSettings(config).requestRules };
}

const ALLIE = { from: "Allie@Example.com", repo: "b3-fun/docs", size: "small", perDay: "3" };

describe("workmesh handoffs rule", () => {
  it("add prints the rule, asks, and writes it only on a yes", async () => {
    const h = harness();
    await runRequestRule("add", undefined, ALLIE, h.deps);
    expect(h.asked).toEqual(["Add this standing rule?"]);
    expect(h.rules()).toEqual([{ from: "allie@example.com", repo: "b3-fun/docs", maxSize: "small", perDay: 3 }]);
    expect(h.lines.join("\n")).toContain("small requests from allie@example.com in b3-fun/docs, at most 3 a day");
    const no = harness({ answer: false });
    await runRequestRule("add", undefined, ALLIE, no.deps);
    expect(no.rules()).toEqual([]);
    expect(no.lines.at(-1)).toBe("Not added.");
  });

  it("without a terminal (an agent's shell) nothing is added and nothing asks", async () => {
    const h = harness({ terminal: false });
    await runRequestRule("add", undefined, ALLIE, h.deps);
    expect(h.asked).toEqual([]);
    expect(h.rules()).toEqual([]);
    expect(h.lines[0]).toMatch(/^Not added: there is no terminal/);
  });

  it("a rule names its requester by email: a name, a bad size or count is refused", async () => {
    for (const bad of [{ from: "Allie" }, { from: "allie@example.com", size: "huge" }, { from: "allie@example.com", perDay: "0" }, { from: "allie@example.com", repo: "docs" }]) {
      const h = harness();
      await expect(runRequestRule("add", undefined, bad, h.deps)).rejects.toThrow(/--from <email>/);
      expect(h.rules()).toEqual([]);
    }
  });

  it("list and remove; removing never asks, even with no terminal", async () => {
    const h = harness({ terminal: false, config: { handoffs: { roots: [], requestRules: [{ from: "allie@example.com", maxSize: "medium", perDay: 2 }] } } as Partial<Config> });
    await runRequestRule("list", undefined, {}, h.deps);
    expect(h.lines).toEqual(["1. small and medium requests from allie@example.com, at most 2 a day"]);
    await runRequestRule("remove", "1", {}, h.deps);
    expect(h.asked).toEqual([]);
    expect(h.rules()).toEqual([]);
  });

  it("the config drops a malformed rule on its own and keeps the rest", () => {
    const c = configSchema.parse({
      handoffs: { roots: [], requestRules: [{ from: "an", maxSize: "small", perDay: 1 }, { from: "allie@example.com", maxSize: "large", perDay: 4 }] },
    });
    expect(delegateSettings(c).requestRules).toEqual([{ from: "allie@example.com", maxSize: "large", perDay: 4 }]);
  });
});

describe("matching a request (SPEC §56)", () => {
  const rule = { from: "allie@example.com", maxSize: "medium" as const, perDay: 2 };
  const h = (over: Record<string, unknown> = {}) => ({ from: { person: "Allie", email: "ALLIE@example.com" }, repo: "b3-fun/web", request: { id: "rq_1", size: "small" }, ...over }) as Parameters<typeof matchRule>[1];
  it("takes the requester's exact email (any case), any repo when the rule names none, up to its size and count", () => {
    expect(matchRule([rule], h(), () => 0)).toEqual(rule);
    expect(matchRule([rule], h({ request: { id: "rq_1", size: "medium" } }), () => 1)).toEqual(rule);
    expect(matchRule([rule], h(), () => 2)).toBeUndefined();
    expect(matchRule([rule], h({ request: { id: "rq_1", size: "large" } }), () => 0)).toBeUndefined();
    expect(matchRule([rule], h({ from: { person: "allie@example.com" } }), () => 0)).toBeUndefined();
    expect(ruleWords(rule)).toBe("small and medium requests from allie@example.com, at most 2 a day");
  });
});

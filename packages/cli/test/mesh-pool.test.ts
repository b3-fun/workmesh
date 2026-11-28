import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCapacityReport, pickBestProvider, readFleetStatus, resetFleetCache } from "../src/lib/fleet";
import { advertisedPoolModes, matchPoolRule, poolRuleKey, type PoolSettings } from "../src/daemon/pool-rules";
import { runCoordOp } from "../src/daemon/coord-ops";
import { runCapacity, runPool, runPoolRule } from "../src/commands/mesh";
import { defaultConfig } from "../src/lib/config";

function makeFleetFixture() {
  return {
    schemaVersion: 1,
    updatedAt: "2026-11-27T23:25:00Z",
    updatedAtMs: 1795821900000,
    todayUsd: 2136.45,
    sevenDayUsd: 14319.65,
    providers: {
      claude: {
        id: "claude" as const,
        displayName: "Claude Code",
        cli: "claude",
        harnessAgent: "claude",
        installed: true,
        quotaMode: "live" as const,
        headroomPct: 9.0,
        poolHeadroomPct: 2.0,
        bucket: "tight" as const,
        tight: true,
        resetsInSec: 38000,
        resetCountdown: "10h 33m",
        expiringResets: [],
      },
      codex: {
        id: "codex" as const,
        displayName: "Codex",
        cli: "codex",
        harnessAgent: "codex",
        installed: true,
        quotaMode: "live" as const,
        headroomPct: 59.0,
        poolHeadroomPct: 59.0,
        bucket: "abundant" as const,
        tight: false,
        resetsInSec: 900,
        resetCountdown: "15m",
        expiringResets: [{ kind: "full", scope: "full", count: 3, endsInSec: 259200 }],
      },
      opencode: {
        id: "opencode" as const,
        displayName: "OpenCode",
        cli: "opencode",
        harnessAgent: "opencode",
        installed: true,
        quotaMode: "budget" as const,
        headroomPct: 93.6,
        poolHeadroomPct: 93.6,
        bucket: "abundant" as const,
        tight: false,
        resetsInSec: null,
        resetCountdown: null,
        expiringResets: [],
        models: ["deepseek-v4.1-flash-abliterated"],
      },
    },
    recommendations: {
      coding: [
        {
          provider: "codex" as const,
          score: 1.86,
          headroomPct: 59.0,
          bucket: "abundant" as const,
          reason: "59% free, resets in 15m, 3 reset credits",
          cli: "codex",
          harnessAgent: "codex",
          expiringCredits: 3,
          resetsInSec: 900,
        },
        {
          provider: "opencode" as const,
          score: 0.76,
          headroomPct: 93.6,
          bucket: "abundant" as const,
          reason: "94% free",
          cli: "opencode",
          harnessAgent: "opencode",
          expiringCredits: 0,
          resetsInSec: null,
        },
      ],
    },
    alerts: [],
  };
}

describe("fleet capacity & opt-in pool rules", () => {
  it("reads fleet_status.json and respects share levels without leaking secrets", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-fleet-"));
    const file = path.join(dir, "fleet_status.json");
    fs.writeFileSync(file, JSON.stringify(makeFleetFixture()), "utf8");
    resetFleetCache();
    const fleet = readFleetStatus(file);
    expect(fleet?.providers.codex?.headroomPct).toBe(59);

    expect(buildCapacityReport(fleet, "off")).toBeUndefined();
    const avail = buildCapacityReport(fleet, "availability", { codex: ["readonly", "worktree"] });
    expect(avail?.todayUsd).toBeUndefined();
    expect(avail?.providers.find((p) => p.id === "codex")?.headroomPct).toBeUndefined();
    expect(avail?.providers.find((p) => p.id === "codex")?.acceptsPool).toEqual(["readonly", "worktree"]);

    const detailed = buildCapacityReport(fleet, "detailed", { codex: ["worktree"] });
    expect(detailed?.todayUsd).toBe(2136.45);
    expect(detailed?.providers.find((p) => p.id === "codex")?.headroomPct).toBe(59);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("matches worktree PR and readonly pool rules with reserve floor and expiring boost", () => {
    const fleet = makeFleetFixture();
    const pool: PoolSettings = {
      enabled: true,
      rules: [
        {
          from: "team",
          providers: ["claude", "codex", "opencode"],
          modes: ["readonly", "worktree"],
          repo: "b3-fun/*",
          minHeadroom: 40,
          expiringFloor: 10,
          perDay: 5,
        },
      ],
    };

    const adv = advertisedPoolModes(pool, fleet);
    expect(adv.claude).toBeUndefined(); // 9% < 10% floor -> protected!
    expect(adv.codex).toEqual(["readonly", "worktree"]);
    expect(adv.opencode).toEqual(["readonly", "worktree"]);

    const match = matchPoolRule(
      pool,
      { from: { person: "An", email: "an@example.com", sessionKey: undefined, sessionName: undefined }, repo: "b3-fun/workmesh", mode: "worktree", taskKind: "coding", pool: true },
      fleet,
      () => 0,
    );
    expect(match?.provider).toBe("codex");

    // Refuses non-matching repo
    const wrongRepo = matchPoolRule(
      pool,
      { from: { person: "An", email: "an@example.com", sessionKey: undefined, sessionName: undefined }, repo: "other/repo", mode: "worktree" },
      fleet,
      () => 0,
    );
    expect(wrongRepo).toBeUndefined();

    // Respects daily cap
    const capped = matchPoolRule(
      pool,
      { from: { person: "An", email: "an@example.com", sessionKey: undefined, sessionName: undefined }, repo: "b3-fun/workmesh", mode: "worktree" },
      fleet,
      (k) => (k === poolRuleKey(pool.rules[0]!) ? 5 : 0),
    );
    expect(capped).toBeUndefined();

    // Pick best provider skips exhausted/tight below floor
    const picked = pickBestProvider(fleet, { allowed: ["claude"], minHeadroom: 20 });
    expect(picked).toBeUndefined();
  });

  it("refuses nested delegation at depth >= 1", async () => {
    const res = await runCoordOp(
      { op: "delegate", args: { task: "do work" }, caller: { client: "claude-code", delegationDepth: 1 } },
      {
        coord: () => ({
          me: () => "Sean",
          myEmail: () => "sean@npclabs.org",
          self: () => ({ person: "Sean", email: "sean@npclabs.org" }),
          view: () => ({ available: true, state: { roster: [] } }),
        }) as never,
        hub: () => ({ url: "https://workmesh.b3os.org", project: { name: "B3" }, person: { name: "Sean" }, deviceId: "dev_1" }),
        getSession: () => undefined,
        listSessions: () => [],
        classify: () => undefined,
        isShared: () => true,
        claudeSessions: () => undefined,
      },
    );
    expect(res.ok).toBe(false);
    expect(res.text).toContain("nested delegation");
  });

  it("enforces terminal-only consent for pool rules and supports capacity share CLI", async () => {
    let cfg = defaultConfig();
    const lines: string[] = [];
    const deps = {
      load: () => cfg,
      save: (c: typeof cfg) => {
        cfg = c;
      },
      isTerminal: () => false,
      ask: async () => true,
      print: (l: string) => {
        lines.push(l);
      },
    };
    await runPoolRule("add", undefined, { from: "team", providers: "codex,opencode", modes: "readonly,worktree" }, deps);
    expect(cfg.pool?.rules ?? []).toHaveLength(0);
    expect(lines.join("\n")).toContain("no terminal");

    // In a terminal with yes: adds rule and turns pool ON
    await runPoolRule(
      "add",
      undefined,
      { from: "team", providers: "codex,opencode", modes: "readonly,worktree", repo: "b3-fun/*", minHeadroom: "30", perDay: "8" },
      { ...deps, isTerminal: () => true },
    );
    expect(cfg.pool?.enabled).toBe(true);
    expect(cfg.pool?.rules).toHaveLength(1);

    await runCapacity("share", "detailed", {}, deps);
    expect(cfg.capacity?.share).toBe("detailed");

    await runPool("off", {}, deps);
    expect(cfg.pool?.enabled).toBe(false);
  });
});

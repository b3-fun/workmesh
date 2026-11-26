import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_CANT_UPDATE, EXIT_FAILED, runUpdate } from "../src/commands/update";
import type { FinishResult, UpdateDeps } from "../src/commands/update";
import type { InstallInfo } from "../src/lib/install-method";
import { configSchema, loadConfig, saveConfig, updateWaitHours } from "../src/lib/config";
import { markSetup, readUpdateState } from "../src/lib/update-state";

/**
 * 0.12 (SPEC §41): `workmesh update` installs the newest release the way Workmesh was installed, has the new version
 * finish its own setup, rolls back when that fails, and changes nothing when there's nothing to do. Run by hand it
 * takes a release younger than the waiting time and says so; started by the daemon it leaves that release.
 */

let home: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-update-"));
  for (const k of ENV) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
  process.exitCode = undefined;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
  process.exitCode = undefined;
});

const NPM: InstallInfo = { method: "npm", canUpdate: true, entry: "/opt/homebrew/lib/node_modules/@b3os/workmesh/dist/index.js", prefix: "/opt/homebrew", packageDir: "/opt/homebrew/lib/node_modules/@b3os/workmesh" };
const GIT: InstallInfo = {
  method: "git",
  canUpdate: false,
  entry: "/Users/sean/Documents/workmesh/packages/cli/dist/index.js",
  gitRoot: "/Users/sean/Documents/workmesh",
  hint: "This Workmesh runs from a git checkout (~/Documents/workmesh), so `workmesh update` leaves it alone.",
};

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;

/**
 * A scripted machine: what's installed, what the registry has, what each step does; records the calls. The `outFor`
 * option is how long ago the registry says the latest release came out (absent: the registry gives no publish times).
 */
function machine(o: { current?: string; latest?: string; info?: InstallInfo; installCode?: number; finishCode?: number; restoreOk?: boolean; finishOk?: boolean; daemon?: string; outFor?: number }) {
  const lines: string[] = [];
  const calls: string[] = [];
  let installed = o.current ?? "0.12.0";
  const deps: UpdateDeps = {
    current: o.current ?? "0.12.0",
    entry: (o.info ?? NPM).entry,
    detect: () => o.info ?? NPM,
    now: () => NOW,
    registry: async () => ({
      latest: o.latest ?? "0.12.1",
      versions: ["0.12.0", "0.12.1", o.latest ?? "0.12.1"],
      published: o.outFor === undefined ? {} : { [o.latest ?? "0.12.1"]: NOW - o.outFor },
    }),
    install: async (_info, spec) => {
      calls.push(`install ${spec}`);
      if ((o.installCode ?? 0) === 0) installed = spec.split("@").pop()!;
      return o.installCode ?? 0;
    },
    installedVersion: () => installed,
    runNewFinish: (from) => {
      calls.push(`finish-new from ${from}`);
      return o.finishCode ?? 0;
    },
    finish: async (v): Promise<FinishResult> => {
      calls.push(`finish ${v}`);
      if (o.finishOk !== false) markSetup(v);
      return { ok: o.finishOk !== false, steps: [], failures: o.finishOk === false ? ["daemon: not answering"] : [] };
    },
    backup: (_i, v) => {
      calls.push(`backup ${v}`);
      return `/backup/${v}`;
    },
    restore: async (_i, v) => {
      calls.push(`restore ${v}`);
      if (o.restoreOk !== false) installed = v;
      return o.restoreOk !== false;
    },
    daemonVersion: async () => o.daemon ?? o.current ?? "0.12.0",
    out: (line) => lines.push(line),
  };
  return { deps, lines, calls, text: () => lines.join("\n") };
}

describe("workmesh update", () => {
  it("installs the newest release, has it finish its own setup, records it", async () => {
    markSetup("0.12.0");
    const m = machine({});
    await runUpdate({}, m.deps);
    expect(m.calls).toEqual(["backup 0.12.0", "install @b3os/workmesh@0.12.1", "finish-new from 0.12.0"]);
    expect(process.exitCode).toBeUndefined();
    expect(m.text()).toContain("Workmesh 0.12.1 is installed and running.");
    expect(m.text()).toContain("told so, once");
    expect(readUpdateState().last).toMatchObject({ ok: true, from: "0.12.0", to: "0.12.1" });
  });

  it("safe to run again: up to date and set up, it changes nothing", async () => {
    markSetup("0.12.1");
    const m = machine({ current: "0.12.1", latest: "0.12.1" });
    await runUpdate({}, m.deps);
    expect(m.calls).toEqual([]);
    expect(m.text()).toContain("Workmesh 0.12.1 is up to date.");
    expect(process.exitCode).toBeUndefined();
  });

  it("up to date but never set up here (npm i -g by hand, 0.11 → 0.12): finishes the setup in place", async () => {
    const m = machine({ current: "0.12.0", latest: "0.12.0", daemon: "an older version" });
    await runUpdate({}, m.deps);
    expect(m.calls).toEqual(["finish 0.12.0"]);
    expect(m.text()).toContain("finishing its setup");
    expect(readUpdateState().setup).toBe("0.12.0");
    const again = machine({ current: "0.12.0", latest: "0.12.0" });
    await runUpdate({}, again.deps);
    expect(again.calls).toEqual([]);
  });

  it("the new version fails its checks: rolls back to the previous one and its daemon, exit 1", async () => {
    markSetup("0.12.0");
    const m = machine({ finishCode: 2 });
    await runUpdate({}, m.deps);
    expect(m.calls).toEqual(["backup 0.12.0", "install @b3os/workmesh@0.12.1", "finish-new from 0.12.0", "restore 0.12.0", "finish 0.12.0"]);
    expect(process.exitCode).toBe(EXIT_FAILED);
    expect(m.text()).toContain("0.12.1 failed its checks: rolling back to 0.12.0");
    expect(m.text()).toContain("Rolled back: Workmesh 0.12.0 is running again.");
    expect(readUpdateState().last).toMatchObject({ ok: false, rolledBack: true, to: "0.12.1" });
  });

  it("a rollback that can't restore says so and how to recover", async () => {
    markSetup("0.12.0");
    const m = machine({ finishCode: 2, restoreOk: false });
    await runUpdate({}, m.deps);
    expect(process.exitCode).toBe(EXIT_FAILED);
    expect(m.text()).toContain("npm i -g @b3os/workmesh@0.12.0");
    expect(readUpdateState().last).toMatchObject({ ok: false });
    expect(readUpdateState().last?.rolledBack).toBeUndefined();
  });

  it("the install itself fails: nothing else runs, it stays on the old version", async () => {
    markSetup("0.12.0");
    const m = machine({ installCode: 1 });
    await runUpdate({}, m.deps);
    expect(m.calls).toEqual(["backup 0.12.0", "install @b3os/workmesh@0.12.1"]);
    expect(process.exitCode).toBe(EXIT_FAILED);
    expect(m.text()).toContain("Workmesh stays on 0.12.0.");
  });

  it("a git checkout (Sean's): changes nothing, says what to do instead, exit 3", async () => {
    const m = machine({ info: GIT });
    await runUpdate({}, m.deps);
    expect(m.calls).toEqual([]);
    expect(process.exitCode).toBe(EXIT_CANT_UPDATE);
    expect(m.text()).toContain("leaves it alone");
  });

  it("--check only reports", async () => {
    markSetup("0.12.0");
    const m = machine({});
    await runUpdate({ check: true }, m.deps);
    expect(m.calls).toEqual([]);
    expect(m.text()).toContain("0.12.1 available");
    const j = machine({});
    await runUpdate({ check: true, json: true }, j.deps);
    expect(JSON.parse(j.lines.join(""))).toMatchObject({ current: "0.12.0", latest: "0.12.1", available: true, install: { method: "npm", canUpdate: true } });
  });

  it("--auto on|off writes config; patch releases unless --minor", async () => {
    const m = machine({});
    await runUpdate({ auto: "on" }, m.deps);
    expect(loadConfig().update).toEqual({ auto: true, scope: "patch" });
    await runUpdate({ auto: "on", minor: true }, m.deps);
    expect(loadConfig().update).toEqual({ auto: true, scope: "minor" });
    await runUpdate({ auto: "off" }, m.deps);
    expect(loadConfig().update?.auto).toBe(false);
    await expect(runUpdate({ auto: "maybe" }, m.deps)).rejects.toThrow(/on or off/);
    expect(m.calls).toEqual([]);
  });

  it("--auto-run (the daemon's) installs only within the person's scope", async () => {
    markSetup("0.12.0");
    const off = machine({});
    await runUpdate({ autoRun: true }, off.deps);
    expect(off.calls).toEqual([]);
    await runUpdate({ auto: "on" }, off.deps);
    const minor = machine({ latest: "0.13.0" });
    await runUpdate({ autoRun: true }, minor.deps);
    expect(minor.calls).toEqual([]);
    const patch = machine({ latest: "0.12.1" });
    await runUpdate({ autoRun: true }, patch.deps);
    expect(patch.calls).toContain("install @b3os/workmesh@0.12.1");
    expect(readUpdateState().last).toMatchObject({ ok: true, auto: true });
  });

  it("--auto on keeps the person's waiting time", async () => {
    saveConfig({ ...loadConfig(), update: { waitHours: 72 } });
    const m = machine({});
    await runUpdate({ auto: "on" }, m.deps);
    expect(loadConfig().update).toEqual({ auto: true, scope: "patch", waitHours: 72 });
    await runUpdate({ auto: "off" }, m.deps);
    expect(loadConfig().update).toEqual({ auto: false, scope: "patch", waitHours: 72 });
  });

  it("by hand: a release younger than the waiting time installs at once, and it says so", async () => {
    markSetup("0.12.0");
    const m = machine({ outFor: 3 * HOUR });
    await runUpdate({}, m.deps);
    expect(m.calls).toEqual(["backup 0.12.0", "install @b3os/workmesh@0.12.1", "finish-new from 0.12.0"]);
    expect(process.exitCode).toBeUndefined();
    expect(m.text()).toContain("0.12.1 came out 3h 0m ago, inside the 24 h waiting time for new releases: installing it now because you ran the update yourself");
    expect(m.text()).toContain("Workmesh 0.12.1 is installed and running.");
    // Old enough, or the wait turned off, or already on it: nothing to say.
    for (const quiet of [machine({ outFor: 24 * HOUR }), machine({}), machine({ current: "0.12.1", latest: "0.12.1", outFor: HOUR })]) {
      await runUpdate({}, quiet.deps);
      expect(quiet.text()).not.toContain("waiting time");
    }
    saveConfig({ ...loadConfig(), update: { waitHours: 0 } });
    const off = machine({ outFor: HOUR });
    await runUpdate({}, off.deps);
    expect(off.text()).not.toContain("waiting time");
    expect(off.calls).toContain("install @b3os/workmesh@0.12.1");
  });

  it("--auto-run (the daemon's) leaves a release younger than the waiting time for a later day", async () => {
    markSetup("0.12.0");
    await runUpdate({ auto: "on" }, machine({}).deps);
    const young = machine({ outFor: 3 * HOUR });
    await runUpdate({ autoRun: true }, young.deps);
    expect(young.calls).toEqual([]);
    expect(young.text()).toContain("auto-update waits until a release is 24 h old (0.12.1 came out 3h 0m ago): nothing to do");
    expect(process.exitCode).toBeUndefined();
    const old = machine({ outFor: 24 * HOUR });
    await runUpdate({ autoRun: true }, old.deps);
    expect(old.calls).toContain("install @b3os/workmesh@0.12.1");
  });

  it("--auto-run --to installs the version the daemon found old enough, not a newer one that came out since", async () => {
    markSetup("0.12.0");
    await runUpdate({ auto: "on" }, machine({}).deps);
    // 0.12.2 came out an hour ago; the daemon waited a day for 0.12.1 and names it. The registry gives it no time here.
    const m = machine({ latest: "0.12.2", outFor: HOUR });
    await runUpdate({ autoRun: true, to: "0.12.1" }, m.deps);
    expect(m.calls).toContain("install @b3os/workmesh@0.12.1");
    expect(m.calls).not.toContain("install @b3os/workmesh@0.12.2");
    expect(readUpdateState().last).toMatchObject({ ok: true, auto: true, to: "0.12.1" });
    // A version the hub named that this registry doesn't list yet: nothing to do, and no error.
    const early = machine({});
    await runUpdate({ autoRun: true, to: "0.12.9" }, early.deps);
    expect(early.calls).toEqual([]);
    expect(early.text()).toContain("the registry doesn't list 0.12.9 yet: nothing to do");
    expect(process.exitCode).toBeUndefined();
    await expect(runUpdate({ to: "0.12.9" }, machine({}).deps)).rejects.toThrow(/isn't on the registry/);
  });

  it("--check says when the newest release is still inside the waiting time", async () => {
    markSetup("0.12.0");
    const m = machine({ outFor: 3 * HOUR });
    await runUpdate({ check: true }, m.deps);
    expect(m.calls).toEqual([]);
    expect(m.text()).toContain("0.12.1 available");
    expect(m.text()).toContain("it came out 3h 0m ago: the daemon offers it once it is 24 h old");
    const j = machine({ outFor: 3 * HOUR });
    await runUpdate({ check: true, json: true }, j.deps);
    expect(JSON.parse(j.lines.join(""))).toMatchObject({ latest: "0.12.1", available: true, publishedAt: NOW - 3 * HOUR, waitHours: 24 });
    const old = machine({ outFor: 48 * HOUR });
    await runUpdate({ check: true }, old.deps);
    expect(old.text()).not.toContain("came out");
  });

  it("update.waitHours: 24 unless set; 0 is no wait; a value out of range keeps the default", () => {
    const hours = (update: unknown) => updateWaitHours(configSchema.parse({ update }));
    expect(updateWaitHours(configSchema.parse({}))).toBe(24);
    expect(hours({ auto: true })).toBe(24);
    expect(hours({ waitHours: 0 })).toBe(0);
    expect(hours({ waitHours: 72 })).toBe(72);
    expect(hours({ waitHours: 0.5 })).toBe(0.5);
    for (const bad of [-1, 721, "12", null, Number.NaN]) expect(hours({ waitHours: bad })).toBe(24);
    // A bad waiting time doesn't take the other update settings with it.
    expect(configSchema.parse({ update: { auto: true, scope: "minor", waitHours: "soon" } }).update).toEqual({ auto: true, scope: "minor", waitHours: undefined });
  });

  it("one update at a time", async () => {
    markSetup("0.12.0");
    const lock = path.join(process.env.XDG_STATE_HOME!, "workmesh", "update.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${process.ppid}\n`); // a live process that isn't us
    const m = machine({});
    await runUpdate({}, m.deps);
    expect(m.calls).toEqual([]);
    expect(m.text()).toContain("another `workmesh update` is running");
    fs.writeFileSync(lock, "999999\n"); // a dead one's lock is taken over
    const n = machine({});
    await runUpdate({}, n.deps);
    expect(n.calls).toContain("install @b3os/workmesh@0.12.1");
  });
});

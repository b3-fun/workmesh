import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTO_EVERY_MS, MENUBAR_EVERY_MS, NPM_EVERY_MS, UpdateChecker } from "../src/daemon/updates";
import type { UpdateCheckerDeps } from "../src/daemon/updates";
import { SessionVersions, staleAdvice, staleNote } from "../src/daemon/session-versions";
import type { InstallInfo } from "../src/lib/install-method";
import type { LastUpdate, MenubarRelease } from "../src/lib/update-state";
import { fetchMenubarRelease, fetchRegistryInfo } from "../src/lib/registry";
import type { AddressInfo } from "node:net";
import pkg from "../package.json";
import { createDaemonServer } from "../src/daemon/server";
import type { DaemonServerDeps, HookMeta } from "../src/daemon/server";
import { getHealth, getUpdateStatus, postEvent } from "../src/lib/daemon-client";
import { hookMeta } from "../src/commands/hook";
import { createDaemonSecret } from "../src/lib/daemon-auth";

/**
 * 0.12 (SPEC §41): the daemon's update notices (hub first, npm at most every 6 h, the menu bar's release), opt-in
 * auto-update, and the once-per-session note to sessions that started under an older Workmesh.
 */

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-updates-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const NPM: InstallInfo = { method: "npm", canUpdate: true, entry: "/opt/homebrew/lib/node_modules/@b3os/workmesh/dist/index.js", prefix: "/opt/homebrew" };
const GIT: InstallInfo = { method: "git", canUpdate: false, entry: "/Users/sean/Documents/workmesh/packages/cli/dist/index.js", hint: "pull and build" };
const REL: MenubarRelease = {
  version: "0.12.1",
  url: "https://github.com/b3-fun/workmesh/releases/download/v0.12.1/Workmesh-menubar-macos.zip",
  sha256: "a".repeat(64),
  releaseUrl: "https://github.com/b3-fun/workmesh/releases/tag/v0.12.1",
};

function harness(over: Partial<UpdateCheckerDeps> & { hub?: string; npm?: string | Error; auto?: boolean; scope?: "patch" | "minor"; last?: LastUpdate } = {}) {
  let t = 1_800_000_000_000;
  const calls = { npm: 0, menubar: 0, auto: [] as string[] };
  const deps: UpdateCheckerDeps = {
    current: "0.12.0",
    install: () => NPM,
    hubLatest: () => (over.hub ? { version: over.hub, at: t } : undefined),
    settings: () => ({ enabled: over.auto ?? false, scope: over.scope ?? "patch" }),
    fetchNpm: async () => {
      calls.npm++;
      if (over.npm instanceof Error) throw over.npm;
      return over.npm ?? "0.12.1";
    },
    fetchMenubar: async () => {
      calls.menubar++;
      return REL;
    },
    startAuto: (to) => {
      calls.auto.push(to);
      return true;
    },
    lastRun: () => over.last,
    runArgv: ["/opt/homebrew/bin/node", NPM.entry, "update"],
    file: path.join(dir, "update-check.json"),
    now: () => t,
    ...over,
  };
  return { checker: new UpdateChecker(deps), deps, calls, advance: (ms: number) => (t += ms), now: () => t };
}

describe("update notices in the daemon", () => {
  it("not paired: asks npm, at most once every 6 h, across restarts too", async () => {
    const h = harness();
    await h.checker.tick();
    await h.checker.tick();
    expect(h.calls.npm).toBe(1);
    expect(h.checker.status()).toMatchObject({ current: "0.12.0", latest: "0.12.1", available: true, source: "npm" });
    h.advance(NPM_EVERY_MS - 1000);
    await h.checker.tick();
    expect(h.calls.npm).toBe(1);
    // A restarted daemon reads the last attempt back: still no second call inside the 6 h.
    const again = harness({ file: path.join(dir, "update-check.json"), now: h.now });
    await again.checker.tick();
    expect(again.calls.npm).toBe(0);
    expect(again.checker.status().latest).toBe("0.12.1");
    h.advance(2000);
    await h.checker.tick();
    expect(h.calls.npm).toBe(2);
  });

  it("a failed npm read waits the 6 h too, and says nothing is available", async () => {
    const h = harness({ npm: new Error("offline") });
    await h.checker.tick();
    await h.checker.tick();
    expect(h.calls.npm).toBe(1);
    expect(h.checker.status()).toMatchObject({ available: false });
    expect(h.checker.status().latest).toBeUndefined();
  });

  it("paired with a hub that knows the latest: never asks npm", async () => {
    const h = harness({ hub: "0.12.2" });
    for (let i = 0; i < 5; i++) {
      await h.checker.tick();
      h.advance(NPM_EVERY_MS);
    }
    expect(h.calls.npm).toBe(0);
    expect(h.checker.status()).toMatchObject({ latest: "0.12.2", source: "hub", available: true });
  });

  it("up to date: nothing available", async () => {
    const h = harness({ hub: "0.12.0" });
    await h.checker.tick();
    expect(h.checker.status()).toMatchObject({ latest: "0.12.0", available: false });
  });

  it("the menu bar's release at most every 6 h; off macOS not at all", async () => {
    const h = harness({ hub: "0.12.1" });
    await h.checker.tick();
    await h.checker.tick();
    expect(h.calls.menubar).toBe(1);
    expect(h.checker.status().menubar).toEqual(REL);
    h.advance(MENUBAR_EVERY_MS);
    await h.checker.tick();
    expect(h.calls.menubar).toBe(2);
    const linux = harness({ hub: "0.12.1", fetchMenubar: undefined });
    await linux.checker.tick();
    expect(linux.checker.status().menubar).toBeUndefined();
  });

  it("status says how to update: the argv for an npm install, the hint for a git checkout", async () => {
    const npm = harness({ hub: "0.12.1" });
    expect(npm.checker.status()).toMatchObject({ install: { method: "npm", canUpdate: true }, run: ["/opt/homebrew/bin/node", NPM.entry, "update"] });
    const git = harness({ hub: "0.12.1", install: () => GIT });
    expect(git.checker.status().run).toBeUndefined();
    expect(git.checker.status().install).toEqual({ method: "git", canUpdate: false, hint: "pull and build" });
  });
});

describe("auto-update (opt-in)", () => {
  it("off by default: never starts one", async () => {
    const h = harness({ hub: "0.12.1" });
    await h.checker.tick();
    expect(h.calls.auto).toEqual([]);
  });

  it("on: a patch release, once a day at most", async () => {
    const h = harness({ hub: "0.12.1", auto: true });
    await h.checker.tick();
    await h.checker.tick();
    expect(h.calls.auto).toEqual(["0.12.1"]);
    h.advance(AUTO_EVERY_MS - 1);
    await h.checker.tick();
    expect(h.calls.auto).toHaveLength(1);
    h.advance(1);
    await h.checker.tick();
    expect(h.calls.auto).toHaveLength(2);
  });

  it("patch scope skips a minor release; minor scope takes it; nobody takes a major", async () => {
    const patch = harness({ hub: "0.13.0", auto: true });
    await patch.checker.tick();
    expect(patch.calls.auto).toEqual([]);
    const minor = harness({ hub: "0.13.0", auto: true, scope: "minor" });
    await minor.checker.tick();
    expect(minor.calls.auto).toEqual(["0.13.0"]);
    const major = harness({ hub: "1.0.0", auto: true, scope: "minor" });
    await major.checker.tick();
    expect(major.calls.auto).toEqual([]);
  });

  it("a version that failed its checks and was rolled back isn't retried on its own; a newer one is", async () => {
    const failed: LastUpdate = { at: 1, ok: false, from: "0.12.0", to: "0.12.1", rolledBack: true };
    const h = harness({ hub: "0.12.1", auto: true, last: failed });
    await h.checker.tick();
    expect(h.calls.auto).toEqual([]);
    const newer = harness({ hub: "0.12.2", auto: true, last: failed });
    await newer.checker.tick();
    expect(newer.calls.auto).toEqual(["0.12.2"]);
  });

  it("an install it can't update (a git checkout) is never auto-updated", async () => {
    const h = harness({ hub: "0.12.1", auto: true, install: () => GIT });
    await h.checker.tick();
    expect(h.calls.auto).toEqual([]);
  });
});

describe("stale sessions: told once (SPEC §41)", () => {
  const file = () => path.join(dir, "session-versions.json");

  /** A machine that ran 0.12.0 and now runs 0.12.1 (the daemon restarted at t0 + 1000). */
  function upgraded(surfaceOld = "s-old", surfaceNew = "s-new") {
    let t = 1_000;
    const v0 = new SessionVersions({ file: file(), current: "0.12.0", surface: surfaceOld, now: () => t });
    v0.observeStart("claude-code:A", { source: "startup", version: "0.12.0", surface: surfaceOld });
    v0.flush();
    t = 5_000;
    const v1 = new SessionVersions({ file: file(), current: "0.12.1", surface: surfaceNew, now: () => t });
    return { v1, tick: (ms: number) => (t += ms) };
  }

  it("a session that started under the older version hears it once, at its next hook", () => {
    const { v1 } = upgraded();
    const note = v1.note("claude-code:A", "claude-code");
    expect(note).toContain("Workmesh was updated to 0.12.1 (this session started under 0.12.0)");
    expect(note).toContain(staleAdvice("claude-code"));
    expect(v1.note("claude-code:A", "claude-code")).toBeUndefined();
    expect(v1.note("claude-code:A", "claude-code")).toBeUndefined();
  });

  it("once across a daemon restart too", () => {
    const { v1 } = upgraded();
    expect(v1.note("claude-code:A", "claude-code")).toBeDefined();
    v1.flush();
    const again = new SessionVersions({ file: file(), current: "0.12.1", surface: "s-new", now: () => 9_000 });
    expect(again.note("claude-code:A", "claude-code")).toBeUndefined();
  });

  it("a session started after the update, and one whose tools didn't change, hear nothing", () => {
    const { v1 } = upgraded();
    v1.observeStart("claude-code:B", { source: "startup", version: "0.12.1", surface: "s-new" });
    expect(v1.note("claude-code:B", "claude-code")).toBeUndefined();
    const same = upgraded("same", "same");
    expect(same.v1.note("claude-code:A", "claude-code")).toBeUndefined();
  });

  it("/clear and compaction keep the process, so they keep what it started under", () => {
    const { v1 } = upgraded();
    v1.observeStart("claude-code:A", { source: "clear", version: "0.12.1", surface: "s-new" });
    v1.observeStart("claude-code:A", { source: "compact", version: "0.12.1", surface: "s-new" });
    expect(v1.note("claude-code:A", "claude-code")).toContain("started under 0.12.0");
  });

  it("no record (a session from before 0.12, or after /clear): a Claude Code process older than this version counts", () => {
    const { v1 } = upgraded();
    expect(v1.note("claude-code:Z", "claude-code", 2_000)).toContain("started under 0.12.0");
    expect(v1.note("claude-code:Y", "claude-code", 6_000)).toBeUndefined();
    expect(v1.note("codex:X", "codex", undefined)).toBeUndefined();
  });

  it("the first run of 0.12 after 0.11 (no record of the old version): sessions older than the daemon hear it", () => {
    const v = new SessionVersions({ file: file(), current: "0.12.0", surface: "s", now: () => 10_000 });
    expect(v.running.previous).toBeUndefined();
    const note = v.note("claude-code:Q", "claude-code", 9_000);
    expect(note).toContain("Workmesh was updated to 0.12.0 after this session started");
  });

  it("a later update tells an already-told session again, once", () => {
    const { v1 } = upgraded();
    expect(v1.note("claude-code:A", "claude-code")).toBeDefined();
    v1.flush();
    const v2 = new SessionVersions({ file: file(), current: "0.12.2", surface: "s-newer", now: () => 50_000 });
    expect(v2.running.previous).toBe("0.12.1");
    expect(v2.note("claude-code:A", "claude-code")).toContain("updated to 0.12.2");
    expect(v2.note("claude-code:A", "claude-code")).toBeUndefined();
  });

  it("Codex gets its own advice", () => {
    expect(staleNote("0.12.1", "0.12.0", staleAdvice("codex"))).toContain(staleAdvice("codex"));
    expect(staleAdvice("codex")).not.toContain("/mcp");
    expect(staleAdvice("claude-code")).toContain("/mcp reconnect workmesh");
  });
});

describe("where new versions come from", () => {
  it("npm: the latest dist-tag from the abbreviated packument", async () => {
    let asked = "";
    const info = await fetchRegistryInfo("http://127.0.0.1:9/", (async (url: string) => {
      asked = url;
      return new Response(JSON.stringify({ "dist-tags": { latest: "0.12.1" }, versions: { "0.12.0": {}, "0.12.1": {} } }));
    }) as typeof fetch);
    expect(asked).toBe("http://127.0.0.1:9/@b3os%2fworkmesh");
    expect(info).toEqual({ latest: "0.12.1", versions: ["0.12.0", "0.12.1"] });
    await expect(fetchRegistryInfo("http://x/", (async () => new Response("{}", { status: 200 })) as typeof fetch)).rejects.toThrow(/no latest/);
  });

  it("GitHub: the menu bar zip with its SHA-256 digest; no digest, no offer", async () => {
    const body = {
      tag_name: "v0.12.1",
      html_url: REL.releaseUrl,
      assets: [
        { name: "Other.zip", browser_download_url: "https://x/o.zip", digest: `sha256:${"b".repeat(64)}` },
        { name: "Workmesh-menubar-macos.zip", browser_download_url: REL.url, digest: `sha256:${"A".repeat(64)}`, size: 1234 },
      ],
    };
    const got = await fetchMenubarRelease("https://api/x", (async () => new Response(JSON.stringify(body))) as typeof fetch);
    expect(got).toEqual({ ...REL, size: 1234 });
    const noDigest = { ...body, assets: [{ name: "Workmesh-menubar-macos.zip", browser_download_url: REL.url }] };
    expect(await fetchMenubarRelease("https://api/x", (async () => new Response(JSON.stringify(noDigest))) as typeof fetch)).toBeUndefined();
    const pre = { ...body, prerelease: true };
    expect(await fetchMenubarRelease("https://api/x", (async () => new Response(JSON.stringify(pre))) as typeof fetch)).toBeUndefined();
  });
});

describe("the daemon's side of it (loopback API, hooks)", () => {
  let server: ReturnType<typeof createDaemonServer> | undefined;
  let SECRET = "";
  let savedState: string | undefined;
  beforeEach(() => {
    // The client reads the daemon's secret from the state dir: a temp one here.
    savedState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = path.join(dir, "state");
    SECRET = createDaemonSecret();
  });
  afterEach(() => {
    server?.close();
    if (savedState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedState;
  });

  async function start(over: Partial<DaemonServerDeps>) {
    const metas: Array<HookMeta | undefined> = [];
    const deps: DaemonServerDeps = {
      secret: SECRET,
      applyEvent: () => {},
      getState: () => ({ snapshot: { sessions: [], working: 0, waiting: 0, agentCount: 0 } as never, formatted: null, paused: false }),
      getLastError: () => undefined,
      getOwnership: () => ({}) as never,
      pause: async () => {},
      resume: () => {},
      dismiss: () => false,
      getConfig: () => ({}) as never,
      setConfig: () => ({}) as never,
      applyHookEvent: (_e, _h, meta) => {
        metas.push(meta);
        return { context: "note" };
      },
      ...over,
    };
    server = createDaemonServer(deps);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { authorization: `Bearer ${SECRET}` } });
    return { port, metas, get };
  }

  it("/health names the daemon's version; GET /update serves the status, 404 on an older daemon", async () => {
    const status = { current: "0.12.0", latest: "0.12.1", available: true, install: { method: "npm", canUpdate: true }, auto: { enabled: false, scope: "patch" } } as const;
    const { port, get } = await start({ getUpdate: () => status as never });
    expect((await getHealth(port)).version).toBe(pkg.version);
    expect(await (await get("/update")).json()).toEqual(status);
    expect(await getUpdateStatus(port)).toEqual(status);
    server?.close();
    const old = await start({});
    expect((await old.get("/update")).status).toBe(404);
  });

  it("a hook says what its session started under; the daemon reads only well-formed values", async () => {
    const { port, metas } = await start({});
    const ev = { source: "claude-code", sessionId: "s1", kind: "start" } as const;
    await postEvent(port, ev, "SessionStart", 2000, { version: "0.12.0", start: "startup", surface: "abcdef0123456789" });
    await postEvent(port, ev, "SessionStart", 2000, { version: "0.12.0; rm", start: "Start Up!", surface: "zz" });
    await postEvent(port, ev, undefined, 2000, { version: "0.12.0" });
    expect(metas).toEqual([
      { version: "0.12.0", start: "startup", surface: "abcdef0123456789" },
      { version: undefined, start: undefined, surface: undefined },
    ]);
  });

  it("the hook sends its version always, and at SessionStart its source and tools", () => {
    expect(hookMeta("PostToolUse", { source: "x" })).toEqual({ version: pkg.version });
    const start = hookMeta("SessionStart", { source: "resume" });
    expect(start).toMatchObject({ version: pkg.version, start: "resume" });
    expect(start.surface).toMatch(/^[0-9a-f]{16}$/);
    expect(hookMeta("SessionStart", { source: "../../etc" }).start).toBeUndefined();
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTO_EVERY_MS, MENUBAR_EVERY_MS, NPM_EVERY_MS, UpdateChecker, releaseDue } from "../src/daemon/updates";
import type { UpdateCheckerDeps, UpdateStatus } from "../src/daemon/updates";
import { SessionVersions, staleAdvice, staleNote } from "../src/daemon/session-versions";
import { signingCheck, versionCheck } from "../src/commands/doctor";
import { updateLines } from "../src/commands/update";
import type { InstallInfo } from "../src/lib/install-method";
import type { LastUpdate, MenubarRelease } from "../src/lib/update-state";
import { readUpdateCheck, writeUpdateCheck } from "../src/lib/update-state";
import { fetchMenubarRelease, fetchRegistryInfo } from "../src/lib/registry";
import type { MenubarRead } from "../src/lib/registry";
import type { AddressInfo } from "node:net";
import pkg from "../package.json";
import { createDaemonServer } from "../src/daemon/server";
import type { DaemonServerDeps, HookMeta } from "../src/daemon/server";
import { getHealth, getUpdateStatus, postEvent } from "../src/lib/daemon-client";
import { hookMeta } from "../src/commands/hook";
import { createDaemonSecret } from "../src/lib/daemon-auth";

/**
 * 0.12 (SPEC §41): the daemon's update notices (hub first, npm at most every 6 h, the menu bar's release), opt-in
 * auto-update, the waiting time for new releases, what a release that fails the signing check does to the offer, and
 * the once-per-session note to sessions that started under an older Workmesh.
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
const T0 = 1_800_000_000_000;
const HOUR = 3600_000;
/** Long before the harness's clock: old enough for any waiting time. */
const LONG_AGO = T0 - 1000 * HOUR;
const REL: MenubarRelease = {
  version: "0.12.1",
  url: "https://github.com/b3-fun/workmesh/releases/download/v0.12.1/Workmesh-menubar-macos.zip",
  sha256: "a".repeat(64),
  releaseUrl: "https://github.com/b3-fun/workmesh/releases/tag/v0.12.1",
  publishedAt: LONG_AGO,
};

interface HarnessOptions {
  hub?: string;
  npm?: string | Error;
  auto?: boolean;
  scope?: "patch" | "minor";
  last?: LastUpdate;
  /** The waiting time in hours (default 24, as in config). */
  wait?: number;
  /** When the registry says each version came out. Default: the versions in play, long ago. */
  published?: Record<string, number>;
  /** What the GitHub release read gives. Default: `REL`, long out. */
  menubar?: MenubarRead;
}

function harness(over: Partial<UpdateCheckerDeps> & HarnessOptions = {}) {
  let t = T0;
  const calls = { npm: 0, menubar: 0, auto: [] as string[] };
  const deps: UpdateCheckerDeps = {
    current: "0.12.0",
    install: () => NPM,
    hubLatest: () => (over.hub ? { version: over.hub, at: t } : undefined),
    settings: () => ({ enabled: over.auto ?? false, scope: over.scope ?? "patch" }),
    waitHours: () => over.wait ?? 24,
    fetchNpm: async () => {
      calls.npm++;
      if (over.npm instanceof Error) throw over.npm;
      const latest = over.npm ?? "0.12.1";
      return { latest, published: over.published ?? { [latest]: LONG_AGO, ...(over.hub ? { [over.hub]: LONG_AGO } : {}) } };
    },
    fetchMenubar: async () => {
      calls.menubar++;
      return over.menubar ?? { kind: "offer", release: REL };
    },
    signing: false,
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

  it("paired with a hub that knows the latest, the waiting time off: never asks npm", async () => {
    const h = harness({ hub: "0.12.2", wait: 0 });
    for (let i = 0; i < 5; i++) {
      await h.checker.tick();
      h.advance(NPM_EVERY_MS);
    }
    expect(h.calls.npm).toBe(0);
    expect(h.checker.status()).toMatchObject({ latest: "0.12.2", source: "hub", available: true });
  });

  it("paired with a hub that knows the latest: npm is asked once, for when that version came out", async () => {
    const h = harness({ hub: "0.12.2" });
    for (let i = 0; i < 5; i++) {
      await h.checker.tick();
      h.advance(NPM_EVERY_MS);
    }
    expect(h.calls.npm).toBe(1);
    expect(h.checker.status()).toMatchObject({ latest: "0.12.2", source: "hub", available: true });
  });

  it("a hub that names a version older than this relay hasn't read npm since a release: npm is asked too", async () => {
    const h = harness({ hub: "0.11.1", npm: "0.12.1" });
    await h.checker.tick();
    expect(h.calls.npm).toBe(1);
    expect(h.checker.status()).toMatchObject({ latest: "0.12.1", source: "npm", available: true });
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

describe("the waiting time for new releases (update.waitHours)", () => {
  it("a release counts from its publish time, or from the first sight of it when that is earlier or all there is", () => {
    const wait = 24 * HOUR;
    expect(releaseDue({ publishedAt: T0 - 25 * HOUR, seenAt: T0 - HOUR, waitMs: wait, now: T0 })).toEqual({ due: true, since: T0 - 25 * HOUR, until: T0 - HOUR });
    expect(releaseDue({ publishedAt: T0 - 3 * HOUR, seenAt: T0 - HOUR, waitMs: wait, now: T0 })).toEqual({ due: false, since: T0 - 3 * HOUR, until: T0 + 21 * HOUR });
    // No publish time: the first sight.
    expect(releaseDue({ seenAt: T0 - 2 * HOUR, waitMs: wait, now: T0 })).toMatchObject({ due: false, until: T0 + 22 * HOUR });
    // Never seen before now, no time at all: it starts now.
    expect(releaseDue({ waitMs: wait, now: T0 })).toMatchObject({ due: false, until: T0 + wait });
    // A publish time later than the first sight (a wrong clock somewhere) can't hold a release longer.
    expect(releaseDue({ publishedAt: T0 + 1000 * HOUR, seenAt: T0 - 25 * HOUR, waitMs: wait, now: T0 })).toMatchObject({ due: true });
    expect(releaseDue({ publishedAt: T0, seenAt: T0, waitMs: 0, now: T0 })).toMatchObject({ due: true });
  });

  it("npm: a version published 3 h ago is not offered; it is once it is 24 h old", async () => {
    const h = harness({ npm: "0.12.1", published: { "0.12.1": T0 - 3 * HOUR } });
    await h.checker.tick();
    expect(h.checker.status()).toMatchObject({
      latest: "0.12.1",
      available: false,
      waiting: { version: "0.12.1", since: T0 - 3 * HOUR, until: T0 + 21 * HOUR },
      waitHours: 24,
    });
    h.advance(21 * HOUR - 1);
    expect(h.checker.status().available).toBe(false);
    h.advance(1);
    const s = h.checker.status();
    expect(s).toMatchObject({ latest: "0.12.1", available: true });
    expect(s.waiting).toBeUndefined();
  });

  it("npm: a registry that gives no publish time: 24 h from when this daemon first saw the version, across a restart", async () => {
    const h = harness({ npm: "0.12.1", published: {} });
    await h.checker.tick();
    expect(h.checker.status()).toMatchObject({ available: false, waiting: { version: "0.12.1", since: T0, until: T0 + 24 * HOUR } });
    h.advance(10 * HOUR);
    await h.checker.tick();
    // A restarted daemon keeps the first sight: the wait doesn't start again.
    const again = harness({ npm: "0.12.1", published: {}, file: path.join(dir, "update-check.json"), now: h.now });
    await again.checker.tick();
    expect(again.checker.status()).toMatchObject({ available: false, waiting: { until: T0 + 24 * HOUR } });
    h.advance(14 * HOUR);
    expect(again.checker.status()).toMatchObject({ available: true });
  });

  it("a newer release starts its own wait", async () => {
    let latest = "0.12.1";
    const times: Record<string, number> = { "0.12.1": LONG_AGO };
    const h = harness({ fetchNpm: async () => ({ latest, published: times }) });
    await h.checker.tick();
    expect(h.checker.status()).toMatchObject({ latest: "0.12.1", available: true });
    h.advance(NPM_EVERY_MS);
    latest = "0.12.2";
    times["0.12.2"] = h.now() - HOUR;
    await h.checker.tick();
    expect(h.checker.status()).toMatchObject({ latest: "0.12.2", available: false, waiting: { version: "0.12.2", until: h.now() + 23 * HOUR } });
  });

  it("the hub names a version it gives no time for: npm's publish time decides, else the first sight", async () => {
    const young = harness({ hub: "0.12.2", published: { "0.12.2": T0 - 2 * HOUR } });
    await young.checker.tick();
    expect(young.calls.npm).toBe(1);
    expect(young.checker.status()).toMatchObject({ latest: "0.12.2", source: "hub", available: false, waiting: { until: T0 + 22 * HOUR } });
    // The time is known now: no more registry reads for it.
    young.advance(NPM_EVERY_MS);
    await young.checker.tick();
    expect(young.calls.npm).toBe(1);

    // The registry can't be read: the wait counts from the first sight, and the registry is tried again at most every 6 h.
    const offline = harness({ hub: "0.12.2", npm: new Error("offline"), file: path.join(dir, "another-machine.json") });
    await offline.checker.tick();
    expect(offline.checker.status()).toMatchObject({ available: false, waiting: { since: T0, until: T0 + 24 * HOUR } });
    offline.advance(NPM_EVERY_MS - 1);
    await offline.checker.tick();
    expect(offline.calls.npm).toBe(1);
    offline.advance(24 * HOUR);
    await offline.checker.tick();
    expect(offline.checker.status()).toMatchObject({ available: true });
    // Old enough by the first sight: the registry isn't asked for its age any more.
    const asked = offline.calls.npm;
    offline.advance(NPM_EVERY_MS);
    await offline.checker.tick();
    expect(offline.calls.npm).toBe(asked);
  });

  it("0 turns the wait off: a release an hour old is offered at once", async () => {
    const h = harness({ npm: "0.12.1", published: { "0.12.1": T0 - HOUR }, wait: 0 });
    await h.checker.tick();
    const s = h.checker.status();
    expect(s).toMatchObject({ available: true, waitHours: 0 });
    expect(s.waiting).toBeUndefined();
  });

  it("auto-update waits too, then installs the version it waited for, by name", async () => {
    const h = harness({ npm: "0.12.1", published: { "0.12.1": T0 - 3 * HOUR }, auto: true });
    await h.checker.tick();
    expect(h.checker.autoDue()).toBe(false);
    expect(h.calls.auto).toEqual([]);
    h.advance(20 * HOUR);
    await h.checker.tick();
    expect(h.calls.auto).toEqual([]);
    h.advance(HOUR);
    await h.checker.tick();
    expect(h.calls.auto).toEqual(["0.12.1"]);
  });

  it("GitHub: the menu bar's release is held until it is 24 h old, by published_at", async () => {
    const fresh: MenubarRelease = { ...REL, publishedAt: T0 - 2 * HOUR };
    const h = harness({ hub: "0.12.1", menubar: { kind: "offer", release: fresh } });
    await h.checker.tick();
    const s = h.checker.status();
    expect(s.menubar).toBeUndefined();
    expect(s.menubarHeld).toEqual({ version: "0.12.1", reason: "waiting", detail: "it is younger than the 24 h waiting time for new releases", until: T0 + 22 * HOUR });
    h.advance(22 * HOUR);
    expect(h.checker.status().menubar).toEqual(fresh);
    expect(h.checker.status().menubarHeld).toBeUndefined();
    // With the wait off it is offered at once.
    const off = harness({ hub: "0.12.1", menubar: { kind: "offer", release: fresh }, wait: 0 });
    await off.checker.tick();
    expect(off.checker.status().menubar).toEqual(fresh);
  });

  it("GitHub: no published_at, or another zip under the same version: the wait counts from the first sight of that file", async () => {
    const { publishedAt: _at, ...undated } = REL;
    let release: MenubarRelease = undated;
    const h = harness({ hub: "0.12.1", fetchMenubar: async () => ({ kind: "offer", release }) });
    await h.checker.tick();
    expect(h.checker.status().menubarHeld).toMatchObject({ reason: "waiting", until: T0 + 24 * HOUR });
    h.advance(24 * HOUR);
    await h.checker.tick();
    expect(h.checker.status().menubar).toEqual(undated);
    // The same version with other bytes is a file this daemon has not seen: it waits again.
    release = { ...undated, sha256: "b".repeat(64) };
    h.advance(MENUBAR_EVERY_MS);
    await h.checker.tick();
    expect(h.checker.status().menubar).toBeUndefined();
    expect(h.checker.status().menubarHeld).toMatchObject({ reason: "waiting", until: h.now() + 24 * HOUR });
  });
});

describe("state saved by a version from before the waiting time", () => {
  it("its menu bar offer has no age on record: served as it was, and the release is read again at the first look", async () => {
    const file = path.join(dir, "update-check.json");
    const { publishedAt: _at, ...saved } = REL;
    // The last read was a minute ago: without the missing age, the next would be 6 h away.
    writeUpdateCheck({ menubar: saved, menubarAt: T0 - 60_000 }, file);
    const fresh: MenubarRelease = { ...saved, publishedAt: T0 - 2 * HOUR };
    const h = harness({ hub: "0.12.1", file, menubar: { kind: "offer", release: fresh } });
    expect(h.checker.status().menubar).toEqual(saved);
    await h.checker.tick();
    expect(h.calls.menubar).toBe(1);
    // Now its age is known: two hours, so it waits like any release.
    expect(h.checker.status().menubar).toBeUndefined();
    expect(h.checker.status().menubarHeld).toMatchObject({ reason: "waiting", until: T0 + 22 * HOUR });
  });
});

describe("a release that fails the signing check (SPEC §41)", () => {
  const SIGNED: MenubarRelease = { ...REL, signed: true };
  const UNSIGNED = { kind: "held", held: { version: "0.12.2", reason: "unsigned", detail: "the release has no workmesh-release.json.sig, so no maintainer key vouches for its files" } } as const;

  it("says whether signing is on", () => {
    expect(harness().checker.status().signing).toEqual({ on: false });
    expect(harness({ signing: true }).checker.status().signing).toEqual({ on: true });
  });

  it("offers nothing and says why; the earlier release's app goes too; a good release brings the offer back", async () => {
    let read: MenubarRead = { kind: "offer", release: SIGNED };
    const h = harness({ hub: "0.12.1", signing: true, fetchMenubar: async () => read });
    await h.checker.tick();
    expect(h.checker.status().menubar).toEqual(SIGNED);
    read = UNSIGNED;
    h.advance(MENUBAR_EVERY_MS);
    await h.checker.tick();
    const s = h.checker.status();
    expect(s.menubar).toBeUndefined();
    expect(s.menubarHeld).toEqual(UNSIGNED.held);
    // It stays so across a restart, without another read.
    const again = harness({ hub: "0.12.1", signing: true, file: path.join(dir, "update-check.json"), now: h.now });
    expect(again.checker.status().menubarHeld).toEqual(UNSIGNED.held);
    expect(again.checker.status().menubar).toBeUndefined();
    read = { kind: "offer", release: { ...SIGNED, version: "0.12.2", sha256: "c".repeat(64) } };
    h.advance(MENUBAR_EVERY_MS);
    await h.checker.tick();
    expect(h.checker.status().menubar).toMatchObject({ version: "0.12.2", signed: true });
    expect(h.checker.status().menubarHeld).toBeUndefined();
  });

  it("a read that fails (GitHub unreachable) keeps what was checked before", async () => {
    let fail = false;
    const h = harness({
      hub: "0.12.1",
      signing: true,
      fetchMenubar: async () => {
        if (fail) throw new Error("workmesh-release.json answered 503");
        return { kind: "offer", release: SIGNED };
      },
    });
    await h.checker.tick();
    fail = true;
    h.advance(MENUBAR_EVERY_MS);
    await h.checker.tick();
    expect(h.checker.status().menubar).toEqual(SIGNED);
  });

  it("signing switched on by an update: an offer saved before it, never checked against a key, is not served", async () => {
    const file = path.join(dir, "update-check.json");
    const before = harness({ hub: "0.12.1", file });
    await before.checker.tick();
    expect(before.checker.status().menubar).toEqual(REL);
    expect(readUpdateCheck(file).menubar).toEqual(REL);
    // The updated daemon pins a key. Before its first read it offers nothing; that read comes at once, not 6 h later.
    const after = harness({ hub: "0.12.1", file, signing: true, menubar: { kind: "offer", release: SIGNED }, now: before.now });
    expect(after.checker.status().menubar).toBeUndefined();
    await after.checker.tick();
    expect(after.calls.menubar).toBe(1);
    expect(after.checker.status().menubar).toEqual(SIGNED);
  });

  it("signing off again (an older version back): a saved hold from the check is dropped and the release read again", async () => {
    const file = path.join(dir, "update-check.json");
    writeUpdateCheck({ menubarAt: T0, menubarHeld: UNSIGNED.held }, file);
    const h = harness({ hub: "0.12.1", file });
    expect(h.checker.status().menubarHeld).toBeUndefined();
    await h.checker.tick();
    expect(h.calls.menubar).toBe(1);
    expect(h.checker.status().menubar).toEqual(REL);
  });
});

describe("what status and doctor say about it", () => {
  const base: UpdateStatus = { current: "0.12.0", available: false, waitHours: 24, install: { method: "npm", canUpdate: true }, auto: { enabled: false, scope: "patch" }, signing: { on: false } };

  it("status: a release that is offered, one that is still waiting, and a menu bar release that failed the check", () => {
    expect(updateLines(base)).toBeUndefined();
    expect(updateLines({ ...base, latest: "0.12.1", available: true })).toEqual({ text: "0.12.1 available: `workmesh update`", latest: "0.12.1" });
    const waiting = { version: "0.12.1", since: T0 - 3 * HOUR, until: T0 + 21 * HOUR };
    expect(updateLines({ ...base, latest: "0.12.1", waiting }, T0)).toEqual({
      text: "0.12.1 is out: offered in 21h 0m (new releases wait 24 h)",
      waiting: { version: "0.12.1", until: T0 + 21 * HOUR },
    });
    const held = { version: "0.12.1", reason: "bad-signature", detail: "the signature on workmesh-release.json is not from a maintainer key this version trusts" } as const;
    expect(updateLines({ ...base, signing: { on: true }, menubarHeld: held })).toEqual({
      text: "the menu bar app in release 0.12.1 is not offered: the signature on workmesh-release.json is not from a maintainer key this version trusts",
      menubarHeld: held,
    });
    // A menu bar release that is only waiting needs nobody's attention: status leaves it out.
    expect(updateLines({ ...base, menubarHeld: { version: "0.12.1", reason: "waiting", detail: "it is younger than the 24 h waiting time for new releases", until: T0 + HOUR } })).toBeUndefined();
    // A daemon from before the waiting time answers with less.
    expect(updateLines({ current: "0.12.0", latest: "0.12.1", available: true })).toMatchObject({ latest: "0.12.1" });
  });

  it("doctor: signing is not switched on yet; on; and why a release's app is not offered", () => {
    expect(signingCheck(base, 0)).toEqual({
      name: "release signing",
      status: "ok",
      detail: "not switched on yet: this version pins no maintainer key, so the menu bar app's download is checked against the SHA-256 GitHub lists",
    });
    expect(signingCheck({ ...base, signing: { on: true } }, 1)).toEqual({ name: "release signing", status: "ok", detail: "on: the menu bar app installs only from a release whose file list a maintainer key signed" });
    const held = { version: "0.12.1", reason: "unsigned", detail: "the release has no workmesh-release.json.sig, so no maintainer key vouches for its files" } as const;
    expect(signingCheck({ signing: { on: true }, menubarHeld: held }, 1)).toEqual({
      name: "release signing",
      status: "warn",
      detail: "on; the menu bar app in release 0.12.1 is not offered: the release has no workmesh-release.json.sig, so no maintainer key vouches for its files",
    });
    // No daemon, or one older than this CLI: this version's own list answers.
    expect(signingCheck(undefined, 0).detail).toContain("not switched on yet");
    expect(signingCheck({}, 2).detail).toContain("on: the menu bar app installs only");
    // Waiting is not a failed check.
    expect(signingCheck({ signing: { on: true }, menubarHeld: { reason: "waiting", detail: "it is younger", until: T0 } }, 1).status).toBe("ok");
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
    const newer = harness({ hub: "0.12.2", auto: true, last: failed, file: path.join(dir, "another-machine.json") });
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
    expect(info).toEqual({ latest: "0.12.1", versions: ["0.12.0", "0.12.1"], published: {} });
    await expect(fetchRegistryInfo("http://x/", (async () => new Response("{}", { status: 200 })) as typeof fetch)).rejects.toThrow(/no latest/);
  });

  it("npm: each version's publish time, from the full packument (the short one has none)", async () => {
    let accept = "";
    const body = {
      "dist-tags": { latest: "0.12.1" },
      versions: { "0.12.0": {}, "0.12.1": {}, "0.12.2-beta.1": {} },
      time: { created: "2026-07-06T10:00:00.000Z", modified: "2026-11-25T20:00:00.000Z", "0.12.0": "2026-11-25T08:00:00.000Z", "0.12.1": "2026-11-25T19:30:00.000Z", "0.12.2-beta.1": "soon", "9.9.9": "2026-11-25T19:30:00.000Z" },
    };
    const info = await fetchRegistryInfo("https://registry.example.test", (async (_url: string, init?: RequestInit) => {
      accept = String(new Headers(init?.headers).get("accept"));
      return new Response(JSON.stringify(body));
    }) as typeof fetch);
    expect(accept).toBe("application/json");
    // Only versions the registry lists, and only times that are times.
    expect(info.published).toEqual({ "0.12.0": Date.parse("2026-11-25T08:00:00.000Z"), "0.12.1": Date.parse("2026-11-25T19:30:00.000Z") });
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
    const { publishedAt: _at, ...undated } = REL;
    const read = (b: unknown) => fetchMenubarRelease("https://api/x", (async () => new Response(JSON.stringify(b))) as typeof fetch, 5000, []);
    expect(await read(body)).toEqual({ kind: "offer", release: { ...undated, size: 1234 } });
    expect(await read({ ...body, published_at: "2026-11-25T19:40:00Z" })).toEqual({ kind: "offer", release: { ...undated, size: 1234, publishedAt: Date.parse("2026-11-25T19:40:00Z") } });
    const noDigest = { ...body, assets: [{ name: "Workmesh-menubar-macos.zip", browser_download_url: REL.url }] };
    expect(await read(noDigest)).toEqual({ kind: "none" });
    expect(await read({ ...body, prerelease: true })).toEqual({ kind: "none" });
    expect(await read({ ...body, assets: [body.assets[0]] })).toEqual({ kind: "none" });
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

  it("doctor's version line: a release inside the waiting time is named, not offered", async () => {
    const status = (over: Partial<UpdateStatus>): UpdateStatus => ({
      current: pkg.version,
      latest: "99.0.0",
      available: false,
      waitHours: 24,
      install: { method: "npm", canUpdate: true },
      auto: { enabled: false, scope: "patch" },
      signing: { on: false },
      ...over,
    });
    const waiting = await start({ getUpdate: () => status({ waiting: { version: "99.0.0", since: T0 - 3 * HOUR, until: T0 + 21 * HOUR } }) });
    expect(await versionCheck(waiting.port, pkg.version, T0)).toEqual({ name: "version", status: "ok", detail: `${pkg.version}; 99.0.0 is out: offered in 21h 0m (new releases wait 24 h)` });
    server?.close();
    const offered = await start({ getUpdate: () => status({ available: true }) });
    expect(await versionCheck(offered.port, pkg.version, T0)).toEqual({ name: "version", status: "warn", detail: `${pkg.version}; 99.0.0 available: \`workmesh update\`` });
  });

  it("doctor's version line with no daemon: the saved check, read with the same waiting time", async () => {
    // A port nothing listens on, and a config dir of this test's own (the waiting time is read from config).
    const { port } = await start({});
    server?.close();
    const savedConfig = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(dir, "config");
    try {
      writeUpdateCheck({ latest: "99.0.0", seen: { version: "99.0.0", at: T0 - HOUR } });
      expect(await versionCheck(port, pkg.version, T0)).toMatchObject({ status: "ok", detail: `${pkg.version}; 99.0.0 is out: offered in 23h 0m (new releases wait 24 h)` });
      expect(await versionCheck(port, pkg.version, T0 + 23 * HOUR)).toMatchObject({ status: "warn", detail: `${pkg.version}; 99.0.0 available: \`workmesh update\`` });
      // The registry's publish time, when the daemon saved one, counts first.
      writeUpdateCheck({ latest: "99.0.0", seen: { version: "99.0.0", at: T0 - HOUR }, published: { version: "99.0.0", at: T0 - 30 * HOUR } });
      expect((await versionCheck(port, pkg.version, T0)).status).toBe("warn");
      // A check saved by a version from before the waiting time holds no time for the release: offered, as it was.
      writeUpdateCheck({ latest: "99.0.0" });
      expect((await versionCheck(port, pkg.version, T0)).status).toBe("warn");
    } finally {
      if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedConfig;
    }
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

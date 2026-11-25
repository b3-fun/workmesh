import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ServiceUnavailableError,
  enableLinger,
  installService,
  lingerOf,
  probeSystemdUser,
  serviceStatus,
  systemdUnitPath,
  userRuntimeDir,
} from "../src/lib/service";
import type { Runner, SystemdUser } from "../src/lib/service";
import { prepareSystemd } from "../src/commands/service";
import { lastContact, offlineCause, serviceChecks } from "../src/commands/doctor";
import { HUB_ALIASES, runInit, sameHub } from "../src/commands/init";
import { isSuperseded } from "../src/hub/forwarder";

/**
 * First-run onboarding (0.11.1): a Linux box you SSH into keeps its daemon after logout (lingering), nothing half-
 * installs where systemd can't run it, doctor names why a paired machine shows offline, and `init` keeps a pairing
 * made under another address of the same hub. Temp HOME, mocked systemctl / loginctl.
 */

let home: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_RUNTIME_DIR"];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-onboard-"));
  for (const k of ENV) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const enoent = (): never => {
  throw Object.assign(new Error("spawnSync systemctl ENOENT"), { code: "ENOENT" });
};
const failed = (stderr: string): never => {
  throw Object.assign(new Error("Command failed"), { status: 1, stderr });
};

describe("systemd --user on Linux", () => {
  it("no systemctl (a container, WSL without systemd): no service, and no unit file is written", () => {
    const run: Runner = () => enoent();
    const probe = probeSystemdUser({ run });
    expect(probe).toEqual({ systemctl: false, manager: false, linger: undefined, error: "systemctl not found" });
    expect(() => installService({ home, run, kind: "systemd", node: "/n", entry: "/e", env: {}, probe })).toThrow(ServiceUnavailableError);
    expect(fs.existsSync(systemdUnitPath(home))).toBe(false);
  });

  it("no user manager (su, cron, SSH without pam_systemd): says why, writes nothing, names the fix", () => {
    const lingerDir = path.join(home, "linger");
    fs.mkdirSync(lingerDir);
    const run: Runner = (cmd) =>
      cmd === "systemctl" ? failed("Failed to connect to bus: No medium found\nmore\n") : "";
    const probe = probeSystemdUser({ run, user: "mitch", lingerDir });
    expect(probe).toEqual({ systemctl: true, manager: false, linger: false, error: "Failed to connect to bus: No medium found" });
    let err: unknown;
    try {
      installService({ home, run, kind: "systemd", node: "/n", entry: "/e", env: {}, probe });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect((err as ServiceUnavailableError).message).toContain("no systemd user session (Failed to connect to bus");
    expect((err as ServiceUnavailableError).fix).toContain("loginctl enable-linger");
    expect(fs.existsSync(systemdUnitPath(home))).toBe(false);
  });

  it("lingering: logind's file per user, else loginctl when nobody ever lingered here", () => {
    const lingerDir = path.join(home, "linger");
    fs.mkdirSync(lingerDir);
    expect(lingerOf("mitch", { lingerDir, run: () => "" })).toBe(false);
    fs.writeFileSync(path.join(lingerDir, "mitch"), "");
    expect(lingerOf("mitch", { lingerDir, run: () => "" })).toBe(true);
    const none = path.join(home, "no-linger-dir");
    expect(lingerOf("mitch", { lingerDir: none, run: () => "yes\n" })).toBe(true);
    expect(lingerOf("mitch", { lingerDir: none, run: () => "no\n" })).toBe(false);
    expect(lingerOf("mitch", { lingerDir: none, run: () => failed("Failed to get user: User ID 1001 is not logged in or lingering") })).toBe(false);
    expect(lingerOf("mitch", { lingerDir: none, run: () => enoent() })).toBeUndefined();
  });

  it("enable-linger without a password prompt; a refusal comes back as text", () => {
    const calls: string[][] = [];
    expect(enableLinger({ run: (cmd, args) => (calls.push([cmd, ...args]), "") })).toEqual({ ok: true });
    expect(calls).toEqual([["loginctl", "--no-ask-password", "enable-linger"]]);
    expect(enableLinger({ run: () => failed("Could not enable linger: Access denied") })).toEqual({ ok: false, error: "Could not enable linger: Access denied" });
  });

  it("finds the user's runtime dir when the shell lost XDG_RUNTIME_DIR", () => {
    expect(userRuntimeDir({ XDG_RUNTIME_DIR: "/run/user/7" }, 1001, () => false)).toBe("/run/user/7");
    expect(userRuntimeDir({}, 1001, (p) => p === "/run/user/1001")).toBe("/run/user/1001");
    expect(userRuntimeDir({}, 1001, () => false)).toBeUndefined();
  });

  it("serviceStatus carries the probe and reads the unit's program back", () => {
    const probe: SystemdUser = { systemctl: true, manager: false, linger: false, error: "Failed to connect to bus" };
    const st = serviceStatus({ home, kind: "systemd", probe, run: () => "" });
    expect(st).toMatchObject({ kind: "systemd", installed: false, loaded: false, systemd: probe });
  });
});

describe("prepareSystemd: lingering before the unit (Mitch's b3-box, 11-25)", () => {
  /** A box where lingering starts off; `loginctl enable-linger` turns it on and starts the user manager. */
  function box(opts: { refuse?: boolean; managerOnlyWithLinger?: boolean; linger?: boolean } = {}) {
    const lingerDir = path.join(home, "linger");
    fs.mkdirSync(lingerDir, { recursive: true });
    const user = os.userInfo().username;
    if (opts.linger) fs.writeFileSync(path.join(lingerDir, user), "");
    const calls: string[][] = [];
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "loginctl" && args.includes("enable-linger")) {
        if (opts.refuse) failed("Could not enable linger: Access denied");
        fs.writeFileSync(path.join(lingerDir, user), "");
        return "";
      }
      if (cmd === "systemctl" && opts.managerOnlyWithLinger && !fs.existsSync(path.join(lingerDir, user))) {
        failed("Failed to connect to bus: No medium found");
      }
      return "";
    };
    return { run, calls, lingerDir };
  }
  const enabled = (calls: string[][]) => calls.filter((c) => c[0] === "loginctl" && c.includes("enable-linger")).length;

  it("turns lingering on when it is off", async () => {
    const b = box();
    const o = await prepareSystemd({ run: b.run, lingerDir: b.lingerDir });
    expect(enabled(b.calls)).toBe(1);
    expect(o).toMatchObject({ lingerEnabled: true, systemd: { systemctl: true, manager: true, linger: true } });
  });

  it("no user manager until lingering is on (su, cron): enabling it brings the manager up", async () => {
    const b = box({ managerOnlyWithLinger: true });
    const o = await prepareSystemd({ run: b.run, lingerDir: b.lingerDir });
    expect(o.systemd).toMatchObject({ manager: true, linger: true });
  });

  it("leaves an already lingering user alone, and --no-linger leaves it off", async () => {
    const on = box({ linger: true });
    expect(await prepareSystemd({ run: on.run, lingerDir: on.lingerDir })).toEqual({ systemd: { systemctl: true, manager: true, linger: true } });
    expect(enabled(on.calls)).toBe(0);
    fs.rmSync(path.join(home, "linger"), { recursive: true });
    const off = box();
    const o = await prepareSystemd({ run: off.run, lingerDir: off.lingerDir, linger: false });
    expect(enabled(off.calls)).toBe(0);
    expect(o.systemd.linger).toBe(false);
  });

  it("a refusal (no polkit) is reported with logind's words, not thrown", async () => {
    const b = box({ refuse: true });
    const asked: string[] = [];
    const o = await prepareSystemd({ run: b.run, lingerDir: b.lingerDir, sudoLinger: async (user) => (asked.push(user), false) });
    expect(asked).toEqual([os.userInfo().username]);
    expect(o).toMatchObject({ lingerError: "Could not enable linger: Access denied", systemd: { linger: false } });
  });

  it("refused, then turned on with sudo in the terminal (the person said yes)", async () => {
    const b = box({ refuse: true });
    const o = await prepareSystemd({
      run: b.run,
      lingerDir: b.lingerDir,
      sudoLinger: async (user) => {
        fs.writeFileSync(path.join(b.lingerDir, user), "");
        return true;
      },
    });
    expect(o).toMatchObject({ lingerEnabled: true, systemd: { linger: true, manager: true } });
  });

  it("no systemd: nothing to do", async () => {
    expect(await prepareSystemd({ run: () => enoent() })).toEqual({ systemd: { systemctl: false, manager: false, linger: undefined, error: "systemctl not found" } });
  });
});

describe("doctor: why a paired machine shows offline", () => {
  it("names the Linux causes with their fixes", () => {
    const base = { kind: "systemd" as const, installed: true, loaded: true, pid: 9 };
    expect(offlineCause({ ...base, systemd: { systemctl: true, manager: true, linger: false } })).toContain("lingering is off");
    expect(offlineCause({ ...base, systemd: { systemctl: true, manager: true, linger: false } })).toContain("sudo loginctl enable-linger $USER");
    expect(offlineCause({ ...base, systemd: { systemctl: true, manager: false, linger: false, error: "No medium found" } })).toContain(
      "no systemd user session: No medium found",
    );
    expect(offlineCause({ kind: "launchd", installed: false, loaded: false })).toContain("no daemon service is installed");
    expect(offlineCause({ ...base, systemd: { systemctl: true, manager: true, linger: true } })).toBe("");
  });

  it("service checks: none without systemd (ok), no user session (warn), lingering off (warn), on (ok)", () => {
    const none = serviceChecks({ kind: "systemd", installed: false, loaded: false, systemd: { systemctl: false, manager: false, linger: undefined } }, true);
    expect(none.map((c) => c.status)).toEqual(["ok"]);
    expect(none[0]!.detail).toContain("no systemd on this machine");

    const noSession = serviceChecks({ kind: "systemd", installed: false, loaded: false, systemd: { systemctl: true, manager: false, linger: false, error: "x" } }, true);
    expect(noSession).toHaveLength(1);
    expect(noSession[0]).toMatchObject({ status: "warn" });
    expect(noSession[0]!.detail).toContain("no systemd user session (x)");

    const off = serviceChecks({ kind: "systemd", installed: true, loaded: true, pid: 5, systemd: { systemctl: true, manager: true, linger: false } }, true);
    expect(off.map((c) => [c.name, c.status])).toEqual([
      ["daemon service", "ok"],
      ["logout", "warn"],
    ]);
    const on = serviceChecks({ kind: "systemd", installed: true, loaded: true, pid: 5, systemd: { systemctl: true, manager: true, linger: true } }, true);
    expect(on.map((c) => c.status)).toEqual(["ok", "ok"]);

    // launchd: a daemon running outside the installed service won't come back after a crash.
    const outside = serviceChecks({ kind: "launchd", installed: true, loaded: true }, true);
    expect(outside[0]!.detail).toContain("isn't the service's");
  });

  it("reads when the hub last heard from this machine from the daemon's state file", () => {
    const file = path.join(home, "hub-forward.json");
    fs.writeFileSync(file, JSON.stringify({ v: 1, savedAt: 1, url: "https://hub.test", lastContactAt: 1234, sessions: [], queue: [] }));
    expect(lastContact("https://hub.test", file)).toBe(1234);
    expect(lastContact("https://other.test", file)).toBeUndefined();
    expect(lastContact("https://hub.test", path.join(home, "missing.json"))).toBeUndefined();
  });
});

describe("one hub, two addresses (An's ans-macbook-pro, 11-25)", () => {
  const TOKEN = `bp_${"a".repeat(64)}`;

  it("B3's two hosts are the same hub without asking anyone", async () => {
    const check = vi.fn(async () => "rejected" as const);
    expect(HUB_ALIASES[0]).toEqual(["https://workmesh.b3os.org", "https://bullpen.b3os.org"]);
    expect(await sameHub({ url: "https://bullpen.b3os.org", deviceToken: TOKEN }, "https://workmesh.b3os.org", check)).toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  it("a sibling host counts when it accepts this machine's token; a token never goes to another domain", async () => {
    const check = vi.fn(async (h: { url: string }) => (h.url === "https://b.example.org" ? ("ok" as const) : ("rejected" as const)));
    expect(await sameHub({ url: "https://a.example.org", deviceToken: TOKEN }, "https://b.example.org", check)).toBe(true);
    expect(await sameHub({ url: "https://a.example.org", deviceToken: TOKEN }, "https://c.example.org", check)).toBe(false);
    check.mockClear();
    expect(await sameHub({ url: "https://a.example.org", deviceToken: TOKEN }, "https://hub.elsewhere.net", check)).toBe(false);
    expect(await sameHub({ url: "https://example.org", deviceToken: TOKEN }, "https://hub.org", check)).toBe(false);
    expect(check).not.toHaveBeenCalled();
    // A dev hub on this machine under two names.
    expect(await sameHub({ url: "http://localhost:8787", deviceToken: TOKEN }, "http://127.0.0.1:8787", async () => "ok")).toBe(true);
    expect(await sameHub({ url: "http://localhost:8787", deviceToken: TOKEN }, "http://127.0.0.1:9999", async () => "ok")).toBe(false);
  });

  it("init keeps a pairing made at the other address and forwards to the new one", async () => {
    const dir = path.join(home, ".config", "workmesh");
    fs.mkdirSync(dir, { recursive: true });
    const hub = {
      url: "https://bullpen.b3os.org",
      deviceId: "dev_01JD0000000000000000000000",
      deviceToken: TOKEN,
      project: { id: "p_b3", name: "B3", include: { remotes: ["github.com/b3-fun/"], dirs: [] }, issueKeys: ["B3"] },
      person: { email: "an@example.com", name: "An" },
      includeDirs: ["/x"],
      excludeDirs: [],
      share: "metadata",
    };
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ hub }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const connects: string[] = [];
    try {
      await runInit("https://workmesh.b3os.org", { codex: false }, {
        claudeBin: null,
        restartDaemon: async () => true,
        connect: async (url) => {
          connects.push(url);
        },
        checkToken: async () => "ok",
        firstContact: async () => ({ kind: "ok", at: Date.now(), sharedSessions: 0 }),
        stopsAtLogout: () => true,
      });
      expect(connects).toEqual([]);
      const after = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")) as { hub: typeof hub };
      expect(after.hub).toMatchObject({ url: "https://workmesh.b3os.org", deviceId: hub.deviceId, deviceToken: TOKEN, includeDirs: ["/x"], share: "metadata" });
      const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(printed).toContain("pairing kept");
      expect(printed).toContain("online on the board, no agents running yet");
      expect(printed).toContain("once you log out, systemd stops the daemon");
      // --repair still pairs again.
      await runInit("https://workmesh.b3os.org", { codex: false, repair: true }, {
        claudeBin: null,
        restartDaemon: async () => true,
        connect: async (url) => {
          connects.push(url);
        },
        firstContact: async () => ({ kind: "failed", error: "hub unreachable" }),
      });
      expect(connects).toEqual(["https://workmesh.b3os.org"]);
      expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("not reached yet: hub unreachable");
    } finally {
      log.mockRestore();
    }
  });

  it("a different hub is paired anew", async () => {
    const dir = path.join(home, ".config", "workmesh");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        hub: {
          url: "https://hub.one.test",
          deviceId: "dev_01JD0000000000000000000000",
          deviceToken: TOKEN,
          project: { id: "p", name: "P", include: { remotes: [], dirs: [] }, issueKeys: [] },
        },
      }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const connects: string[] = [];
    try {
      await runInit("https://hub.two.example", { codex: false }, {
        claudeBin: null,
        restartDaemon: async () => true,
        connect: async (url) => {
          connects.push(url);
        },
        checkToken: async () => "ok",
        firstContact: async () => ({ kind: "no-daemon" }),
      });
      expect(connects).toEqual(["https://hub.two.example"]);
      expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("no daemon is running");
    } finally {
      log.mockRestore();
    }
  });
});

describe("a superseded token (the machine paired again)", () => {
  it("reads the hub's 401 body", () => {
    expect(isSuperseded(JSON.stringify({ error: "superseded: b3-box paired again", reason: "superseded" }))).toBe(true);
    expect(isSuperseded(JSON.stringify({ error: "unknown or revoked device token; pair again" }))).toBe(false);
    expect(isSuperseded("superseded")).toBe(true);
    expect(isSuperseded("")).toBe(false);
  });
});

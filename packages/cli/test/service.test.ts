import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markStopRequested, takeStopRequest } from "../src/lib/daemon-control";
import {
  LAUNCHD_LABEL,
  SERVICE_ENV,
  installService,
  launchAgentPath,
  renderPlist,
  serviceEnv,
  serviceKind,
  serviceStatus,
  stableNodePath,
  startService,
  systemdUnitPath,
  uninstallService,
} from "../src/lib/service";

// v0.10 (SPEC §24): the daemon under launchd / systemd, so a crash, kill, reboot or wake brings it back.

let home: string;
let calls: string[][];
const run = (cmd: string, args: string[]): string => {
  calls.push([cmd, ...args]);
  if (cmd === "launchctl" && args[0] === "print") return "state = running\n\tpid = 4242\n";
  if (cmd === "systemctl" && args.includes("show")) return "ActiveState=active\nMainPID=777\n";
  return "";
};
const uid = typeof process.getuid === "function" ? process.getuid() : 0;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-service-"));
  calls = [];
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("launchd (macOS)", () => {
  it("the plist: RunAtLoad, KeepAlive unless it exited cleanly, ThrottleInterval 10, logs in ~/Library/Logs", () => {
    const plist = renderPlist({
      node: "/opt/homebrew/bin/node",
      entry: "/Users/x/workmesh/packages/cli/dist/index.js",
      env: { PATH: "/opt/homebrew/bin:/usr/bin", [SERVICE_ENV]: "1", XDG_STATE_HOME: "/tmp/a&b" },
      log: "/Users/x/Library/Logs/workmesh-daemon.log",
    });
    expect(plist).toContain(`<key>Label</key><string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toMatch(/<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/Users\/x\/workmesh\/packages\/cli\/dist\/index\.js<\/string>\s*<string>start<\/string>/);
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>/);
    expect(plist).toContain("<key>ThrottleInterval</key><integer>10</integer>");
    expect(plist).toContain("<key>StandardOutPath</key><string>/Users/x/Library/Logs/workmesh-daemon.log</string>");
    expect(plist).toContain("<key>WORKMESH_SERVICE</key><string>1</string>");
    expect(plist).toContain("/tmp/a&amp;b");
  });

  it("install writes the plist and (re)loads it; status reads it back; uninstall removes it", () => {
    const res = installService({ home, run, kind: "launchd", node: "/usr/bin/node", entry: "/x/dist/index.js", env: {} });
    const file = launchAgentPath(home);
    expect(res).toEqual({ kind: "launchd", file, wrote: true });
    expect(fs.readFileSync(file, "utf8")).toContain("<string>/x/dist/index.js</string>");
    expect(fs.existsSync(path.join(home, "Library", "Logs"))).toBe(true);
    expect(calls).toEqual([
      ["launchctl", "bootout", `gui/${uid}/${LAUNCHD_LABEL}`],
      ["launchctl", "bootstrap", `gui/${uid}`, file],
    ]);
    // Again with the same program: the file is unchanged, the job reloaded.
    expect(installService({ home, run, kind: "launchd", node: "/usr/bin/node", entry: "/x/dist/index.js", env: {} }).wrote).toBe(false);

    expect(serviceStatus({ home, run, kind: "launchd" })).toEqual({
      kind: "launchd",
      installed: true,
      loaded: true,
      pid: 4242,
      file,
      program: ["/usr/bin/node", "/x/dist/index.js"],
    });

    calls = [];
    expect(startService({ home, run, kind: "launchd" })).toBe(true);
    expect(calls.at(-1)).toEqual(["launchctl", "kickstart", `gui/${uid}/${LAUNCHD_LABEL}`]);

    calls = [];
    expect(uninstallService({ home, run, kind: "launchd" })).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(calls).toEqual([["launchctl", "bootout", `gui/${uid}/${LAUNCHD_LABEL}`]]);
    expect(serviceStatus({ home, run, kind: "launchd" })).toMatchObject({ installed: false, loaded: false });
    expect(startService({ home, run, kind: "launchd" })).toBe(false);
  });

  it("an installed job launchd doesn't know is bootstrapped, not kickstarted", () => {
    installService({ home, run, kind: "launchd", node: "/usr/bin/node", entry: "/x/dist/index.js", env: {} });
    calls = [];
    const notLoaded = (cmd: string, args: string[]): string => {
      calls.push([cmd, ...args]);
      if (args[0] === "print") throw new Error("Could not find service");
      return "";
    };
    expect(startService({ home, run: notLoaded, kind: "launchd" })).toBe(true);
    expect(calls.at(-1)).toEqual(["launchctl", "bootstrap", `gui/${uid}`, launchAgentPath(home)]);
  });
});

describe("systemd --user (Linux)", () => {
  it("writes a unit that restarts on failure and enables it", () => {
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    try {
      const res = installService({ home, run, kind: "systemd", node: "/usr/bin/node", entry: "/x/dist/index.js", env: {} });
      const unit = fs.readFileSync(systemdUnitPath(home), "utf8");
      expect(res.file).toBe(systemdUnitPath(home));
      expect(unit).toContain('ExecStart="/usr/bin/node" "/x/dist/index.js" start');
      expect(unit).toContain("Restart=on-failure");
      expect(unit).toContain('Environment="WORKMESH_SERVICE=1"');
      expect(calls).toEqual([
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "workmesh.service"],
      ]);
      expect(serviceStatus({ home, run, kind: "systemd" })).toMatchObject({ installed: true, loaded: true, pid: 777 });
      expect(uninstallService({ home, run, kind: "systemd" })).toBe(true);
      expect(fs.existsSync(systemdUnitPath(home))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });
});

describe("the service's program and environment", () => {
  it("prefers the node on PATH when it is this same binary (Homebrew's stable path)", () => {
    const bin = path.join(home, "bin");
    const cellar = path.join(home, "Cellar", "node", "25.8.2", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(cellar, { recursive: true });
    fs.writeFileSync(path.join(cellar, "node"), "");
    fs.symlinkSync(path.join(cellar, "node"), path.join(bin, "node"));
    expect(stableNodePath(path.join(cellar, "node"), `/nope:${bin}`)).toBe(path.join(bin, "node"));
    expect(stableNodePath(path.join(cellar, "node"), "/nope")).toBe(path.join(cellar, "node"));
  });

  it("carries PATH and the dirs Workmesh reads, nothing else", () => {
    const env = serviceEnv("/opt/homebrew/bin/node", { HOME: "/h", XDG_STATE_HOME: "/s", SECRET_TOKEN: "x", CLAUDE_CONFIG_DIR: "/c" });
    expect(env).toEqual({
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      WORKMESH_SERVICE: "1",
      XDG_STATE_HOME: "/s",
      CLAUDE_CONFIG_DIR: "/c",
    });
  });

  it("tests never reach the real service manager", () => {
    expect(process.env.WORKMESH_NO_SERVICE).toBe("1");
    expect(serviceKind()).toBeNull();
  });
});

describe("stop requests (a service brings back a killed daemon, not a stopped one)", () => {
  it("marks the pid being stopped, and forgets it once read", () => {
    const file = path.join(home, "daemon.stop-requested");
    expect(takeStopRequest(123, file)).toBe(false);
    markStopRequested(123, file);
    expect(takeStopRequest(456, file)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    expect(takeStopRequest(123, file)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });
});

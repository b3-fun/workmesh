import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findRunningDaemon, looksLikeOurDaemon, stopDaemon } from "../src/lib/daemon-control";
import { legacyPidFilePath, pidFilePath } from "../src/lib/paths";
import { isProcessAlive, readPidFile, writePidFile } from "../src/lib/pidfile";

let tmp: string;
let savedStateHome: string | undefined;
let savedConfigHome: string | undefined;
const children: ChildProcess[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-control-"));
  savedStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = tmp;
  savedConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
});

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedStateHome;
  if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedConfigHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

type OnTerm = "exit" | "exit-slowly" | "ignore";

/**
 * A process whose command line looks like a daemon (`…/workmesh/dist/index.js
 * start`) or, with `ours: false`, like some other program. Resolves once its
 * SIGTERM handler is installed.
 */
async function fakeProcess(onTerm: OnTerm, ours = true): Promise<ChildProcess & { pid: number }> {
  const handler = {
    exit: "process.exit(0)",
    "exit-slowly": "setTimeout(() => process.exit(0), 300)",
    ignore: "",
  }[onTerm];
  const script = `process.on("SIGTERM", () => { ${handler} }); setInterval(() => {}, 1e6); console.log("ready");`;
  const args = ours ? ["-e", script, "/x/workmesh/dist/index.js", "start"] : ["-e", script, "some-other-tool"];
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "ignore"] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once("data", () => resolve());
    child.once("error", reject);
  });
  return child as ChildProcess & { pid: number };
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid as number;
}

describe("looksLikeOurDaemon", () => {
  it("recognises a daemon by its command line, and not another program", async () => {
    const daemon = await fakeProcess("exit");
    const other = await fakeProcess("exit", false);
    expect(looksLikeOurDaemon(daemon.pid)).toBe(true);
    expect(looksLikeOurDaemon(other.pid)).toBe(false);
    expect(looksLikeOurDaemon(await deadPid())).toBeUndefined();
  });
});

describe("stopDaemon", () => {
  it("returns only after the daemon has exited", async () => {
    const daemon = await fakeProcess("exit-slowly");
    writePidFile(daemon.pid);
    const outcome = await stopDaemon();
    expect(outcome).toEqual({ kind: "stopped", pid: daemon.pid, killed: false, legacy: false });
    expect(isProcessAlive(daemon.pid)).toBe(false);
    expect(fs.existsSync(pidFilePath())).toBe(false);
  });

  it("kills a daemon that ignores SIGTERM past the grace period", async () => {
    const daemon = await fakeProcess("ignore");
    writePidFile(daemon.pid);
    const outcome = await stopDaemon({ graceMs: 300 });
    expect(outcome).toEqual({ kind: "stopped", pid: daemon.pid, killed: true, legacy: false });
    expect(isProcessAlive(daemon.pid)).toBe(false);
    expect(fs.existsSync(pidFilePath())).toBe(false);
  });

  it("stops a daemon started before the rename, from the agentblip pidfile", async () => {
    const daemon = await fakeProcess("exit");
    writePidFile(daemon.pid, legacyPidFilePath());
    expect(legacyPidFilePath()).toBe(path.join(tmp, "agentblip", "daemon.pid"));
    const outcome = await stopDaemon();
    expect(outcome).toEqual({ kind: "stopped", pid: daemon.pid, killed: false, legacy: true });
    expect(isProcessAlive(daemon.pid)).toBe(false);
  });

  it("removes a pidfile whose process is gone", async () => {
    writePidFile(await deadPid());
    expect(await stopDaemon()).toEqual({ kind: "stale" });
    expect(fs.existsSync(pidFilePath())).toBe(false);
  });

  it("never signals a program that reused the pid", async () => {
    const other = await fakeProcess("exit", false);
    writePidFile(other.pid);
    expect(await stopDaemon()).toEqual({ kind: "stale" });
    expect(isProcessAlive(other.pid)).toBe(true);
    expect(fs.existsSync(pidFilePath())).toBe(false);
  });

  it("reports not-running without a pidfile", async () => {
    expect(await stopDaemon()).toEqual({ kind: "not-running" });
  });
});

describe("findRunningDaemon", () => {
  it("ignores and removes a pidfile whose process is gone", async () => {
    writePidFile(await deadPid());
    expect(await findRunningDaemon({ exitWaitMs: 100 })).toBeUndefined();
    expect(fs.existsSync(pidFilePath())).toBe(false);
  });

  it("ignores a pid reused by another program", async () => {
    const other = await fakeProcess("exit", false);
    writePidFile(other.pid);
    expect(await findRunningDaemon({ exitWaitMs: 100 })).toBeUndefined();
  });

  it("waits for a daemon that is shutting down", async () => {
    const daemon = await fakeProcess("exit-slowly");
    writePidFile(daemon.pid);
    daemon.kill("SIGTERM");
    expect(await findRunningDaemon({ exitWaitMs: 3000 })).toBeUndefined();
    expect(readPidFile()).toBeUndefined();
  });

  it("returns a live daemon that doesn't exit", async () => {
    const daemon = await fakeProcess("ignore");
    writePidFile(daemon.pid);
    expect(await findRunningDaemon({ exitWaitMs: 200 })).toBe(daemon.pid);
    expect(readPidFile()).toBe(daemon.pid);
  });

  it("sees a daemon started before the rename", async () => {
    const daemon = await fakeProcess("ignore");
    writePidFile(daemon.pid, legacyPidFilePath());
    expect(await findRunningDaemon({ exitWaitMs: 100 })).toBe(daemon.pid);
  });
});

describe("restart", () => {
  it("starts the new daemon only after the old one has exited", async () => {
    const daemon = await fakeProcess("exit-slowly");
    writePidFile(daemon.pid);
    let oldAliveAtSpawn: boolean | undefined;
    vi.resetModules();
    vi.doMock("../src/lib/daemon-client", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/lib/daemon-client")>()),
      isDaemonUp: async () => false,
      startDaemonInBackground: async () => {
        oldAliveAtSpawn = isProcessAlive(daemon.pid);
        return true;
      },
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { runRestart } = await import("../src/commands/start");
      await runRestart();
    } finally {
      vi.doUnmock("../src/lib/daemon-client");
      vi.restoreAllMocks();
    }
    expect(oldAliveAtSpawn).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

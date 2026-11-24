import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDaemon } from "../src/daemon";
import { configSchema } from "../src/lib/config";
import type { Config } from "../src/lib/config";
import { pidFilePath } from "../src/lib/paths";
import { readPidFile, writePidFile } from "../src/lib/pidfile";

let stateDirTmp: string;
let savedStateHome: string | undefined;

beforeEach(() => {
  stateDirTmp = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-daemon-"));
  savedStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateDirTmp;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedStateHome;
  fs.rmSync(stateDirTmp, { recursive: true, force: true });
});

const config = (over: Record<string, unknown> = {}): Config =>
  configSchema.parse({
    adapters: { codex: { enabled: false }, claudeCode: { enabled: false } },
    ...over,
  });

describe("runDaemon startup failures", () => {
  it("does not leave a pidfile when the sink cannot be created", async () => {
    // unlink leaves relay mode + no token in old configs; the daemon must
    // fail without claiming the pidfile, or `workmesh stop` lies later.
    await expect(runDaemon(config({ mode: "relay" }))).rejects.toThrow(/device token/);
    expect(fs.existsSync(pidFilePath())).toBe(false);
  });

  it("does not leave a pidfile when the port is already taken", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      await expect(runDaemon(config({ mode: "console", port }))).rejects.toThrow();
      expect(fs.existsSync(pidFilePath())).toBe(false);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it("refuses to start when a live daemon owns the pidfile", async () => {
    // a process whose command line looks like a daemon, and that won't exit
    const script = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1e6); console.log("ready")';
    const fake = spawn(process.execPath, ["-e", script, "/x/workmesh/dist/index.js", "start"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      await new Promise((resolve) => fake.stdout?.once("data", resolve));
      writePidFile(fake.pid as number);
      await expect(runDaemon(config({ mode: "console" }), { exitWaitMs: 200 })).rejects.toThrow(
        /already running/,
      );
      expect(readPidFile()).toBe(fake.pid);
    } finally {
      fake.kill("SIGKILL");
    }
  });

  it("ignores a pidfile whose pid now belongs to another program", async () => {
    // the test runner's parent is alive but isn't a daemon: the start goes on
    // and fails later, at the sink, instead of at the pidfile
    fs.mkdirSync(path.dirname(pidFilePath()), { recursive: true });
    fs.writeFileSync(pidFilePath(), `${process.ppid}\n`);
    await expect(runDaemon(config({ mode: "relay" }), { exitWaitMs: 200 })).rejects.toThrow(/device token/);
    expect(fs.existsSync(pidFilePath())).toBe(false);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configSchema } from "../src/lib/config";
import type { Config } from "../src/lib/config";
import net from "node:net";
import type { AddressInfo } from "node:net";
import {
  HOOK_TIMING,
  START_FAILURE_COOLDOWN_MS,
  ensureDaemon,
  inStartFailureCooldown,
  sinkConfigured,
} from "../src/lib/daemon-client";
import { logFilePath, spawnLockPath, startFailedMarkerPath } from "../src/lib/paths";

// port 1 is never listening — isDaemonUp fails immediately
const DEAD_PORT = 1;

const config = (over: Record<string, unknown> = {}): Config =>
  configSchema.parse({ port: DEAD_PORT, ...over });

let stateDirTmp: string;
let savedStateHome: string | undefined;

beforeEach(() => {
  stateDirTmp = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-client-"));
  savedStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateDirTmp;
});

afterEach(() => {
  if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedStateHome;
  fs.rmSync(stateDirTmp, { recursive: true, force: true });
});

describe("sinkConfigured", () => {
  it("rejects relay mode without a device token (post-unlink state)", () => {
    expect(sinkConfigured(config({ mode: "relay" }))).toBe(false);
    expect(sinkConfigured(config({ mode: "relay", deviceToken: "ab_x" }))).toBe(true);
  });

  it("rejects slack mode without a token, allows console always", () => {
    expect(sinkConfigured(config({ mode: "slack" }))).toBe(false);
    expect(sinkConfigured(config({ mode: "slack", slackToken: "xoxp-1" }))).toBe(true);
    expect(sinkConfigured(config({ mode: "console" }))).toBe(true);
  });
});

describe("inStartFailureCooldown", () => {
  it("is false with no marker", () => {
    expect(inStartFailureCooldown()).toBe(false);
  });

  it("is true while the marker is fresh and false once it expires", () => {
    fs.mkdirSync(path.dirname(startFailedMarkerPath()), { recursive: true });
    const now = Date.now();
    fs.writeFileSync(startFailedMarkerPath(), `${now}\n`);
    expect(inStartFailureCooldown(now)).toBe(true);
    expect(inStartFailureCooldown(now + START_FAILURE_COOLDOWN_MS - 1)).toBe(true);
    expect(inStartFailureCooldown(now + START_FAILURE_COOLDOWN_MS)).toBe(false);
  });

  it("is false on a garbage marker", () => {
    fs.mkdirSync(path.dirname(startFailedMarkerPath()), { recursive: true });
    fs.writeFileSync(startFailedMarkerPath(), "not-a-timestamp\n");
    expect(inStartFailureCooldown()).toBe(false);
  });
});

describe("ensureDaemon", () => {
  it("does not spawn when the sink is unconfigured (relay mode, no token)", async () => {
    const result = await ensureDaemon(config({ mode: "relay" }));
    expect(result).toBe(false);
    // spawnDetachedDaemon would have created the daemon log
    expect(fs.existsSync(logFilePath())).toBe(false);
  });

  it("does not re-spawn while a failed start is in cooldown", async () => {
    fs.mkdirSync(path.dirname(startFailedMarkerPath()), { recursive: true });
    fs.writeFileSync(startFailedMarkerPath(), `${Date.now()}\n`);
    const result = await ensureDaemon(config({ mode: "console" }));
    expect(result).toBe(false);
    expect(fs.existsSync(logFilePath())).toBe(false);
  });

  it("respects autoStartDaemon: false", async () => {
    const result = await ensureDaemon(config({ autoStartDaemon: false }));
    expect(result).toBe(false);
    expect(fs.existsSync(logFilePath())).toBe(false);
  });
});

describe("hook timing (a hook runs on every tool call)", () => {
  it("gives up on a hung daemon after the hook's short timeout, not the CLI's", async () => {
    // Accepts the connection and never answers: the case where every hook pays the full timeout.
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const started = Date.now();
      expect(await ensureDaemon(config({ port, autoStartDaemon: false }), HOOK_TIMING)).toBe(false);
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(HOOK_TIMING.requestTimeoutMs - 50);
      expect(took).toBeLessThan(1400); // the CLI's 1.5 s health timeout would not fit
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("doesn't sit out another hook's whole daemon start", async () => {
    // Another hook holds the spawn lock (it is starting the daemon), which never comes up.
    fs.mkdirSync(path.dirname(spawnLockPath()), { recursive: true });
    fs.writeFileSync(spawnLockPath(), "12345");
    const started = Date.now();
    expect(await ensureDaemon(config({ mode: "console" }), HOOK_TIMING)).toBe(false);
    expect(Date.now() - started).toBeLessThan(HOOK_TIMING.lockWaitMs + 900); // not the 5 s START_WAIT_MS
    expect(fs.existsSync(logFilePath())).toBe(false); // no second daemon spawned
    expect(fs.existsSync(spawnLockPath())).toBe(true); // the other hook's lock is left alone
  });

  it("keeps every hook wait well under the old ~8 s worst case", () => {
    const worst = HOOK_TIMING.requestTimeoutMs * 2 + HOOK_TIMING.startWaitMs;
    expect(worst).toBeLessThanOrEqual(4500);
    expect(HOOK_TIMING.lockWaitMs).toBeLessThan(HOOK_TIMING.startWaitMs);
  });
});

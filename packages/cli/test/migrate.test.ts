import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/lib/config";
import { createDaemonSecret, mirrorLegacySecret } from "../src/lib/daemon-auth";
import { migrateLegacyDirs } from "../src/lib/migrate";
import { configPath, daemonSecretPath, legacyDaemonSecretPath, ownershipStatePath } from "../src/lib/paths";

let tmp: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["XDG_CONFIG_HOME", "XDG_STATE_HOME"];

const PAIRED_CONFIG = {
  mode: "relay",
  deviceToken: "ab_0123456789abcdef0123456789abcdef",
  granularity: "activity",
  hub: {
    url: "https://hub.example.com",
    deviceId: "dev_1",
    deviceToken: `bp_${"a1".repeat(32)}`,
    project: { id: "prj_1", name: "acme", include: { remotes: ["github.com/acme/"] } },
    share: "conversation",
  },
};

const mode = (file: string): number => fs.statSync(file).mode & 0o777;

function writeLegacy(rel: string, body: string, fileMode = 0o600): string {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: fileMode });
  fs.chmodSync(file, fileMode);
  return file;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-migrate-")));
  for (const k of ENV) saved[k] = process.env[k];
  process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
  process.env.XDG_STATE_HOME = path.join(tmp, "state");
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("migrateLegacyDirs", () => {
  it("copies config, daemon secret and ownership state from the agentblip dirs, keeping the old files", () => {
    const oldConfig = writeLegacy("config/agentblip/config.json", JSON.stringify(PAIRED_CONFIG));
    const oldSecret = writeLegacy("state/agentblip/daemon.secret", "s3cret\n");
    const oldOwnership = writeLegacy("state/agentblip/ownership.json", '{"lastPushed":null,"savedPrior":null,"backedOff":true}\n');
    writeLegacy("state/agentblip/daemon.pid", "12345\n", 0o644);
    writeLegacy("state/agentblip/daemon.log", "old log\n", 0o644);

    const copied = migrateLegacyDirs();

    expect(copied.sort()).toEqual([configPath(), daemonSecretPath(), ownershipStatePath()].sort());
    expect(configPath()).toBe(path.join(tmp, "config", "workmesh", "config.json"));
    for (const [from, to] of [
      [oldConfig, configPath()],
      [oldSecret, daemonSecretPath()],
      [oldOwnership, ownershipStatePath()],
    ] as const) {
      expect(fs.readFileSync(to, "utf8")).toBe(fs.readFileSync(from, "utf8"));
      expect(mode(to)).toBe(0o600);
      expect(fs.existsSync(from)).toBe(true); // the old file stays as a backup
    }
    // runtime files start fresh
    expect(fs.existsSync(path.join(tmp, "state", "workmesh", "daemon.pid"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "state", "workmesh", "daemon.log"))).toBe(false);
    expect(mode(path.join(tmp, "config", "workmesh"))).toBe(0o700);
    // no temp files left behind
    expect(fs.readdirSync(path.join(tmp, "config", "workmesh"))).toEqual(["config.json"]);
  });

  it("keeps the hub pairing and share level", () => {
    writeLegacy("config/agentblip/config.json", JSON.stringify(PAIRED_CONFIG));
    migrateLegacyDirs();
    const config = loadConfig();
    expect(config.hub?.url).toBe("https://hub.example.com");
    expect(config.hub?.deviceToken).toBe(PAIRED_CONFIG.hub.deviceToken);
    expect(config.hub?.project.include.remotes).toEqual(["github.com/acme/"]);
    expect(config.hub?.share).toBe("conversation");
    expect(config.deviceToken).toBe(PAIRED_CONFIG.deviceToken);
  });

  it("never overwrites a file that already exists in the new dir", () => {
    writeLegacy("config/agentblip/config.json", JSON.stringify(PAIRED_CONFIG));
    const current = writeLegacy("config/workmesh/config.json", '{"mode":"console"}\n');
    expect(migrateLegacyDirs()).toEqual([]);
    expect(fs.readFileSync(current, "utf8")).toBe('{"mode":"console"}\n');
  });

  it("narrows a wider old mode to 0600 and keeps a narrower one", () => {
    writeLegacy("config/agentblip/config.json", "{}", 0o644);
    writeLegacy("state/agentblip/ownership.json", "{}", 0o400);
    migrateLegacyDirs();
    expect(mode(configPath())).toBe(0o600);
    expect(mode(ownershipStatePath())).toBe(0o400);
  });

  it("does nothing on a fresh machine, and is idempotent", () => {
    expect(migrateLegacyDirs()).toEqual([]);
    expect(fs.existsSync(path.join(tmp, "config", "workmesh"))).toBe(false);
    writeLegacy("config/agentblip/config.json", "{}");
    expect(migrateLegacyDirs()).toEqual([configPath()]);
    expect(migrateLegacyDirs()).toEqual([]);
  });

  it("skips a legacy path that isn't a file", () => {
    fs.mkdirSync(path.join(tmp, "config", "agentblip", "config.json"), { recursive: true });
    expect(migrateLegacyDirs()).toEqual([]);
    expect(fs.existsSync(configPath())).toBe(false);
  });
});

describe("mirrorLegacySecret", () => {
  it("keeps the pre-rename secret path current while that dir exists", () => {
    fs.mkdirSync(path.join(tmp, "state", "agentblip"), { recursive: true });
    const secret = createDaemonSecret();
    expect(mirrorLegacySecret(secret)).toBe(true);
    expect(fs.readFileSync(legacyDaemonSecretPath(), "utf8")).toBe(`${secret}\n`);
    expect(mode(legacyDaemonSecretPath())).toBe(0o600);
  });

  it("never creates the old dir", () => {
    expect(mirrorLegacySecret(createDaemonSecret())).toBe(false);
    expect(fs.existsSync(path.join(tmp, "state", "agentblip"))).toBe(false);
  });
});

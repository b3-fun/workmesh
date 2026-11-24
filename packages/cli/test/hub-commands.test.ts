import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  machineName,
  pairWithHub,
  resolveDir,
  resolveHubUrl,
  runHubConnect,
  runHubDisconnect,
  runHubExclude,
  runHubInclude,
  runHubShare,
  SHARE_LEVEL_SUMMARY,
  parseShareLevel,
  suggestedShare,
  withDir,
} from "../src/commands/hub";
import { loadConfig, safeConfig, saveConfig } from "../src/lib/config";
import type { HubConfig } from "../src/lib/config";

const TOKEN = `bp_${"c".repeat(64)}`;
const PROJECT = {
  id: "b3",
  name: "B3",
  include: { remotes: ["github.com/b3-fun/"], dirs: [] },
  issueKeys: ["B3"],
};

describe("hub command helpers", () => {
  it("accepts https hub URLs and local http only", () => {
    expect(resolveHubUrl("https://workmesh.b3os.org/")).toBe("https://workmesh.b3os.org");
    expect(resolveHubUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(() => resolveHubUrl("http://workmesh.b3os.org")).toThrow(/https/);
    expect(() => resolveHubUrl("https://u:p@workmesh.b3os.org")).toThrow(/credentials/);
    expect(() => resolveHubUrl("nope")).toThrow(/invalid hub URL/);
  });

  it("names the machine like the board expects", () => {
    expect(machineName("Seans-Mac-Studio.local")).toBe("seans-mac-studio");
    expect(machineName("dev box_01")).toBe("dev-box-01");
    expect(machineName("...")).toBe("machine");
  });

  it("moves a dir between include and exclude", () => {
    const hub = { includeDirs: ["/a"], excludeDirs: ["/b"] } as unknown as HubConfig;
    expect(withDir(hub, "/b", "include")).toMatchObject({ includeDirs: ["/a", "/b"], excludeDirs: [] });
    expect(withDir(hub, "/a", "exclude")).toMatchObject({ includeDirs: [], excludeDirs: ["/b", "/a"] });
    expect(resolveDir("~/x", "/home/me")).toBe("/home/me/x");
  });
});

describe("sharing level helpers (SPEC §8)", () => {
  it("parses levels and rejects anything else", () => {
    expect(parseShareLevel("conversation")).toBe("conversation");
    expect(parseShareLevel(" Metadata ")).toBe("metadata");
    expect(() => parseShareLevel("everything")).toThrow(/conversation or metadata/);
  });

  it("suggests this machine's earlier choice, else the project's default, else conversation (max sharing)", () => {
    expect(suggestedShare({ ...PROJECT, defaultShare: "conversation" })).toBe("conversation");
    expect(suggestedShare({ ...PROJECT, defaultShare: "conversation" }, "metadata")).toBe("metadata");
    expect(suggestedShare(PROJECT)).toBe("conversation");
  });

  it("states plainly what each level sends", () => {
    expect(SHARE_LEVEL_SUMMARY.metadata).toMatch(/No prompt or agent text/);
    expect(SHARE_LEVEL_SUMMARY.conversation).toMatch(/prompts/);
    expect(SHARE_LEVEL_SUMMARY.conversation).toMatch(/redacted on this machine/);
  });
});

describe("pairWithHub (SPEC §3.1)", () => {
  const start = { code: "ABCD-1234", deviceId: "dev_01HZZZZZZZZZZZZZZZZZZZZZZZ", pollSecret: "f".repeat(32), verifyUrl: "https://hub/pair?code=ABCD-1234", expiresInSec: 600 };
  const fakeFetch = (polls: unknown[], calls: Array<{ url: string; body: unknown }> = []): typeof fetch =>
    (async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as unknown;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/relay/pair/start")) return new Response(JSON.stringify(start), { status: 200 });
      return new Response(JSON.stringify(polls.shift() ?? { status: "pending" }), { status: 200 });
    }) as typeof fetch;

  it("shows the code, polls, and returns the token and rule once approved", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const codes: string[] = [];
    const result = await pairWithHub("https://hub", {
      machine: "seans-mac-studio",
      client: "workmesh/0.6.0",
      fetchImpl: fakeFetch(
        [{ status: "pending" }, { status: "complete", deviceToken: TOKEN, person: { email: "sean@npclabs.org", name: "Sean" }, project: PROJECT }],
        calls,
      ),
      onCode: (p) => codes.push(p.code),
      wait: async () => {},
    });
    expect(codes).toEqual(["ABCD-1234"]);
    expect(calls[0]).toEqual({ url: "https://hub/relay/pair/start", body: { machine: "seans-mac-studio", client: "workmesh/0.6.0" } });
    expect(calls[1]?.body).toEqual({ deviceId: start.deviceId, pollSecret: start.pollSecret });
    expect(result).toEqual({ deviceId: start.deviceId, deviceToken: TOKEN, person: { email: "sean@npclabs.org", name: "Sean" }, project: PROJECT });
  });

  it("names the sharing level at pair/start when it is known", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    await pairWithHub("https://hub", {
      machine: "m",
      client: "workmesh/0.7.0",
      share: "conversation",
      fetchImpl: fakeFetch([{ status: "complete", deviceToken: TOKEN, project: PROJECT }], calls),
      wait: async () => {},
    });
    expect(calls[0]?.body).toEqual({ machine: "m", client: "workmesh/0.7.0", share: "conversation" });
  });

  it("fails on expiry and on a malformed token", async () => {
    await expect(
      pairWithHub("https://hub", { machine: "m", fetchImpl: fakeFetch([{ status: "expired" }]), wait: async () => {} }),
    ).rejects.toThrow(/expired/);
    await expect(
      pairWithHub("https://hub", {
        machine: "m",
        fetchImpl: fakeFetch([{ status: "complete", deviceToken: "ab_nope", project: PROJECT }]),
        wait: async () => {},
      }),
    ).rejects.toThrow(/no valid device token/);
  });
});

describe("hub config", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-hubcfg-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a hub section and keeps the token out of safeConfig", () => {
    const file = path.join(dir, "config.json");
    const config = loadConfig(file);
    config.hub = { url: "https://workmesh.b3os.org", deviceId: "dev_x", deviceToken: TOKEN, project: PROJECT, includeDirs: [], excludeDirs: [] };
    saveConfig(config, file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(loadConfig(file).hub?.deviceToken).toBe(TOKEN);
    const safe = JSON.stringify(safeConfig(loadConfig(file)));
    expect(safe).not.toContain(TOKEN);
    expect(safeConfig(loadConfig(file)).hub).toEqual({ url: "https://workmesh.b3os.org", project: { id: "b3", name: "B3" }, share: "conversation" });
  });

  it("a malformed hub section reads as not paired and keeps the Slack config valid", () => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ mode: "console", granularity: "activity", hub: { url: "x", deviceToken: "nope" } }));
    const config = loadConfig(file);
    expect(config.hub).toBeUndefined();
    expect(config.granularity).toBe("activity");
  });
});

describe("hub connect / include / exclude / disconnect (temp HOME, mock hub)", () => {
  let tmp: string;
  let server: http.Server;
  let base: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-hubcli-"));
    for (const k of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "WORKMESH_PORT"]) saved[k] = process.env[k];
    process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
    process.env.XDG_STATE_HOME = path.join(tmp, "state");
    // A port nothing listens on: these tests must never reach a real daemon.
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    process.env.WORKMESH_PORT = String((probe.address() as AddressInfo).port);
    await new Promise<void>((r) => probe.close(() => r()));

    let polls = 0;
    server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/relay/pair/start") {
        res.end(JSON.stringify({ code: "WXYZ-0001", deviceId: "dev_01J0000000000000000000000A", pollSecret: "a".repeat(32), verifyUrl: `${base}/pair?code=WXYZ-0001`, expiresInSec: 60 }));
        return;
      }
      polls += 1;
      res.end(JSON.stringify(polls < 2 ? { status: "pending" } : { status: "complete", deviceToken: TOKEN, person: { email: "sean@npclabs.org", name: "Sean" }, project: PROJECT }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("pairs, stores the token 0600, edits dirs, and disconnects", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runHubConnect(base, { open: false, machine: "Test-Box.local" });
      const file = path.join(tmp, "config", "workmesh", "config.json");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const hub = loadConfig(file).hub;
      expect(hub).toMatchObject({ url: base, deviceToken: TOKEN, machine: "test-box", project: PROJECT, person: { name: "Sean" } });
      const printed = out.mock.calls.flat().join("\n");
      expect(printed).toContain("WXYZ-0001");
      expect(printed).not.toContain(TOKEN);

      await runHubInclude(path.join(tmp, "notes"));
      await runHubExclude(path.join(tmp, "secret"));
      expect(loadConfig(file).hub).toMatchObject({ includeDirs: [path.join(tmp, "notes")], excludeDirs: [path.join(tmp, "secret")] });

      // No --share and no terminal: the default is max sharing (Sean, 11-24).
      expect(loadConfig(file).hub?.share).toBe("conversation");

      await runHubDisconnect();
      expect(loadConfig(file).hub).toBeUndefined();
    } finally {
      out.mockRestore();
    }
  });

  it("--share sets the level; the question suggests the hub's default; hub share changes it", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const file = path.join(tmp, "config", "workmesh", "config.json");
      await runHubConnect(base, { open: false, share: "conversation" });
      expect(loadConfig(file).hub?.share).toBe("conversation");
      expect(out.mock.calls.flat().join("\n")).toContain("sharing level: ");

      const asked: string[] = [];
      await runHubConnect(base, {
        open: false,
        askShare: async (suggested) => {
          asked.push(suggested);
          return "metadata";
        },
      });
      expect(asked).toEqual(["conversation"]); // this machine's earlier choice for the same hub
      expect(loadConfig(file).hub?.share).toBe("metadata");

      await runHubShare("conversation");
      expect(loadConfig(file).hub?.share).toBe("conversation");
      expect(out.mock.calls.flat().join("\n")).toContain("text starts from now");
      await expect(runHubShare("all")).rejects.toThrow(/conversation or metadata/);
      await expect(runHubConnect(base, { open: false, share: "loud" })).rejects.toThrow(/unknown sharing level/);
      await runHubDisconnect();
    } finally {
      out.mockRestore();
    }
  });
});

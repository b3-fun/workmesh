import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  announcePairing,
  checkPairLink,
  machineName,
  PAIR_CODE_WARNING,
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
        [{ status: "pending" }, { status: "complete", deviceToken: TOKEN, person: { email: "sean@example.com", name: "Sean" }, project: PROJECT }],
        calls,
      ),
      onCode: (p) => codes.push(p.code),
      wait: async () => {},
    });
    expect(codes).toEqual(["ABCD-1234"]);
    expect(calls[0]).toEqual({ url: "https://hub/relay/pair/start", body: { machine: "seans-mac-studio", client: "workmesh/0.6.0" } });
    expect(calls[1]?.body).toEqual({ deviceId: start.deviceId, pollSecret: start.pollSecret });
    expect(result).toEqual({ deviceId: start.deviceId, deviceToken: TOKEN, person: { email: "sean@example.com", name: "Sean" }, project: PROJECT });
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

describe("the approve link is checked before it is opened (SPEC §3.1)", () => {
  const HUB = "https://workmesh.b3os.org";
  const LOCAL = "http://127.0.0.1:8797";

  it("opens an https link on the hub's own host, as parsed", () => {
    expect(checkPairLink(HUB, "https://workmesh.b3os.org/pair?code=ABCD-1234")).toEqual({
      open: true,
      url: "https://workmesh.b3os.org/pair?code=ABCD-1234",
    });
    // The parsed form is what gets opened: no stray whitespace, the host in lower case.
    expect(checkPairLink(HUB, "  HTTPS://WORKMESH.B3OS.ORG/pair?code=ABCD-1234\n")).toEqual({
      open: true,
      url: "https://workmesh.b3os.org/pair?code=ABCD-1234",
    });
  });

  it("opens plain http only for a hub on this machine, on the same host and port", () => {
    expect(checkPairLink(LOCAL, "http://127.0.0.1:8797/pair?code=ABCD-1234")).toMatchObject({ open: true });
    expect(checkPairLink("http://localhost:8797", "http://localhost:8797/pair?code=A")).toMatchObject({ open: true });
    expect(checkPairLink("http://[::1]:8797", "http://[::1]:8797/pair?code=A")).toMatchObject({ open: true });
    expect(checkPairLink(LOCAL, "http://127.0.0.1:9999/pair?code=A")).toMatchObject({ open: false });
    expect(checkPairLink(LOCAL, "http://localhost:8797/pair?code=A")).toMatchObject({ open: false });
  });

  it.each([
    ["another host", "https://other.example/pair?code=ABCD-1234", /leads to other\.example, not to workmesh\.b3os\.org/],
    ["a host that only starts with the hub's name", "https://workmesh.b3os.org.other.example/pair", /leads to workmesh\.b3os\.org\.other\.example/],
    ["the hub's name used as a user name", "https://workmesh.b3os.org@other.example/pair", /leads to other\.example/],
    ["the hub's name in the path only", "https://other.example/workmesh.b3os.org/pair", /leads to other\.example/],
    ["another port", "https://workmesh.b3os.org:8443/pair", /leads to workmesh\.b3os\.org:8443/],
    ["plain http on a host that isn't this machine", "http://workmesh.b3os.org/pair?code=ABCD-1234", /plain http to workmesh\.b3os\.org, not https/],
    ["a javascript: link", "javascript:alert(1)", /a javascript: link, not https/],
    ["a file: link", "file:///Applications/Calculator.app", /a file: link, not https/],
    ["a data: link", "data:text/html,<p>hello</p>", /a data: link, not https/],
    ["another app's link", "x-apple.systempreferences:com.apple.preference.security", /not https/],
    ["a user name or password", "https://sam:secret@workmesh.b3os.org/pair", /user name or password/],
    ["a path with no host", "/pair?code=ABCD-1234", /not a web address/],
    ["something that reads like an option", "-a Calculator", /not a web address/],
    ["nothing", "", /not a web address/],
  ])("does not open %s", (_name, link, why) => {
    const r = checkPairLink(HUB, link);
    expect(r.open).toBe(false);
    if (!r.open) expect(r.why).toMatch(why);
  });

  const announce = (hubUrl: string, verifyUrl: string, open?: boolean, code = "ABCD-1234") => {
    const lines: string[] = [];
    const opened: string[] = [];
    announcePairing(hubUrl, { code, verifyUrl }, { open, openLink: (u) => opened.push(u), print: (l) => lines.push(l) });
    return { text: lines.join("\n"), opened };
  };

  it("a good link: the code, the link, the one-line warning, and the browser opens once", () => {
    const { text, opened } = announce(HUB, "https://workmesh.b3os.org/pair?code=ABCD-1234");
    expect(opened).toEqual(["https://workmesh.b3os.org/pair?code=ABCD-1234"]);
    expect(text).toContain("pairing code: ABCD-1234");
    expect(text).toContain("approve it in your browser: https://workmesh.b3os.org/pair?code=ABCD-1234");
    expect(text).toContain(PAIR_CODE_WARNING);
    expect(PAIR_CODE_WARNING).toBe("approve only a code you see in your own terminal");
  });

  it("--no-open prints the good link and opens nothing", () => {
    const { text, opened } = announce(HUB, "https://workmesh.b3os.org/pair?code=ABCD-1234", false);
    expect(opened).toEqual([]);
    expect(text).toContain("https://workmesh.b3os.org/pair?code=ABCD-1234");
    expect(text).toContain(PAIR_CODE_WARNING);
  });

  it.each([
    ["another host", "https://other.example/pair?code=ABCD-1234"],
    ["a javascript: link", "javascript:alert(1)"],
    ["a file: link", "file:///Applications/Calculator.app"],
    ["plain http on a host that isn't this machine", "http://workmesh.b3os.org/pair?code=ABCD-1234"],
  ])("%s: nothing opens; the code, the hub's own pairing page and the reason are printed, the link is not", (_name, link) => {
    const { text, opened } = announce(HUB, link);
    expect(opened).toEqual([]);
    expect(text).toContain("pairing code: ABCD-1234");
    expect(text).toContain("the hub's link was not opened: it ");
    expect(text).toContain("https://workmesh.b3os.org/pair");
    expect(text).toContain(PAIR_CODE_WARNING);
    expect(text).not.toContain(link);
  });

  it("prints the code on one line, without the escape sequences a hub may have put in it", () => {
    const esc = String.fromCharCode(27);
    const { text } = announce(HUB, "https://workmesh.b3os.org/pair", false, `AB${esc}[2JCD\n-1234`);
    expect(text).toContain("pairing code: ABCD -1234");
    expect(text).not.toContain(esc);
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
  /** The approve link the mock hub sends; unset, its own pairing page. */
  let link: string | undefined;
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
        res.end(JSON.stringify({ code: "WXYZ-0001", deviceId: "dev_01J0000000000000000000000A", pollSecret: "a".repeat(32), verifyUrl: link ?? `${base}/pair?code=WXYZ-0001`, expiresInSec: 60 }));
        return;
      }
      polls += 1;
      res.end(JSON.stringify(polls < 2 ? { status: "pending" } : { status: "complete", deviceToken: TOKEN, person: { email: "sean@example.com", name: "Sean" }, project: PROJECT }));
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
      await runHubConnect(base, { open: false, machine: "Test-Box.local", readGithub: async () => "sean-test" });
      const file = path.join(tmp, "config", "workmesh", "config.json");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const hub = loadConfig(file).hub;
      expect(hub).toMatchObject({ url: base, deviceToken: TOKEN, machine: "test-box", project: PROJECT, person: { name: "Sean" } });
      expect(hub?.github).toBe("sean-test"); // v0.6: read from gh at connect, for the avatar
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
      await runHubConnect(base, { open: false, share: "conversation", readGithub: async () => undefined });
      expect(loadConfig(file).hub?.share).toBe("conversation");
      expect(out.mock.calls.flat().join("\n")).toContain("sharing level: ");

      const asked: string[] = [];
      await runHubConnect(base, {
        open: false,
        readGithub: async () => undefined,
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
      await expect(runHubConnect(base, { open: false, share: "loud", readGithub: async () => undefined })).rejects.toThrow(/unknown sharing level/);
      await runHubDisconnect();
    } finally {
      out.mockRestore();
    }
  });

  it("opens the hub's own approve link, and leaves a link to another host unopened", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const opened: string[] = [];
    const connect = () => runHubConnect(base, { share: "metadata", readGithub: async () => undefined, openLink: (u) => opened.push(u) });
    try {
      await connect();
      expect(opened).toEqual([`${base}/pair?code=WXYZ-0001`]);
      expect(out.mock.calls.flat().join("\n")).toContain(PAIR_CODE_WARNING);

      out.mockClear();
      opened.length = 0;
      link = "https://other.example/pair?code=WXYZ-0001";
      await connect();
      expect(opened).toEqual([]);
      const printed = out.mock.calls.flat().join("\n");
      expect(printed).toContain("pairing code: WXYZ-0001");
      expect(printed).toContain("the hub's link was not opened: it leads to other.example");
      expect(printed).toContain(`${base}/pair`);
      expect(printed).toContain(PAIR_CODE_WARNING);
      expect(printed).not.toContain("other.example/pair");
      await runHubDisconnect();
    } finally {
      link = undefined;
      out.mockRestore();
    }
  });
});

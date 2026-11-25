import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hubSyncAcceptSchema } from "@workmesh/protocol";
import type { HubSyncResponse } from "@workmesh/protocol";
import type { AgentSession, SessionEvent } from "@workmesh/core";
import { CoordClient } from "../src/hub/coord";
import { recipient, resolveCaller, resolveLeasePaths, runCoordOp } from "../src/daemon/coord-ops";
import type { CoordOpRequest, CoordOpsDeps } from "../src/daemon/coord-ops";
import { MCP_TOOLS, handleMcpMessage, serveMcp } from "../src/mcp/server";
import { createDaemonServer } from "../src/daemon/server";
import type { DaemonServerDeps } from "../src/daemon/server";
import { installClaudeMcp, installCodexMcp, isClaudeMcpInstalled, isCodexMcpInstalled, mcpServerCommand } from "../src/adapters/mcp-install";

/** v1 Coordinate (SPEC §23): the daemon's coordination ops, the MCP server, its registration, the loopback API. */

const TOKEN = `bp_${"d".repeat(64)}`;
const DEV = "dev_01JD0000000000000000000000";
const AN = "dev_01JDANANANANANANANANANANAN:claude-code:s9";
const T = 1_795_545_600_000;
const ROOT = "/w/workmesh";
const classify = (p: string) => (p === ROOT || p.startsWith(`${ROOT}/`) ? { root: ROOT, repo: "b3-fun/workmesh" } : undefined);

const SYNC: HubSyncResponse = {
  cursor: "c1",
  serverNow: T,
  me: { person: "Sean" },
  leases: [
    { id: "ls_1", repo: "b3-fun/workmesh", paths: ["packages/cli/src/hub/**"], holder: { person: "An", sessionKey: AN, sessionName: "b3iq-strategy" }, expiresAt: T + 20 * 60_000, reason: "forwarder" },
  ],
  holds: [],
  inbox: [{ id: "m1", to: `${DEV}:claude-code:s1`, from: { person: "An", sessionName: "b3iq-strategy" }, text: "take the CLI?", ts: T }],
  claims: [{ issue: "B3-7167", holder: { person: "An", sessionKey: AN }, since: T }],
  roster: [{ person: "An", github: "an-b3", sessions: [{ hubKey: AN, name: "b3iq-strategy", state: "working", repo: "b3-fun/workmesh" }] }],
  notes: [{ id: "n1", by: { person: "An" }, text: "deploys freeze at 5pm", tags: ["deploy"], ts: T - 120_000 }],
  edits: [],
};

const session = (over: Partial<AgentSession>): AgentSession => ({
  key: "claude-code:s1",
  source: "claude-code",
  sessionId: "s1",
  state: "working",
  agents: 1,
  cwd: ROOT,
  name: "documents-07",
  startedAt: T,
  updatedAt: T,
  stateSince: T,
  ...over,
});

function harness(replies: Array<{ status: number; body?: unknown }> = []) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined });
    const r = replies.shift() ?? { status: 200, body: { ok: true, id: "x1" } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
  const coord = new CoordClient({ url: "https://hub.test", token: TOKEN, deviceId: DEV, person: "Sean", fetchImpl, now: () => T });
  coord.apply(hubSyncAcceptSchema.parse(SYNC), T);
  const sessions = [session({}), session({ key: "codex:t7", source: "codex", sessionId: "t7", cwd: "/w/other", updatedAt: T + 5 })];
  const deps: CoordOpsDeps = {
    coord: () => coord,
    hub: () => ({ url: "https://hub.test", project: { name: "B3" }, person: { name: "Sean" }, deviceId: DEV }),
    getSession: (k) => sessions.find((s) => s.key === k),
    listSessions: () => sessions,
    classify,
    isShared: (k) => k === "claude-code:s1",
    claudeSessions: () => new Map([["s1", { pid: 4242, sessionId: "s1" }]]),
    now: () => T,
    home: "/home/me",
  };
  const op = (o: CoordOpRequest["op"], args: Record<string, unknown> = {}, caller: CoordOpRequest["caller"] = { ppid: 4242 }) =>
    runCoordOp({ op: o, args, caller }, deps);
  return { calls, coord, deps, op };
}

describe("coordination ops (POST /coord/op)", () => {
  it("finds the calling session: parent process, session env, Codex thread, cwd; else the person", () => {
    const { deps } = harness();
    expect(resolveCaller({ ppid: 4242 }, deps)).toBe("claude-code:s1");
    expect(resolveCaller({ ppid: 1, claudeSessionId: "zz" }, deps)).toBe("claude-code:zz");
    expect(resolveCaller({ codexThreadId: "t9" }, deps)).toBe("codex:t9");
    expect(resolveCaller({ cwd: "/w/other", client: "codex-mcp-client" }, deps)).toBe("codex:t7");
    expect(resolveCaller({ cwd: ROOT }, deps)).toBe("claude-code:s1");
    expect(resolveCaller({ cwd: "/nowhere" }, deps)).toBeUndefined();
  });

  it("lease paths: repo-relative, relative to the session, absolute, globs; one repo", () => {
    expect(resolveLeasePaths(["src/a.ts", "./docs/"], "b3-fun/workmesh", undefined, classify)).toEqual({ repo: "b3-fun/workmesh", paths: ["src/a.ts", "docs"] });
    expect(resolveLeasePaths(["packages/cli/src/hub/**", `${ROOT}/README.md`], undefined, ROOT, classify)).toEqual({ repo: "b3-fun/workmesh", paths: ["packages/cli/src/hub/**", "README.md"] });
    expect(resolveLeasePaths(["src/*.ts"], undefined, `${ROOT}/packages/cli`, classify)).toEqual({ repo: "b3-fun/workmesh", paths: ["packages/cli/src/*.ts"] });
    expect(resolveLeasePaths([ROOT], undefined, undefined, classify)).toEqual({ repo: "b3-fun/workmesh", paths: ["**"] });
    expect(resolveLeasePaths(["a.ts"], undefined, "/elsewhere", classify)).toMatchObject({ error: expect.stringContaining("isn't in a repo") });
    expect(resolveLeasePaths(["a.ts"], undefined, undefined, classify)).toMatchObject({ error: expect.stringContaining("relative") });
    expect(resolveLeasePaths(["../x"], "b3-fun/workmesh", undefined, classify)).toMatchObject({ error: expect.any(String) });
  });

  it("recipients: people (name or GitHub login), agents by session name, hub keys", () => {
    const st = hubSyncAcceptSchema.parse(SYNC);
    expect(recipient("an", undefined, st)).toEqual({ person: "An" });
    expect(recipient("an-b3", undefined, st)).toEqual({ person: "An" });
    expect(recipient("b3iq-strategy", undefined, st)).toEqual({ agent: "b3iq-strategy" });
    expect(recipient(AN, undefined, st)).toEqual({ session: AN });
    expect(recipient("Gio", undefined, st)).toEqual({ person: "Gio" });
    expect(recipient("b3iq-strategy", "person", st)).toEqual({ person: "b3iq-strategy" });
  });

  it("lease: acquires for the calling session, reports conflicts by holder", async () => {
    const conflict = { ok: false, conflicts: [{ leaseId: "ls_1", holder: { person: "An", sessionKey: AN, sessionName: "b3iq-strategy" }, paths: ["packages/cli/src/hub/**"], expiresAt: T + 20 * 60_000, reason: "forwarder" }] };
    const h = harness([{ status: 200, body: { ok: true, lease: { ...SYNC.leases[0], id: "ls_9", paths: ["README.md"], holder: { person: "Sean", sessionKey: `${DEV}:claude-code:s1` } } } }, { status: 409, body: conflict }]);
    const ok = await h.op("lease", { paths: ["README.md"], reason: "docs pass", minutes: 15 });
    expect(h.calls[0]).toMatchObject({ url: "https://hub.test/relay/leases", body: { action: "acquire", sessionKey: "claude-code:s1", repo: "b3-fun/workmesh", paths: ["README.md"], ttlSec: 900, reason: "docs pass" } });
    expect(ok).toMatchObject({ ok: true, text: expect.stringContaining("Leased README.md in b3-fun/workmesh for 15 min [ls_9]") });
    const no = await h.op("lease", { paths: ["packages/cli/src/hub/git.ts"] });
    expect(no.ok).toBe(false);
    expect(no.text).toContain("An (b3iq-strategy) · 20 min left — forwarder");
    const person = await h.op("lease", { paths: ["README.md"] }, { cwd: "/nowhere" });
    expect(person).toMatchObject({ ok: false, text: expect.stringContaining("can't tell which agent session") });
  });

  it("send: redacts on the machine, resolves the recipient, speaks for the session (or the person)", async () => {
    const h = harness([{ status: 200, body: { ok: true, id: "m_7" } }, { status: 200, body: { ok: true, id: "m_8" } }]);
    const secret = `sk-ant-api03-${"A".repeat(40)}`;
    const r = await h.op("send", { to: "an", text: `use the key ${secret} from /home/me/.env` });
    expect(r).toMatchObject({ ok: true, text: "Sent to An (message m_7)." });
    const body = h.calls[0]?.body as { from?: string; to: unknown; text: string };
    expect(body.from).toBe("claude-code:s1");
    expect(body.to).toEqual({ person: "An" });
    expect(body.text).not.toContain(secret);
    expect(body.text).toContain("[redacted]");
    expect(body.text).toContain("~/.env");
    await h.op("send", { to: "b3iq-strategy", text: "hi" }, { cwd: "/nowhere" });
    expect(h.calls[1]?.body).toEqual({ to: { agent: "b3iq-strategy" }, text: "hi" });
  });

  it("inbox: an agent reads (and acks) its own; the person sees the machine's", async () => {
    const h = harness();
    const all = await h.op("inbox", {}, { cwd: "/nowhere" });
    expect(all.text).toContain("to documents-07: from An (b3iq-strategy): take the CLI?");
    const mine = await h.op("inbox");
    expect(mine.text).toBe("Message from An (b3iq-strategy): take the CLI?");
    expect((await h.op("inbox")).text).toBe("No new messages for this session.");
  });

  it("claim, release, claims, leases, notes, note, roster, whoami", async () => {
    const h = harness([
      { status: 200, body: { ok: true, claim: { issue: "B3-7200", holder: { person: "Sean", sessionKey: `${DEV}:claude-code:s1` }, since: T } } },
      { status: 409, body: { ok: false, holder: { person: "An", sessionKey: AN, sessionName: "b3iq-strategy" } } },
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true, id: "n_2" } },
    ]);
    expect((await h.op("claim", { issue: "b3-7200", note: "tests" })).text).toBe("Claimed B3-7200.");
    expect(h.calls[0]?.body).toEqual({ action: "claim", sessionKey: "claude-code:s1", issue: "B3-7200", note: "tests" });
    expect((await h.op("claim", { issue: "B3-7167" })).text).toContain("already claimed by An (b3iq-strategy)");
    expect((await h.op("release", { issue: "B3-7200" })).text).toBe("Released B3-7200.");
    expect((await h.op("claim", { issue: "nope" })).ok).toBe(false);
    expect((await h.op("claims")).text).toBe("- B3-7167 · An");
    expect((await h.op("leases")).text).toBe("- b3-fun/workmesh: packages/cli/src/hub/** · An (b3iq-strategy) · 20 min left — forwarder [ls_1]");
    expect((await h.op("notes")).text).toContain("An, 2 min ago [deploy]: deploys freeze at 5pm");
    expect((await h.op("note", { text: "use npm ci", tags: ["build", "two words"] })).text).toBe("Noted for the team (note n_2).");
    expect(h.calls[3]?.body).toEqual({ sessionKey: "claude-code:s1", text: "use npm ci", tags: ["build"] });
    expect((await h.op("roster")).text).toContain("An: 1 session\n  - b3iq-strategy · working · b3-fun/workmesh");
    const who = await h.op("whoami");
    expect(who.text).toContain("You are Sean on B3 (https://hub.test). Coordination: on.");
    expect(who.text).toContain(`documents-07 (${DEV}:claude-code:s1), shared with the team`);
  });

  it("fails soft: not paired, an older hub, a hub that is down", async () => {
    const h = harness();
    expect((await runCoordOp({ op: "leases", args: {}, caller: {} }, { ...h.deps, hub: () => undefined })).text).toContain("isn't connected to a Workmesh hub");
    const old = new CoordClient({ url: "https://hub.test", token: TOKEN, deviceId: DEV, fetchImpl: (async () => new Response("nf", { status: 404 })) as typeof fetch });
    await old.sync();
    const r = await runCoordOp({ op: "lease", args: { paths: ["README.md"] }, caller: { ppid: 4242 } }, { ...h.deps, coord: () => old });
    expect(r).toMatchObject({ ok: false, text: "Workmesh coordination isn't on this team's hub yet." });
    const down = new CoordClient({ url: "https://hub.test", token: TOKEN, deviceId: DEV, fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    down.apply(hubSyncAcceptSchema.parse(SYNC), T);
    const s = await runCoordOp({ op: "send", args: { to: "An", text: "hi" }, caller: { ppid: 4242 } }, { ...h.deps, coord: () => down });
    expect(s).toMatchObject({ ok: false, text: expect.stringContaining("hub unreachable") });
  });
});

describe("MCP server (workmesh mcp)", () => {
  const caller = () => ({ ppid: 4242, cwd: ROOT });
  const opts = (calls: unknown[]) => ({
    version: "0.10.0",
    caller,
    call: async (op: string, args: Record<string, unknown>, c: unknown) => {
      calls.push({ op, args, c });
      return op === "lease" ? { ok: false, text: "Not leased: overlap" } : { ok: true, text: `did ${op}` };
    },
  });

  it("initializes, lists the tools, calls them through the daemon", async () => {
    const calls: unknown[] = [];
    const session: { client?: string } = {};
    const init = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } } }, opts(calls), session)) as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: unknown } };
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "workmesh", version: "0.10.0" }, capabilities: { tools: {} } });
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, opts(calls), session)).toBeUndefined();
    const list = (await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, opts(calls), session)) as { result: { tools: Array<{ name: string; description: string }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["whoami", "roster", "send", "inbox", "claim", "release", "lease", "unlease", "leases", "note", "notes"]);
    for (const t of list.result.tools) expect(t.description.length, t.name).toBeLessThanOrEqual(240);
    const ok = (await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send", arguments: { to: "An", text: "hi" } } }, opts(calls), session)) as { result: unknown };
    expect(ok.result).toEqual({ content: [{ type: "text", text: "did send" }], isError: false });
    expect(calls[0]).toEqual({ op: "send", args: { to: "An", text: "hi" }, c: { ppid: 4242, cwd: ROOT, client: "claude-code" } });
    const err = (await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "lease", arguments: { paths: ["x"] } } }, opts(calls), session)) as { result: { isError: boolean } };
    expect(err.result.isError).toBe(true);
    const unknown = (await handleMcpMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rm" } }, opts(calls), session)) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32602);
    expect(((await handleMcpMessage({ jsonrpc: "2.0", id: 6, method: "resources/list" }, opts(calls), session)) as { error: { code: number } }).error.code).toBe(-32601);
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: 7, method: "ping" }, opts(calls), session)).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    const older = (await handleMcpMessage({ jsonrpc: "2.0", id: 8, method: "initialize", params: { protocolVersion: "1999-01-01" } }, opts(calls), {})) as { result: { protocolVersion: string } };
    expect(older.result.protocolVersion).toBe("2025-11-25");
  });

  it("a daemon that doesn't answer is a tool error, not a crash", async () => {
    const r = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inbox" } },
      { version: "x", caller, call: async () => { throw new Error("ECONNREFUSED"); } },
      {},
    )) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]?.text).toContain("workmesh start --detach");
  });

  it("speaks newline-delimited JSON-RPC on stdio; garbage gets a parse error", async () => {
    const input = new PassThrough();
    const out: string[] = [];
    const done = serveMcp({ input, write: (l) => out.push(l), ...opts([]) });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    input.write("not json\n");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami" } })}\n`);
    input.end();
    await done;
    const msgs = out.map((l) => JSON.parse(l) as { id: unknown; error?: { code: number } });
    expect(msgs.map((m) => m.id).sort()).toEqual([1, 2, null]);
    expect(msgs.find((m) => m.id === null)?.error?.code).toBe(-32700);
    expect(MCP_TOOLS).toHaveLength(11);
  });
});

describe("MCP registration (workmesh setup)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-mcp-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const want = mcpServerCommand();

  it("Claude Code without its CLI: merges ~/.claude.json, backs it up once, keeps everything else", () => {
    const file = path.join(dir, ".claude.json");
    const original = { numStartups: 7, projects: { "/x": { allowedTools: [] } }, mcpServers: { other: { type: "stdio", command: "other" } } };
    fs.writeFileSync(file, JSON.stringify(original));
    expect(installClaudeMcp({ file, claudeBin: null })).toMatchObject({ result: "installed", via: "file", backupPath: `${file}.workmesh-backup` });
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> & { mcpServers: Record<string, unknown> };
    expect(doc.numStartups).toBe(7);
    expect(doc.projects).toEqual(original.projects);
    expect(doc.mcpServers.other).toEqual(original.mcpServers.other);
    expect(doc.mcpServers.workmesh).toEqual({ type: "stdio", command: want.command, args: want.args, env: {} });
    expect(JSON.parse(fs.readFileSync(`${file}.workmesh-backup`, "utf8"))).toEqual(original);
    expect(isClaudeMcpInstalled(file)).toBe(true);
    expect(installClaudeMcp({ file, claudeBin: null }).result).toBe("already-installed");
    // An older install path is repointed.
    doc.mcpServers.workmesh = { type: "stdio", command: "/old/node", args: ["/old/workmesh/dist/index.js", "mcp"] };
    fs.writeFileSync(file, JSON.stringify(doc));
    expect(installClaudeMcp({ file, claudeBin: null }).result).toBe("updated");
    expect(JSON.parse(fs.readFileSync(`${file}.workmesh-backup`, "utf8"))).toEqual(original); // backup kept from the first change
  });

  it("Claude Code with its CLI: claude mcp add -s user (remove first when repointing)", () => {
    const file = path.join(dir, ".claude.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { workmesh: { type: "stdio", command: "/old/node", args: ["/old/workmesh/dist/index.js", "mcp"] } } }));
    const runs: string[][] = [];
    const run = (cmd: string, args: string[]) => {
      runs.push([cmd, ...args]);
      if (args[1] === "add") {
        fs.writeFileSync(file, JSON.stringify({ mcpServers: { workmesh: { type: "stdio", command: want.command, args: want.args, env: {} } } }));
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    expect(installClaudeMcp({ file, claudeBin: "/bin/claude", run })).toMatchObject({ result: "updated", via: "claude-cli" });
    expect(runs).toEqual([
      ["/bin/claude", "mcp", "remove", "-s", "user", "workmesh"],
      ["/bin/claude", "mcp", "add", "-s", "user", "workmesh", "--", want.command, ...want.args],
    ]);
  });

  it("Claude Code: another server named workmesh, or a file that isn't JSON, is left alone", () => {
    const file = path.join(dir, ".claude.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { workmesh: { type: "http", url: "https://someone.else/mcp" } } }));
    expect(installClaudeMcp({ file, claudeBin: null }).result).toBe("manual");
    fs.writeFileSync(file, "{ not json");
    expect(installClaudeMcp({ file, claudeBin: null }).result).toBe("manual");
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("Codex: appends [mcp_servers.workmesh] to config.toml, backup first, repoints its own, leaves others", () => {
    const file = path.join(dir, "config.toml");
    const original = 'model = "gpt-5.4"\nnotify = ["node", "/x/workmesh/dist/index.js", "hook", "codex"]\n\n[mcp_servers.linear]\ncommand = "npx"\nargs = ["linear-mcp"]\n';
    fs.writeFileSync(file, original);
    expect(installCodexMcp(file)).toMatchObject({ result: "installed", backupPath: `${file}.workmesh-backup` });
    const text = fs.readFileSync(file, "utf8");
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain(`[mcp_servers.workmesh]\ncommand = ${JSON.stringify(want.command)}\nargs = [${want.args.map((a) => JSON.stringify(a)).join(", ")}]\n`);
    expect(isCodexMcpInstalled(file)).toBe(true);
    expect(installCodexMcp(file).result).toBe("already-installed");
    fs.writeFileSync(file, `${original}\n[mcp_servers.workmesh]\ncommand = "/old/node"\nargs = ["/old/workmesh/dist/index.js", "mcp"]\n\n[profiles.fast]\nmodel = "x"\n`);
    expect(installCodexMcp(file).result).toBe("updated");
    const repointed = fs.readFileSync(file, "utf8");
    expect(repointed).toContain(`command = ${JSON.stringify(want.command)}`);
    expect(repointed).not.toContain("/old/node");
    expect(repointed).toContain("[profiles.fast]\nmodel = \"x\"");
    expect(repointed.match(/\[mcp_servers\.workmesh\]/g)).toHaveLength(1);
    fs.writeFileSync(file, '[mcp_servers.workmesh]\ncommand = "someone-else"\n');
    expect(installCodexMcp(file).result).toBe("manual");
    fs.writeFileSync(file, 'mcp_servers = { workmesh = { command = "x" } }\n');
    expect(installCodexMcp(file).result).toBe("manual");
    const fresh = path.join(dir, "new", "config.toml");
    expect(installCodexMcp(fresh).result).toBe("installed");
    expect(isCodexMcpInstalled(fresh)).toBe(true);
  });
});

describe("daemon loopback API (v1)", () => {
  let server: ReturnType<typeof createDaemonServer> | undefined;
  afterEach(() => server?.close());
  const SECRET = "s".repeat(32);

  async function start(over: Partial<DaemonServerDeps>) {
    const applied: SessionEvent[] = [];
    const deps: DaemonServerDeps = {
      secret: SECRET,
      applyEvent: (e) => applied.push(e),
      getState: () => ({ snapshot: { sessions: [], working: 0, waiting: 0, agentCount: 0 } as never, formatted: null, paused: false }),
      getLastError: () => undefined,
      getOwnership: () => ({}) as never,
      pause: async () => {},
      resume: () => {},
      dismiss: () => false,
      getConfig: () => ({}) as never,
      setConfig: () => ({}) as never,
      ...over,
    };
    server = createDaemonServer(deps);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { applied, post };
  }
  const event = { source: "claude-code", sessionId: "s1", kind: "working", detail: { hookEvent: "PreToolUse", tool: "Edit", filePath: "/w/a.ts" } };

  it("a hook's event comes back with the daemon's answer; without the header, as before", async () => {
    const { applied, post } = await start({ applyHookEvent: (e, hook) => (hook === "PreToolUse" ? { deny: `no ${e.sessionId}` } : undefined) });
    expect(await (await post("/event", event, { "x-workmesh-hook": "PreToolUse" })).json()).toEqual({ ok: true, coord: { deny: "no s1" } });
    expect(await (await post("/event", event, { "x-workmesh-hook": "PostToolUse" })).json()).toEqual({ ok: true });
    expect(await (await post("/event", event)).json()).toEqual({ ok: true });
    expect(applied).toHaveLength(1); // the two hook events went through applyHookEvent
  });

  it("fails open: a coordination error still applies the event and answers nothing", async () => {
    const { applied, post } = await start({ applyHookEvent: () => { throw new Error("boom"); } });
    expect(await (await post("/event", event, { "x-workmesh-hook": "PreToolUse" })).json()).toEqual({ ok: true });
    expect(applied).toHaveLength(1);
  });

  it("POST /coord/op validates and runs; an older daemon has none (404)", async () => {
    const { post } = await start({ coordOp: async (req) => ({ ok: true, text: `ran ${req.op}` }) });
    expect(await (await post("/coord/op", { op: "leases" })).json()).toEqual({ ok: true, text: "ran leases" });
    expect((await post("/coord/op", { op: "rm -rf" })).status).toBe(400);
    server?.close();
    const old = await start({});
    expect((await old.post("/coord/op", { op: "leases" })).status).toBe(404);
  });
});

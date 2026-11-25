import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hubSyncAcceptSchema } from "@workmesh/protocol";
import type { HubHandoffAccepted, HubSyncResponse } from "@workmesh/protocol";
import { CoordClient } from "../src/hub/coord";
import { CheckoutIndex, HandoffRunner, codexThreadFromLog, handoffPrompt, resultText } from "../src/daemon/handoff-runner";
import type { RunnerSettings } from "../src/daemon/handoff-runner";
import { runCoordOp } from "../src/daemon/coord-ops";
import type { CoordOpsDeps } from "../src/daemon/coord-ops";
import { codexWaker } from "../src/daemon/codex-wake";
import { isHeadless, transcriptVersion, versionAtLeast, wakeWaitOnce } from "../src/commands/wake";
import { runInit } from "../src/commands/init";
import { claudeWakeCommand } from "../src/adapters/claude-code";

/** v2 Delegate, relay side (SPEC §31): the handoff runner, the wake hook, `workmesh init`, the v2 ops. Temp HOME. */

const TOKEN = `bp_${"e".repeat(64)}`;
const DEV = "dev_01JD0000000000000000000000";
const T = 1_795_545_600_000;

let home: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_ENTRYPOINT", "WORKMESH_HANDOFF"];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-delegate-"));
  for (const k of ENV) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  // Tests may run inside an agent session (`claude -p` says sdk-cli): the wake hook reads these.
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  delete process.env.WORKMESH_HANDOFF;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const PROJECT = { id: "p_b3", name: "B3", include: { remotes: ["github.com/b3-fun/"], dirs: [] }, issueKeys: ["B3"] };
function writeConfig(extra: Record<string, unknown> = {}, hub = true): void {
  const dir = path.join(home, ".config", "workmesh");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({
      ...(hub ? { hub: { url: "https://hub.test", deviceId: DEV, deviceToken: TOKEN, project: PROJECT, person: { email: "sean@x", name: "Sean" } } } : {}),
      ...extra,
    }),
  );
}

/** A git checkout as `.git` files only (the resolver reads them; no `git` binary). */
function fakeRepo(dir: string, remote: string): string {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
  return dir;
}

function fakeHub(replies: Array<{ status: number; body?: unknown }> = []) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined });
    const r = replies.shift() ?? { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
  const coord = new CoordClient({ url: "https://hub.test", token: TOKEN, deviceId: DEV, person: "Sean", fetchImpl, now: () => T });
  return { coord, calls };
}

const HANDOFF: HubHandoffAccepted = {
  id: "h_abc12345",
  from: { person: "An", sessionKey: "dev_A:claude-code:s9", sessionName: "b3iq-strategy" },
  to: { person: "Sean" },
  task: "Port the KEK rotation to the new runner",
  repo: "b3-fun/b3os-beta",
  issue: "B3-7168",
  context: "Start from PR 212.",
  status: "accepted",
  createdAt: T,
  updatedAt: undefined,
  device: DEV,
  sessionKey: undefined,
  note: undefined,
};

const settings = (over: Partial<RunnerSettings> = {}): RunnerSettings => ({
  roots: [],
  worktree: true,
  maxRunning: 2,
  permissionMode: "auto",
  maxMinutes: 120,
  share: "conversation",
  ...over,
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("handoff runner (SPEC §31)", () => {
  it("finds checkouts from sessions and roots; scratch dirs aren't checkouts", () => {
    const code = path.join(home, "code");
    fakeRepo(path.join(code, "b3os-beta"), "git@github.com:b3-fun/b3os-beta.git");
    fakeRepo(path.join(home, "elsewhere", "workmesh"), "https://github.com/b3-fun/workmesh.git");
    const idx = new CheckoutIndex(path.join(home, "checkouts.json"));
    expect(idx.find("b3-fun/b3os-beta", [])).toBeUndefined();
    expect(idx.find("b3-fun/b3os-beta", [code])).toBe(path.join(code, "b3os-beta"));
    idx.observe(path.join(home, "elsewhere", "workmesh"), "b3-fun/workmesh");
    idx.save();
    const again = new CheckoutIndex(path.join(home, "checkouts.json"));
    expect(again.find("b3-fun/workmesh", [])).toBe(path.join(home, "elsewhere", "workmesh"));
    expect(again.repos()).toEqual(["b3-fun/workmesh"]);
  });

  it("claims the start, makes a worktree, runs claude -p headless with a chosen session id, reports done", async () => {
    const checkout = fakeRepo(path.join(home, "code", "b3os-beta"), "git@github.com:b3-fun/b3os-beta.git");
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin);
    const argsFile = path.join(home, "claude-args.txt");
    // A stand-in `claude`: records its argv and cwd, prints a result line like `--output-format json`.
    fs.writeFileSync(
      path.join(bin, "claude"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\npwd >> "${argsFile}"\necho "WORKMESH_HANDOFF=$WORKMESH_HANDOFF" >> "${argsFile}"\necho '{"type":"result","subtype":"success","is_error":false,"result":"Ported it; PR 214 is up. Token ghp_abcdefghijklmnopqrstuvwxyz0123456789 redacted."}'\n`,
      { mode: 0o755 },
    );
    const hub = fakeHub([
      { status: 200, body: { ok: true, handoff: { ...HANDOFF, status: "started" } } },
      { status: 200, body: { ok: true, handoff: { ...HANDOFF, status: "done" } } },
    ]);
    const gitCalls: string[][] = [];
    const runner = new HandoffRunner({
      coord: () => hub.coord,
      settings: () => settings({ roots: [path.join(home, "code")], model: "haiku" }),
      checkouts: new CheckoutIndex(path.join(home, "checkouts.json")),
      dir: path.join(home, "handoffs"),
      which: (b) => (b === "claude" ? path.join(bin, "claude") : undefined),
      pathEnv: async () => process.env.PATH ?? "/usr/bin:/bin",
      git: async (args) => {
        gitCalls.push(args);
        if (args[0] === "symbolic-ref") return { ok: true, stdout: "origin/main\n", stderr: "" };
        if (args[0] === "worktree") fs.mkdirSync(args[4]!, { recursive: true });
        return { ok: true, stdout: "", stderr: "" };
      },
    });
    expect(runner.cannotRun(HANDOFF)).toBeUndefined();
    expect(runner.cannotRun({ ...HANDOFF, repo: "b3-fun/nope" })).toMatch(/no checkout of b3-fun\/nope/);
    runner.run(HANDOFF);
    expect(runner.running().has(HANDOFF.id)).toBe(true);
    await until(() => runner.list().length === 1);
    const start = hub.calls[0]!.body as { action: string; id: string; sessionKey: string };
    expect(start).toMatchObject({ action: "start", id: HANDOFF.id });
    expect(start.sessionKey).toMatch(/^claude-code:[0-9a-f-]{36}$/);
    const wt = `${checkout}-handoff-abc12345`;
    expect(gitCalls).toContainEqual(["worktree", "add", "-b", "workmesh/handoff-abc12345", wt, "origin/main"]);
    const rec = runner.list()[0]!;
    await until(() => fs.existsSync(rec.exitFile) && fs.readFileSync(rec.exitFile, "utf8").trim() !== "");
    const args = fs.readFileSync(argsFile, "utf8").split("\n");
    expect(args[0]).toBe("-p");
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe(start.sessionKey.slice("claude-code:".length));
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args).toContain(fs.realpathSync(wt));
    expect(args).toContain(`WORKMESH_HANDOFF=${HANDOFF.id}`);
    runner.poll();
    await until(() => hub.calls.length === 2);
    expect(hub.calls[1]!.body).toEqual({
      action: "done",
      id: HANDOFF.id,
      sessionKey: start.sessionKey,
      note: "Ported it; PR 214 is up. Token [redacted] redacted.",
    });
    expect(runner.running().size).toBe(0);
  });

  it("doesn't run when another device won the start; at metadata the note says only how it ended", async () => {
    const hub = fakeHub([{ status: 409, body: { ok: false, error: "another device started it" } }]);
    const runner = new HandoffRunner({
      coord: () => hub.coord,
      settings: () => settings(),
      checkouts: new CheckoutIndex(path.join(home, "c.json")),
      dir: path.join(home, "handoffs"),
      which: () => "/bin/true",
      spawnImpl: (() => {
        throw new Error("must not spawn");
      }) as never,
    });
    runner.run({ ...HANDOFF, repo: undefined });
    await until(() => runner.running().size === 0);
    expect(hub.calls).toHaveLength(1);
    expect(runner.list()).toEqual([]);
    const log = path.join(home, "agent.log");
    fs.writeFileSync(log, '{"type":"result","result":"secret plans"}\n');
    expect(resultText({ agent: "claude", logFile: log })).toBe("secret plans");
  });

  it("the prompt carries the task, context, issue, branch and the headless rules", () => {
    const p = handoffPrompt(HANDOFF, { repo: HANDOFF.repo, branch: "workmesh/handoff-abc12345", base: "origin/main", dir: "/x" });
    expect(p).toContain("Workmesh handoff from An (their agent b3iq-strategy). The task:\n\nPort the KEK rotation");
    expect(p).toContain("Context from An:\n\nStart from PR 212.");
    expect(p).toContain("Linear issue: B3-7168");
    expect(p).toContain("on branch workmesh/handoff-abc12345, made from origin/main");
    expect(p).toContain("You run headless");
  });

  it("reads a codex thread id from exec --json's first event", () => {
    const log = path.join(home, "codex.log");
    fs.writeFileSync(log, '{"type":"thread.started","thread_id":"019a2139-6c2e-7440-938b-08ccb8b2f894"}\n{"type":"turn.started"}\n');
    expect(codexThreadFromLog(log)).toBe("019a2139-6c2e-7440-938b-08ccb8b2f894");
    expect(codexThreadFromLog(path.join(home, "none.log"))).toBeUndefined();
  });
});

describe("codex wake (SPEC §31)", () => {
  it("queues the message with codex queue; a failure is false", async () => {
    const seen: string[][] = [];
    let fail = false;
    const wake = codexWaker({
      bin: () => "/opt/codex",
      exec: (file, args, _o, cb) => {
        seen.push([file, ...args]);
        cb(fail ? new Error("exit 1") : null, "", fail ? "no rollout found for thread id" : "");
      },
    });
    expect(await wake("019a2139-6c2e-7440-938b-08ccb8b2f894", "hello")).toBe(true);
    expect(seen[0]).toEqual(["/opt/codex", "queue", "--thread", "019a2139-6c2e-7440-938b-08ccb8b2f894", "--message", "<workmesh-wake>\nhello\n</workmesh-wake>"]);
    fail = true;
    expect(await wake("019a2139-6c2e-7440-938b-08ccb8b2f894", "hello")).toBe(false);
    expect(await wake("bad id;", "x")).toBe(false);
    expect(await codexWaker({ bin: () => undefined })("019a2139-6c2e", "x")).toBe(false);
  });
});

describe("wake-wait, the asyncRewake Stop hook (SPEC §31)", () => {
  const transcript = (version: string): string => {
    const f = path.join(home, "t.jsonl");
    fs.writeFileSync(f, `${JSON.stringify({ type: "user", version })}\n${JSON.stringify({ type: "assistant", message: { content: [] } })}\n`);
    return f;
  };
  const stdin = (over: Record<string, unknown> = {}) => async () =>
    JSON.stringify({ hook_event_name: "Stop", session_id: "s1", transcript_path: transcript("2.1.332"), ...over });

  it("exits 2 with the message on stderr", async () => {
    writeConfig();
    let err = "";
    const asked: Array<[string, number]> = [];
    const code = await wakeWaitOnce("claude-code", {
      stdin: stdin(),
      env: { CLAUDE_CODE_ENTRYPOINT: "cli" },
      daemonUp: async () => true,
      wait: async (_port, key, ms) => {
        asked.push([key, ms]);
        return asked.length < 2 ? {} : { wake: "Workmesh woke this idle session…\nMessage from An: ping" };
      },
      stderr: (t) => {
        err += t;
      },
    });
    expect(code).toBe(2);
    expect(err).toBe("Workmesh woke this idle session…\nMessage from An: ping\n");
    expect(asked[0]?.[0]).toBe("claude-code:s1");
    expect(asked[0]![1]).toBeLessThanOrEqual(55_000);
  });

  it("exits 0 without waiting: an older Claude Code, wake off, no hub, not a Stop, garbage", async () => {
    const never = async (): Promise<never> => {
      throw new Error("must not wait");
    };
    writeConfig();
    expect(await wakeWaitOnce("claude-code", { stdin: async () => JSON.stringify({ hook_event_name: "Stop", session_id: "s1", transcript_path: transcript("2.1.100") }), wait: never })).toBe(0);
    expect(await wakeWaitOnce("claude-code", { stdin: async () => JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }), wait: never })).toBe(0);
    expect(await wakeWaitOnce("claude-code", { stdin: stdin({ hook_event_name: "SubagentStop" }), wait: never })).toBe(0);
    expect(await wakeWaitOnce("claude-code", { stdin: async () => "not json", wait: never })).toBe(0);
    expect(await wakeWaitOnce("codex", { stdin: stdin(), wait: never })).toBe(0);
    // Headless: a handoff's agent, `claude -p`, an SDK session. Nobody to wake, and a waiter would hold the run open.
    expect(await wakeWaitOnce("claude-code", { stdin: stdin(), env: { CLAUDE_CODE_ENTRYPOINT: "cli", WORKMESH_HANDOFF: "ho_1" }, wait: never })).toBe(0);
    expect(await wakeWaitOnce("claude-code", { stdin: stdin(), env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, wait: never })).toBe(0);
    expect(await wakeWaitOnce("claude-code", { stdin: stdin(), env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }, wait: never })).toBe(0);
    writeConfig({ wake: false });
    expect(await wakeWaitOnce("claude-code", { stdin: stdin(), wait: never })).toBe(0);
    writeConfig({}, false);
    expect(await wakeWaitOnce("claude-code", { stdin: stdin(), wait: never })).toBe(0);
  });

  it("tells interactive sessions from headless ones", () => {
    expect(isHeadless({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(false);
    expect(isHeadless({ CLAUDE_CODE_ENTRYPOINT: "claude-vscode" })).toBe(false);
    expect(isHeadless({})).toBe(false);
    expect(isHeadless({ CLAUDE_CODE_ENTRYPOINT: "sdk-py" })).toBe(true);
    expect(isHeadless({ WORKMESH_HANDOFF: "ho_1" })).toBe(true);
  });

  it("exits 0 when the daemon ends the wait, when its parent goes, and after its window (daemon errors retried)", async () => {
    writeConfig();
    expect(await wakeWaitOnce("claude-code", { stdin: stdin(), daemonUp: async () => true, wait: async () => ({ end: true }) })).toBe(0);
    let ppid = 100;
    expect(
      await wakeWaitOnce("claude-code", {
        stdin: stdin(),
        daemonUp: async () => true,
        parentPid: () => ppid,
        wait: async () => {
          ppid = 1;
          return {};
        },
      }),
    ).toBe(0);
    let now = 0;
    let tries = 0;
    expect(
      await wakeWaitOnce("claude-code", {
        stdin: stdin(),
        now: () => now,
        windowMs: 60_000,
        sleep: async (ms) => {
          now += ms;
        },
        daemonUp: async () => true,
        wait: async () => {
          tries++;
          throw new Error("daemon responded 404");
        },
      }),
    ).toBe(0);
    expect(tries).toBe(4);
  });

  it("reads the Claude Code version from the transcript's newest line that has one", () => {
    expect(transcriptVersion(transcript("2.1.332"))).toEqual([2, 1, 332]);
    expect(transcriptVersion(path.join(home, "missing.jsonl"))).toBeUndefined();
    expect(versionAtLeast([2, 1, 330], [2, 1, 330])).toBe(true);
    expect(versionAtLeast([2, 2, 0], [2, 1, 330])).toBe(true);
    expect(versionAtLeast([2, 1, 99], [2, 1, 330])).toBe(false);
  });
});

describe("v2 ops through the daemon (SPEC §31)", () => {
  const deps = (coord: CoordClient, over: Partial<CoordOpsDeps> = {}): CoordOpsDeps => ({
    coord: () => coord,
    hub: () => ({ url: "https://hub.test", project: { name: "B3" }, person: { name: "Sean" }, deviceId: DEV }),
    getSession: () => undefined,
    listSessions: () => [],
    classify: (p) => (p.startsWith("/w/b3os-beta") ? { root: "/w/b3os-beta", repo: "b3-fun/b3os-beta" } : undefined),
    isShared: () => true,
    claudeSessions: () => undefined,
    home: "/Users/dev",
    ...over,
  });
  const sync = (coord: CoordClient, over: Partial<HubSyncResponse> = {}) =>
    coord.apply(
      hubSyncAcceptSchema.parse({
        cursor: "c",
        me: { person: "Sean" },
        leases: [],
        holds: [],
        inbox: [],
        claims: [],
        roster: [{ person: "An", github: "an-b3", sessions: [] }],
        handoffs: [],
        gates: [],
        approvals: [],
        ...over,
      }),
      T,
    );

  it("handoff: to a person by GitHub login or to me, repo from the session's directory, text redacted", async () => {
    const hub = fakeHub([
      { status: 200, body: { ok: true, handoff: { ...HANDOFF, status: "offered", to: { person: "An" } } } },
      { status: 200, body: { ok: true, handoff: { ...HANDOFF, status: "offered" } } },
    ]);
    sync(hub.coord);
    const r = await runCoordOp(
      { op: "handoff", args: { to: "an-b3", task: "rotate the key in ~/x with token ghp_abcdefghijklmnopqrstuvwxyz0123456789", issue: "b3-7168" }, caller: { claudeSessionId: "s1", cwd: "/w/b3os-beta/src" } },
      deps(hub.coord, { getSession: (k) => (k === "claude-code:s1" ? ({ key: k, cwd: "/w/b3os-beta/src" } as never) : undefined) }),
    );
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^Handed to An \(handoff h_abc12345, b3-fun\/b3os-beta\)/);
    expect(hub.calls[0]!.body).toEqual({
      action: "create",
      from: "claude-code:s1",
      to: { person: "An" },
      task: "rotate the key in ~/x with token [redacted]",
      repo: "b3-fun/b3os-beta",
      issue: "B3-7168",
    });
    const me = await runCoordOp({ op: "handoff", args: { to: "me", task: "finish on the Studio", repo: "b3-fun/workmesh" }, caller: {} }, deps(hub.coord));
    expect(me.text).toMatch(/^Handed to yourself/);
    expect(hub.calls[1]!.body).toEqual({ action: "create", to: { person: "Sean" }, task: "finish on the Studio", repo: "b3-fun/workmesh" });
  });

  it("an older hub: handoffs say so, and coordination stays on", async () => {
    const hub = fakeHub([{ status: 404, body: "Not found" }]);
    sync(hub.coord);
    const r = await runCoordOp({ op: "handoff", args: { to: "An", task: "x" }, caller: {} }, deps(hub.coord));
    expect(r).toMatchObject({ ok: false, text: "This team's hub has no delegation yet (it predates Workmesh v2); nothing was sent." });
    expect(hub.coord.view().available).toBe(true);
  });

  it("gates and approvals are a person's: an agent can't set or decide them", async () => {
    const hub = fakeHub([
      { status: 200, body: { ok: true, gates: { owner: "Sean", actions: ["merge", "deploy"] } } },
      { status: 200, body: { ok: true, approval: { id: "ap_1", sessionKey: `${DEV}:claude-code:s1`, gate: "merge", detail: "gh pr merge 1", status: "approved", ts: T, by: "Sean" } } },
      { status: 200, body: { ok: true, approval: { id: "ap_2", sessionKey: `${DEV}:claude-code:s1`, gate: "merge", detail: "gh pr merge 2", status: "denied", ts: T, by: "Sean" } } },
    ]);
    sync(hub.coord);
    const agent = { claudeSessionId: "s1" };
    expect((await runCoordOp({ op: "gates", args: { set: ["merge"] }, caller: agent }, deps(hub.coord))).text).toMatch(/your person's to set/);
    expect((await runCoordOp({ op: "approvals", args: { action: "approve", id: "ap_1" }, caller: agent }, deps(hub.coord))).text).toMatch(/decided by a person/);
    expect((await runCoordOp({ op: "gates", args: { set: "merge,launch" }, caller: {} }, deps(hub.coord))).text).toMatch(/Unknown gate: launch/);
    expect(hub.calls).toEqual([]);
    const set = await runCoordOp({ op: "gates", args: { set: "merge, deploy" }, caller: {} }, deps(hub.coord));
    expect(set.text).toBe("Your agents now ask before they merge, deploy (approve on the board, in the menu bar or with workmesh approvals approve <id>).");
    expect(hub.calls[0]).toEqual({ url: "https://hub.test/relay/gates", body: { actions: ["merge", "deploy"] } });
    const ok = await runCoordOp({ op: "approvals", args: { action: "approve", id: "ap_1" }, caller: {} }, deps(hub.coord));
    expect(ok.text).toBe("Approved: gh pr merge 1.");
    // 0.12.1: the hub hears where the person decided, so the notice can say it (a terminal, or the menu bar).
    expect(hub.calls[1]!.body).toEqual({ action: "approve", id: "ap_1", via: "cli" });
    const bar = await runCoordOp({ op: "approvals", args: { action: "deny", id: "ap_2" }, caller: { client: "menubar" } }, deps(hub.coord));
    expect(bar.text).toBe("Denied: gh pr merge 2.");
    expect(hub.calls[2]!.body).toEqual({ action: "deny", id: "ap_2", via: "menubar" });
  });

  it("handoffs accept starts it here; list reads the sync", async () => {
    const hub = fakeHub([{ status: 200, body: { ok: true, handoff: { ...HANDOFF } } }]);
    sync(hub.coord, { handoffs: [{ ...HANDOFF, status: "offered" }] as never });
    const list = await runCoordOp({ op: "handoffs", args: {}, caller: {} }, deps(hub.coord));
    expect(list.text).toBe("- h_abc12345 · offered · from An · b3-fun/b3os-beta, B3-7168: Port the KEK rotation to the new runner");
    const accepted: string[] = [];
    const r = await runCoordOp({ op: "handoffs", args: { action: "accept", id: "h_abc12345" }, caller: {} }, deps(hub.coord, { onAccepted: (h) => accepted.push(h.id) }));
    expect(r.text).toBe("Accepted h_abc12345: this machine starts an agent for it.");
    expect(accepted).toEqual(["h_abc12345"]);
  });

  it("a sync older than 5 s is refreshed first (a person at the terminal while no shared session is live)", async () => {
    let now = T;
    const calls: string[] = [];
    const offered = { ...HANDOFF, status: "offered" };
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ cursor: "c2", serverNow: now, me: { person: "Sean" }, leases: [], holds: [], inbox: [], claims: [], roster: [], notes: [], edits: [], handoffs: [offered], gates: [], approvals: [] }), { status: 200 });
    }) as typeof fetch;
    const coord = new CoordClient({ url: "https://hub.test", token: TOKEN, deviceId: DEV, person: "Sean", fetchImpl, now: () => now });
    sync(coord);
    expect((await runCoordOp({ op: "handoffs", args: {}, caller: {} }, deps(coord))).text).toBe("No handoffs.");
    expect(calls).toEqual([]);
    now += 30_000;
    const list = await runCoordOp({ op: "handoffs", args: {}, caller: {} }, deps(coord));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^https:\/\/hub.test\/relay\/sync/);
    expect(list.text).toMatch(/^- h_abc12345 · offered · from An/);
  });
});

describe("workmesh init (SPEC §31)", () => {
  it("hooks, tools, daemon and pairing in one go; a second run keeps the pairing", async () => {
    fs.mkdirSync(path.join(home, ".codex"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const connects: Array<[string, unknown]> = [];
    const restarts: number[] = [];
    try {
      const deps = {
        claudeBin: null,
        restartDaemon: async () => {
          restarts.push(1);
          return true;
        },
        connect: async (url: string, opts: unknown) => {
          connects.push([url, opts]);
          writeConfig();
        },
        checkToken: async () => "ok" as const,
        setShare: async () => {},
        firstContact: async () => ({ kind: "ok" as const, at: Date.now(), sharedSessions: 0 }),
      };
      await runInit("https://hub.test/", { share: "metadata", open: false }, deps);
      expect(connects).toEqual([["https://hub.test", { open: false, share: "metadata" }]]);
      expect(restarts).toHaveLength(1);
      const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
      expect(Object.keys(settings.hooks)).toEqual(expect.arrayContaining(["PreToolUse", "PostToolUse", "SessionStart", "Stop"]));
      expect(settings.hooks.Stop?.some((e) => e.hooks[0]?.command === claudeWakeCommand())).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers.workmesh).toBeDefined();
      expect(fs.existsSync(path.join(home, ".codex", "hooks.json"))).toBe(true);
      const before = fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8");

      await runInit("https://hub.test", {}, deps);
      expect(connects).toHaveLength(1); // still paired: no second pairing
      expect(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")).toBe(before); // hooks unchanged
      const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(printed).toContain("already paired with B3 as Sean");

      // A token the hub rejects, or --repair: pair again.
      await runInit("https://hub.test", {}, { ...deps, checkToken: async () => "rejected" as const });
      await runInit("https://hub.test", { repair: true }, deps);
      expect(connects).toHaveLength(3);
    } finally {
      log.mockRestore();
    }
  });

  it("--no-codex leaves Codex alone; a bad URL changes nothing", async () => {
    fs.mkdirSync(path.join(home, ".codex"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(runInit("ftp://nope", {}, { claudeBin: null })).rejects.toThrow(/hub URL must be https/);
      expect(fs.existsSync(path.join(home, ".claude", "settings.json"))).toBe(false);
      await runInit("https://hub.test", { codex: false }, { claudeBin: null, restartDaemon: async () => true, connect: async () => {}, firstContact: async () => ({ kind: "no-daemon" as const }) });
      expect(fs.existsSync(path.join(home, ".codex", "hooks.json"))).toBe(false);
      expect(fs.existsSync(path.join(home, ".claude", "settings.json"))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});

describe("POST /wake/wait on the daemon (SPEC §31)", () => {
  it("long-polls the delegate; a client that hangs up frees its waiter", async () => {
    const { createDaemonServer } = await import("../src/daemon/server");
    const secret = "b".repeat(64);
    const aborted: string[] = [];
    let release: ((v: { wake?: string }) => void) | undefined;
    const server = createDaemonServer({
      secret,
      applyEvent: () => {},
      getState: () => ({ snapshot: { sessions: [], working: 0, waiting: 0, idle: 0, agentCount: 0 } as never, formatted: null, paused: false }),
      getLastError: () => undefined,
      getOwnership: () => ({ backedOff: false, savedPrior: false, policy: "respect" }),
      pause: async () => {},
      resume: () => {},
      dismiss: () => false,
      getConfig: () => ({}) as never,
      setConfig: () => ({}) as never,
      wakeWait: (session, _ms, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            aborted.push(session);
            resolve({ end: true, reason: "gone" });
          });
          if (session === "claude-code:now") resolve({ wake: "Message from An: hi" });
          else release = resolve;
        }),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const post = (body: unknown, signal?: AbortSignal) =>
      fetch(`http://127.0.0.1:${port}/wake/wait`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body), signal });
    try {
      expect(await (await post({ session: "claude-code:now", timeoutMs: 1000 })).json()).toEqual({ ok: true, wake: "Message from An: hi" });
      expect((await post({ timeoutMs: 1000 })).status).toBe(400);
      expect((await fetch(`http://127.0.0.1:${port}/wake/wait`, { method: "POST", body: "{}" })).status).toBe(401);
      const ac = new AbortController();
      const hung = post({ session: "claude-code:later", timeoutMs: 50_000 }, ac.signal).catch(() => undefined);
      await until(() => release !== undefined);
      ac.abort();
      await hung;
      await until(() => aborted.length === 1);
      expect(aborted).toEqual(["claude-code:later"]);
    } finally {
      server.close();
    }
  });
});

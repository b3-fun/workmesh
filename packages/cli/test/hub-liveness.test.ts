import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionStore } from "@workmesh/core";
import type { AgentSession, SessionEvent } from "@workmesh/core";
import { hubIngestRequestSchema } from "@workmesh/protocol";
import type { HubIngestRequest, HubProjectRule } from "@workmesh/protocol";
import { mapHookInput } from "../src/adapters/claude-code";
import { HubForwarder } from "../src/hub/forwarder";
import { readStateFile, writeStateFile } from "../src/hub/persist";

// v0.10 liveness and persistence (SPEC §24). Sean, 2026-11-25: "I see myself as offline at times, maybe when the
// daemon is interrupted." A restarted daemon forgot its shared sessions and its first full heartbeat ended them all.

const NOW = 1_795_545_600_000;
const RULE: HubProjectRule = { id: "b3", name: "B3", include: { remotes: ["github.com/b3-fun/"], dirs: [] }, issueKeys: ["B3"] };

let home: string;
let docs: string;
let beta: string;
let statePath: string;

function fakeRepo(dir: string, origin: string): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${origin}\n`);
}

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-liveness-")));
  docs = path.join(home, "Documents");
  beta = path.join(docs, "b3", "b3os-beta");
  fakeRepo(beta, "git@github.com:b3-fun/b3os-beta.git");
  fs.mkdirSync(path.join(beta, "src"), { recursive: true });
  statePath = path.join(home, ".local", "state", "workmesh", "hub-forward.json");
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

interface Reply {
  status: number;
}

/** One daemon's forwarder + store, against a fake hub; `clock` is shared across "restarts". */
function daemon(clock: { now: number }, over: { gone?: Set<string>; alive?: Set<string>; replies?: Reply[]; startupGraceMs?: number } = {}) {
  const store = new SessionStore();
  const bodies: HubIngestRequest[] = [];
  const replies = over.replies ?? [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as HubIngestRequest;
    // Every body the relay sends passes the strict wire schema.
    expect(hubIngestRequestSchema.safeParse(body).success).toBe(true);
    bodies.push(body);
    const r = replies.shift() ?? { status: 200 };
    return new Response(JSON.stringify({ ok: true, accepted: body.events.length }), { status: r.status });
  };
  const fwd = new HubForwarder({
    url: "https://hub.test",
    token: `bp_${"a".repeat(64)}`,
    rule: RULE,
    share: "metadata",
    listSessions: () => store.list(),
    getSession: (k) => store.get(k),
    fetchImpl,
    now: () => clock.now,
    homeDir: home,
    client: "workmesh/0.10.0",
    statePath,
    aliveOf: (s) => (over.alive?.has(s.sessionId) ? true : undefined),
    isGone: (s) => over.gone?.has(s.sessionId) ?? false,
    seedSessions: (list) => {
      store.restore(list, clock.now);
    },
    startupGraceMs: over.startupGraceMs,
  });
  const claude = (sessionId: string, cwd: string, input: Record<string, unknown>): void => {
    const e = mapHookInput({ session_id: sessionId, cwd, ...input }, clock.now, { backgroundWork: () => false, turnEnding: () => "asks" }) as SessionEvent;
    store.apply(e, clock.now);
    fwd.observe(e);
  };
  const touch = (sessionId: string, cwd: string) =>
    claude(sessionId, cwd, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(beta, "src", "vm.rs") } });
  return {
    store,
    fwd,
    bodies,
    claude,
    touch,
    upserts: (key: string) => bodies.flatMap((b) => b.sessions).filter((s) => s.key === key),
    fulls: () => bodies.filter((b) => b.full),
  };
}

describe("a restarted daemon keeps sharing (SPEC §24)", () => {
  it("restores shared sessions: the first full heartbeat lists them, none goes ended", async () => {
    fs.rmSync(statePath, { force: true });
    const clock = { now: NOW };
    const a = daemon(clock);
    a.fwd.restoreState();
    // documents-a0: an orchestrator in ~/Documents, shared only because it touched a B3 file (rule 4).
    a.claude("orch", docs, { hook_event_name: "SessionStart" });
    a.touch("orch", docs);
    a.claude("repo", beta, { hook_event_name: "SessionStart" });
    await a.fwd.tick();
    expect(a.fwd.status().sharedSessions).toBe(2);
    clock.now += 1000;
    await a.fwd.stop(); // SIGTERM: flush, then the state file

    const saved = readStateFile(statePath) as { sessions: Array<{ key: string }> };
    expect(saved.sessions.map((s) => s.key).sort()).toEqual(["claude-code:orch", "claude-code:repo"]);
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);

    // The new daemon: an empty store, nothing heard from the hooks yet.
    clock.now += 2000;
    const b = daemon(clock);
    const seeded = b.fwd.restoreState();
    expect(seeded.map((s) => s.key).sort()).toEqual(["claude-code:orch", "claude-code:repo"]);
    expect(b.store.list()).toHaveLength(2);
    await b.fwd.tick();
    const first = b.bodies[0]!;
    expect(first.full).toBe(true);
    expect(first.client).toBe("workmesh/0.10.0");
    expect(first.sessions.map((s) => [s.key, s.state]).sort()).toEqual([
      ["claude-code:orch", "working"],
      ["claude-code:repo", "idle"],
    ]);
    expect(b.bodies.flatMap((x) => x.sessions).some((s) => s.state === "ended")).toBe(false);
    // The orchestrator is still shared: its next tool call goes out without touching a B3 file again.
    b.claude("orch", docs, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: path.join(beta, "src", "a.rs") } });
    await b.fwd.tick();
    expect(b.bodies.at(-1)!.events.map((e) => e.key)).toContain("claude-code:orch");
    expect(b.fwd.status().restored).toEqual({ sessions: 2, events: 0, ended: 0 });
  });

  it("unsent events survive the restart and go out once, with their ids", async () => {
    fs.rmSync(statePath, { force: true });
    const clock = { now: NOW };
    const a = daemon(clock, { replies: Array.from({ length: 20 }, () => ({ status: 503 })) });
    a.fwd.restoreState();
    a.claude("q1", beta, { hook_event_name: "SessionStart" });
    a.touch("q1", beta);
    await a.fwd.tick();
    expect(a.fwd.status().queued).toBe(2);
    const ids = a.bodies[0]!.events.map((e) => e.id);
    await a.fwd.stop(200);

    clock.now += 5000;
    const b = daemon(clock);
    b.fwd.restoreState();
    expect(b.fwd.status().queued).toBe(2);
    await b.fwd.tick();
    expect(b.bodies[0]!.events.map((e) => e.id)).toEqual(ids);
    expect(b.fwd.status()).toMatchObject({ queued: 0, accepted: 2 });
  });

  it("a session whose process is gone is ended at once, saying so (alive: false), and not put back", async () => {
    fs.rmSync(statePath, { force: true });
    const clock = { now: NOW };
    const a = daemon(clock);
    a.fwd.restoreState();
    a.claude("dead", beta, { hook_event_name: "SessionStart" });
    a.claude("live", beta, { hook_event_name: "SessionStart" });
    await a.fwd.tick();
    await a.fwd.stop();

    const b = daemon(clock, { gone: new Set(["dead"]), alive: new Set(["live"]) });
    expect(b.fwd.restoreState().map((s) => s.key)).toEqual(["claude-code:live"]);
    await b.fwd.tick();
    expect(b.upserts("claude-code:dead").at(-1)).toMatchObject({ state: "ended", alive: false });
    expect(b.upserts("claude-code:live").at(-1)).toMatchObject({ state: "idle", alive: true });
    expect(b.store.get("claude-code:dead")).toBeUndefined();
    expect(b.fwd.status().restored).toEqual({ sessions: 2, events: 0, ended: 1 });
  });

  it("ignores a state file that is corrupt, for another hub, or a day old", async () => {
    const clock = { now: NOW };
    for (const bad of ["{not json", JSON.stringify({ v: 1, savedAt: NOW, url: "https://other.test", sessions: [{ key: "x" }], queue: [] }), JSON.stringify({ v: 1, savedAt: NOW - 25 * 3600_000, url: "https://hub.test", sessions: [], queue: [] }), JSON.stringify({ v: 9 })]) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, bad);
      const d = daemon(clock);
      expect(d.fwd.restoreState()).toEqual([]);
      expect(d.fwd.status().restored).toEqual({ sessions: 0, events: 0, ended: 0 });
    }
    // A record that fails its checks costs only itself.
    writeStateFile(statePath, {
      v: 1,
      savedAt: NOW,
      url: "https://hub.test",
      sessions: [
        { key: "claude-code:ok", shared: true, roots: [], issues: [], last: { key: "claude-code:ok", source: "claude-code", sessionId: "ok", state: "idle", agents: 1, startedAt: NOW, updatedAt: NOW, stateSince: NOW } },
        { key: "claude-code:nolast", shared: true, roots: [], issues: [] },
      ],
      queue: [{ id: "x-1", key: "claude-code:ok", ts: NOW, kind: "tool", path: "/etc/passwd" }, { id: "x-2", key: "claude-code:ok", ts: NOW, kind: "tool" }],
    });
    const d = daemon(clock);
    expect(d.fwd.restoreState().map((s) => s.key)).toEqual(["claude-code:ok"]);
    expect(d.fwd.status().queued).toBe(1);
  });

  it("start() reads the state back before its first send", async () => {
    fs.rmSync(statePath, { force: true });
    const clock = { now: NOW };
    const a = daemon(clock);
    a.claude("s", beta, { hook_event_name: "SessionStart" });
    await a.fwd.tick();
    await a.fwd.stop();
    const b = daemon(clock);
    b.fwd.start();
    await b.fwd.stop();
    expect(b.bodies[0]?.sessions.map((s) => s.key)).toEqual(["claude-code:s"]);
    expect(b.bodies[0]?.full).toBe(true);
  });
});

describe("heartbeats right after a start (SPEC §24)", () => {
  it("never sends an empty full heartbeat in the first 2 minutes, but still heartbeats", async () => {
    fs.rmSync(statePath, { force: true });
    const clock = { now: NOW };
    const d = daemon(clock);
    d.fwd.restoreState();
    await d.fwd.tick();
    expect(d.bodies.map((b) => [b.full, b.sessions.length])).toEqual([[false, 0]]);
    clock.now += 1000;
    await d.fwd.tick(); // not due
    expect(d.bodies).toHaveLength(1);
    clock.now += 30_000;
    await d.fwd.tick(); // due: still held back, still sent (the hub hears from a running relay)
    expect(d.bodies.map((b) => b.full)).toEqual([false, false]);
    clock.now += 90_000;
    await d.fwd.tick(); // past the grace: an empty set is the truth now
    expect(d.bodies.at(-1)?.full).toBe(true);
  });

  it("a full heartbeat goes out as soon as there is something to list", async () => {
    fs.rmSync(statePath, { force: true });
    const clock = { now: NOW };
    const d = daemon(clock);
    d.fwd.restoreState();
    d.claude("x", beta, { hook_event_name: "SessionStart" });
    await d.fwd.tick();
    expect(d.bodies[0]).toMatchObject({ full: true, client: "workmesh/0.10.0" });
  });
});

describe("liveness fields (SPEC §24)", () => {
  it("alive from the process check; quietSince once a working session has had no event for a minute", async () => {
    fs.rmSync(statePath, { force: true });
    const clock = { now: NOW };
    const d = daemon(clock, { alive: new Set(["w"]) });
    d.fwd.restoreState();
    d.claude("w", beta, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    await d.fwd.tick();
    expect(d.upserts("claude-code:w").at(-1)).toMatchObject({ state: "working", alive: true });
    expect(d.upserts("claude-code:w").at(-1)?.quietSince).toBeUndefined();
    clock.now += 61_000;
    d.store.touch("claude-code:w", clock.now); // Claude Code says busy: still working, no events
    await d.fwd.tick();
    expect(d.upserts("claude-code:w").at(-1)?.quietSince).toBe(NOW);
    const sent = d.bodies.length;
    clock.now += 1000;
    await d.fwd.tick(); // stable: no new upsert for it
    expect(d.bodies.length).toBe(sent);
    d.touch("w", beta);
    await d.fwd.tick();
    expect(d.upserts("claude-code:w").at(-1)?.quietSince).toBeUndefined();
  });

  it("persists at most once a second, only when something changed", async () => {
    fs.rmSync(statePath, { force: true });
    const clock = { now: NOW };
    const d = daemon(clock);
    d.fwd.restoreState();
    d.claude("p", beta, { hook_event_name: "SessionStart" });
    await d.fwd.tick();
    const t1 = fs.statSync(statePath).mtimeMs;
    const first = fs.readFileSync(statePath, "utf8");
    clock.now += 2000;
    await d.fwd.tick();
    expect(fs.readFileSync(statePath, "utf8")).toBe(first); // nothing changed: not rewritten
    expect(fs.statSync(statePath).mtimeMs).toBe(t1);
  });
});

/** Type check: the seed is the store's own shape. */
const _seed: (s: AgentSession[]) => void = (s) => void s;
void _seed;

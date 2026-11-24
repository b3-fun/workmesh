import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SessionStore, hubIngestRequestSchema } from "@workmesh/core";
import type { HubIngestRequest, HubProjectRule, SessionEvent } from "@workmesh/core";
import { mapHookInput } from "../src/adapters/claude-code";
import { mapCodexHookInput, mapNotifyArg } from "../src/adapters/codex";
import { HubForwarder, parseRetryAfter } from "../src/hub/forwarder";

const NOW = 1_795_545_600_000;
const TOKEN = `bp_${"a".repeat(64)}`;
const RULE: HubProjectRule = {
  id: "b3",
  name: "B3",
  include: { remotes: ["github.com/b3-fun/"], dirs: [] },
  issueKeys: ["B3"],
};

// --- fixture: a fake home with B3 repos, a worktree, a non-B3 repo ----------

let home: string;
let docs: string;
let beta: string;
let wt: string;
let salience: string;
let priv: string;
let notes: string;

function fakeRepo(dir: string, origin: string, branch = "main"): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(path.join(dir, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${origin}\n`);
}

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentblip-hubfwd-")));
  docs = path.join(home, "Documents");
  beta = path.join(docs, "b3", "b3os-beta");
  wt = path.join(docs, "b3", "b3os-beta-relay");
  salience = path.join(docs, "salience");
  priv = path.join(docs, "b3", "b3-private");
  notes = path.join(docs, "team-notes");
  fakeRepo(beta, "git@github.com:b3-fun/b3os-beta.git");
  fakeRepo(salience, "https://github.com/seangeng/salience.git");
  fakeRepo(priv, "git@github.com:b3-fun/b3-private.git");
  fs.mkdirSync(notes, { recursive: true });
  // linked worktree of b3os-beta
  const wtGit = path.join(beta, ".git", "worktrees", "relay");
  fs.mkdirSync(wtGit, { recursive: true });
  fs.writeFileSync(path.join(wtGit, "HEAD"), "ref: refs/heads/sean/b3-7166-relay\n");
  fs.writeFileSync(path.join(wtGit, "commondir"), "../..\n");
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtGit}\n`);
  for (const d of [path.join(beta, "crates", "vm", "src"), path.join(wt, "src"), path.join(salience, "research")]) {
    fs.mkdirSync(d, { recursive: true });
  }
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// --- harness --------------------------------------------------------------------

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

function harness(over: { maxBuffer?: number; url?: string; useRealFetch?: boolean } = {}) {
  const store = new SessionStore();
  const bodies: HubIngestRequest[] = [];
  const raw: string[] = [];
  const replies: Reply[] = [];
  const logs: string[] = [];
  let now = NOW;
  const fetchImpl: typeof fetch = async (_url, init) => {
    const text = String(init?.body ?? "");
    raw.push(text);
    const body = JSON.parse(text) as HubIngestRequest;
    bodies.push(body);
    const r = replies.shift() ?? { status: 200, body: { ok: true, accepted: body.events.length } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
  };
  const fwd = new HubForwarder({
    url: over.url ?? "https://hub.test",
    token: TOKEN,
    rule: RULE,
    share: "metadata", // these tests cover the metadata-level rules (SPEC §3.3)
    includeDirs: [notes],
    excludeDirs: [priv],
    listSessions: () => store.list(),
    getSession: (k) => store.get(k),
    fetchImpl: over.useRealFetch ? undefined : fetchImpl,
    now: () => now,
    log: (m) => logs.push(m),
    maxBuffer: over.maxBuffer,
    homeDir: home,
  });
  const feed = (event: SessionEvent | null): void => {
    if (!event) throw new Error("mapper returned null");
    store.apply(event, now);
    fwd.observe(event);
  };
  const claude = (sessionId: string, cwd: string, input: Record<string, unknown>): void =>
    feed(
      mapHookInput({ session_id: sessionId, cwd, ...input }, now, {
        backgroundWork: () => false,
        turnEnding: () => "asks",
      }),
    );
  const codex = (sessionId: string, cwd: string, input: Record<string, unknown>): void =>
    feed(mapCodexHookInput({ session_id: sessionId, cwd, transcript_path: null, model: "m", ...input }, now));
  return {
    store,
    fwd,
    bodies,
    raw,
    replies,
    logs,
    feed,
    claude,
    codex,
    advance: (ms: number) => {
      now += ms;
    },
    events: () => bodies.flatMap((b) => b.events),
    upserts: (key: string) => bodies.flatMap((b) => b.sessions).filter((s) => s.key === key),
  };
}

/** Every string anywhere in a JSON value. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

// --- inclusion -------------------------------------------------------------------

describe("HubForwarder inclusion (SPEC §3.3 rules 1-4)", () => {
  it("shares a session in a B3 repo with repo-relative paths", async () => {
    const h = harness();
    h.claude("s1", beta, { hook_event_name: "SessionStart" });
    h.claude("s1", beta, {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: path.join(beta, "crates/vm/src/vm.rs") },
    });
    await h.fwd.tick();
    expect(h.events().map((e) => e.kind)).toEqual(["start", "tool"]);
    expect(h.events()[1]).toMatchObject({
      key: "claude-code:s1",
      tool: "Edit",
      label: "editing vm.rs",
      path: "crates/vm/src/vm.rs",
      repo: "b3-fun/b3os-beta",
      branch: "main",
    });
    expect(h.upserts("claude-code:s1")[0]).toMatchObject({
      source: "claude-code",
      state: "working",
      activity: "editing vm.rs",
      repo: "b3-fun/b3os-beta",
      branch: "main",
    });
  });

  it("sends nothing at all for a session in a non-B3 repo", async () => {
    const h = harness();
    h.claude("s2", salience, { hook_event_name: "SessionStart" });
    h.claude("s2", salience, { hook_event_name: "UserPromptSubmit", prompt: "B3-1 research" });
    h.claude("s2", salience, {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(salience, "research/edge.py"), content: "alpha" },
    });
    h.claude("s2", salience, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push" } });
    await h.fwd.tick();
    h.advance(30_000);
    await h.fwd.tick();
    expect(h.bodies.length).toBeGreaterThan(0); // heartbeats still go out
    expect(h.raw.join("")).not.toContain("s2");
    expect(h.fwd.status().sharedSessions).toBe(0);
  });

  it("treats a worktree as its main repository", async () => {
    const h = harness();
    h.claude("w1", wt, {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(wt, "src/relay.ts") },
    });
    await h.fwd.tick();
    expect(h.events()[0]).toMatchObject({
      path: "src/relay.ts",
      repo: "b3-fun/b3os-beta",
      branch: "sean/b3-7166-relay",
    });
    expect(h.upserts("claude-code:w1")[0]).toMatchObject({ repo: "b3-fun/b3os-beta", branch: "sean/b3-7166-relay" });
  });

  it("an orchestrator in ~/Documents shares only what touches a shared repo", async () => {
    const h = harness();
    const key = "claude-code:o1";
    h.claude("o1", docs, { hook_event_name: "SessionStart" });
    h.claude("o1", docs, { hook_event_name: "UserPromptSubmit", prompt: "plan B3-7166 across repos" });
    h.claude("o1", docs, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls ~/Documents" } });
    await h.fwd.tick();
    expect(h.raw.join("")).not.toContain(key); // not shared yet: nothing

    // touching a B3 file shares the session
    h.claude("o1", docs, {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: path.join(beta, "SPEC.md") },
    });
    // a non-B3 file, a bash command without a shared path, a web fetch: dropped
    h.claude("o1", docs, {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: path.join(salience, "research/notes.md") },
    });
    h.claude("o1", docs, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: `cat ${salience}/research/notes.md | wc -l` },
    });
    h.claude("o1", docs, { hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_input: { url: "https://x" } });
    // bash naming a path in the shared repo: forwarded
    h.claude("o1", docs, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: `cargo test --manifest-path ${beta}/Cargo.toml` },
    });
    h.claude("o1", docs, { hook_event_name: "UserPromptSubmit", prompt: "now do B3-7170" });
    h.claude("o1", docs, { hook_event_name: "Stop" });
    await h.fwd.tick();

    const evs = h.events().filter((e) => e.key === key);
    expect(evs.map((e) => [e.kind, e.tool, e.path ?? e.cmd ?? null])).toEqual([
      ["tool", "Read", "SPEC.md"],
      ["tool", "Bash", "cargo test"],
      ["prompt", undefined, null],
      ["idle", undefined, null],
    ]);
    expect(evs[1]).toMatchObject({ repo: "b3-fun/b3os-beta" });
    expect(evs[2]?.issues).toEqual(["B3-7170"]);
    const up = h.upserts(key).at(-1);
    expect(up).toMatchObject({ repo: "b3-fun/b3os-beta", state: "idle" });
    expect(up?.issues).toEqual(["B3-7166", "B3-7170"]);
    expect(h.raw.join("")).not.toContain("salience");
    expect(h.raw.join("")).not.toContain("notes.md");
  });

  it("an excluded dir beats a matching remote; an included dir shares a plain folder", async () => {
    const h = harness();
    h.claude("p1", priv, {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: path.join(priv, "a.ts") },
    });
    h.claude("n1", notes, {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(notes, "standup.md") },
    });
    await h.fwd.tick();
    expect(h.raw.join("")).not.toContain("p1");
    expect(h.events().find((e) => e.key === "claude-code:n1")).toMatchObject({ path: "standup.md" });
    expect(h.events().find((e) => e.key === "claude-code:n1")?.repo).toBeUndefined();
  });

  it("a file outside the shared repos in a shared session loses its name", async () => {
    const h = harness();
    h.claude("s3", beta, {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: path.join(salience, "research/alpha.py") },
    });
    await h.fwd.tick();
    const ev = h.events()[0];
    expect(ev).toMatchObject({ kind: "tool", tool: "Edit", label: "editing files" });
    expect(ev?.path).toBeUndefined();
    expect(ev?.repo).toBeUndefined();
    expect(h.upserts("claude-code:s3")[0]?.activity).toBe("editing files");
  });

  it("workflow fan-out launched by a shared session is shared with it", async () => {
    const h = harness();
    h.claude("lead", beta, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    h.feed({
      source: "workflow",
      sessionId: "wf1",
      kind: "working",
      agents: 5,
      activity: "running a workflow",
      orchestrator: "claude-code:lead",
      ts: NOW,
    });
    await h.fwd.tick();
    expect(h.upserts("workflow:wf1")[0]).toMatchObject({
      agents: 5,
      orchestrator: "claude-code:lead",
      repo: "b3-fun/b3os-beta",
      activity: "running a workflow",
    });
  });

  it("reports an ended session once, then forgets it", async () => {
    const h = harness();
    h.claude("e1", beta, { hook_event_name: "SessionStart" });
    await h.fwd.tick();
    h.claude("e1", beta, { hook_event_name: "SessionEnd" });
    h.advance(1000);
    await h.fwd.tick();
    expect(h.upserts("claude-code:e1").at(-1)?.state).toBe("ended");
    expect(h.events().at(-1)?.kind).toBe("end");
    h.advance(30_000);
    await h.fwd.tick();
    expect(h.bodies.at(-1)?.full).toBe(true);
    expect(h.bodies.at(-1)?.sessions.find((s) => s.key === "claude-code:e1")).toBeUndefined();
  });
});

// --- PR + Codex ---------------------------------------------------------------------

describe("HubForwarder PR and Codex events", () => {
  it("adds a PR line from gh pr create on a shared repo", async () => {
    const h = harness();
    const pre = { tool_name: "Bash", tool_input: { command: 'gh pr create --title "B3-7166: relay" --body "secret body"' } };
    h.claude("pr", beta, { hook_event_name: "PreToolUse", ...pre });
    h.claude("pr", beta, {
      hook_event_name: "PostToolUse",
      ...pre,
      tool_response: { stdout: "https://github.com/b3-fun/b3os-beta/pull/42\n", stderr: "" },
    });
    // a PR URL on a repo that isn't shared is not sent
    h.claude("pr", beta, {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr view 9" },
      tool_response: { stdout: "https://github.com/seangeng/salience/pull/9\n", stderr: "" },
    });
    await h.fwd.tick();
    const evs = h.events();
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({ kind: "tool", cmd: "gh pr", issues: ["B3-7166"] });
    expect(evs[0]?.pr).toBeUndefined();
    expect(evs[1]).toMatchObject({ kind: "tool", cmd: "gh pr", ok: true, pr: "https://github.com/b3-fun/b3os-beta/pull/42" });
    expect(h.raw.join("")).not.toContain("salience");
  });

  it("maps a Codex session like Claude Code", async () => {
    const h = harness();
    const patch = "*** Begin Patch\n*** Update File: crates/vm/src/vm.rs\n@@\n-a\n+b\n*** End Patch";
    h.codex("cx", beta, { hook_event_name: "SessionStart", source: "startup" });
    h.codex("cx", beta, { hook_event_name: "UserPromptSubmit", prompt: "fix it" });
    h.codex("cx", beta, { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch } });
    h.codex("cx", beta, { hook_event_name: "PreToolUse", tool_name: "shell", tool_input: { command: ["bash", "-lc", "cargo test -p vm"] } });
    h.codex("cx", beta, {
      hook_event_name: "PostToolUse",
      tool_name: "shell",
      tool_input: { command: ["bash", "-lc", "cargo test -p vm"] },
      tool_response: "Exit code: 101\nOutput:\nfailed",
    });
    h.codex("cx", beta, { hook_event_name: "PermissionRequest", tool_name: "shell", tool_input: { command: "rm -rf target" } });
    h.codex("cx", beta, { hook_event_name: "Stop", last_assistant_message: "all done" });
    await h.fwd.tick();
    expect(h.events().map((e) => [e.kind, e.tool ?? null, e.label ?? null, e.path ?? e.cmd ?? null, e.ok ?? null])).toEqual([
      ["start", null, null, null, null],
      ["prompt", null, null, null, null],
      ["tool", "apply_patch", "editing vm.rs", "crates/vm/src/vm.rs", null],
      ["tool", "shell", "running commands", "cargo test", null],
      ["tool", "shell", "running commands", "cargo test", false],
      ["waiting", "shell", "needs my input", null, null],
      ["idle", null, null, null, null],
    ]);
    expect(h.upserts("codex:cx").at(-1)).toMatchObject({ source: "codex", state: "idle" });
  });

  it("never forwards Codex notify's assistant text as a label", async () => {
    const h = harness();
    h.codex("cn", beta, { hook_event_name: "SessionStart" });
    h.feed(mapNotifyArg(JSON.stringify({ type: "agent-turn-complete", "thread-id": "cn", "last-assistant-message": "ASSISTANT_TEXT here" }), NOW));
    await h.fwd.tick();
    expect(h.raw.join("")).not.toContain("ASSISTANT_TEXT");
  });
});

// --- privacy ---------------------------------------------------------------------------

describe("HubForwarder privacy: nothing raw leaves the machine", () => {
  it("strips secrets, commands, prompts, file contents and absolute paths from every request", async () => {
    const h = harness();
    const SECRET = "sk-live-9f8e7d6c5b4a";
    const run = (id: string, cwd: string, inputs: Array<Record<string, unknown>>): void => {
      for (const input of inputs) h.claude(id, cwd, input);
    };
    run("priv1", beta, [
      { hook_event_name: "SessionStart" },
      { hook_event_name: "UserPromptSubmit", prompt: `PROMPT_TEXT: deploy with ${SECRET}, password hunter2, B3-7166` },
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `curl -H "Authorization: Bearer ${SECRET}" https://api.internal.example/v1/keys` } },
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: `curl -H "Authorization: Bearer ${SECRET}" https://api.internal.example/v1/keys` },
        tool_response: { stdout: `{"key":"${SECRET}","owner":"ops@corp"}`, stderr: "" },
      },
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `export AWS_SECRET_ACCESS_KEY=${SECRET} && npm run deploy -- --token ${SECRET}` } },
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: path.join(beta, "config/prod.env") } },
      {
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: { file_path: path.join(beta, "config/prod.env") },
        tool_response: { type: "text", file: { filePath: path.join(beta, "config/prod.env"), content: `DATABASE_URL=postgres://admin:hunter2@db\nFILE_CONTENTS_MARKER` } },
      },
      {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: path.join(beta, "crates/vm/src/vm.rs"), old_string: "FILE_CONTENTS_MARKER", new_string: `let key = "${SECRET}";` },
      },
      { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(salience, "research/alpha.py"), content: "FILE_CONTENTS_MARKER" } },
      { hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: SECRET, path: path.join(home, ".ssh") } },
      { hook_event_name: "PreToolUse", tool_name: "mcp__slack__send_message", tool_input: { text: `PROMPT_TEXT ${SECRET}` } },
      { hook_event_name: "Notification", notification_type: "idle_prompt", message: `Claude needs your permission ${SECRET}` },
      { hook_event_name: "Stop" },
    ]);
    h.codex("priv2", docs, { hook_event_name: "UserPromptSubmit", prompt: `PROMPT_TEXT orchestrate ${SECRET}` });
    h.codex("priv2", docs, {
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: `*** Begin Patch\n*** Update File: ${beta}/README.md\n+${SECRET}\n*** End Patch` },
    });
    h.codex("priv2", docs, { hook_event_name: "PreToolUse", tool_name: "shell", tool_input: { command: ["bash", "-lc", `psql postgres://admin:${SECRET}@db -c 'select 1'`] } });
    h.codex("priv2", docs, { hook_event_name: "Stop", last_assistant_message: `ASSISTANT_TEXT ${SECRET}` });
    await h.fwd.tick();
    h.advance(30_000);
    await h.fwd.tick();

    const all = h.raw.join("\n");
    for (const needle of [
      SECRET,
      "hunter2",
      "Authorization",
      "Bearer",
      "PROMPT_TEXT",
      "ASSISTANT_TEXT",
      "FILE_CONTENTS_MARKER",
      "AWS_SECRET",
      "api.internal",
      "postgres://",
      "salience",
      "alpha.py",
      ".ssh",
      home,
      "/Users/",
      "Documents",
    ]) {
      expect(all, `leaked ${needle}`).not.toContain(needle);
    }
    // Only contract fields, and no absolute paths anywhere.
    for (const text of h.raw) {
      const body = JSON.parse(text) as unknown;
      expect(hubIngestRequestSchema.safeParse(body).success).toBe(true);
      for (const s of strings(body)) {
        expect(s.startsWith("/"), s).toBe(false);
        expect(s.startsWith("~"), s).toBe(false);
      }
    }
    // What should be there is there.
    const evs = h.events();
    expect(evs.some((e) => e.path === "crates/vm/src/vm.rs")).toBe(true);
    expect(evs.some((e) => e.path === "README.md" && e.key === "codex:priv2")).toBe(true);
    expect(evs.some((e) => e.cmd === "npm run")).toBe(true);
    const promptKeys = new Set(["id", "key", "ts", "kind", "repo", "branch", "issues"]);
    for (const e of evs.filter((ev) => ev.kind === "prompt")) {
      for (const k of Object.keys(e)) expect(promptKeys.has(k), `prompt event field ${k}`).toBe(true);
    }
    expect(evs.find((e) => e.kind === "prompt" && e.key === "claude-code:priv1")?.issues).toEqual(["B3-7166"]);
  });
});

// --- batching, retry, 429, 401 against a mock hub ------------------------------------

describe("HubForwarder delivery (mock hub over HTTP)", () => {
  let server: http.Server;
  let base: string;
  const received: Array<{ auth?: string; body: HubIngestRequest }> = [];
  const replies: Reply[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c: Buffer) => {
        data += c.toString("utf8");
      });
      req.on("end", () => {
        if (req.url !== "/relay/ingest" || req.method !== "POST") {
          res.writeHead(404).end();
          return;
        }
        const body = JSON.parse(data) as HubIngestRequest;
        received.push({ auth: req.headers.authorization, body });
        const r = replies.shift() ?? { status: 200, body: { ok: true, accepted: body.events.length } };
        res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
        res.end(JSON.stringify(r.body ?? {}));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });
  afterEach(() => {
    received.length = 0;
    replies.length = 0;
  });

  const tools = (h: ReturnType<typeof harness>, n: number, id = "d1"): void => {
    for (let i = 0; i < n; i++) {
      h.claude(id, beta, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `cargo test ${i}` } });
    }
  };

  it("batches everything since the last send into one authenticated request", async () => {
    const h = harness({ url: base, useRealFetch: true });
    tools(h, 3);
    await h.fwd.tick();
    expect(received).toHaveLength(1);
    expect(received[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(received[0]?.body).toMatchObject({ v: 1, full: true, sentAt: NOW });
    expect(received[0]?.body.events).toHaveLength(3);
    expect(new Set(received[0]?.body.events.map((e) => e.id)).size).toBe(3);
    await h.fwd.tick(); // nothing new: no request
    expect(received).toHaveLength(1);
    h.advance(30_000);
    await h.fwd.tick(); // heartbeat
    expect(received).toHaveLength(2);
    expect(received[1]?.body.full).toBe(true);
    expect(received[1]?.body.sessions.map((s) => s.key)).toEqual(["claude-code:d1"]);
    expect(h.fwd.status()).toMatchObject({ queued: 0, accepted: 3, lastSendOk: true, sharedSessions: 1 });
  });

  it("keeps events across failures and resends them with the same ids", async () => {
    const h = harness({ url: base, useRealFetch: true });
    replies.push({ status: 503 }, { status: 503 });
    tools(h, 2);
    await h.fwd.tick();
    expect(h.fwd.status()).toMatchObject({ queued: 2, lastSendOk: false });
    await h.fwd.tick(); // still backing off (1 s)
    expect(received).toHaveLength(1);
    h.advance(1000);
    await h.fwd.tick(); // second 503, backoff 2 s
    h.advance(1500);
    await h.fwd.tick();
    expect(received).toHaveLength(2);
    h.advance(1000);
    await h.fwd.tick(); // succeeds
    expect(received).toHaveLength(3);
    const ids = received.map((r) => r.body.events.map((e) => e.id).join());
    expect(ids[0]).toBe(ids[2]);
    expect(h.fwd.status().queued).toBe(0);
  });

  it("drops the oldest events past the buffer and counts them", async () => {
    const h = harness({ url: `http://127.0.0.1:1`, useRealFetch: true, maxBuffer: 3 });
    tools(h, 5);
    expect(h.fwd.status()).toMatchObject({ queued: 3, dropped: 2 });
  });

  it("honors Retry-After on 429", async () => {
    const h = harness({ url: base, useRealFetch: true });
    replies.push({ status: 429, headers: { "retry-after": "5" } });
    tools(h, 1);
    await h.fwd.tick();
    h.advance(4000);
    await h.fwd.tick();
    expect(received).toHaveLength(1);
    expect(h.fwd.status().lastError).toMatch(/429/);
    h.advance(1000);
    await h.fwd.tick();
    expect(received).toHaveLength(2);
    expect(received[1]?.body.events).toHaveLength(1);
    expect(parseRetryAfter("Wed, 21 Oct 2099 07:28:00 GMT", NOW)).toBe(10 * 60_000);
    expect(parseRetryAfter(null, NOW)).toBe(30_000);
  });

  it("stops for good on 401 and says how to re-pair", async () => {
    const h = harness({ url: base, useRealFetch: true });
    replies.push({ status: 401, body: { ok: false, error: "unknown device" } });
    tools(h, 1);
    await h.fwd.tick();
    expect(h.fwd.status()).toMatchObject({ halted: true });
    expect(h.logs.join("\n")).toContain(`agentblip hub connect ${base}`);
    tools(h, 2);
    h.advance(60_000);
    await h.fwd.tick();
    expect(received).toHaveLength(1);
  });

  it("does not loop on a 400", async () => {
    const h = harness({ url: base, useRealFetch: true });
    replies.push({ status: 400, body: { ok: false, error: ["events.0.cmd: bad"] } });
    tools(h, 2);
    await h.fwd.tick();
    h.advance(1000);
    await h.fwd.tick();
    expect(received).toHaveLength(1);
    expect(h.fwd.status()).toMatchObject({ rejected: 2, queued: 0 });
  });

  it("runs on its own timer once started", async () => {
    const store = new SessionStore();
    const fwd = new HubForwarder({
      url: base,
      token: TOKEN,
      rule: RULE,
      share: "metadata",
      listSessions: () => store.list(),
      getSession: (k) => store.get(k),
      batchIntervalMs: 20,
      homeDir: home,
    });
    fwd.start();
    const e = mapHookInput(
      { hook_event_name: "PreToolUse", session_id: "t1", cwd: beta, tool_name: "Bash", tool_input: { command: "git status" } },
      Date.now(),
    )!;
    store.apply(e);
    fwd.observe(e);
    const deadline = Date.now() + 2000;
    while (!received.some((r) => r.body.events.length > 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await fwd.stop();
    expect(received.some((r) => r.body.events.some((ev) => ev.cmd === "git status"))).toBe(true);
  });
});

#!/usr/bin/env node
// A stand-in for the Workmesh daemon's loopback API, with fixture data, so the
// menu bar app can be run and snapshotted without a real daemon, hub or Slack.
//
//   XDG_CONFIG_HOME=/tmp/wm/config XDG_STATE_HOME=/tmp/wm/state \
//     node scripts/mock-daemon.mjs [--port 45190] [--scenario team]
//
// Scenarios: team (default: two local sessions, three teammates, a wait on
// another machine), empty (paired, nobody else online), unpaired (no hub),
// halted (the hub rejected the device token), noteam (a hub without the team
// view), legacy (a daemon from before GET /team: 404).
//
// It writes <XDG_STATE_HOME>/workmesh/daemon.secret and
// <XDG_CONFIG_HOME>/workmesh/config.json ({"port": ...}) so the app finds it.
// Both variables are required and must not be the real ~/.config or
// ~/.local/state: this never touches a live install. Plain Node, no deps.

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(arg("port", "45190"));
const scenario = arg("scenario", "team");
const SCENARIOS = ["team", "empty", "unpaired", "halted", "noteam", "legacy"];

function die(msg) {
  console.error(`mock-daemon: ${msg}`);
  process.exit(1);
}

if (!SCENARIOS.includes(scenario)) die(`unknown --scenario ${scenario} (${SCENARIOS.join(", ")})`);
if (!Number.isInteger(port) || port < 1024 || port > 65535) die(`bad --port ${port}`);
if (port === 4519) die("4519 is the real daemon's port; pick another");

const configHome = process.env.XDG_CONFIG_HOME;
const stateHome = process.env.XDG_STATE_HOME;
if (!configHome || !stateHome) die("set XDG_CONFIG_HOME and XDG_STATE_HOME to a scratch directory");
const home = homedir();
for (const [dir, real] of [
  [configHome, join(home, ".config")],
  [stateHome, join(home, ".local", "state")],
]) {
  if (resolve(dir) === resolve(real)) die(`${dir} is the real config/state dir; use a scratch directory`);
}

const secret = randomBytes(24).toString("hex");
mkdirSync(join(stateHome, "workmesh"), { recursive: true });
mkdirSync(join(configHome, "workmesh"), { recursive: true });
writeFileSync(join(stateHome, "workmesh", "daemon.secret"), secret + "\n", { mode: 0o600 });
writeFileSync(join(configHome, "workmesh", "config.json"), JSON.stringify({ port }, null, 2) + "\n", { mode: 0o600 });

// ---------------------------------------------------------------- fixtures

const T0 = Date.now();
const ago = (min) => T0 - min * 60_000;
const HUB = "https://workmesh.b3os.org";
const THIS_DEVICE = "dev_01JMOCKSTUDIO";
const OTHER_DEVICE = "dev_01JMOCKLAPTOP";

const localWaiting = {
  key: "claude-code:5f0c2a1e-7b3d-4c11-9e0a-2f6d8c4b1a90",
  source: "claude-code",
  sessionId: "5f0c2a1e-7b3d-4c11-9e0a-2f6d8c4b1a90",
  state: "waiting",
  activity: "waiting for input",
  project: "workmesh",
  agents: 1,
  cwd: "/tmp/workmesh-mock/workmesh",
  name: "documents-07",
  startedAt: ago(48),
  updatedAt: ago(4),
  stateSince: ago(4),
  subagents: 0,
};
const localWorking = {
  key: "codex:019a7c3e-55f1-7d20-b6e4-8f1d2c9a0b37",
  source: "codex",
  sessionId: "019a7c3e-55f1-7d20-b6e4-8f1d2c9a0b37",
  state: "working",
  activity: "running tests",
  project: "hub",
  agents: 3,
  cwd: "/tmp/workmesh-mock/hub",
  name: "codex-1",
  startedAt: ago(30),
  updatedAt: ago(0.2),
  stateSince: ago(12),
  subagents: 2,
};

function localSessions() {
  return scenario === "empty" ? [] : [localWaiting, localWorking];
}

function state() {
  const sessions = localSessions();
  const working = sessions.filter((s) => s.state === "working").length;
  const waiting = sessions.filter((s) => s.state === "waiting").length;
  const agentCount = sessions.filter((s) => s.state === "working").reduce((n, s) => n + (s.agents ?? 1), 0);
  return {
    snapshot: {
      sessions,
      working,
      waiting,
      idle: sessions.length - working - waiting,
      total: sessions.length,
      agentCount,
      latestActivity: sessions.length ? "running tests" : undefined,
    },
    formatted: sessions.length
      ? { text: "3 agents working · 1 waiting on me", emoji: ":large_green_circle:", expirationSec: 300 }
      : null,
    paused: false,
    ownership: { backedOff: false, savedPrior: false, policy: "respect" },
  };
}

const config = {
  mode: "relay",
  relayUrl: "https://agentblip.com",
  port,
  granularity: "activity",
  statusPolicy: "respect",
  showProject: true,
  repoPrefix: false,
  statusTtlSec: 300,
  debounceMs: 1500,
};

function hub() {
  if (scenario === "unpaired") return { enabled: false };
  return {
    enabled: true,
    url: HUB,
    project: { id: "b3", name: "B3" },
    running: scenario !== "halted",
    halted: scenario === "halted",
    lastSendAt: T0 - 2_000,
    lastSendOk: scenario !== "halted",
    queued: 0,
    dropped: 0,
    rejected: 0,
    accepted: 412,
    sharedSessions: localSessions().length,
    share: "conversation",
    conversationSessions: localSessions().length,
  };
}

const me = { name: "Sean", email: "sean@example.com" };

function teamBody() {
  const now = Date.now();
  if (scenario === "empty") {
    return {
      me,
      people: [
        { ...me, online: true, counts: { working: 0, waiting: 0, idle: 0 } },
        { name: "An", email: "an@example.com", github: "an-b3", online: false, counts: { working: 0, waiting: 0, idle: 0 } },
        { name: "Mitch", email: "mitch@example.com", online: false, counts: { working: 0, waiting: 0, idle: 0 } },
      ],
      needsMe: [],
      sessions: [],
      serverNow: now,
    };
  }
  return {
    me,
    people: [
      { ...me, online: true, counts: { working: 1, waiting: 2, idle: 0 } },
      // an-b3 is not a GitHub account: the initials fallback shows.
      { name: "An", email: "an@example.com", github: "an-b3", online: true, counts: { working: 2, waiting: 0, idle: 1 } },
      // GitHub's own demo account, so the avatar path shows a real image.
      { name: "Gio", email: "gio@example.com", github: "octocat", online: true, counts: { working: 0, waiting: 1, idle: 0 } },
      { name: "Mitch", email: "mitch@example.com", online: false, counts: { working: 0, waiting: 0, idle: 0 } },
    ],
    needsMe: [
      {
        session: `${THIS_DEVICE}:${localWaiting.key}`,
        reason: "Approve the deploy to workmesh.b3os.org",
        since: localWaiting.stateSince,
        name: "documents-07",
        source: "claude-code",
        repo: "b3-fun/workmesh",
        owner: "Sean",
      },
      {
        session: `${OTHER_DEVICE}:codex:019a6b11-0c2d-7e3f-a410-5b6c7d8e9f01`,
        reason: "Pick a name for the migration",
        since: ago(9),
        name: "codex-4",
        source: "codex",
        repo: "b3-fun/b3os",
        owner: "Sean",
      },
    ],
    sessions: [
      // Mine (the menu shows them through /state and needsMe, not the team list).
      { key: `${THIS_DEVICE}:${localWaiting.key}`, owner: "Sean", name: "documents-07", source: "claude-code", state: "waiting", now: "Approve the deploy to workmesh.b3os.org", repo: "b3-fun/workmesh", branch: "relay-v06", subagents: 0, stateSince: localWaiting.stateSince },
      { key: `${THIS_DEVICE}:${localWorking.key}`, owner: "Sean", name: "codex-1", source: "codex", state: "working", now: "Running tests", repo: "b3-fun/workmesh", branch: "relay-v06", subagents: 2, stateSince: localWorking.stateSince },
      // An
      { key: "dev_01JMOCKAN:codex:019a7d00-1111-7aaa-8bbb-ccccdddd0001", owner: "An", name: "codex-3", source: "codex", state: "working", now: "Fixing the ingest test", repo: "b3-fun/workmesh", branch: "main", subagents: 2, stateSince: ago(23) },
      { key: "dev_01JMOCKAN:claude-code:6a1b2c3d-0000-4000-8000-00000000a002", owner: "An", name: "spec-team-view", source: "claude-code", state: "working", now: "Writing the SPEC section on team reads", repo: "b3-fun/workmesh", branch: "spec-team", subagents: 0, stateSince: ago(6) },
      { key: "dev_01JMOCKAN:claude-code:6a1b2c3d-0000-4000-8000-00000000a003", owner: "An", name: "b3iq-fleet", source: "claude-code", state: "idle", now: "Done: PR opened", repo: "b3-fun/b3iq", branch: "fleet-ops", subagents: 0, stateSince: ago(41) },
      { key: "dev_01JMOCKAN:claude-code:6a1b2c3d-0000-4000-8000-00000000a004", owner: "An", name: "old-run", source: "claude-code", state: "ended", repo: "b3-fun/b3iq", subagents: 0, stateSince: ago(180) },
      // Gio
      { key: "dev_01JMOCKGIO:claude-code:7b2c3d4e-0000-4000-8000-00000000b001", owner: "Gio", name: "stake-revival", source: "claude-code", state: "waiting", now: "Needs a reviewer on the farm cutoff", repo: "b3-fun/stake", branch: "farm-cutoff", subagents: 0, stateSince: ago(15) },
      // Mitch (offline: the hub still lists his last session)
      { key: "dev_01JMOCKMITCH:codex:019a5000-2222-7aaa-8bbb-ccccdddd0009", owner: "Mitch", name: "codex-2", source: "codex", state: "offline", now: "Refactoring the payout job", repo: "b3-fun/b3iq", branch: "payouts", subagents: 0, stateSince: ago(130) },
    ],
    serverNow: now,
  };
}

function team(open) {
  if (scenario === "unpaired") return { enabled: false };
  const base = {
    enabled: true,
    hubUrl: HUB,
    boardUrl: HUB,
    hubName: "B3",
    deviceId: THIS_DEVICE,
    share: "conversation",
    connected: scenario !== "halted",
    halted: scenario === "halted",
    pollMs: open ? 15_000 : 60_000,
  };
  if (scenario === "halted") return { ...base, available: null, error: "hub rejected the device token (401)" };
  if (scenario === "noteam") return { ...base, available: false, fetchedAt: Date.now() - 1_000 };
  return { ...base, available: true, fetchedAt: Date.now() - 1_000, team: teamBody() };
}

// ---------------------------------------------------------------- server

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = req.method ?? "GET";
  if (method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, pid: process.pid, uptimeSec: Math.round((Date.now() - T0) / 1000), mock: scenario });
  }
  if (req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { ok: false, error: "unauthorized" });
  if (method === "GET" && url.pathname === "/state") return send(res, 200, state());
  if (method === "GET" && url.pathname === "/config") return send(res, 200, config);
  if (method === "GET" && url.pathname === "/hub") return send(res, 200, hub());
  if (method === "GET" && url.pathname === "/team") {
    if (scenario === "legacy") return send(res, 404, { ok: false, error: "not found" });
    const open = url.searchParams.get("open") === "1";
    if (process.env.MOCK_DAEMON_VERBOSE) console.log(`GET /team${open ? " (menu open)" : ""}`);
    return send(res, 200, team(open));
  }
  if (method === "POST" && url.pathname === "/config") return send(res, 200, config);
  if (method === "POST" && ["/pause", "/resume", "/sessions/dismiss", "/hub/reload"].includes(url.pathname)) {
    req.resume();
    return send(res, 200, { ok: true });
  }
  send(res, 404, { ok: false, error: "not found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-daemon: ${scenario} on http://127.0.0.1:${port} (secret in ${join(stateHome, "workmesh", "daemon.secret")})`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));

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
// view), legacy (a daemon from before GET /team: 404), coord (team plus v1: a hold on
// one of this Mac's agents and a message waiting for another), delegate (team plus
// v2: handoffs offered to me or running here, and approvals; POST /coord/op answers
// them, so Accept, Decline, Approve and Deny work against the mock; h_1 has a long
// task and a context, h_3 is short and can't run on this Mac).
//
// GET /update: legacy answers 404 (an older daemon), the scenarios above "up to
// date". The update scenarios are team plus a newer release:
//   update          `workmesh update` can run here; `run` is scripts/mock-update.mjs,
//                   which prints for a few seconds, exits 0 and restarts this mock
//                   (down 3 s, new secret), after which /update says it's current
//   update-fail     the same, but the run fails and rolls back (exit 1)
//   update-git      a git checkout: no run, a hint with a command to copy
//   update-menubar  the CLI is current, only the menu bar app is behind
// Release options: --current 0.12.0 --latest 0.12.1 --menubar-version <latest>,
// --menubar-zip <path> (served at /mock/Workmesh-menubar-macos.zip with its real
// SHA-256; without it a placeholder that won't unpack), --menubar-sha256 <hex>
// (announce another digest: the tampered-download test).
//
// It writes <XDG_STATE_HOME>/workmesh/daemon.secret and
// <XDG_CONFIG_HOME>/workmesh/config.json ({"port": ...}) so the app finds it.
// Both variables are required and must not be the real ~/.config or
// ~/.local/state: this never touches a live install. Plain Node, no deps.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(arg("port", "45190"));
const scenario = arg("scenario", "team");
const UPDATE_SCENARIOS = ["update", "update-fail", "update-git", "update-menubar"];
const SCENARIOS = ["team", "coord", "delegate", "empty", "unpaired", "halted", "noteam", "legacy", ...UPDATE_SCENARIOS];
const CURRENT = arg("current", "0.12.0");
const LATEST = arg("latest", "0.12.1");
const MENUBAR_VERSION = arg("menubar-version", LATEST);
const MENUBAR_ZIP = arg("menubar-zip", "");
const MENUBAR_SHA = arg("menubar-sha256", "");

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

let secret = randomBytes(24).toString("hex");
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

// v2 (scenario delegate): changed by POST /coord/op, like the real daemon after its hub call.
const delegate = {
  available: true,
  // `task` and `context` are the whole text; `onAccept` is the daemon's line about what Accept starts here.
  handoffs: [
    {
      id: "h_1",
      from: "An",
      fromSession: "b3iq-strategy",
      task: "Port the KEK rotation to the vault service: rotate behind the new key-id header, keep the old key readable for a week, and open a PR against main.\n\nSteps:\n1. Add the key-id header to the vault client.\n2. Rotate the key in staging and check that last week's records still decrypt.\n3. Write the runbook page for the rotation.",
      context: "Start from PR 212, which adds the header on the server side. The staging key lives in the vault under kek/staging. Ask Gio before you touch the stake service: it reads the same key.",
      onAccept: { agent: "claude", permissionMode: "auto", text: "Starts a Claude Code agent on this Mac in auto mode, in a new worktree of b3-fun/b3os-beta." },
      repo: "b3-fun/b3os-beta",
      issue: "B3-7168",
      status: "offered",
      createdAt: ago(6),
      runningHere: false,
    },
    {
      id: "h_3",
      from: "Mitch",
      task: "Bump the lockfile and rerun CI",
      onAccept: { text: "This Mac can't run it: no checkout of b3-fun/b3iq here (`workmesh roots add <dir>` names where your repos live)." },
      repo: "b3-fun/b3iq",
      status: "offered",
      createdAt: ago(2),
      runningHere: false,
    },
    { id: "h_2", from: "Gio", task: "Move the stake API to the new farm cutoff and redeploy staging", context: "The cutoff is block 21,400,000.", repo: "b3-fun/stake", status: "started", createdAt: ago(25), runningHere: true },
  ],
  approvals: [
    { id: "ap_1", session: localWaiting.key, name: localWaiting.name, gate: "merge", detail: "gh pr merge 212 --merge in b3-fun/b3os-beta", status: "pending", ts: ago(3), mine: true, canDecide: true },
    { id: "ap_2", gate: "deploy", detail: "wrangler deploy in b3-fun/stake", status: "pending", ts: ago(8), mine: false, canDecide: true },
    { id: "ap_3", session: localWorking.key, name: localWorking.name, gate: "publish", detail: "npm publish in b3-fun/workmesh", status: "pending", ts: ago(1), mine: true, canDecide: false },
  ],
};

function coordOp(body) {
  const { op, args = {} } = body ?? {};
  const { action, id } = args;
  if (op === "handoffs" && (action === "accept" || action === "decline")) {
    const i = delegate.handoffs.findIndex((h) => h.id === id && h.status === "offered");
    if (i < 0) return { ok: false, text: `Workmesh: handoff ${id} isn't offered to you` };
    if (action === "decline") {
      delegate.handoffs.splice(i, 1);
      return { ok: true, text: `Declined ${id}.` };
    }
    Object.assign(delegate.handoffs[i], { status: "accepted", runningHere: true });
    return { ok: true, text: `Accepted ${id}: this machine starts an agent for it.` };
  }
  if (op === "approvals" && (action === "approve" || action === "deny")) {
    const i = delegate.approvals.findIndex((a) => a.id === id && a.canDecide);
    if (i < 0) return { ok: false, text: `Workmesh: no pending approval ${id} for you` };
    const [a] = delegate.approvals.splice(i, 1);
    return { ok: true, text: `${action === "approve" ? "Approved" : "Denied"}: ${a.detail}.` };
  }
  return { ok: false, text: `mock-daemon: ${op} ${action ?? ""} isn't mocked` };
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
  const out = { ...base, available: true, fetchedAt: Date.now() - 1_000, team: teamBody() };
  // v1: a hold on one of this Mac's agents and messages waiting for them.
  if (scenario === "coord") {
    out.coord = {
      available: true,
      holds: [{ session: localWorking.key, name: localWorking.name, by: "An", reason: "reworking the cell layout", since: Date.now() - 4 * 60_000 }],
      unread: [
        { id: "m1", session: localWaiting.key, name: localWaiting.name, from: "An", fromSession: "b3iq-strategy", text: "I have packages/cli/src/hub leased for the forwarder rework; can you take the CLI side?", ts: Date.now() - 2 * 60_000, delivered: false },
      ],
    };
  }
  if (scenario === "delegate") out.delegate = delegate;
  return out;
}

// GET /update. The menu bar zip comes from --menubar-zip (or a placeholder).
const updateResultPath = join(stateHome, "workmesh", "mock-update-result.json");
rmSync(updateResultPath, { force: true });
if (MENUBAR_ZIP && !existsSync(MENUBAR_ZIP)) die(`--menubar-zip ${MENUBAR_ZIP} doesn't exist`);
const menubarZip = MENUBAR_ZIP ? readFileSync(MENUBAR_ZIP) : Buffer.from("not a zip: start the mock with --menubar-zip <Workmesh-menubar-macos.zip>\n");
const menubarSha = MENUBAR_SHA || createHash("sha256").update(menubarZip).digest("hex");
const mockUpdate = join(dirname(fileURLToPath(import.meta.url)), "mock-update.mjs");

function update() {
  const result = existsSync(updateResultPath) ? JSON.parse(readFileSync(updateResultPath, "utf8")) : null;
  const updated = result?.ok === true;
  const current = scenario === "update-menubar" || updated ? LATEST : CURRENT;
  const base = {
    current,
    latest: UPDATE_SCENARIOS.includes(scenario) ? LATEST : current,
    available: false,
    checkedAt: T0 - 5 * 60_000,
    source: "npm",
    install: { method: "npm", canUpdate: true },
    run: [process.execPath, mockUpdate, "update"],
    auto: { enabled: true, scope: "patch" },
  };
  if (!UPDATE_SCENARIOS.includes(scenario)) return base;
  const out = {
    ...base,
    source: "hub",
    available: scenario !== "update-menubar" && !updated,
    run: [process.execPath, mockUpdate, "update", "--from", CURRENT, "--to", LATEST, ...(scenario === "update-fail" ? ["--fail"] : [])],
    menubar: {
      version: MENUBAR_VERSION,
      url: `http://127.0.0.1:${port}/mock/Workmesh-menubar-macos.zip`,
      sha256: menubarSha,
      size: menubarZip.length,
      releaseUrl: `https://github.com/b3-fun/workmesh/releases/tag/v${MENUBAR_VERSION}`,
    },
  };
  if (scenario === "update-git") {
    out.install = {
      method: "git",
      canUpdate: false,
      hint: "This Workmesh runs from a git checkout at ~/src/workmesh: pull and build it there, then run `workmesh update`.",
    };
    delete out.run;
  }
  if (result) out.last = { at: result.at, ok: result.ok, from: result.from, to: result.to, rolledBack: result.rolledBack, message: result.message };
  return out;
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
  // Like a GitHub release asset: no daemon secret.
  if (method === "GET" && url.pathname === "/mock/Workmesh-menubar-macos.zip") {
    if (process.env.MOCK_DAEMON_VERBOSE) console.log(`GET ${url.pathname} (${menubarZip.length} bytes)`);
    res.writeHead(200, { "content-type": "application/zip", "content-length": menubarZip.length });
    return res.end(menubarZip);
  }
  if (req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { ok: false, error: "unauthorized" });
  if (method === "GET" && url.pathname === "/update") {
    if (scenario === "legacy") return send(res, 404, { ok: false, error: "not found" });
    const body = update();
    if (process.env.MOCK_DAEMON_VERBOSE) console.log(`GET /update -> current ${body.current}, available ${body.available}${body.menubar ? `, menubar ${body.menubar.version}` : ""}`);
    return send(res, 200, body);
  }
  // mock-update.mjs, at the end of a good run: go away like a restarting daemon.
  if (method === "POST" && url.pathname === "/mock/restart") {
    req.resume();
    send(res, 200, { ok: true });
    setTimeout(restart, 50);
    return;
  }
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
  if (method === "POST" && url.pathname === "/coord/op") {
    if (scenario !== "delegate") {
      req.resume();
      return send(res, 404, { ok: false, error: "not found" });
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { ok: false, error: "bad json" });
      }
      const answer = coordOp(body);
      if (process.env.MOCK_DAEMON_VERBOSE) console.log(`POST /coord/op ${body.op} ${JSON.stringify(body.args)} -> ${answer.ok ? "ok" : answer.text}`);
      send(res, 200, answer);
    });
    return;
  }
  if (method === "POST" && ["/pause", "/resume", "/sessions/dismiss", "/hub/reload"].includes(url.pathname)) {
    req.resume();
    return send(res, 200, { ok: true });
  }
  send(res, 404, { ok: false, error: "not found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-daemon: ${scenario} on http://127.0.0.1:${port} (secret in ${join(stateHome, "workmesh", "daemon.secret")})`);
});

// Down for 3 s, then back on a new secret, as the real daemon is after an update.
function restart() {
  console.log("mock-daemon: restarting (down 3 s, new secret)");
  server.close();
  server.closeAllConnections();
  setTimeout(() => {
    secret = randomBytes(24).toString("hex");
    writeFileSync(join(stateHome, "workmesh", "daemon.secret"), secret + "\n", { mode: 0o600 });
    server.listen(port, "127.0.0.1", () => console.log("mock-daemon: back"));
  }, 3000);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));

// Fake relay: pairs synthetic machines for Sean, An and Gio (conversation level) and Mitch (metadata only) and streams
// scripted sessions: prompts, multi-paragraph agent messages, tool calls, waits and turn ends, so the board and the
// conversation view can be judged with data. Everything it sends is made up; machine names start with "fake-".
//
//   node scripts/fake-relay.ts                       # against wrangler dev on :8787, auto-approves as each person
//   node scripts/fake-relay.ts --url https://...     # elsewhere: prints the verify URL and waits for a person
//   node scripts/fake-relay.ts --minutes 5           # stop after five minutes (default: run until Ctrl-C)
//   node scripts/fake-relay.ts --fast                # shorter gaps between steps
//
// Auto-approve uses the dev-only X-Dev-User-Email header, which the Worker honours only when DEV_USER_EMAIL is set
// outside production.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { HubActivityEvent, HubIngestRequest, HubSessionUpsert } from "@workmesh/protocol";
import type { SessionState, ShareLevel } from "../src/shared/types.ts";

const { values: opts } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8787" },
    minutes: { type: "string", default: "0" },
    approve: { type: "boolean" },
    quiet: { type: "boolean", default: false },
    fast: { type: "boolean", default: false },
  },
});

const BASE = opts.url!.replace(/\/$/, "");
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE);
const AUTO_APPROVE = opts.approve ?? LOCAL;
const CACHE = ".wrangler/fake-relay.json";
const SPEED = opts.fast ? 0.35 : 1;
const log = (...a: unknown[]) => opts.quiet || console.log(...a);

type Repo = "b3-fun/b3os-beta" | "b3-fun/b3iq" | "b3-fun/bullpen";

/** What the fake relay sends, typed by the wire protocol it shares with the real relay. */
interface Upsert extends HubSessionUpsert {
  name: string;
  repo: Repo;
  branch: string;
  issues: string[];
}

type Ev = HubActivityEvent;

// --------------------------------------------------------------------------- scripts

type Step =
  | { k: "prompt"; text: string }
  | { k: "message"; text: string }
  | { k: "tool"; tool: string; desc?: string; path?: string; cmd?: string; ok?: boolean; pr?: boolean; label: string }
  | { k: "wait"; label: string }
  | { k: "turn" };

const P = (text: string): Step => ({ k: "prompt", text });
const M = (...paras: string[]): Step => ({ k: "message", text: paras.join("\n\n") });
const T: Step = { k: "turn" };
const W = (label: string): Step => ({ k: "wait", label });
const base = (p: string) => p.split("/").pop()!;

/** Tool helpers; `codex` switches to Codex's tool names. */
function tools(codex: boolean) {
  return {
    sh: (cmd: string | undefined, desc: string, ok = true, pr = false): Step => ({
      k: "tool",
      tool: codex ? "shell" : "Bash",
      cmd,
      desc,
      ok,
      pr,
      label: cmd ? `running ${cmd}` : "running commands",
    }),
    edit: (path: string): Step => ({ k: "tool", tool: codex ? "apply_patch" : "Edit", path, label: `editing ${base(path)}` }),
    write: (path: string): Step => ({ k: "tool", tool: codex ? "apply_patch" : "Write", path, label: `writing ${base(path)}` }),
    read: (path: string): Step => ({ k: "tool", tool: codex ? "shell" : "Read", path: codex ? undefined : path, label: "reading files" }),
    grep: (desc: string): Step => ({ k: "tool", tool: codex ? "shell" : "Grep", desc, label: "searching" }),
    mcp: (server: string, tool: string, desc: string): Step => ({ k: "tool", tool: `mcp__${server}__${tool}`, desc: `${server} · ${tool}${desc ? ` · ${desc}` : ""}`, label: `using ${server}` }),
    agent: (desc: string): Step => ({ k: "tool", tool: "Agent", desc, label: "running agents" }),
    todo: (): Step => ({ k: "tool", tool: "TodoWrite", label: "planning" }),
    web: (desc: string): Step => ({ k: "tool", tool: "WebSearch", desc, label: "searching the web" }),
  };
}

const cc = tools(false);
const cx = tools(true);

const SCRIPTS: Record<string, Step[][]> = {
  "bullpen-hub": [
    [
      P("The board needs summaries. Use a small model to write a one-line \"now\" for each session and a summary per turn, off the ingest path. Workers AI until we have a key."),
      cc.todo(),
      cc.read("SPEC.md"),
      cc.read("src/worker/project.ts"),
      M(
        "Plan, in the order I'll land it:",
        "1. A `summary_jobs` table in the Durable Object, one row per session, so a burst of events becomes one job.\n2. The DO's alarm runs due jobs; ingest only records the trigger, so its latency doesn't move.\n3. Providers behind one interface: OpenRouter when `OPENROUTER_API_KEY` is set, Workers AI otherwise.",
        "Guards: 10 s between calls per session, skip when nothing is new, and a **daily cap** of 3,000 calls.",
      ),
      cc.write("src/worker/summaries/policy.ts"),
      cc.write("src/worker/summaries/prompts.ts"),
      cc.edit("src/worker/project.ts"),
      cc.edit("src/worker/project.ts"),
      cc.sh("pnpm typecheck", "Typecheck the worker and the board"),
      cc.sh("pnpm test", "Run the test suite", false),
      M(
        "One failure: `activityBlock` put the ellipsis before the prompt once the lines were reversed.",
        "```ts\nif (first && i > 0) lines.push(\"…\", first);\n```",
        "Fixed and re-running.",
      ),
      cc.edit("src/worker/summaries/prompts.ts"),
      cc.sh("pnpm test", "Run the test suite"),
      M("All 98 tests pass. The queue, both providers and the digest are in; the board still shows the activity label until a now line lands."),
      T,
    ],
    [
      P("Now the conversation view: prompts, the agent's messages, folded tool calls like Claude Code's \"Ran 2 shell commands\", and the turn summary at the end."),
      cc.read("src/board/components/LiveTail.tsx"),
      cc.write("src/board/lib/transcript.ts"),
      cc.write("src/board/lib/markdown.ts"),
      cc.write("src/board/components/Conversation.tsx"),
      cc.sh("pnpm build", "Build the board"),
      cc.mcp("claude-in-chrome", "navigate", "localhost:8787"),
      cc.mcp("claude-in-chrome", "computer", "screenshot"),
      M(
        "The view renders. Two things I changed after looking at it:",
        "- Tool calls fold into one line per run and expand to each call's tool, description and path.\n- The view follows the bottom only while you're there; scroll up and a **New activity** button appears instead.",
      ),
      cc.sh("git push", "Push to main"),
      T,
    ],
  ],
  "documents-07": [
    [
      P("Bring n2 up from the runbook in docs/n2-bringup.md. Fan out: one agent per crate, then a build and boot check."),
      cc.agent("Audit b3os-sandboxes for the n2 boot path"),
      cc.agent("Audit b3os-node scheduler config for n2"),
      cc.agent("Check vault KEK wiring on n2"),
      M(
        "Three audits are back. The blockers:",
        "- `crates/b3os-sandboxes/src/spec.rs` still pins the n1 kernel image.\n- The scheduler reads `NODE_POOL` but n2's unit file sets `B3OS_NODE_POOL`.",
        "The vault side is fine.",
      ),
      cc.edit("crates/b3os-sandboxes/src/spec.rs"),
      cc.edit("crates/b3os-node/src/scheduler.rs"),
      cc.sh("cargo build", "Build the workspace in release mode"),
      cc.sh("cargo test", "Run the sandbox boot tests"),
      M("Build is clean and the boot tests pass on n2's kernel. Next: deploy the node unit and watch the first sandbox boot."),
      T,
    ],
    [
      P("Deploy it and watch the first boot."),
      cc.sh("just bench", "Boot 20 sandboxes on n2 and time them"),
      cc.read("docs/n2-bringup.md"),
      M("20 of 20 sandboxes booted; p50 **412 ms**, p95 640 ms. That's within 5 % of n1."),
      cc.edit("docs/n2-bringup.md"),
      T,
    ],
  ],
  "n2-docs": [
    [
      P("Write the n2 bring-up doc from what documents-07 did today."),
      cx.read("docs/n2-bringup.md"),
      cx.sh(undefined, "Read the session notes"),
      cx.edit("docs/n2-bringup.md"),
      M(
        "Drafted the bring-up steps through the first sandbox boot.",
        "One question before I go on: the KEK rotation steps exist in two places, `crates/b3os-vault/README.md` and the old n1 doc. Should n2's doc **link** to the vault README, or **copy** the steps so the runbook stands alone?",
      ),
      W("question about scope"),
    ],
  ],
  "fleet-agent": [
    [
      P("Move the fleet agent's #oncall placement out of shadow mode for disk alerts only."),
      cc.grep("shadowMode"),
      cc.read("fleet-ops/src/agent.ts"),
      cc.edit("fleet-ops/src/agent.ts"),
      cc.edit("fleet-ops/src/slack.ts"),
      cc.sh("pnpm test", "Run fleet-ops tests"),
      cc.sh("gh pr create", "Open the PR", true, true),
      M("Disk alerts now post to #oncall for real; everything else stays in shadow. PR is open and CI is green."),
      T,
    ],
  ],
  "k8s-sandbox": [
    [
      P("Get the k8s sandbox boot test passing on the virtio mount branch."),
      cx.sh("cargo test", "Run the k8s sandbox tests", false),
      M(
        "`boot_with_virtio_mount` fails: the guest sees the mount as read-only.",
        "The pod spec sets `readOnly: true` on the shared volume, left over from the hardening pass. The sandbox needs it writable for `/work`.",
      ),
      cx.read("deploy/k8s/sandbox.yaml"),
      cx.edit("deploy/k8s/sandbox.yaml"),
      cx.sh("cargo test", "Run the k8s sandbox tests"),
      M("Passing now. I kept `/etc` read-only and only made `/work` writable."),
      cx.sh("git push", "Push the branch"),
      T,
    ],
    [
      P("Open a PR and ask Sean for review."),
      cx.sh("gh pr create", "Open the PR", true, true),
      M("PR is up with the test output in the description."),
      T,
    ],
  ],
  "cell-layout": [
    [
      P("Redo the cell layout so the workcell grid reflows at 400 px. Plan first."),
      cc.read("apps/web/src/pages/index.tsx"),
      cc.grep("gridTemplateColumns"),
      M(
        "Here's the plan:",
        "1. Replace the fixed 4-column grid with `repeat(auto-fill, minmax(11rem, 1fr))`.\n2. Move the cell toolbar under the title below 640 px.\n3. Drop the hover-only actions on touch; show them in a menu instead.",
        "This touches 6 files and changes the toolbar markup that the e2e tests select on. OK to go ahead?",
      ),
      W("approve plan"),
    ],
  ],
  "offtake-payouts": [
    [
      P("The payout request webhook fires twice when an offtake earning is backfilled. Find out why and fix it."),
      cc.grep("payoutRequested"),
      cc.read("packages/db/src/offtake.ts"),
      cc.read("apps/admin/src/routes/payouts.tsx"),
      M(
        "Found it. Backfill inserts the earning and then calls `markPayable`, and **both** paths emit `payoutRequested`.",
        "The fix is to emit only from `markPayable` and make it idempotent on `(earningId, period)`.",
      ),
      cc.edit("packages/db/src/offtake.ts"),
      cc.write("packages/db/migrations/0042_offtake.sql"),
      cc.sh("pnpm test", "Run db tests"),
      cc.sh("pnpm typecheck", "Typecheck"),
      M("One webhook per earning now, and a unique index backs it. Tests pass."),
      T,
    ],
  ],
  "admin-tables": [
    [
      P("The payouts table in the admin console janks with 5,000 rows. Virtualize it, keep sticky headers."),
      cc.read("apps/admin/src/components/DataTable.tsx"),
      cc.web("tanstack virtual sticky header table"),
      M(
        "I'll use `@tanstack/react-virtual` with a fixed row height of 36 px; the header stays a real `<thead>` with `position: sticky`, so screen readers still see a table.",
      ),
      cc.edit("apps/admin/src/components/DataTable.tsx"),
      cc.edit("apps/admin/src/routes/payouts.tsx"),
      cc.sh("pnpm build", "Build the admin app"),
      cc.mcp("claude-in-chrome", "navigate", "admin payouts"),
      cc.mcp("claude-in-chrome", "computer", "scroll test"),
      M("Scrolling 5,000 rows holds 60 fps in the trace; the header stays put and row heights don't jump."),
      T,
    ],
  ],
  "board-dark-mode": [
    [
      P("Check the board's dark theme against the B3 tokens and fix anything off."),
      cx.read("src/board/styles.css"),
      cx.edit("src/board/styles.css"),
      cx.sh("pnpm build", "Build the board"),
      M("Two tokens were off: `--line` was too faint on `#111113`, and the waiting amber failed contrast. Both fixed."),
      T,
    ],
  ],
  "payout-export": [
    [
      P("(metadata only)"),
      cc.read("apps/admin/src/routes/payouts.tsx"),
      cc.grep("exportCsv"),
      cc.edit("apps/admin/src/routes/payouts.tsx"),
      cc.write("apps/admin/src/lib/csv.ts"),
      cc.sh("pnpm test", "Run tests", false),
      cc.edit("apps/admin/src/lib/csv.ts"),
      cc.sh("pnpm test", "Run tests"),
      T,
    ],
  ],
  "vault-kek": [[P("Rotate the n1 KEK on the staging vault."), cc.read("crates/b3os-vault/src/kek.rs"), cc.sh("cargo test", "Run vault tests"), T]],
  "chat-v0": [[P("Ship chat v0 behind the flag."), cc.edit("apps/web/src/pages/index.tsx"), cc.sh("gh pr create", "Open the PR", true, true), M("Shipped behind `chat_v0`."), T]],
};

// --------------------------------------------------------------------------- people

interface Sim {
  s: Upsert;
  script: Step[][];
  turn: number;
  step: number;
  nextAt: number;
  turnStart: number;
  /** Stays where it is: waiting, idle or ended, so the board always has one of each. */
  pinned?: boolean;
}

interface Person {
  email: string;
  machine: string;
  share: ShareLevel;
  sims: Sim[];
  /** Sends one batch and goes quiet, so its sessions turn offline after two minutes. */
  oneShot?: boolean;
}

let prCounter = 212;
let evCounter = 0;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

function sim(
  key: string,
  name: string,
  repo: Repo,
  branch: string,
  issues: string[],
  state: SessionState,
  over: Partial<Upsert> & { startedMin?: number; pinned?: boolean } = {},
): Sim {
  const now = Date.now();
  const { startedMin = 40, pinned, ...rest } = over;
  return {
    s: {
      key,
      source: key.split(":")[0]!,
      name,
      state,
      activity: state === "waiting" ? "needs my input" : state === "idle" ? "idle" : "thinking",
      repo,
      branch,
      issues,
      startedAt: Math.round(now - startedMin * 60_000),
      updatedAt: now,
      stateSince: now,
      ...rest,
    },
    script: SCRIPTS[name] ?? [],
    turn: 0,
    step: 0,
    nextAt: 0,
    turnStart: 0,
    pinned,
  };
}

const PEOPLE: Person[] = [
  {
    email: "sean@npclabs.org",
    machine: "fake-sean-studio",
    share: "conversation",
    sims: [
      sim("claude-code:0b7d44e1", "bullpen-hub", "b3-fun/bullpen", "main", ["B3-7166"], "working", { startedMin: 52 }),
      sim("claude-code:5f1c9e2a", "documents-07", "b3-fun/b3os-beta", "feat/n2-bringup", ["B3-7012"], "working", { agents: 6, phase: "build", startedMin: 94 }),
      sim("codex:019a6c3f", "n2-docs", "b3-fun/b3os-beta", "docs/n2", ["B3-7015"], "waiting", { pinned: true, startedMin: 20 }),
      sim("claude-code:7e2a0c91", "fleet-agent", "b3-fun/b3iq", "fleet/oncall-shadow", ["B3-7140"], "idle", { pinned: true, startedMin: 70 }),
    ],
  },
  {
    email: "an@npclabs.org",
    machine: "fake-an-laptop",
    share: "conversation",
    sims: [
      sim("codex:019a5d10", "k8s-sandbox", "b3-fun/b3os-beta", "feat/k8s-sandboxes", ["B3-7031"], "working", { startedMin: 41 }),
      sim("claude-code:c4a1f803", "cell-layout", "b3-fun/b3os-beta", "feat/cell-layout", ["B3-7044"], "waiting", { pinned: true, startedMin: 15 }),
      sim("claude-code:9d03b6e7", "offtake-payouts", "b3-fun/b3iq", "fix/payout-request", ["B3-7101"], "working", { startedMin: 23 }),
    ],
  },
  {
    email: "gio@npclabs.org",
    machine: "fake-gio-mbp",
    share: "conversation",
    sims: [
      sim("claude-code:3a8e1d55", "admin-tables", "b3-fun/b3iq", "feat/admin-tables", ["B3-7120", "B3-7121"], "working", { startedMin: 66 }),
      sim("codex:019a7b22", "board-dark-mode", "b3-fun/bullpen", "feat/board-dark", ["B3-7166"], "working", { background: true, startedMin: 12 }),
      sim("claude-code:e61f0a4b", "chat-v0", "b3-fun/b3iq", "feat/chat-v0", ["B3-7052"], "ended", { pinned: true, startedMin: 120 }),
    ],
  },
  {
    email: "mitch@npclabs.org",
    machine: "fake-mitch-mbp",
    share: "metadata",
    sims: [sim("claude-code:51c0ffee", "payout-export", "b3-fun/b3iq", "feat/payout-export", ["B3-7133"], "working", { startedMin: 18 })],
  },
  {
    email: "sean@npclabs.org",
    machine: "fake-sean-laptop",
    share: "conversation",
    oneShot: true,
    sims: [sim("claude-code:aa41c7d0", "vault-kek", "b3-fun/b3os-beta", "fix/kek-rotation", ["B3-7088"], "working", { pinned: true, startedMin: 30 })],
  },
];

// --------------------------------------------------------------------------- playback

function nextId(prefix: string) {
  return `${prefix}-${(++evCounter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** What a relay at this level sends for a step (SPEC.md §8: metadata relays send no text). */
function toEvent(p: Person, x: Sim, step: Step, ts: number, prefix: string): Ev {
  const s = x.s;
  const ev: Ev = { id: nextId(prefix), key: s.key, ts, kind: "tool", repo: s.repo, branch: s.branch };
  const text = p.share === "conversation";
  switch (step.k) {
    case "prompt":
      return { ...ev, kind: "prompt", issues: s.issues, ...(text ? { text: step.text } : {}) };
    case "message":
      return { ...ev, kind: "message", ...(text ? { text: step.text } : {}) };
    case "wait":
      return { ...ev, kind: "waiting", label: step.label };
    case "turn":
      return { ...ev, kind: "turn", durationMs: Math.round(ts - x.turnStart) };
    case "tool": {
      const out: Ev = { ...ev, tool: step.tool, label: step.label };
      if (step.path) out.path = step.path;
      if (step.cmd) out.cmd = step.cmd;
      if (step.ok !== undefined && (step.cmd || step.tool === "Bash" || step.tool === "shell")) out.ok = step.ok;
      if (text && step.desc) out.desc = step.desc;
      if (step.pr) {
        out.pr = `https://github.com/${s.repo}/pull/${++prCounter}`;
        out.issues = s.issues;
      }
      return out;
    }
  }
}

function gapAfter(step: Step): number {
  const k = step.k === "message" ? rand(5, 11) : step.k === "prompt" ? rand(2, 4) : rand(2, 7);
  return k * 1000 * SPEED;
}

/** Plays one step: returns its event and applies its effect on the session. */
function play(p: Person, x: Sim, ts: number, prefix: string): Ev | null {
  const turn = x.script[x.turn % Math.max(1, x.script.length)];
  if (!turn) return null;
  const step = turn[x.step]!;
  const s = x.s;
  if (step.k === "prompt") {
    x.turnStart = ts;
    s.state = "working";
    s.activity = "thinking";
    s.stateSince = ts;
  }
  const ev = toEvent(p, x, step, ts, prefix);
  if (step.k === "tool") s.activity = step.label;
  if (step.k === "message") s.activity = "thinking";
  if (step.k === "wait") {
    s.state = "waiting";
    s.activity = step.label;
    s.stateSince = ts;
  }
  if (step.k === "turn") {
    s.state = "idle";
    s.activity = "idle";
    s.stateSince = ts;
  }
  s.updatedAt = ts;
  x.step++;
  if (x.step >= turn.length) {
    x.turn++;
    x.step = 0;
  }
  return ev;
}

/**
 * History so the board isn't empty on first look: pinned sessions play their whole script, others all but their
 * last turn, spaced over the minutes before now.
 */
function backfill(p: Person, prefix: string): Ev[] {
  const out: Ev[] = [];
  const now = Date.now();
  for (const x of p.sims) {
    const s = x.s;
    const turns = x.pinned ? x.script.length : Math.max(1, x.script.length - 1);
    const steps = x.script.slice(0, turns).reduce((n, t) => n + t.length, 0);
    const finalState = s.state;
    let ts = Math.max(s.startedAt + 5_000, now - steps * 9_000 - turns * 40_000);
    out.push({ id: nextId(prefix), key: s.key, ts: s.startedAt, kind: "start", repo: s.repo, branch: s.branch });
    for (let i = 0; i < steps; i++) {
      const ev = play(p, x, ts, prefix);
      if (ev) out.push(ev);
      const justEnded = x.step === 0;
      ts += justEnded ? rand(25_000, 50_000) : rand(3_000, 12_000);
      ts = Math.min(ts, now - 2_000);
    }
    if (finalState === "ended") {
      s.state = "ended";
      s.activity = undefined;
      out.push({ id: nextId(prefix), key: s.key, ts: Math.min(ts, now - 1_000), kind: "end" });
    }
    if (x.pinned && finalState === "working") {
      s.state = "working";
      s.activity = "running cargo test";
    }
    x.nextAt = now + rand(1_000, 6_000) * SPEED;
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function step(p: Person, x: Sim, now: number, prefix: string): { events: Ev[]; changed: boolean } {
  if (x.pinned || now < x.nextAt || !x.script.length) return { events: [], changed: false };
  const before = `${x.s.state}|${x.s.activity}`;
  const ev = play(p, x, now, prefix);
  const s = x.s;
  // After a turn, idle for a while; after a wait, the person answers within a minute or two.
  const last = ev?.kind;
  x.nextAt =
    now +
    (last === "turn" ? rand(25_000, 70_000) * SPEED : last === "waiting" ? rand(30_000, 90_000) * SPEED : gapAfter(x.script[x.turn % x.script.length]![Math.max(0, x.step - 1)] ?? T));
  if (s.agents && s.state === "working" && Math.random() < 0.1) s.agents = Math.max(2, Math.min(9, s.agents + (Math.random() < 0.5 ? -1 : 1)));
  return { events: ev ? [ev] : [], changed: before !== `${s.state}|${s.activity}` };
}

// --------------------------------------------------------------------------- http

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON (an Access login page, say)
  }
  return { status: res.status, json, headers: res.headers };
}

function loadCache(): Record<string, string> {
  if (!LOCAL) return {};
  try {
    return JSON.parse(readFileSync(CACHE, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(c: Record<string, string>) {
  if (!LOCAL) return;
  mkdirSync(".wrangler", { recursive: true });
  writeFileSync(CACHE, JSON.stringify(c, null, 2), { mode: 0o600 });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pair(p: Person): Promise<string> {
  const start = await post("/relay/pair/start", { machine: p.machine, client: "fake-relay/0.2.0", share: p.share });
  if (start.status !== 200) throw new Error(`pair start for ${p.machine}: HTTP ${start.status} ${JSON.stringify(start.json)}`);
  const { code, deviceId, pollSecret, verifyUrl, expiresInSec } = start.json;
  if (AUTO_APPROVE) {
    const a = await post("/api/pair/approve", { code }, { "x-dev-user-email": p.email });
    if (a.status !== 200) throw new Error(`auto-approve for ${p.machine}: HTTP ${a.status} (is DEV_USER_EMAIL set?)`);
  } else {
    console.log(`\n${p.machine} (${p.email}): approve ${code} at ${verifyUrl}`);
  }
  const deadline = Date.now() + expiresInSec * 1000;
  while (Date.now() < deadline) {
    const r = await post("/relay/pair/poll", { deviceId, pollSecret });
    if (r.status !== 200) throw new Error(`poll for ${p.machine}: HTTP ${r.status}`);
    if (r.json.status === "complete" && r.json.deviceToken) return r.json.deviceToken;
    if (r.json.status === "expired") throw new Error(`pairing for ${p.machine} expired`);
    await sleep(AUTO_APPROVE ? 200 : 3000);
  }
  throw new Error(`pairing for ${p.machine} timed out`);
}

// --------------------------------------------------------------------------- main

async function run() {
  const cache = loadCache();
  const minutes = Number(opts.minutes);
  const stopAt = minutes > 0 ? Date.now() + minutes * 60_000 : Infinity;
  log(`fake relay -> ${BASE}${AUTO_APPROVE ? " (auto-approve)" : ""}`);

  const devices = await Promise.all(
    PEOPLE.map(async (p, i) => {
      const cacheKey = `${BASE} ${p.machine}`;
      let token = cache[cacheKey];
      const prefix = `f${i}${Date.now().toString(36)}`;
      const send = async (body: Omit<HubIngestRequest, "share">) => {
        for (let failures = 0; ; ) {
          let r: Awaited<ReturnType<typeof post>>;
          try {
            r = await post("/relay/ingest", { ...body, share: p.share }, { authorization: `Bearer ${token}` });
          } catch {
            // Hub unreachable: keep the batch and retry, as the real relay does (dedupe makes resends safe).
            if (failures++ === 0) log(`${p.machine}: hub unreachable, retrying`);
            await sleep(Math.min(10_000, 1000 * failures));
            continue;
          }
          if (r.status === 401) {
            log(`${p.machine}: token rejected, pairing again`);
            token = await pair(p);
            cache[cacheKey] = token;
            saveCache(cache);
            continue;
          }
          if (r.status === 429) {
            await sleep(Number(r.headers.get("retry-after") ?? "5") * 1000);
            continue;
          }
          if (r.status !== 200) throw new Error(`${p.machine}: ingest HTTP ${r.status} ${JSON.stringify(r.json)}`);
          return r.json as { accepted: number };
        }
      };
      if (!token) {
        token = await pair(p);
        cache[cacheKey] = token;
        saveCache(cache);
      }
      const history = backfill(p, prefix);
      let accepted = 0;
      for (let k = 0; k < history.length || k === 0; k += 200) {
        const r = await send({ v: 1, sentAt: Date.now(), full: true, sessions: p.sims.map((x) => x.s), events: history.slice(k, k + 200) });
        accepted += r.accepted;
      }
      log(`${p.machine} (${p.email}, ${p.share}): ${p.sims.length} sessions, ${accepted} backfilled events`);
      return { p, send, prefix };
    }),
  );

  let tick = 0;
  for (;;) {
    if (Date.now() > stopAt) break;
    await sleep(1000);
    tick++;
    const now = Date.now();
    await Promise.all(
      devices.map(async ({ p, send, prefix }) => {
        if (p.oneShot) return;
        const events: Ev[] = [];
        const dirty: Upsert[] = [];
        for (const x of p.sims) {
          const r = step(p, x, now, prefix);
          events.push(...r.events);
          if (r.changed || r.events.length) dirty.push(x.s);
        }
        const full = tick % 30 === 0;
        if (!events.length && !dirty.length && !full) return;
        await send({ v: 1, sentAt: now, full, sessions: full ? p.sims.map((x) => x.s) : dirty, events });
      }),
    );
  }
  log("fake relay: done");
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

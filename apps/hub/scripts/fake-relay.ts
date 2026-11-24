// Fake relay: pairs synthetic machines for Sean, An and Gio and streams realistic sessions and tool events,
// so the board can be judged with data. Everything it sends is made up; machine names start with "fake-".
//
//   node scripts/fake-relay.ts                       # against wrangler dev on :8787, auto-approves as each person
//   node scripts/fake-relay.ts --url https://...     # elsewhere: prints the verify URL and waits for a person
//   node scripts/fake-relay.ts --minutes 5           # stop after five minutes (default: run until Ctrl-C)
//
// Auto-approve uses the dev-only X-Dev-User-Email header, which the Worker honours only when DEV_USER_EMAIL is set
// outside production.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { EventKind, SessionState } from "../src/shared/types.ts";

const { values: opts } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8787" },
    minutes: { type: "string", default: "0" },
    approve: { type: "boolean" },
    quiet: { type: "boolean", default: false },
  },
});

const BASE = opts.url!.replace(/\/$/, "");
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE);
const AUTO_APPROVE = opts.approve ?? LOCAL;
const CACHE = ".wrangler/fake-relay.json";
const log = (...a: unknown[]) => opts.quiet || console.log(...a);

type Repo = "b3-fun/b3os-beta" | "b3-fun/b3iq" | "b3-fun/bullpen";

interface Upsert {
  key: string;
  source: string;
  name: string;
  state: SessionState;
  activity?: string;
  background?: boolean;
  agents?: number;
  phase?: string;
  repo: Repo;
  branch: string;
  issues: string[];
  startedAt: number;
  updatedAt: number;
  stateSince: number;
}

interface Ev {
  id: string;
  key: string;
  ts: number;
  kind: EventKind;
  tool?: string;
  label?: string;
  path?: string;
  cmd?: string;
  repo?: string;
  branch?: string;
  issues?: string[];
  pr?: string;
  ok?: boolean;
}

interface Sim {
  s: Upsert;
  /** Stays in its starting state so the board always has something waiting. */
  pinned?: boolean;
  /** Seconds until a waiting/idle session resumes. */
  resumeIn?: number;
}

const PATHS: Record<Repo, string[]> = {
  "b3-fun/b3os-beta": [
    "crates/b3os-sandboxes/src/vm.rs",
    "crates/b3os-sandboxes/src/spec.rs",
    "crates/b3os-sandboxes/tests/boot.rs",
    "crates/b3os-node/src/main.rs",
    "crates/b3os-node/src/scheduler.rs",
    "crates/b3os-vault/src/kek.rs",
    "deploy/k8s/sandbox.yaml",
    "docs/n2-bringup.md",
    "Cargo.toml",
  ],
  "b3-fun/b3iq": [
    "fleet-ops/src/agent.ts",
    "fleet-ops/src/slack.ts",
    "apps/admin/src/routes/payouts.tsx",
    "apps/admin/src/components/DataTable.tsx",
    "packages/db/src/offtake.ts",
    "packages/db/migrations/0042_offtake.sql",
    "apps/web/src/pages/index.tsx",
  ],
  "b3-fun/bullpen": [
    "src/worker/project.ts",
    "src/worker/index.ts",
    "src/board/App.tsx",
    "src/board/components/People.tsx",
    "src/board/components/LiveTail.tsx",
    "test/ingest.test.ts",
    "SPEC.md",
  ],
};

const CMDS: Record<Repo, string[]> = {
  "b3-fun/b3os-beta": ["cargo test", "cargo build", "cargo clippy", "git status", "git diff", "just bench"],
  "b3-fun/b3iq": ["pnpm test", "pnpm typecheck", "pnpm build", "git diff", "git status"],
  "b3-fun/bullpen": ["pnpm test", "pnpm typecheck", "vitest run", "git diff", "wrangler dev"],
};

const WAIT_LABELS = ["needs my input", "approve plan", "permission for Bash", "question about scope"];

let prCounter = 212;
let evCounter = 0;
const rand = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const chance = (p: number) => Math.random() < p;
const base = (p: string) => p.split("/").pop()!;

function session(
  key: string,
  name: string,
  repo: Repo,
  branch: string,
  issues: string[],
  state: SessionState,
  over: Partial<Upsert> & { sinceMin?: number; startedMin?: number } = {},
): Upsert {
  const now = Date.now();
  const { sinceMin = 1, startedMin = 30, ...rest } = over;
  return {
    key,
    source: key.split(":")[0]!,
    name,
    state,
    activity: state === "waiting" ? "needs my input" : state === "idle" ? "idle" : "thinking",
    repo,
    branch,
    issues,
    startedAt: Math.round(now - startedMin * 60_000),
    updatedAt: Math.round(now - sinceMin * 60_000),
    stateSince: Math.round(now - sinceMin * 60_000),
    ...rest,
  };
}

interface Person {
  email: string;
  machine: string;
  sims: Sim[];
  /** Sends one batch and goes quiet, so its sessions turn offline after two minutes. */
  oneShot?: boolean;
}

const PEOPLE: Person[] = [
  {
    email: "sean@npclabs.org",
    machine: "fake-sean-studio",
    sims: [
      {
        s: session("claude-code:5f1c9e2a", "documents-07", "b3-fun/b3os-beta", "feat/n2-bringup", ["B3-7012"], "working", {
          agents: 6,
          phase: "build",
          startedMin: 94,
        }),
      },
      { s: session("claude-code:0b7d44e1", "bullpen-hub", "b3-fun/bullpen", "main", ["B3-7166"], "working", { startedMin: 52 }) },
      {
        s: session("codex:019a6c3f", "n2-docs", "b3-fun/b3os-beta", "docs/n2", ["B3-7015"], "waiting", {
          activity: "needs my input",
          sinceMin: 1.2,
        }),
        pinned: true,
      },
      {
        s: session("claude-code:7e2a0c91", "fleet-agent", "b3-fun/b3iq", "fleet/oncall-shadow", ["B3-7140"], "idle", {
          sinceMin: 14,
          startedMin: 180,
        }),
        pinned: true,
      },
    ],
  },
  {
    email: "an@npclabs.org",
    machine: "fake-an-laptop",
    sims: [
      {
        s: session("codex:019a5d10", "k8s-sandbox", "b3-fun/b3os-beta", "feat/k8s-sandboxes", ["B3-7031"], "working", {
          startedMin: 41,
        }),
      },
      {
        s: session("claude-code:c4a1f803", "cell-layout", "b3-fun/b3os-beta", "feat/cell-layout", ["B3-7044"], "waiting", {
          activity: "approve plan",
          sinceMin: 4.3,
        }),
        pinned: true,
      },
      {
        s: session("claude-code:9d03b6e7", "offtake-payouts", "b3-fun/b3iq", "fix/payout-request", ["B3-7101"], "working", {
          startedMin: 23,
        }),
      },
    ],
  },
  {
    email: "gio@npclabs.org",
    machine: "fake-gio-mbp",
    sims: [
      {
        s: session("claude-code:3a8e1d55", "admin-tables", "b3-fun/b3iq", "feat/admin-tables", ["B3-7120", "B3-7121"], "working", {
          startedMin: 66,
        }),
      },
      {
        s: session("codex:019a7b22", "board-dark-mode", "b3-fun/bullpen", "feat/board-dark", ["B3-7166"], "working", {
          background: true,
          startedMin: 12,
        }),
      },
      {
        s: session("claude-code:e61f0a4b", "chat-v0", "b3-fun/b3iq", "feat/chat-v0", ["B3-7052"], "ended", {
          activity: undefined,
          sinceMin: 38,
          startedMin: 120,
        }),
        pinned: true,
      },
    ],
  },
  {
    email: "sean@npclabs.org",
    machine: "fake-sean-laptop",
    oneShot: true,
    sims: [
      {
        s: session("claude-code:aa41c7d0", "vault-kek", "b3-fun/b3os-beta", "fix/kek-rotation", ["B3-7088"], "working", {
          startedMin: 30,
        }),
        pinned: true,
      },
    ],
  },
];

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
  const start = await post("/relay/pair/start", { machine: p.machine, client: "fake-relay/0.1.0" });
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

// --------------------------------------------------------------------------- simulation

function nextId(prefix: string) {
  return `${prefix}-${(++evCounter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toolEvent(sim: Sim, ts: number, prefix: string): Ev {
  const s = sim.s;
  const codex = s.source === "codex";
  const roll = Math.random();
  const ev: Ev = { id: nextId(prefix), key: s.key, ts, kind: "tool", repo: s.repo, branch: s.branch };
  if (roll < 0.34) {
    const path = rand(PATHS[s.repo]);
    // Codex reads through the shell with programs off the allow list, so only the tool name leaves the machine.
    ev.tool = codex ? "shell" : "Read";
    if (!codex) ev.path = path;
    ev.label = "reading files";
  } else if (roll < 0.62) {
    const path = rand(PATHS[s.repo]);
    ev.tool = codex ? "apply_patch" : rand(["Edit", "Edit", "Write"]);
    ev.path = path;
    ev.label = `editing ${base(path)}`;
  } else if (roll < 0.72 && !codex) {
    ev.tool = rand(["Grep", "Glob"]);
    ev.label = "searching";
  } else if (roll < 0.97) {
    const cmd = rand(CMDS[s.repo]);
    ev.tool = codex ? "shell" : "Bash";
    ev.cmd = cmd;
    ev.label = `running ${cmd}`;
    ev.ok = !/test|clippy|typecheck/.test(cmd) || chance(0.85);
  } else {
    ev.tool = codex ? "shell" : "Bash";
    ev.cmd = "gh pr create";
    ev.label = "opening a PR";
    ev.pr = `https://github.com/${s.repo}/pull/${++prCounter}`;
    ev.issues = s.issues;
    ev.ok = true;
  }
  return ev;
}

/** Ten minutes of history so the tail is not empty on first look. */
function backfill(p: Person, prefix: string): Ev[] {
  const out: Ev[] = [];
  const now = Date.now();
  for (const sim of p.sims) {
    const s = sim.s;
    const end = s.state === "working" ? now - 2_000 : s.stateSince;
    let ts = Math.max(s.startedAt, end - 10 * 60_000);
    if (s.startedAt > end - 10 * 60_000) out.push({ id: nextId(prefix), key: s.key, ts: s.startedAt, kind: "start", repo: s.repo, branch: s.branch });
    out.push({ id: nextId(prefix), key: s.key, ts: ts - 500, kind: "prompt", issues: s.issues });
    while (ts < end) {
      out.push(toolEvent(sim, ts, prefix));
      ts += Math.round(4_000 + Math.random() * 40_000);
    }
    if (s.state === "waiting") out.push({ id: nextId(prefix), key: s.key, ts: s.stateSince, kind: "waiting", label: s.activity });
    if (s.state === "idle") out.push({ id: nextId(prefix), key: s.key, ts: s.stateSince, kind: "idle" });
    if (s.state === "ended") out.push({ id: nextId(prefix), key: s.key, ts: s.stateSince, kind: "end" });
    const last = out.filter((e) => e.key === s.key && e.kind === "tool").pop();
    if (last && s.state === "working" && last.label) s.activity = last.label;
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function step(sim: Sim, now: number, prefix: string): { events: Ev[]; changed: boolean } {
  const s = sim.s;
  const events: Ev[] = [];
  let changed = false;
  const set = (state: SessionState, activity: string | undefined) => {
    s.state = state;
    s.activity = activity;
    s.stateSince = now;
    s.updatedAt = now;
    changed = true;
  };
  if (s.state === "working") {
    if (chance(0.3)) {
      const ev = toolEvent(sim, now, prefix);
      events.push(ev);
      if (ev.label && ev.label !== s.activity) {
        s.activity = ev.label;
        s.updatedAt = now;
        changed = true;
      }
    }
    if (!sim.pinned && chance(0.004)) {
      const label = rand(WAIT_LABELS);
      set("waiting", label);
      sim.resumeIn = 25 + Math.random() * 70;
      events.push({ id: nextId(prefix), key: s.key, ts: now, kind: "waiting", label });
    }
  } else if ((s.state === "waiting" || s.state === "idle") && !sim.pinned) {
    sim.resumeIn = (sim.resumeIn ?? 60) - 1;
    if (sim.resumeIn <= 0) {
      events.push({ id: nextId(prefix), key: s.key, ts: now, kind: "prompt" });
      set("working", "thinking");
    }
  }
  if (s.agents && s.state === "working" && chance(0.05)) {
    s.agents = Math.max(1, Math.min(12, s.agents + rand([-1, 1])));
    s.updatedAt = now;
    changed = true;
  }
  return { events, changed };
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
      const prefix = `f${i}`;
      const send = async (body: unknown) => {
        for (let failures = 0; ; ) {
          let r: Awaited<ReturnType<typeof post>>;
          try {
            r = await post("/relay/ingest", body, { authorization: `Bearer ${token}` });
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
      for (let k = 0; k < history.length || k === 0; k += 500) {
        const r = await send({
          v: 1,
          sentAt: Date.now(),
          full: true,
          sessions: p.sims.map((x) => x.s),
          events: history.slice(k, k + 500),
        });
        accepted += r.accepted;
      }
      log(`${p.machine} (${p.email}): ${p.sims.length} sessions, ${accepted} backfilled events`);
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
        for (const sim of p.sims) {
          const r = step(sim, now, prefix);
          events.push(...r.events);
          if (r.changed) dirty.push(sim.s);
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

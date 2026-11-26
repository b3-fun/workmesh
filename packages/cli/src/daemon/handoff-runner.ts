import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HubHandoffAccepted, HubShareLevel } from "@workmesh/protocol";
import { HUB_DELEGATE_NOTE_MAX } from "@workmesh/protocol";
import type { CoordClient } from "../hub/coord";
import { GitResolver } from "../hub/git";
import { scrubText } from "../hub/redact";
import { QUOTE_MARK, label, quoted } from "../lib/untrusted";
import type { HandoffRunnerLike } from "./delegate";
import { droppedEnvLine, handoffEnv } from "./handoff-env";
import type { HandoffPlan } from "./handoff-text";

/**
 * v2 handoffs on this machine (docs/SPEC.md §31): an accepted handoff gets a fresh agent session. The runner finds
 * this machine's checkout of the handoff's repo (repos its sessions worked in, and `workmesh roots add <dir>`), makes
 * a git worktree on a new branch from the remote's default branch (so nobody's working tree is touched), and runs the
 * person's agent CLI headless in it: `claude -p` with a session id chosen up front (the hub links the handoff to that
 * session at `start`), or `codex exec`. The prompt goes in on standard input and the environment has no variable
 * whose name looks like a secret. The session is shared like any other in that repo, so it shows on the board.
 * At exit it reports `done` or `fail` with a short note (the agent's last words at the conversation level, else only
 * how it ended).
 *
 * Runs survive a daemon restart: each is a detached process wrapped in `sh`, which writes its exit code to a file, and
 * the runner's list is saved (0600) and re-read on start.
 */

export type HandoffAgent = "claude" | "codex";

export interface RunnerSettings {
  /** Which agent CLI runs handoffs (default: claude when found, else codex). */
  agent?: HandoffAgent;
  /** Dirs whose repos (the dir itself, children, grandchildren) count as known checkouts. */
  roots: readonly string[];
  /** Run in a new git worktree (default true); false runs in the checkout itself. */
  worktree: boolean;
  /** Handoffs running at once on this machine (default 2). */
  maxRunning: number;
  /** Claude Code's permission mode for the headless session (default `auto`). */
  permissionMode: string;
  /** The model the agent runs on (`--model` for Claude Code, `-m` for Codex); absent: the agent's default. */
  model?: string;
  /** A run is stopped after this long (default 120 min). */
  maxMinutes: number;
  /** Variables the agent gets although their names look like secrets (`handoffs.env`; absent: none). */
  env?: readonly string[];
  /** This machine's sharing level: the done note carries the agent's last words only at `conversation`. */
  share: HubShareLevel;
}

export interface RunRecord {
  id: string;
  agent: HandoffAgent;
  pid?: number;
  sessionKey?: string;
  dir: string;
  branch?: string;
  startedAt: number;
  logFile: string;
  exitFile: string;
  resultFile?: string;
  task: string;
  from: string;
}

export interface HandoffRunnerDeps {
  coord: () => CoordClient | undefined;
  settings: () => RunnerSettings;
  /** Repo → main checkout dirs this machine's sessions worked in (CheckoutIndex). */
  checkouts: CheckoutIndex;
  /** Where runs keep their logs and the saved list: `~/.local/state/workmesh/handoffs`. */
  dir: string;
  /** A session the runner started (shared from its first event: its dir is in a shared repo or the scratch dir). */
  onStarted?: (record: RunRecord) => void;
  which?: (bin: string) => string | undefined;
  spawnImpl?: typeof spawn;
  /** `git` runner (tests pass a fake). */
  git?: (args: string[], cwd: string, timeoutMs?: number) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  pathEnv?: () => Promise<string>;
  /** The daemon's own environment (tests pass their own). */
  env?: () => NodeJS.ProcessEnv;
  now?: () => number;
  log?: (message: string) => void;
}

const STATE_FILE = "running.json";
const POLL_MS = 5000;

/** `claude` / `codex` on this machine: PATH first, then where their installers put them. */
export function findBin(bin: string, pathEnv = process.env.PATH ?? "", home = os.homedir()): string | undefined {
  const dirs = [
    ...pathEnv.split(path.delimiter).filter(Boolean),
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
  ];
  for (const d of dirs) {
    const p = path.join(d, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // next
    }
  }
  return undefined;
}

/** The person's login-shell PATH (a service daemon has a short one), else a sane default. */
export async function loginPath(): Promise<string> {
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
  const fallback = [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? "/usr/bin:/bin"].join(":");
  return new Promise((resolve) => {
    execFile(shell, ["-l", "-c", 'printf %s "$PATH"'], { timeout: 5000, encoding: "utf8" }, (err, stdout) => {
      const p = typeof stdout === "string" ? stdout.trim() : "";
      resolve(!err && p && !p.includes("\n") ? `${p}:${fallback}` : fallback);
    });
  });
}

function runGit(args: string[], cwd: string, timeoutMs = 60_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/**
 * Where this machine's checkouts are: the main checkout of every shared repo a session worked in (saved across
 * restarts), and repos under the person's roots. No `git` subprocess: `.git` is read directly (hub/git.ts).
 */
export class CheckoutIndex {
  private readonly file: string;
  private readonly git = new GitResolver({ ttlMs: 60_000 });
  private readonly known = new Map<string, Set<string>>();
  private dirty = false;
  private saveTimer: NodeJS.Timeout | undefined;
  private scanned: { at: number; roots: string; found: Map<string, string[]> } | undefined;

  constructor(file: string) {
    this.file = file;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const [repo, dirs] of Object.entries(raw)) {
        if (Array.isArray(dirs)) this.known.set(repo, new Set(dirs.filter((d): d is string => typeof d === "string")));
      }
    } catch {
      // none yet
    }
  }

  /** A shared session's checkout: remember its main repository. Cheap (cached `.git` reads). */
  observe(dir: string | undefined, repo: string | undefined): void {
    if (!dir || !repo || !path.isAbsolute(dir)) return;
    const info = this.git.resolve(dir);
    if (!info?.repo || info.repo !== repo) return;
    const main = info.mainRoot;
    if (main.includes(`${path.sep}.local${path.sep}state${path.sep}workmesh${path.sep}`)) return;
    let set = this.known.get(repo);
    if (!set) {
      set = new Set();
      this.known.set(repo, set);
    }
    if (set.has(main)) return;
    set.add(main);
    this.dirty = true;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, 1000);
    this.saveTimer.unref?.();
  }

  save(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const out: Record<string, string[]> = {};
      for (const [repo, dirs] of this.known) out[repo] = [...dirs].slice(-10);
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // best effort
    }
  }

  /** The repos under `roots` (each root, its children and grandchildren), cached for a minute. */
  private scan(roots: readonly string[]): Map<string, string[]> {
    const key = roots.join("\u0000");
    const now = Date.now();
    if (this.scanned && this.scanned.roots === key && now - this.scanned.at < 60_000) return this.scanned.found;
    const found = new Map<string, string[]>();
    const visit = (dir: string, depth: number): void => {
      let isRepo = false;
      try {
        isRepo = fs.existsSync(path.join(dir, ".git"));
      } catch {
        return;
      }
      if (isRepo) {
        const info = this.git.resolve(dir);
        if (info?.repo && info.root === dir) {
          const list = found.get(info.repo) ?? [];
          list.push(info.mainRoot);
          found.set(info.repo, list);
        }
        return;
      }
      if (depth >= 2) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries.slice(0, 500)) {
        if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
        visit(path.join(dir, e.name), depth + 1);
      }
    };
    for (const r of roots) visit(r, 0);
    this.scanned = { at: now, roots: key, found };
    return found;
  }

  /** A main checkout of `repo` that still exists here, or undefined. */
  find(repo: string, roots: readonly string[]): string | undefined {
    const candidates = [...(this.known.get(repo) ?? []), ...(this.scan(roots).get(repo) ?? [])];
    for (const dir of candidates) {
      const info = this.git.resolve(dir);
      if (info?.repo === repo) return info.mainRoot;
    }
    return undefined;
  }

  repos(): string[] {
    return [...this.known.keys()].sort();
  }
}

/**
 * The prompt a handoff's session starts with. The sender's names, task and context go into it through
 * `lib/untrusted.ts`: a name stays on the line that carries it, and every line of the task and of the context is
 * marked. So no line of them can read as one of the lines Workmesh adds around them, and nothing a reader cannot see
 * reaches the agent. The task is still this session's task, only fenced: the rule for a teammate's message is not
 * said over it.
 */
export function handoffPrompt(
  h: HubHandoffAccepted,
  where: { repo?: string; branch?: string; base?: string; dir: string },
  agent: HandoffAgent = "claude",
): string {
  const person = label(h.from.person);
  const session = h.from.sessionName ? label(h.from.sessionName) : "";
  const from = session ? `${person} (their agent ${session})` : person;
  const lines = [
    `Workmesh handoff from ${from}. The task (every line of it starts with ${QUOTE_MARK}):`,
    "",
    quoted(h.task),
    "",
  ];
  if (h.context) lines.push(`Context from ${person} (marked the same way):`, "", quoted(h.context), "");
  const facts: string[] = [];
  if (h.issue) facts.push(`Linear issue: ${h.issue} (claim it with the workmesh \`claim\` tool).`);
  if (where.repo && where.branch) {
    facts.push(`You are in a fresh git worktree of ${where.repo} on branch ${where.branch}, made from ${where.base ?? "the default branch"} for this handoff. Commit there; push the branch and open a draft PR when the work is ready for review, unless the task says otherwise.`);
  } else if (where.repo) {
    facts.push(`You are in this machine's checkout of ${where.repo}. Someone may be working here too: commit on a new branch, never on theirs.`);
  } else {
    facts.push("You are in an empty scratch directory made for this handoff.");
  }
  if (agent === "codex" && where.repo) {
    // Codex's sandbox keeps the repo's git metadata read-only (a worktree's too): commits and pushes go through its
    // escalation, which `--approve-for-me` sends to Codex's automatic reviewer. Without the hint a model gave up.
    facts.push(
      "Codex's sandbox keeps this repo's git metadata read-only: run `git commit` and `git push` with escalated sandbox permissions and a one-line justification; Codex's automatic reviewer approves routine commits and pushes.",
    );
  }
  facts.push(
    "You run headless: nobody will answer questions here. Use the workmesh tools to coordinate (lease files before larger edits, `send` to ask a teammate).",
    `End with a short summary of what you did and what's left: it goes back to ${person}.`,
  );
  lines.push(...facts);
  return lines.join("\n");
}

/**
 * The name of a handoff's session. It is on the agent's command line, where any process can read it, so it carries
 * no task text: the issue or the handoff's short id, and the sender as a label.
 */
export function handoffSessionName(h: Pick<HubHandoffAccepted, "id" | "issue" | "from">): string {
  return `handoff ${h.issue ?? shortId(h.id)} from ${label(h.from.person, 60)}`;
}

function shortId(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "").slice(-8).toLowerCase() || "handoff";
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class HandoffRunner implements HandoffRunnerLike {
  private readonly deps: HandoffRunnerDeps;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly records = new Map<string, RunRecord>();
  /** Ids being started (a `start` call or worktree in flight). */
  private readonly starting = new Set<string>();
  private readonly ids = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(deps: HandoffRunnerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.load();
  }

  private get stateFile(): string {
    return path.join(this.deps.dir, STATE_FILE);
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as RunRecord[];
      for (const r of Array.isArray(raw) ? raw : []) {
        if (r && typeof r.id === "string" && typeof r.exitFile === "string") this.records.set(r.id, r);
      }
    } catch {
      // nothing running
    }
    this.syncIds();
  }

  private persist(): void {
    try {
      fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify([...this.records.values()], null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    } catch {
      // best effort
    }
  }

  private syncIds(): void {
    this.ids.clear();
    for (const id of this.records.keys()) this.ids.add(id);
    for (const id of this.starting) this.ids.add(id);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref?.();
    this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  running(): ReadonlySet<string> {
    return this.ids;
  }

  list(): RunRecord[] {
    return [...this.records.values()];
  }

  hasRoom(): boolean {
    return this.ids.size < Math.max(0, this.deps.settings().maxRunning);
  }

  private agentFor(): { agent: HandoffAgent; bin: string } | undefined {
    const which = this.deps.which ?? ((b: string) => findBin(b));
    const want = this.deps.settings().agent;
    const order: HandoffAgent[] = want ? [want] : ["claude", "codex"];
    for (const agent of order) {
      const bin = which(agent);
      if (bin) return { agent, bin };
    }
    return undefined;
  }

  cannotRun(h: HubHandoffAccepted): string | undefined {
    if (this.deps.settings().maxRunning <= 0) return "handoffs.maxRunning is 0";
    if (!this.agentFor()) {
      const want = this.deps.settings().agent;
      return want ? `no ${want} CLI found on this machine` : "neither claude nor codex is installed here";
    }
    if (h.repo && !this.deps.checkouts.find(h.repo, this.deps.settings().roots)) {
      return `no checkout of ${h.repo} here (\`workmesh roots add <dir>\` names where your repos live)`;
    }
    return undefined;
  }

  /**
   * What accepting `h` would start here, for the person to read before they accept: the agent and permission mode a
   * run would use, and where it would run. It reads the same settings as a run and starts nothing.
   */
  plan(h: HubHandoffAccepted): HandoffPlan {
    const settings = this.deps.settings();
    const picked = this.agentFor();
    const cannot = this.cannotRun(h);
    return {
      ...(picked ? { agent: picked.agent } : {}),
      ...(picked?.agent === "claude" ? { permissionMode: settings.permissionMode } : {}),
      where: !h.repo ? "scratch" : settings.worktree ? "worktree" : "checkout",
      ...(cannot ? { cannot } : {}),
    };
  }

  /** Claims the run on the hub (`start`), prepares the directory, and launches the agent. Never throws. */
  run(h: HubHandoffAccepted): void {
    if (this.ids.has(h.id)) return;
    this.starting.add(h.id);
    this.syncIds();
    void this.runUnsafe(h)
      .catch((err: unknown) => {
        this.log(`handoff ${h.id}: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.starting.delete(h.id);
        this.syncIds();
      });
  }

  private async runUnsafe(h: HubHandoffAccepted): Promise<void> {
    const coord = this.deps.coord();
    const picked = this.agentFor();
    if (!coord || !picked) return;
    const settings = this.deps.settings();
    const sessionId = picked.agent === "claude" ? randomUUID() : undefined;
    const sessionKey = sessionId ? `claude-code:${sessionId}` : undefined;
    // The hub decides who runs it: the first `start` wins.
    const claim = await coord.handoff({ action: "start", id: h.id, ...(sessionKey ? { sessionKey } : {}) });
    if (!claim.ok || !claim.body.ok) {
      const why = claim.ok ? (claim.body.ok ? "" : claim.body.error) : claim.error;
      this.log(`handoff ${h.id}: not starting here (${why || "the hub said no"})`);
      return;
    }
    const fail = async (note: string): Promise<void> => {
      this.log(`handoff ${h.id}: ${note}`);
      await coord.handoff({ action: "fail", id: h.id, note: note.slice(0, HUB_DELEGATE_NOTE_MAX) });
    };

    // Where it runs.
    const runDir = path.join(this.deps.dir, shortId(h.id));
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    let dir: string;
    let branch: string | undefined;
    let base: string | undefined;
    if (h.repo) {
      const checkout = this.deps.checkouts.find(h.repo, settings.roots);
      if (!checkout) return fail(`no checkout of ${h.repo} on this machine`);
      if (settings.worktree) {
        const git = this.deps.git ?? runGit;
        await git(["fetch", "--quiet", "origin"], checkout, 60_000);
        const head = await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], checkout, 10_000);
        base = head.ok && head.stdout.trim() ? head.stdout.trim() : "HEAD";
        branch = `workmesh/handoff-${shortId(h.id)}`;
        dir = `${checkout}-handoff-${shortId(h.id)}`;
        const add = await git(["worktree", "add", "-b", branch, dir, base], checkout, 60_000);
        if (!add.ok) {
          // A second try (a retried handoff) reuses the branch and directory if they are there.
          if (!fs.existsSync(dir)) return fail(`git worktree add failed: ${add.stderr.trim().split("\n").pop() ?? "error"}`);
        }
      } else {
        dir = checkout;
      }
    } else {
      dir = path.join(runDir, "work");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const prompt = handoffPrompt(h, { repo: h.repo, branch, base, dir }, picked.agent);
    const logFile = path.join(runDir, "agent.log");
    const exitFile = path.join(runDir, "exit-code");
    const resultFile = path.join(runDir, "result.txt");
    // The prompt goes to the agent on standard input, from a file only this user can read. On the command line any
    // process on the machine could read the task in the process list.
    const promptFile = path.join(runDir, "prompt.txt");
    try {
      fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
      fs.chmodSync(promptFile, 0o600);
    } catch {
      // The start is already claimed on the hub: say that nothing runs, rather than leave it as started.
      return fail("couldn't write the prompt file on this machine");
    }
    try {
      fs.rmSync(exitFile, { force: true });
    } catch {
      // fine
    }
    const name = handoffSessionName(h);
    // `claude -p` with no prompt argument reads the prompt from standard input.
    const argv =
      picked.agent === "claude"
        ? [
            picked.bin, "-p", "--session-id", sessionId!, "--output-format", "json", "--permission-mode", settings.permissionMode, "--name", name,
            ...(settings.model ? ["--model", settings.model] : []),
          ]
        : codexExecArgs(picked.bin, { dir, resultFile, model: settings.model, approveForMe: await codexHasApproveForMe(picked.bin) });
    // The agent works on someone else's task. It gets the daemon's environment without the variables whose names say
    // "secret", except what its own tool signs in with and what the person listed (handoff-env.ts).
    const passed = handoffEnv((this.deps.env ?? (() => process.env))(), picked.agent, settings.env);
    const env: NodeJS.ProcessEnv = { ...passed.env, PATH: await (this.deps.pathEnv ?? loginPath)(), WORKMESH_HANDOFF: h.id, WM_EXIT_FILE: exitFile };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CODEX_THREAD_ID;
    const out = fs.openSync(logFile, "a", 0o600);
    const input = fs.openSync(promptFile, "r");
    let pid: number | undefined;
    try {
      if (passed.dropped.length > 0) {
        // Names only, so the person can see what to add to `handoffs.env`.
        fs.writeSync(out, `${droppedEnvLine(passed.dropped)}\n`);
        this.log(`handoff ${h.id}: ${passed.dropped.length} environment variable(s) not passed to the agent (names in ${logFile})`);
      }
      const child = (this.deps.spawnImpl ?? spawn)("/bin/sh", ["-c", '"$@"; echo $? > "$WM_EXIT_FILE"', "workmesh-handoff", ...argv], {
        cwd: dir,
        env,
        detached: true,
        stdio: [input, out, out],
      });
      child.on("error", () => {});
      child.unref();
      pid = child.pid;
    } finally {
      fs.closeSync(out);
      fs.closeSync(input);
    }
    if (!pid) return fail(`couldn't start ${picked.agent}`);
    const record: RunRecord = {
      id: h.id,
      agent: picked.agent,
      pid,
      sessionKey,
      dir,
      branch,
      startedAt: this.now(),
      logFile,
      exitFile,
      ...(picked.agent === "codex" ? { resultFile } : {}),
      task: h.task.slice(0, 200),
      from: h.from.person,
    };
    this.records.set(h.id, record);
    this.persist();
    this.log(`handoff ${h.id}: ${picked.agent} started in ${dir} (pid ${pid})`);
    this.deps.onStarted?.(record);
  }

  /** A Codex run learned its thread id (its first event): tell the hub which session it is. */
  attachSession(id: string, sessionKey: string): void {
    const r = this.records.get(id);
    if (!r || r.sessionKey) return;
    r.sessionKey = sessionKey;
    this.persist();
    void this.deps.coord()?.handoff({ action: "start", id, sessionKey });
  }

  /** Checks running handoffs: finished ones report done/fail, ones over time are stopped. */
  poll(): void {
    const coord = this.deps.coord();
    const settings = this.deps.settings();
    for (const r of [...this.records.values()]) {
      if (r.agent === "codex" && !r.sessionKey) {
        const thread = codexThreadFromLog(r.logFile);
        if (thread) this.attachSession(r.id, `codex:${thread}`);
      }
      let code: number | undefined;
      try {
        const text = fs.readFileSync(r.exitFile, "utf8").trim();
        if (text) code = Number.parseInt(text, 10);
      } catch {
        code = undefined;
      }
      const alive = pidAlive(r.pid);
      if (code === undefined && alive) {
        if (this.now() - r.startedAt > settings.maxMinutes * 60_000 && r.pid) {
          try {
            process.kill(-r.pid, "SIGTERM");
          } catch {
            try {
              process.kill(r.pid, "SIGTERM");
            } catch {
              // gone
            }
          }
          this.log(`handoff ${r.id}: stopped after ${settings.maxMinutes} min`);
        }
        continue;
      }
      if (!coord) continue;
      this.records.delete(r.id);
      this.persist();
      this.syncIds();
      const ok = code === 0;
      const summary = settings.share === "conversation" ? resultText(r) : undefined;
      const how = code === undefined ? "the agent stopped without an exit code" : ok ? "finished" : `the agent exited ${code}`;
      const where = r.branch ? ` Branch ${r.branch}.` : "";
      const note = (summary ? `${summary}` : `${how}.${where}`).slice(0, HUB_DELEGATE_NOTE_MAX);
      this.log(`handoff ${r.id}: ${how}`);
      void coord.handoff({ action: ok ? "done" : "fail", id: r.id, ...(r.sessionKey ? { sessionKey: r.sessionKey } : {}), note });
    }
  }
}

/**
 * `codex exec` for a handoff (SPEC §31). Live on codex-cli 0.164 (11-25), `-s workspace-write` with approvals off let
 * a run edit files but never commit: Codex keeps the repo's git metadata read-only (a worktree's gitdir too, even
 * with `--add-dir`), and gave it no network to push. `--approve-for-me` keeps that sandbox and sends each escalation
 * (a commit, a push) to Codex's automatic reviewer, the counterpart of Claude Code's `auto` permission mode that a
 * Claude handoff runs in; the sandbox gets network access like a Claude run has. A Codex without the flag runs as
 * before.
 *
 * The prompt is not an argument: the last one is `-`, which tells `codex exec` to read the prompt from standard
 * input (its own source says so: "If not provided as an argument (or if `-` is used), instructions are read from
 * stdin").
 */
export function codexExecArgs(
  bin: string,
  o: { dir: string; resultFile: string; model?: string; approveForMe?: boolean },
): string[] {
  return [
    bin, "exec", "--json", "-C", o.dir,
    ...(o.approveForMe ? ["--approve-for-me"] : ["-s", "workspace-write"]),
    "--skip-git-repo-check", "-o", o.resultFile,
    "-c", "sandbox_workspace_write.network_access=true",
    ...(o.model ? ["-m", o.model] : []),
    "-",
  ];
}

const approveForMe = new Map<string, Promise<boolean>>();

/** Whether this codex's `exec` takes `--approve-for-me` (asked once per binary). */
export function codexHasApproveForMe(bin: string): Promise<boolean> {
  let p = approveForMe.get(bin);
  if (!p) {
    p = new Promise((resolve) => {
      execFile(bin, ["exec", "--help"], { timeout: 10_000, encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout) =>
        resolve(!err && String(stdout).includes("--approve-for-me")),
      );
    });
    approveForMe.set(bin, p);
  }
  return p;
}

/** The agent's last words: Claude's `--output-format json` result, or Codex's last message file; redacted. */
export function resultText(r: Pick<RunRecord, "agent" | "logFile" | "resultFile">): string | undefined {
  let raw: string | undefined;
  try {
    if (r.agent === "codex" && r.resultFile) {
      raw = fs.readFileSync(r.resultFile, "utf8");
    } else {
      const text = readTail(r.logFile, 256 * 1024);
      for (const line of text.split("\n").reverse()) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
          const j = JSON.parse(t) as { type?: unknown; result?: unknown };
          if (j.type === "result" && typeof j.result === "string") {
            raw = j.result;
            break;
          }
        } catch {
          // not this line
        }
      }
    }
  } catch {
    return undefined;
  }
  return scrubText(raw?.replace(/\s+/g, " "), { max: HUB_DELEGATE_NOTE_MAX })?.text;
}

function readTail(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** `codex exec --json`'s first event names the thread: `{"type":"thread.started","thread_id":"…"}`. */
export function codexThreadFromLog(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(16 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.toString("utf8", 0, n).split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
          const j = JSON.parse(t) as { type?: unknown; thread_id?: unknown };
          if (j.type === "thread.started" && typeof j.thread_id === "string" && /^[\w-]{8,64}$/.test(j.thread_id)) return j.thread_id;
        } catch {
          // next
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

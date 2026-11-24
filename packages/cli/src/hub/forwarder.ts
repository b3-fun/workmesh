import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HUB_MAX_BODY_BYTES,
  HUB_MAX_EVENTS_PER_REQUEST,
  HUB_MAX_SESSIONS_PER_REQUEST,
  HUB_WIRE_VERSION,
  hubActivityEventSchema,
  hubIngestRequestSchema,
  hubSessionUpsertSchema,
  isRepoRelativePath,
} from "@agentblip/core";
import type {
  AgentSession,
  HubActivityEvent,
  HubEventKind,
  HubProjectRule,
  HubSessionUpsert,
  SessionEvent,
} from "@agentblip/core";
import type { z } from "zod";
import { GitResolver } from "./git";
import {
  extractCmd,
  extractIssues,
  extractPr,
  hubLabel,
  hubToolName,
  isUnder,
  mentionedRoot,
} from "./rules";

/**
 * HubForwarder: the daemon's "hub forward" output (Bullpen SPEC §3). It sees
 * every applied SessionEvent (with its local-only detail) and the SessionStore,
 * reduces them to the hub's metadata fields under the §3.3 inclusion rules,
 * and POSTs batches to `<hub>/relay/ingest`.
 *
 * It never blocks the hook path: observe() is synchronous and cheap (cached
 * .git reads, an array push), and all network I/O runs on its own 1 s timer,
 * one request at a time, independent of the Slack pusher.
 */

export interface HubForwarderOptions {
  /** Hub base URL, e.g. https://bullpen.b3os.org */
  url: string;
  /** Device token (bp_…). */
  token: string;
  /** Sharing rule received at pairing. */
  rule: HubProjectRule;
  /** Absolute dirs the person shares locally (`agentblip hub include`). */
  includeDirs?: readonly string[];
  /** Absolute dirs the person never shares (`agentblip hub exclude`); beat every include. */
  excludeDirs?: readonly string[];
  /** The daemon's live sessions. */
  listSessions: () => readonly AgentSession[];
  /** One live session by key. */
  getSession: (key: string) => AgentSession | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
  /** Send cadence while there is something to send. Default 1 s. */
  batchIntervalMs?: number;
  /** full=true heartbeat cadence. Default 30 s. */
  heartbeatMs?: number;
  /** Events kept while the hub is unreachable. Default 5,000. */
  maxBuffer?: number;
  requestTimeoutMs?: number;
  git?: GitResolver;
  homeDir?: string;
}

export interface HubForwarderStatus {
  url: string;
  project: { id: string; name: string };
  running: boolean;
  /** Stopped for good: the hub rejected the device token (401). */
  halted: boolean;
  lastSendAt?: number;
  lastSendOk?: boolean;
  lastSuccessAt?: number;
  lastError?: string;
  /** Events waiting to be sent. */
  queued: number;
  /** Events dropped because the buffer was full (oldest first). */
  dropped: number;
  /** Events the hub refused (400/413) and that were not retried. */
  rejected: number;
  /** Events the hub has accepted since start. */
  accepted: number;
  /** Sessions currently shared with the hub. */
  sharedSessions: number;
  retryAt?: number;
}

/** A shared place a path resolved to. */
interface Target {
  /** Checkout top-level (repo-relative paths are relative to it). */
  root: string;
  repo?: string;
  branch?: string;
}

interface Tracked {
  key: string;
  cwd?: string;
  cwdTarget?: Target;
  /** Shared because its cwd is, or a file event touched a shared path, or its orchestrator is shared. */
  shared: boolean;
  /** Shared roots this session touched (rule 4: bash events must mention one). */
  roots: Map<string, Target>;
  /** Most recent shared target touched: the session's repo when its cwd is not shared. */
  lastTarget?: Target;
  issues: string[];
  /** Last raw activity label and what the hub may see of it. */
  label?: { raw: string; hub?: string };
  /** Last known store session, for the final "ended" upsert. */
  last?: AgentSession;
  current?: HubSessionUpsert;
  sentJson?: string;
}

const SESSION_REQUIRED = new Set(["key", "source", "state", "startedAt", "updatedAt", "stateSince"]);
const EVENT_REQUIRED = new Set(["id", "key", "ts", "kind"]);
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 30_000;

/**
 * Validates a record against a strict hub schema, dropping optional fields
 * that fail (a bad branch name must not cost the whole batch a 400). Returns
 * undefined when a required field is invalid.
 */
function conform<T>(
  schema: z.ZodType<T>,
  obj: Record<string, unknown>,
  required: ReadonlySet<string>,
): T | undefined {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  for (let attempt = 0; attempt < 8; attempt++) {
    const parsed = schema.safeParse(obj);
    if (parsed.success) return parsed.data;
    let removed = false;
    for (const issue of parsed.error.issues) {
      const keys =
        issue.code === "unrecognized_keys"
          ? (issue as { keys: string[] }).keys
          : [String(issue.path[0] ?? "")];
      for (const k of keys) {
        if (k && !required.has(k) && k in obj) {
          delete obj[k];
          removed = true;
        }
      }
    }
    if (!removed) return undefined;
  }
  return undefined;
}

/** Seconds or an HTTP date → ms from now, clamped to [1 s, 10 min]. */
export function parseRetryAfter(value: string | null, now: number): number {
  if (!value) return DEFAULT_RETRY_AFTER_MS;
  const secs = Number(value);
  let ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(ms)) ms = DEFAULT_RETRY_AFTER_MS;
  return Math.min(Math.max(ms, 1000), 10 * 60_000);
}

/** Normalizes an include remote ("https://github.com/b3-fun/") to the "host/path" form. */
function normalizeIncludeRemote(entry: string): string {
  return entry
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\/)/, "$1/");
}

export class HubForwarder {
  private readonly url: string;
  private readonly token: string;
  private readonly rule: HubProjectRule;
  private readonly remotes: string[];
  private readonly includeDirs: string[];
  private readonly excludeDirs: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly batchIntervalMs: number;
  private readonly heartbeatMs: number;
  private readonly maxBuffer: number;
  private readonly requestTimeoutMs: number;
  private readonly git: GitResolver;
  private readonly home: string;
  private readonly listSessions: () => readonly AgentSession[];
  private readonly getSession: (key: string) => AgentSession | undefined;

  private readonly sessions = new Map<string, Tracked>();
  private queue: HubActivityEvent[] = [];
  private readonly bootId = crypto.randomBytes(5).toString("hex");
  private seq = 0;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private lastFullAt = 0;
  private retryAt = 0;
  private failures = 0;
  private maxEvents = HUB_MAX_EVENTS_PER_REQUEST;
  private halted = false;
  private lastSendAt: number | undefined;
  private lastSendOk: boolean | undefined;
  private lastSuccessAt: number | undefined;
  private lastError: string | undefined;
  private dropped = 0;
  private rejected = 0;
  private accepted = 0;

  constructor(opts: HubForwarderOptions) {
    this.url = opts.url.replace(/\/+$/, "");
    this.token = opts.token;
    this.rule = opts.rule;
    this.home = opts.homeDir ?? os.homedir();
    this.remotes = opts.rule.include.remotes.map(normalizeIncludeRemote).filter(Boolean);
    // Each dir in its given and its real form: git records worktree pointers
    // as real paths (/private/var/… for /var/… on macOS).
    const absDirs = (dirs: readonly string[]): string[] => {
      const out = new Set<string>();
      for (const raw of dirs) {
        const d = raw.startsWith("~") ? path.join(this.home, raw.slice(1)) : raw;
        if (!path.isAbsolute(d)) continue;
        out.add(path.normalize(d));
        try {
          out.add(fs.realpathSync(d));
        } catch {
          // missing dir: the given form is all there is
        }
      }
      return [...out];
    };
    this.includeDirs = absDirs([...opts.rule.include.dirs, ...(opts.includeDirs ?? [])]);
    this.excludeDirs = absDirs(opts.excludeDirs ?? []);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.batchIntervalMs = opts.batchIntervalMs ?? 1000;
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
    this.maxBuffer = opts.maxBuffer ?? 5000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.git = opts.git ?? new GitResolver({ now: this.now });
    this.listSessions = opts.listSessions;
    this.getSession = opts.getSession;
  }

  // --- lifecycle -------------------------------------------------------------

  start(): void {
    if (this.timer || this.halted) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.batchIntervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  /** Stops the timer and makes one last best-effort send of queued events. */
  async stop(flushTimeoutMs = 2000): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.halted) return;
    await Promise.race([
      (async () => {
        await this.inFlight;
        if (this.queue.length > 0) await this.tick(true);
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, flushTimeoutMs).unref?.()),
    ]);
  }

  status(): HubForwarderStatus {
    return {
      url: this.url,
      project: { id: this.rule.id, name: this.rule.name },
      running: this.timer !== undefined,
      halted: this.halted,
      lastSendAt: this.lastSendAt,
      lastSendOk: this.lastSendOk,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      queued: this.queue.length,
      dropped: this.dropped,
      rejected: this.rejected,
      accepted: this.accepted,
      sharedSessions: [...this.sessions.values()].filter((t) => t.shared && t.current?.state !== "ended")
        .length,
      retryAt: this.retryAt > this.now() ? this.retryAt : undefined,
    };
  }

  // --- inclusion (§3.3 rules 1-2) --------------------------------------------

  private excluded(p: string): boolean {
    return this.excludeDirs.some((d) => isUnder(p, d));
  }

  /** The shared place an absolute path belongs to, or undefined when it is not shared. */
  classify(absPath: string): Target | undefined {
    if (!path.isAbsolute(absPath)) return undefined;
    const p = path.normalize(absPath);
    if (this.excluded(p)) return undefined;
    const info = this.git.resolve(p);
    if (info) {
      // Worktrees count as their main repository (remote, dirs and excludes).
      if (this.excluded(info.root) || this.excluded(info.mainRoot)) return undefined;
      const remote = info.remote?.toLowerCase();
      const byRemote = remote !== undefined && this.remotes.some((r) => remote.includes(r));
      const byDir = this.includeDirs.some(
        (d) => isUnder(p, d) || isUnder(info.root, d) || isUnder(info.mainRoot, d),
      );
      if (!byRemote && !byDir) return undefined;
      return { root: info.root, repo: info.repo, branch: info.branch };
    }
    const dir = this.includeDirs.find((d) => isUnder(p, d));
    return dir ? { root: dir } : undefined;
  }

  /** Repo-relative path the hub accepts, or undefined. */
  private relPath(target: Target, absPath: string): string | undefined {
    const rel = path.relative(target.root, path.normalize(absPath)).split(path.sep).join("/");
    if (!rel || rel.length > 400 || !isRepoRelativePath(rel)) return undefined;
    return rel;
  }

  /** True when an "owner/name" repo is shared by remote or by a root this device has seen. */
  private repoShared(repo: string): boolean {
    const remote = `github.com/${repo}`.toLowerCase();
    if (this.remotes.some((r) => remote.includes(r))) return true;
    for (const t of this.sessions.values()) {
      for (const target of t.roots.values()) if (target.repo === repo) return true;
    }
    return false;
  }

  private track(key: string): Tracked {
    let t = this.sessions.get(key);
    if (!t) {
      t = { key, shared: false, roots: new Map(), issues: [] };
      this.sessions.set(key, t);
    }
    return t;
  }

  private setCwd(t: Tracked, cwd: string): void {
    if (t.cwd === cwd) return;
    t.cwd = cwd;
    t.cwdTarget = this.classify(cwd);
    if (t.cwdTarget) {
      t.shared = true;
      t.roots.set(t.cwdTarget.root, t.cwdTarget);
    }
  }

  private addIssues(t: Tracked, ids: readonly string[]): void {
    for (const id of ids) {
      if (t.issues.includes(id)) continue;
      t.issues.push(id);
      if (t.issues.length > 20) t.issues.shift();
    }
  }

  // --- events (§3.3 rules 3-7) -------------------------------------------------

  /** Called for every event the daemon applied. Never throws. */
  observe(event: SessionEvent): void {
    try {
      this.observeUnsafe(event);
    } catch (err) {
      this.log(`hub: skipped an event: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private observeUnsafe(event: SessionEvent): void {
    if (this.halted || event.kind === "heartbeat") return;
    const key = `${event.source}:${event.sessionId}`;
    const t = this.track(key);
    const live = this.getSession(key);
    if (live) t.last = live;
    if (event.cwd) this.setCwd(t, event.cwd);

    const d = event.detail;
    const files = d ? [...new Set([d.filePath, ...(d.filePaths ?? [])].filter((f): f is string => !!f))] : [];
    const fileTargets = files.map((file) => ({ file, target: this.classify(file) }));
    const sharedFiles = fileTargets.filter(
      (f): f is { file: string; target: Target } => f.target !== undefined,
    );
    for (const { target } of sharedFiles) {
      t.shared = true;
      t.roots.set(target.root, target);
      t.lastTarget = target;
    }

    const keys = this.rule.issueKeys;
    const ids = [
      ...new Set([...extractIssues(d?.prompt, keys), ...extractIssues(d?.command, keys)]),
    ];
    this.addIssues(t, ids);

    const label = hubLabel(event.activity, new Set(sharedFiles.map((f) => path.basename(f.file))));
    if (event.activity) t.label = { raw: event.activity, hub: label };

    if (!t.shared) return; // rule 3: unshared sessions send nothing
    const ev = this.buildEvent(event, t, { sharedFiles, anyFiles: files.length > 0, ids, label });
    if (ev) this.enqueue(ev);
  }

  private buildEvent(
    event: SessionEvent,
    t: Tracked,
    ctx: {
      sharedFiles: Array<{ file: string; target: Target }>;
      anyFiles: boolean;
      ids: string[];
      label: string | undefined;
    },
  ): Omit<HubActivityEvent, "id"> | undefined {
    const d = event.detail;
    const base = { key: t.key, ts: event.ts ?? this.now() };
    const cwdShared = t.cwdTarget !== undefined;
    const stateKind: Partial<Record<SessionEvent["kind"], HubEventKind>> = {
      start: "start",
      waiting: "waiting",
      idle: "idle",
      end: "end",
    };
    const sk = stateKind[event.kind];
    if (sk) {
      return {
        ...base,
        kind: sk,
        tool: hubToolName(d?.tool),
        label: ctx.label,
        repo: t.cwdTarget?.repo,
        branch: t.cwdTarget?.branch,
      };
    }
    if (event.kind !== "working" || !d) return undefined; // watcher/liveness chatter: upserts cover it

    if (d.hookEvent === "UserPromptSubmit" || d.prompt !== undefined) {
      // The person sent a message: the text never leaves, the ids may.
      return {
        ...base,
        kind: "prompt",
        repo: (t.cwdTarget ?? t.lastTarget)?.repo,
        branch: (t.cwdTarget ?? t.lastTarget)?.branch,
        issues: ctx.ids.length ? ctx.ids : undefined,
      };
    }
    if (!d.tool) return undefined;

    const post = d.hookEvent === "PostToolUse" || d.hookEvent === "PostToolUseFailure";
    const pr = extractPr(d.command, d.toolResponseText);
    const prShared = pr !== undefined && this.repoShared(pr.repo);
    // One line per tool call: PreToolUse carries it; PostToolUse only adds a
    // line when it has news (a PR link, or a failure).
    if (post && !prShared && d.ok !== false) return undefined;

    const tool = {
      ...base,
      kind: "tool" as const,
      tool: hubToolName(d.tool),
      label: ctx.label,
      ok: post ? d.ok : undefined,
    };

    if (ctx.anyFiles) {
      const hit = ctx.sharedFiles[0];
      if (hit) {
        return {
          ...tool,
          path: this.relPath(hit.target, hit.file),
          repo: hit.target.repo,
          branch: hit.target.branch,
        };
      }
      // A file outside every shared repo: in a shared cwd, say only that a
      // tool ran (label already reduced to "editing files"); otherwise drop.
      return cwdShared ? { ...tool, label: ctx.label } : undefined;
    }

    if (d.command !== undefined) {
      const rootHit = mentionedRoot(d.command, t.roots.keys(), this.home);
      const target = rootHit ? t.roots.get(rootHit) : t.cwdTarget;
      const extras = {
        cmd: extractCmd(d.command),
        issues: ctx.ids.length ? ctx.ids : undefined,
        pr: prShared ? pr?.url : undefined,
      };
      if (cwdShared || rootHit) {
        return { ...tool, ...extras, repo: target?.repo, branch: target?.branch };
      }
      // Rule 4 drops shell events in an unshared cwd that mention no shared
      // root; a PR on a shared repo is itself shared data (rule 7), so it goes.
      if (prShared) return { ...tool, ...extras, repo: pr?.repo };
      return undefined;
    }

    return cwdShared ? { ...tool, repo: t.cwdTarget?.repo, branch: t.cwdTarget?.branch } : undefined;
  }

  private enqueue(raw: Omit<HubActivityEvent, "id">): void {
    const id = `${this.bootId}-${(this.seq++).toString(36)}`;
    const ev = conform(hubActivityEventSchema, { id, ...raw } as Record<string, unknown>, EVENT_REQUIRED);
    if (!ev) {
      this.log("hub: dropped an event that failed the wire schema");
      return;
    }
    this.queue.push(ev);
    if (this.queue.length > this.maxBuffer) {
      const over = this.queue.length - this.maxBuffer;
      this.queue.splice(0, over);
      this.dropped += over;
    }
  }

  // --- sessions ----------------------------------------------------------------

  private buildUpsert(s: AgentSession, t: Tracked, ended?: number): HubSessionUpsert | undefined {
    // Re-resolve the cwd so a branch switch shows up (GitResolver caches 5 s).
    const target = t.cwd && t.cwdTarget ? (this.classify(t.cwd) ?? t.cwdTarget) : t.lastTarget;
    const orchestrator =
      s.orchestrator && this.sessions.get(s.orchestrator)?.shared ? s.orchestrator : undefined;
    let activity: string | undefined;
    if (!ended && s.activity) {
      activity = t.label?.raw === s.activity ? t.label.hub : hubLabel(s.activity);
    }
    return conform(
      hubSessionUpsertSchema,
      {
        key: s.key,
        source: s.source,
        name: s.name,
        state: ended ? "ended" : s.state,
        activity,
        background: !ended && s.background ? true : undefined,
        agents: s.agents,
        phase: ended ? undefined : s.phase,
        orchestrator,
        repo: target?.repo,
        branch: target?.branch,
        issues: t.issues.length ? [...t.issues] : undefined,
        startedAt: s.startedAt,
        updatedAt: ended ?? s.updatedAt,
        stateSince: ended ?? s.stateSince,
      },
      SESSION_REQUIRED,
    );
  }

  /** Brings every tracked session's upsert in line with the store. */
  private reconcile(now: number): void {
    const live = new Map(this.listSessions().map((s) => [s.key, s]));
    for (const s of live.values()) {
      const t = this.track(s.key);
      t.last = s;
      if (s.cwd) this.setCwd(t, s.cwd);
      if (!t.shared && s.orchestrator && this.sessions.get(s.orchestrator)?.shared) {
        // Fan-out sessions (workflows) launched by a shared session carry no
        // paths of their own: they share with their orchestrator.
        const o = this.sessions.get(s.orchestrator)!;
        t.shared = true;
        t.lastTarget ??= o.cwdTarget ?? o.lastTarget;
      }
      if (t.shared) t.current = this.buildUpsert(s, t);
    }
    for (const [key, t] of this.sessions) {
      if (live.has(key)) continue;
      if (!t.shared || !t.last) {
        this.sessions.delete(key);
        continue;
      }
      if (t.current?.state !== "ended") t.current = this.buildUpsert(t.last, t, now);
    }
  }

  // --- sending -------------------------------------------------------------------

  /** One send cycle; `force` sends even when nothing changed (shutdown flush). */
  tick(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = this.tickUnsafe(force).catch((err: unknown) => {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log(`hub: send cycle failed: ${this.lastError}`);
    });
    this.inFlight = run.finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async tickUnsafe(force: boolean): Promise<void> {
    if (this.halted) return;
    const now = this.now();
    if (now < this.retryAt) return;
    this.reconcile(now);
    const full = now - this.lastFullAt >= this.heartbeatMs;
    const changed: Array<[Tracked, string]> = [];
    for (const t of this.sessions.values()) {
      if (!t.shared || !t.current) continue;
      const json = JSON.stringify(t.current);
      if (json !== t.sentJson || (full && t.current.state !== "ended")) changed.push([t, json]);
    }
    if (!full && !force && changed.length === 0 && this.queue.length === 0) return;

    changed.sort((a, b) => (b[0].current?.updatedAt ?? 0) - (a[0].current?.updatedAt ?? 0));
    const batchSessions = changed.slice(0, HUB_MAX_SESSIONS_PER_REQUEST);
    let n = Math.min(this.queue.length, this.maxEvents);
    let body = "";
    for (;;) {
      const req = hubIngestRequestSchema.safeParse({
        v: HUB_WIRE_VERSION,
        sentAt: now,
        full,
        sessions: batchSessions.map(([t]) => t.current),
        events: this.queue.slice(0, n),
      });
      if (!req.success) {
        // Every record was validated on its way in; this is a bug guard.
        this.log(`hub: batch failed the wire schema, dropping it: ${req.error.issues[0]?.message ?? ""}`);
        this.rejected += n;
        this.queue.splice(0, n);
        for (const [t, json] of batchSessions) t.sentJson = json;
        return;
      }
      body = JSON.stringify(req.data);
      if (Buffer.byteLength(body) <= HUB_MAX_BODY_BYTES || n === 0) break;
      n = Math.floor(n / 2);
    }
    const sentIds = new Set(this.queue.slice(0, n).map((e) => e.id));

    this.lastSendAt = now;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/relay/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        body,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      this.fail(`hub unreachable: ${err instanceof Error ? err.message : String(err)}`, now);
      return;
    }

    if (res.ok) {
      let accepted = sentIds.size;
      try {
        const parsed = (await res.json()) as { accepted?: unknown };
        if (typeof parsed.accepted === "number") accepted = parsed.accepted;
      } catch {
        // body is informational
      }
      this.queue = this.queue.filter((e) => !sentIds.has(e.id));
      for (const [t, json] of batchSessions) {
        t.sentJson = json;
        if (t.current?.state === "ended") this.sessions.delete(t.key);
      }
      if (full) this.lastFullAt = now;
      this.accepted += accepted;
      this.failures = 0;
      this.maxEvents = Math.min(HUB_MAX_EVENTS_PER_REQUEST, this.maxEvents * 2);
      this.lastSendOk = true;
      this.lastSuccessAt = now;
      this.lastError = undefined;
      return;
    }

    this.lastSendOk = false;
    const detail = await res.text().then(
      (text) => text.slice(0, 300),
      () => "",
    );
    if (res.status === 401) {
      this.halted = true;
      this.lastError = "device token rejected (401)";
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.log(
        `hub: ${this.url} rejected this device's token (401): forwarding stopped. ` +
          `Run \`agentblip hub connect ${this.url}\` to pair this machine again.`,
      );
      return;
    }
    if (res.status === 429) {
      const wait = parseRetryAfter(res.headers.get("retry-after"), now);
      this.retryAt = now + wait;
      this.lastError = `rate limited (429), retrying in ${Math.round(wait / 1000)}s`;
      this.log(`hub: ${this.lastError}`);
      return;
    }
    if (res.status === 400) {
      // The hub rejects the whole request; resending it would loop forever.
      this.queue = this.queue.filter((e) => !sentIds.has(e.id));
      this.rejected += sentIds.size;
      for (const [t, json] of batchSessions) t.sentJson = json;
      if (full) this.lastFullAt = now;
      this.lastError = `hub rejected a batch (400): ${detail}`;
      this.log(`hub: ${this.lastError}`);
      return;
    }
    if (res.status === 413) {
      if (n > 1) {
        this.maxEvents = Math.max(1, Math.floor(n / 2));
      } else {
        this.queue = this.queue.filter((e) => !sentIds.has(e.id));
        this.rejected += sentIds.size;
      }
      this.lastError = "batch too large (413), sending smaller batches";
      this.log(`hub: ${this.lastError}`);
      return;
    }
    this.fail(`hub responded ${res.status}${detail ? `: ${detail}` : ""}`, now);
  }

  private fail(message: string, now: number): void {
    this.failures += 1;
    this.lastSendOk = false;
    this.lastError = message;
    const wait = Math.min(1000 * 2 ** (this.failures - 1), MAX_BACKOFF_MS);
    this.retryAt = now + wait;
    if (this.failures === 1 || this.failures % 10 === 0) {
      this.log(`hub: ${message} (attempt ${this.failures}; ${this.queue.length} events queued)`);
    }
  }
}

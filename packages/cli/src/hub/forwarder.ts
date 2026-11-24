import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HUB_DESC_MAX,
  HUB_MAX_BODY_BYTES,
  HUB_MAX_DURATION_MS,
  HUB_MAX_EVENTS_PER_REQUEST,
  HUB_MAX_SESSIONS_PER_REQUEST,
  HUB_TEXT_MAX,
  HUB_WIRE_VERSION,
  hubActivityEventSchema,
  hubIngestRequestSchema,
  hubSessionUpsertSchema,
  isRepoRelativePath,
  truncateHead,
} from "@agentblip/core";
import type {
  AgentSession,
  HubActivityEvent,
  HubEventKind,
  HubProjectRule,
  HubSessionUpsert,
  HubShareLevel,
  SessionEvent,
} from "@agentblip/core";
import type { z } from "zod";
import { GitResolver } from "./git";
import { scrubText } from "./redact";
import {
  MAX_READ_BYTES,
  acceptClaudeTranscript,
  acceptCodexTranscript,
  defaultCodexSessionsDir,
  findCodexRollout,
  readTail,
  startTail,
} from "./transcript";
import type { TranscriptItem, TranscriptTail } from "./transcript";
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
 *
 * At the `conversation` sharing level (SPEC §8-9) it also sends prompt text,
 * the agent's text messages (tailed from the session transcript, from the
 * moment the session is shared), one-line tool descriptions and turn
 * durations: only for sessions whose cwd is in a shared repo, and only after
 * redaction on this machine. Transcript reads are async and bounded.
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
  /** SPEC §8 sharing level. Default `metadata`. */
  share?: HubShareLevel;
  /** Where Codex keeps rollout files (default ~/.codex/sessions). */
  codexSessionsDir?: string;
  /** How long a Stop waits for the transcript's turn-duration record. Default 5 s. */
  turnRecordWaitMs?: number;
  /** Bytes read from one transcript per pass. Default 2 MB. */
  maxReadBytes?: number;
  /** Queued event bytes kept while the hub is unreachable. Default 16 MB. */
  maxBufferBytes?: number;
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
  /** SPEC §8 sharing level this forwarder sends at. */
  share: HubShareLevel;
  /** Sessions whose conversation is being sent (cwd in a shared repo, conversation level). */
  conversationSessions: number;
  /** The hub refused message/turn events (an older hub): they are held back until this time. */
  conversationHeldUntil?: number;
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
  /** When this session started sending conversation text (SPEC §8: from that moment on). */
  convoSince?: number;
  /** Transcript tail while the conversation is shared. */
  tail?: TranscriptTail;
  /** New transcript bytes may be waiting. */
  tailDirty?: boolean;
  /** Codex: rollout lookup state when the hook gave no transcript path. */
  rolloutSearch?: { pending: boolean; nextAt: number; tries: number };
  /** Start of the current turn (the prompt), for the turn-duration fallback. */
  promptAt?: number;
  /** A Stop waiting for the transcript's turn-duration record. */
  pendingTurn?: { stopTs: number; promptAt?: number; deadline: number };
  /** A turn-duration record read before its Stop arrived (Codex writes it first). */
  turnRecord?: { durationMs: number; ts?: number };
  /** Transcript text blocks already sent (ids), bounded. */
  sentMessages?: Set<string>;
}

const SESSION_REQUIRED = new Set(["key", "source", "state", "startedAt", "updatedAt", "stateSince"]);
const EVENT_REQUIRED = new Set(["id", "key", "ts", "kind"]);
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 30_000;
/** Requests one tick may send while a backlog drains (the hub allows 300/min/device). */
const MAX_REQUESTS_PER_TICK = 4;
/** Bytes kept free in each request for JSON framing. */
const BODY_MARGIN_BYTES = 2048;
/** Queued event bytes kept while the hub is unreachable (text makes events large). */
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/** After a hub refuses message/turn events, try again this much later. */
const CONVERSATION_HOLD_MS = 10 * 60_000;
const CONVERSATION_KINDS: ReadonlySet<string> = new Set(["message", "turn"]);
/** Transcript message ids remembered per session (dedupe across re-reads). */
const MAX_SENT_MESSAGE_IDS = 2000;

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
  private readonly share: HubShareLevel;
  private readonly codexSessionsDir: string;
  private readonly turnRecordWaitMs: number;
  private readonly maxReadBytes: number;

  private readonly sessions = new Map<string, Tracked>();
  private queue: HubActivityEvent[] = [];
  /** JSON byte size of each queued event (batching stays under 256 KB). */
  private readonly sizes = new WeakMap<HubActivityEvent, number>();
  private queuedBytes = 0;
  private readonly maxBufferBytes: number;
  private conversationHeldUntil = 0;
  private pumpRun: Promise<void> | undefined;
  private pumpAgain = false;
  private pumpScheduled = false;
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
    this.share = opts.share ?? "metadata";
    this.codexSessionsDir = opts.codexSessionsDir ?? defaultCodexSessionsDir();
    this.turnRecordWaitMs = opts.turnRecordWaitMs ?? 5000;
    this.maxReadBytes = opts.maxReadBytes ?? MAX_READ_BYTES;
    this.maxBufferBytes = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
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
        // Turns still waiting for their record end now, with what is known.
        const now = this.now();
        for (const t of this.sessions.values()) if (t.pendingTurn) t.pendingTurn.deadline = now;
        await this.flushTranscripts(2);
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
      share: this.share,
      conversationSessions: [...this.sessions.values()].filter((t) => this.conversationShared(t)).length,
      conversationHeldUntil: this.conversationHeldUntil > this.now() ? this.conversationHeldUntil : undefined,
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

    // Tool names show only when this event is B3 work: the session's cwd is
    // shared, or the event touched a shared file (SPEC 3.3 rule 4).
    const toolNames = !!t.cwdTarget || sharedFiles.length > 0;
    const label = hubLabel(event.activity, new Set(sharedFiles.map((f) => path.basename(f.file))), {
      toolNames,
    });
    if (event.activity) t.label = { raw: event.activity, hub: label };

    if (!t.shared) return; // rule 3: unshared sessions send nothing
    // Conversation bookkeeping first: a prompt that makes the session shared
    // starts its conversation, so its own text is "from that moment on".
    this.conversationStep(event, t);
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
      // The person sent a message. Metadata level (and rule-4 sessions): the
      // text never leaves, the ids may. Conversation level: redacted text.
      const text = this.conversationShared(t) ? scrubText(d.prompt, { home: this.home, max: HUB_TEXT_MAX }) : undefined;
      return {
        ...base,
        kind: "prompt",
        repo: (t.cwdTarget ?? t.lastTarget)?.repo,
        branch: (t.cwdTarget ?? t.lastTarget)?.branch,
        issues: ctx.ids.length ? ctx.ids : undefined,
        text: text?.text,
        truncated: text?.truncated || undefined,
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
      desc: this.conversationShared(t) ? this.descOf(d.desc) : undefined,
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
      return cwdShared || this.conversationShared(t) ? { ...tool, label: ctx.label } : undefined;
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
      // Conversation level: the shell call still shows (desc, program +
      // subcommand), with no repo since it names no shared root.
      if (this.conversationShared(t)) return { ...tool, ...extras };
      return undefined;
    }

    if (cwdShared) return { ...tool, repo: t.cwdTarget?.repo, branch: t.cwdTarget?.branch };
    return this.conversationShared(t) ? { ...tool, repo: t.lastTarget?.repo, branch: t.lastTarget?.branch } : undefined;
  }

  private enqueue(raw: Omit<HubActivityEvent, "id">): void {
    const id = `${this.bootId}-${(this.seq++).toString(36)}`;
    const ev = conform(hubActivityEventSchema, { id, ...raw } as Record<string, unknown>, EVENT_REQUIRED);
    if (!ev) {
      this.log("hub: dropped an event that failed the wire schema");
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(ev));
    this.sizes.set(ev, bytes);
    this.queue.push(ev);
    this.queuedBytes += bytes;
    // Over the count or byte cap: drop the oldest, never the event just added.
    let over = Math.max(0, this.queue.length - this.maxBuffer);
    let freed = 0;
    for (let i = 0; i < over; i++) freed += this.sizes.get(this.queue[i]!) ?? 0;
    while (this.queuedBytes - freed > this.maxBufferBytes && over < this.queue.length - 1) {
      freed += this.sizes.get(this.queue[over]!) ?? 0;
      over++;
    }
    if (over > 0) this.removeQueued(this.queue.slice(0, over), true);
  }

  /** Takes events out of the queue (sent, refused, or dropped for space). */
  private removeQueued(events: readonly HubActivityEvent[], dropped = false): void {
    if (events.length === 0) return;
    const gone = new Set(events);
    this.queue = this.queue.filter((e) => !gone.has(e));
    for (const e of gone) this.queuedBytes -= this.sizes.get(e) ?? 0;
    if (dropped) this.dropped += gone.size;
  }

  // --- conversation (SPEC §8-9) --------------------------------------------------

  /**
   * Conversation text flows at the conversation level for every shared
   * session, from the moment it became shared (SPEC §8). That includes a
   * session shared through rule 4 (cwd outside every shared repo, e.g. an
   * orchestrator in ~/Documents that touched a shared repo): Sean, 11-24,
   * "set sharing to max ... default max sharing".
   */
  private conversationShared(t: Tracked): boolean {
    return this.share === "conversation" && t.shared;
  }

  /** A tool description the hub may see: redacted, one line, ≤ 200 chars. */
  private descOf(raw: string | undefined): string | undefined {
    const scrubbed = scrubText(raw?.replace(/\s+/g, " "), { home: this.home })?.text;
    if (!scrubbed) return undefined;
    return scrubbed.length > HUB_DESC_MAX ? `${truncateHead(scrubbed, HUB_DESC_MAX - 1)}…` : scrubbed;
  }

  /** Transcript, turn and fallback bookkeeping for one observed event. */
  private conversationStep(event: SessionEvent, t: Tracked): void {
    if (!this.conversationShared(t)) {
      // Left the shared repo, or never in it: forget the tail so text resumes
      // only from the moment it is shared again.
      t.tail = undefined;
      t.convoSince = undefined;
      t.pendingTurn = undefined;
      t.promptAt = undefined;
      return;
    }
    const now = this.now();
    const ts = event.ts ?? now;
    t.convoSince ??= ts;
    const d = event.detail;
    this.attachTranscript(event, t);
    if (d?.hookEvent === "UserPromptSubmit") {
      // A turn still waiting for its duration record ends now, with the fallback.
      if (t.pendingTurn) t.pendingTurn.deadline = now;
      t.promptAt = ts;
      t.turnRecord = undefined;
    }
    if (d?.hookEvent === "Stop") {
      // No tail (Codex thread in SQLite, no transcript path): the Stop
      // payload's final message stands in, if this turn began while shared.
      if (!t.tail && d.lastAssistantMessage && t.promptAt !== undefined && t.promptAt >= (t.convoSince ?? Infinity)) {
        this.enqueueMessage(t, d.lastAssistantMessage, ts);
      }
      t.pendingTurn = { stopTs: ts, promptAt: t.promptAt, deadline: now + (t.tail ? this.turnRecordWaitMs : 0) };
      t.promptAt = undefined;
    }
    if (event.kind === "end" && t.pendingTurn) t.pendingTurn.deadline = now;
    t.tailDirty = true;
    this.schedulePump();
  }

  /** Starts (or moves) the session's transcript tail from the file's current end. */
  private attachTranscript(event: SessionEvent, t: Tracked): void {
    const codex = event.source === "codex";
    const raw = event.detail?.transcriptPath;
    const file = codex ? acceptCodexTranscript(raw, event.sessionId) : acceptClaudeTranscript(raw);
    if (file) {
      if (t.tail?.path !== file) t.tail = startTail(file, codex ? "codex" : "claude-code");
      return;
    }
    if (!codex || t.tail) return;
    // Codex without a transcript path: look for the rollout file (async).
    const search = (t.rolloutSearch ??= { pending: false, nextAt: 0, tries: 0 });
    const now = this.now();
    if (search.pending || now < search.nextAt || search.tries >= 20) return;
    search.pending = true;
    search.tries += 1;
    const id = event.sessionId;
    void findCodexRollout(this.codexSessionsDir, id)
      .then((found) => {
        search.pending = false;
        if (!found) {
          // Newer Codex keeps threads in SQLite: no file to tail. The Stop
          // payload's last message is the fallback.
          search.nextAt = this.now() + 30_000;
          return;
        }
        if (!t.tail && this.conversationShared(t)) {
          t.tail = startTail(found, "codex");
          t.tailDirty = true;
        }
      })
      .catch(() => {
        search.pending = false;
        search.nextAt = this.now() + 30_000;
      });
  }

  private enqueueMessage(t: Tracked, raw: string, ts: number): void {
    const text = scrubText(raw, { home: this.home, max: HUB_TEXT_MAX });
    if (!text) return;
    this.enqueue({
      key: t.key,
      ts: Math.round(ts),
      kind: "message",
      text: text.text,
      truncated: text.truncated || undefined,
      repo: t.cwdTarget?.repo,
      branch: t.cwdTarget?.branch,
    });
  }

  private emitTurn(t: Tracked, stopTs: number, durationMs: number | undefined): void {
    const ms = durationMs !== undefined && durationMs >= 0 && durationMs <= HUB_MAX_DURATION_MS ? Math.round(durationMs) : undefined;
    this.enqueue({
      key: t.key,
      ts: Math.round(stopTs),
      kind: "turn",
      durationMs: ms,
      repo: t.cwdTarget?.repo,
      branch: t.cwdTarget?.branch,
    });
  }

  private handleItem(t: Tracked, item: TranscriptItem): void {
    if (!this.conversationShared(t)) return;
    if (item.kind === "message") {
      const seen = (t.sentMessages ??= new Set());
      if (seen.has(item.id)) return;
      seen.add(item.id);
      if (seen.size > MAX_SENT_MESSAGE_IDS) seen.delete(seen.values().next().value as string);
      this.enqueueMessage(t, item.text, item.ts ?? this.now());
      return;
    }
    if (t.pendingTurn) {
      this.emitTurn(t, t.pendingTurn.stopTs, item.durationMs);
      t.pendingTurn = undefined;
      t.turnRecord = undefined;
    } else {
      t.turnRecord = { durationMs: item.durationMs, ts: item.ts };
    }
  }

  /**
   * Settles Stops: at once when the turn's record is already in hand (Codex
   * writes task_complete before its Stop hook), else after the wait, falling
   * back to prompt → stop when the record never came.
   */
  private finalizeTurns(now: number): void {
    for (const t of this.sessions.values()) {
      const p = t.pendingTurn;
      if (!p || (now < p.deadline && !t.turnRecord)) continue;
      t.pendingTurn = undefined;
      if (!this.conversationShared(t)) continue;
      let ms: number | undefined;
      if (t.turnRecord && (p.promptAt === undefined || (t.turnRecord.ts ?? p.stopTs) >= p.promptAt)) {
        ms = t.turnRecord.durationMs;
      } else if (p.promptAt !== undefined) {
        ms = p.stopTs - p.promptAt;
      }
      t.turnRecord = undefined;
      this.emitTurn(t, p.stopTs, ms);
    }
  }

  /** Runs a transcript pass soon, off the hook response path. */
  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      void this.pump();
    });
  }

  /** One transcript pass at a time; a request during a pass queues one more. */
  private pump(): Promise<void> {
    if (this.pumpRun) {
      this.pumpAgain = true;
      return this.pumpRun;
    }
    this.pumpRun = this.pumpOnce()
      .catch((err: unknown) => this.log(`hub: transcript read failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.pumpRun = undefined;
        if (this.pumpAgain) {
          this.pumpAgain = false;
          this.schedulePump();
        }
      });
    return this.pumpRun;
  }

  /** Reads each dirty tail once (≤ maxReadBytes each), then settles due turns. */
  private async pumpOnce(): Promise<void> {
    for (const t of [...this.sessions.values()]) {
      if (!t.tail || (!t.tailDirty && !t.pendingTurn)) continue;
      t.tailDirty = false;
      const tail = t.tail;
      const res = await readTail(tail, this.maxReadBytes);
      if (t.tail !== tail) continue; // moved while reading
      if (res.reset) this.log(`hub: a transcript was ${res.reset}; reading from its new end`);
      for (const item of res.items) this.handleItem(t, item);
      if (res.more) {
        t.tailDirty = true;
        this.pumpAgain = true;
      }
    }
    this.finalizeTurns(this.now());
  }

  /** Test and shutdown hook: transcript passes until nothing is left (bounded). */
  async flushTranscripts(maxPasses = 50): Promise<void> {
    for (let i = 0; i < maxPasses; i++) {
      await this.pump();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const busy = [...this.sessions.values()].some((t) => t.tailDirty || t.rolloutSearch?.pending);
      if (!busy && !this.pumpRun && !this.pumpScheduled) {
        this.finalizeTurns(this.now());
        return;
      }
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
      activity =
        t.label?.raw === s.activity ? t.label.hub : hubLabel(s.activity, new Set(), { toolNames: !!t.cwdTarget });
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
    // Transcript reads first (bounded, async), so a turn's last message rides
    // in the same batch as its turn event.
    if ([...this.sessions.values()].some((t) => t.tailDirty || t.pendingTurn)) await this.pump();
    const now = this.now();
    if (now < this.retryAt) return;
    this.reconcile(now);
    for (let round = 0; round < MAX_REQUESTS_PER_TICK; round++) {
      const full = round === 0 && now - this.lastFullAt >= this.heartbeatMs;
      const changed: Array<[Tracked, string]> = [];
      for (const t of this.sessions.values()) {
        if (!t.shared || !t.current) continue;
        const json = JSON.stringify(t.current);
        if (json !== t.sentJson || (full && t.current.state !== "ended")) changed.push([t, json]);
      }
      if (!full && !(force && round === 0) && changed.length === 0 && this.queue.length === 0) return;
      const more = await this.sendOnce(now, full, changed);
      if (!more || this.queue.length === 0 || this.halted) return;
    }
  }

  /**
   * Picks the events for one request: oldest first, under the event cap and
   * the 256 KB body limit, message/turn events skipped while an older hub is
   * refusing them.
   */
  private pickEvents(budgetBytes: number, now: number): { events: HubActivityEvent[]; held: HubActivityEvent[] } {
    const holding = now < this.conversationHeldUntil;
    const events: HubActivityEvent[] = [];
    const held: HubActivityEvent[] = [];
    let bytes = 0;
    for (const e of this.queue) {
      if (events.length >= this.maxEvents) break;
      if (holding && CONVERSATION_KINDS.has(e.kind)) {
        held.push(e);
        continue;
      }
      const size = (this.sizes.get(e) ?? Buffer.byteLength(JSON.stringify(e))) + 1;
      if (bytes + size > budgetBytes && events.length > 0) break;
      events.push(e);
      bytes += size;
    }
    return { events, held };
  }

  /** One ingest request. True when it succeeded (the caller may send another). */
  private async sendOnce(now: number, fullWanted: boolean, changed: Array<[Tracked, string]>): Promise<boolean> {
    changed.sort((a, b) => (b[0].current?.updatedAt ?? 0) - (a[0].current?.updatedAt ?? 0));
    const limit = HUB_MAX_BODY_BYTES - BODY_MARGIN_BYTES;
    // Sessions first: they are small, and a full heartbeat must list them all.
    let batchSessions = changed.slice(0, HUB_MAX_SESSIONS_PER_REQUEST);
    let full = fullWanted && batchSessions.length === changed.length;
    const frame = (sessions: Array<[Tracked, string]>, isFull: boolean): number =>
      Buffer.byteLength(
        JSON.stringify({ v: HUB_WIRE_VERSION, sentAt: now, share: this.share, full: isFull, sessions: sessions.map(([t]) => t.current), events: [] }),
      );
    let overhead = frame(batchSessions, full);
    while (overhead > limit / 2 && batchSessions.length > 1) {
      // A huge session set: send part now, the full heartbeat on a later tick.
      batchSessions = batchSessions.slice(0, Math.ceil(batchSessions.length / 2));
      full = false;
      overhead = frame(batchSessions, false);
    }
    const { events, held } = this.pickEvents(limit - overhead, now);
    if (held.length > 0) {
      // An older hub refused these kinds; it may be upgraded later, but text
      // waiting for it must not pile up. Count and drop.
      this.removeQueued(held);
      this.rejected += held.length;
    }
    // Oldest first by time: transcript messages are read a beat after the
    // hook events around them.
    const ordered = [...events].sort((a, b) => a.ts - b.ts);
    const req = hubIngestRequestSchema.safeParse({
      v: HUB_WIRE_VERSION,
      sentAt: now,
      share: this.share,
      full,
      sessions: batchSessions.map(([t]) => t.current),
      events: ordered,
    });
    if (!req.success) {
      // Every record was validated on its way in; this is a bug guard.
      this.log(`hub: batch failed the wire schema, dropping it: ${req.error.issues[0]?.message ?? ""}`);
      this.rejected += events.length;
      this.removeQueued(events);
      for (const [t, json] of batchSessions) t.sentJson = json;
      return false;
    }
    const body = JSON.stringify(req.data);

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
      return false;
    }

    if (res.ok) {
      let accepted = events.length;
      try {
        const parsed = (await res.json()) as { accepted?: unknown };
        if (typeof parsed.accepted === "number") accepted = parsed.accepted;
      } catch {
        // body is informational
      }
      this.removeQueued(events);
      for (const [t, json] of batchSessions) {
        t.sentJson = json;
        if (t.current?.state === "ended") {
          this.sessions.delete(t.key);
        }
      }
      if (full) this.lastFullAt = now;
      this.accepted += accepted;
      this.failures = 0;
      this.maxEvents = Math.min(HUB_MAX_EVENTS_PER_REQUEST, this.maxEvents * 2);
      this.lastSendOk = true;
      this.lastSuccessAt = now;
      this.lastError = undefined;
      return true;
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
      return false;
    }
    if (res.status === 429) {
      const wait = parseRetryAfter(res.headers.get("retry-after"), now);
      this.retryAt = now + wait;
      this.lastError = `rate limited (429), retrying in ${Math.round(wait / 1000)}s`;
      this.log(`hub: ${this.lastError}`);
      return false;
    }
    if (res.status === 400) {
      const convo = events.filter((e) => CONVERSATION_KINDS.has(e.kind));
      if (convo.length > 0 && now >= this.conversationHeldUntil) {
        // Likely a hub from before SPEC §10 (its kind enum has no message or
        // turn): drop those, hold them back for a while, resend the rest.
        this.conversationHeldUntil = now + CONVERSATION_HOLD_MS;
        this.removeQueued(convo);
        this.rejected += convo.length;
        this.lastError = `hub rejected conversation events (400), holding them for ${CONVERSATION_HOLD_MS / 60_000} min: ${detail}`;
        this.log(`hub: ${this.lastError}`);
        return false;
      }
      // The hub rejects the whole request; resending it would loop forever.
      this.removeQueued(events);
      this.rejected += events.length;
      for (const [t, json] of batchSessions) t.sentJson = json;
      if (full) this.lastFullAt = now;
      this.lastError = `hub rejected a batch (400): ${detail}`;
      this.log(`hub: ${this.lastError}`);
      return false;
    }
    if (res.status === 413) {
      if (events.length > 1) {
        this.maxEvents = Math.max(1, Math.floor(events.length / 2));
      } else {
        this.removeQueued(events);
        this.rejected += events.length;
      }
      this.lastError = "batch too large (413), sending smaller batches";
      this.log(`hub: ${this.lastError}`);
      return false;
    }
    this.fail(`hub responded ${res.status}${detail ? `: ${detail}` : ""}`, now);
    return false;
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

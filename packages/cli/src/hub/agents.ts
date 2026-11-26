import fs from "node:fs";
import path from "node:path";
import { HUB_MAX_USAGE_MODELS } from "@workmesh/protocol";
import type { HubModelUsage, HubSessionUsage, HubTasks } from "@workmesh/protocol";
import { TaskSet, applyToTasks, claudeMirrorItems, claudeMirrorLine } from "./mirror";
import type { TaskKind } from "./mirror";

/**
 * Local readers behind v0.6's session structure (docs/SPEC.md §15): who a
 * session's subagents are, what they're for, which model they run and how
 * many tokens they used. Everything here reads files the agents already keep
 * on this machine, asynchronously and bounded; only the reduced numbers and
 * ids it returns ever reach the hub forwarder (titles are redacted there and
 * sent at the conversation level only).
 *
 * Shapes, read from real files on Claude Code 2.1.331 and Codex 0.164 (keys
 * and types only, never content):
 * - Claude Code keeps a subagent's transcript at
 *   `<projects>/<slug>/<session>/subagents/agent-<agentId>.jsonl` and, beside
 *   it, `agent-<agentId>.meta.json` with `agentType`, `description` (the task
 *   the parent gave it), `toolUseId`, `model` (an alias), `requestShape`.
 *   Its `assistant` lines carry `message.id`, `message.model` and
 *   `message.usage` (`input_tokens`, `cache_creation_input_tokens`,
 *   `cache_read_input_tokens`, `output_tokens`); a message split into several
 *   lines (one per content block) repeats the same id and usage.
 * - Codex writes each spawned thread's rollout with a first `session_meta`
 *   line whose `payload.source.subagent.thread_spawn` holds `parent_thread_id`,
 *   `agent_role`, `agent_nickname`, `agent_path`, `depth`; `event_msg`
 *   `token_count` lines carry cumulative `info.total_token_usage`
 *   (`input_tokens`, `output_tokens`, …) and `turn_context` lines the `model`.
 */

/**
 * Token use as Claude Code shows it per agent: `tokensIn` is the agent's
 * context now (the input, cache reads and cache writes of its latest model
 * call), `tokensOut` what it has generated so far (output summed over its
 * calls). Claude Code's own per-agent "tokens" figure (the Agent result's
 * `totalTokens`) is tokensIn plus the latest call's output: verified against
 * six finished subagents on this machine.
 */
export interface Usage {
  tokensIn: number;
  tokensOut: number;
  model?: string;
  /** v0.11 (SPEC §26): a Claude Code agent's own background tasks running now (launches minus ending notices). */
  tasks?: HubTasks;
  /** SPEC §45: every token kind by model since the transcript began, as the wire sends it. */
  full?: HubSessionUsage;
}

/** SPEC §45: one model's running totals. */
export interface ModelTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
  calls: number;
}

const KINDS = ["input", "cacheRead", "cacheWrite", "cacheWrite1h", "output", "reasoning", "calls"] as const;
const zeroTotals = (): ModelTotals => ({ input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, calls: 0 });

/** SPEC §45: token totals by model, added to and taken from as calls are read, sent as `usage.models`. */
export class UsageTotals {
  private readonly byModel = new Map<string, ModelTotals>();

  get size(): number {
    return this.byModel.size;
  }

  add(model: string, t: Partial<ModelTotals>, sign: 1 | -1 = 1): void {
    const cur = this.byModel.get(model) ?? zeroTotals();
    for (const k of KINDS) cur[k] = Math.max(0, cur[k] + sign * (t[k] ?? 0));
    this.byModel.set(model, cur);
  }

  merge(other: UsageTotals): void {
    for (const [model, t] of other.byModel) this.add(model, t);
  }

  clear(): void {
    this.byModel.clear();
  }

  /**
   * The wire form: one entry per model, the biggest first, at most HUB_MAX_USAGE_MODELS; optional parts only when
   * there are any. `at` = when the latest call counted was made.
   */
  toWire(at?: number): HubSessionUsage {
    const size = (t: ModelTotals) => t.input + t.cacheRead + t.cacheWrite + t.output;
    const models: HubModelUsage[] = [...this.byModel]
      .sort((a, b) => size(b[1]) - size(a[1]))
      .slice(0, HUB_MAX_USAGE_MODELS)
      .map(([model, t]) => ({
        model,
        input: t.input,
        cacheRead: t.cacheRead,
        cacheWrite: t.cacheWrite,
        ...(t.cacheWrite1h ? { cacheWrite1h: Math.min(t.cacheWrite1h, t.cacheWrite) } : {}),
        output: t.output,
        ...(t.reasoning ? { reasoning: Math.min(t.reasoning, t.output) } : {}),
        ...(t.calls ? { calls: t.calls } : {}),
      }));
    return at !== undefined && Number.isFinite(at) && at > 0 ? { models, at: Math.round(at) } : { models };
  }

  /** For the forwarder's state file. */
  export(): Record<string, ModelTotals> {
    return Object.fromEntries([...this.byModel].map(([m, t]) => [m, { ...t }]));
  }

  /** Reads a saved form back; anything malformed is skipped. */
  static from(raw: unknown): UsageTotals {
    const out = new UsageTotals();
    if (!raw || typeof raw !== "object") return out;
    for (const [model, t] of Object.entries(raw as Record<string, unknown>)) {
      if (!cleanModel(model) || !t || typeof t !== "object") continue;
      const v = t as Record<string, unknown>;
      out.add(model, Object.fromEntries(KINDS.map((k) => [k, finiteInt(v[k])])) as unknown as ModelTotals);
    }
    return out;
  }
}

/** Sums several readers' wire usage (a workflow's agents): per model, the latest `at`. */
export function mergeUsage(parts: ReadonlyArray<HubSessionUsage | undefined>): HubSessionUsage | undefined {
  const totals = new UsageTotals();
  let at: number | undefined;
  let any = false;
  for (const p of parts) {
    if (!p) continue;
    any = true;
    for (const m of p.models) totals.add(m.model, m);
    if (p.at !== undefined) at = Math.max(at ?? 0, p.at);
  }
  return any ? totals.toWire(at) : undefined;
}

const MODEL_RE = /^[\w.:@/-]{1,80}$/;
const MAX_LINE_BYTES = 4 * 1024 * 1024;

function finiteInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function cleanModel(v: unknown): string | undefined {
  return typeof v === "string" && v !== "<synthetic>" && MODEL_RE.test(v) ? v : undefined;
}

/** The subagents dir of a Claude Code main-thread transcript (`…/<session>.jsonl` → `…/<session>/subagents`). */
export function claudeSubagentsDir(parentTranscript: string | undefined): string | undefined {
  if (!parentTranscript || !path.isAbsolute(parentTranscript) || !parentTranscript.endsWith(".jsonl")) return undefined;
  if (parentTranscript.split(path.sep).includes("subagents")) return undefined;
  return path.join(path.dirname(parentTranscript), path.basename(parentTranscript, ".jsonl"), "subagents");
}

export interface ClaudeSubagentMeta {
  agentType?: string;
  /** The task the parent gave it (raw: the forwarder redacts it, conversation level only). */
  description?: string;
  /** "background" for run_in_background agents. */
  requestShape?: string;
  /** A workflow's agent (the workflow watcher reports those). */
  inWorkflowRun?: boolean;
}

/** Reads `agent-<id>.meta.json` (≤ 64 KB). Undefined when missing or unreadable. */
export async function readClaudeSubagentMeta(file: string): Promise<ClaudeSubagentMeta | undefined> {
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size > 64 * 1024) return undefined;
    const raw = JSON.parse(await fs.promises.readFile(file, "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return undefined;
    const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
    return {
      agentType: str(raw.agentType)?.slice(0, 64),
      description: str(raw.description)?.slice(0, 2000),
      requestShape: str(raw.requestShape)?.slice(0, 40),
      inWorkflowRun: raw.inWorkflowRun === true || raw.inWorkflowRun === "true" ? true : undefined,
    };
  } catch {
    return undefined;
  }
}

interface FileCursor {
  offset: number;
  ino?: number;
  skipping: boolean;
}

/**
 * Reads complete lines appended since `cur.offset`, at most `maxBytes` per
 * call. A replaced or truncated file restarts at 0 (usage is metadata; there is
 * no "from the moment it was shared" rule for counts).
 */
async function readNewLines(
  file: string,
  cur: FileCursor,
  maxBytes: number,
): Promise<{ lines: string[]; more: boolean; restarted: boolean } | undefined> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(file, "r");
    const st = await fh.stat();
    let restarted = false;
    if ((cur.ino !== undefined && st.ino !== cur.ino) || st.size < cur.offset) {
      cur.offset = 0;
      cur.skipping = false;
      restarted = true;
    }
    cur.ino = st.ino;
    if (st.size === cur.offset) return { lines: [], more: false, restarted };
    const len = Math.min(st.size - cur.offset, maxBytes);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, cur.offset);
    const chunk = buf.subarray(0, bytesRead);
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl < 0) {
      if (bytesRead >= maxBytes) {
        cur.offset += bytesRead;
        cur.skipping = true;
        return { lines: [], more: true, restarted };
      }
      return { lines: [], more: false, restarted };
    }
    let start = 0;
    if (cur.skipping) {
      start = chunk.indexOf(0x0a) + 1;
      cur.skipping = false;
    }
    const text = chunk.subarray(start, lastNl).toString("utf8");
    cur.offset += lastNl + 1;
    return { lines: text.split("\n").filter(Boolean), more: st.size > cur.offset, restarted };
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** What a Claude Code usage reader keeps across a daemon restart (SPEC §45: never read a file twice). */
export interface ClaudeUsageState {
  offset: number;
  ino?: number;
  skipping?: boolean;
  totals?: Record<string, ModelTotals>;
  /** The latest message ids with what they counted (a message's lines can straddle two reads). */
  recent?: Array<[id: string, model: string, counted: Partial<ModelTotals>]>;
  latestIn?: number;
  out?: number;
  model?: string;
  at?: number;
  tasks?: Array<{ id: string; kind: string }>;
}

export interface ClaudeUsageReaderOptions {
  /** Bytes read per pass (default 2 MB). */
  maxReadBytes?: number;
  /** Message ids remembered for the once-per-message rule (lines of one message are adjacent; default 64). */
  maxIds?: number;
  /**
   * A main thread's transcript: sidechain lines (older Claude Code wrote subagents' calls there) are skipped, since a
   * subagent's own file counts them, and background tasks are left to the session mirror.
   */
  mainThread?: boolean;
  /** Carry on from a saved state (same file). */
  state?: ClaudeUsageState;
}

const SAVED_RECENT_IDS = 8;

/**
 * Token use of one Claude Code transcript (see Usage), read incrementally from the start: each pass reads only new
 * complete lines, at most `maxReadBytes`. A message split into several lines (one per content block) repeats its id
 * and usage: it counts once, at its latest line's figures. SPEC §45: every kind by model (`full`), beside v0.6's
 * context-now and output totals.
 */
export class ClaudeUsageReader {
  private readonly cur: FileCursor = { offset: 0, skipping: false };
  private readonly recent = new Map<string, { model?: string; counted: ModelTotals }>();
  private readonly sums = new UsageTotals();
  /** Output over every counted line (v0.6 `tokensOut`, also lines with no model to price). */
  private out = 0;
  /** Context of the latest call. */
  private latestIn = 0;
  private model: string | undefined;
  /** When the latest counted call was made (the assistant line's timestamp). */
  private at: number | undefined;
  /** v0.11: the agent's own background tasks (its transcript is read from the start, so the count is complete). */
  private readonly tasks = new TaskSet();
  private readonly maxReadBytes: number;
  private readonly maxIds: number;
  readonly mainThread: boolean;

  constructor(
    readonly file: string,
    opts: ClaudeUsageReaderOptions = {},
  ) {
    this.maxReadBytes = opts.maxReadBytes ?? 2 * 1024 * 1024;
    this.maxIds = Math.max(1, opts.maxIds ?? 64);
    this.mainThread = opts.mainThread === true;
    if (opts.state) this.restore(opts.state);
  }

  /** Reads what's new; `more` = data past this pass's cap is waiting. Undefined when unreadable. */
  async read(): Promise<(Usage & { more: boolean }) | undefined> {
    const res = await readNewLines(this.file, this.cur, this.maxReadBytes);
    if (!res) return undefined;
    if (res.restarted) this.reset();
    for (const line of res.lines) this.take(line);
    return { ...this.totals(), more: res.more };
  }

  totals(): Usage {
    return {
      tokensIn: this.latestIn,
      tokensOut: this.out,
      model: this.model,
      tasks: this.mainThread ? undefined : this.tasks.counts(),
      full: this.sums.toWire(this.at),
    };
  }

  /** What a restart needs to carry on from here. */
  exportState(): ClaudeUsageState {
    const recent = [...this.recent].slice(-SAVED_RECENT_IDS).map(([id, r]) => [id, r.model ?? "", { ...r.counted }] as [string, string, ModelTotals]);
    return {
      offset: this.cur.offset,
      ...(this.cur.ino !== undefined ? { ino: this.cur.ino } : {}),
      ...(this.cur.skipping ? { skipping: true } : {}),
      totals: this.sums.export(),
      recent,
      latestIn: this.latestIn,
      out: this.out,
      ...(this.model ? { model: this.model } : {}),
      ...(this.at !== undefined ? { at: this.at } : {}),
      ...(this.mainThread || !this.tasks.size ? {} : { tasks: this.tasks.entries() }),
    };
  }

  private restore(st: ClaudeUsageState): void {
    if (typeof st.offset !== "number" || !Number.isFinite(st.offset) || st.offset < 0) return;
    this.cur.offset = Math.floor(st.offset);
    if (typeof st.ino === "number") this.cur.ino = st.ino;
    this.cur.skipping = st.skipping === true;
    this.sums.merge(UsageTotals.from(st.totals));
    if (Array.isArray(st.recent)) {
      for (const r of st.recent.slice(-this.maxIds)) {
        if (!Array.isArray(r) || typeof r[0] !== "string") continue;
        const counted = zeroTotals();
        const c = (r[2] ?? {}) as Record<string, unknown>;
        for (const k of KINDS) counted[k] = finiteInt(c[k]);
        this.recent.set(r[0], { model: cleanModel(r[1]), counted });
      }
    }
    this.latestIn = finiteInt(st.latestIn);
    this.out = finiteInt(st.out);
    this.model = cleanModel(st.model);
    this.at = typeof st.at === "number" && st.at > 0 ? st.at : undefined;
    if (!this.mainThread && Array.isArray(st.tasks)) {
      for (const t of st.tasks) if (t && typeof t.id === "string" && TASK_KIND_SET.has(t.kind)) this.tasks.add(t.id, t.kind as TaskKind);
    }
  }

  private reset(): void {
    this.recent.clear();
    this.sums.clear();
    this.out = 0;
    this.latestIn = 0;
    this.at = undefined;
    this.tasks.replace([]);
  }

  /** v0.11: background launches (structured tool results) and the notices that end them; counts only. */
  private takeTasks(line: string): boolean {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return true;
    }
    if (!e || typeof e !== "object" || e.type !== "user") return false;
    for (const item of claudeMirrorItems(e, undefined)) applyToTasks(this.tasks, item);
    return true;
  }

  private take(line: string): void {
    if (line.length > MAX_LINE_BYTES) return;
    if (!this.mainThread && claudeMirrorLine(line) && this.takeTasks(line)) return;
    if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
    let e: {
      type?: unknown;
      isApiErrorMessage?: unknown;
      isSidechain?: unknown;
      timestamp?: unknown;
      message?: { id?: unknown; model?: unknown; usage?: unknown };
    };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      return;
    }
    if (e?.type !== "assistant" || e.isApiErrorMessage === true) return;
    if (this.mainThread && e.isSidechain === true) return;
    const m = e.message;
    const u = m?.usage as Record<string, unknown> | undefined;
    if (!m || !u || typeof u !== "object") return;
    const model = cleanModel(m.model);
    if (model) this.model = model;
    const cacheWrite = finiteInt(u.cache_creation_input_tokens);
    const split = u.cache_creation as Record<string, unknown> | undefined;
    const counted: ModelTotals = {
      input: finiteInt(u.input_tokens),
      cacheRead: finiteInt(u.cache_read_input_tokens),
      cacheWrite,
      cacheWrite1h: Math.min(cacheWrite, finiteInt(split && typeof split === "object" ? split.ephemeral_1h_input_tokens : 0)),
      output: finiteInt(u.output_tokens),
      reasoning: 0,
      calls: 1,
    };
    this.latestIn = counted.input + counted.cacheWrite + counted.cacheRead;
    const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : Number.NaN;
    if (Number.isFinite(ts) && ts > 0) this.at = Math.max(this.at ?? 0, ts);
    const id = typeof m.id === "string" ? m.id : undefined;
    if (id) {
      const prev = this.recent.get(id);
      if (prev) {
        // Another line of the same message: replace what it counted.
        this.out -= prev.counted.output;
        if (prev.model) this.sums.add(prev.model, prev.counted, -1);
        this.recent.delete(id); // re-insert: newest last, so eviction drops the oldest
      }
      this.recent.set(id, { model, counted });
      while (this.recent.size > this.maxIds) this.recent.delete(this.recent.keys().next().value as string);
    }
    this.out += counted.output;
    if (model) this.sums.add(model, counted);
  }
}

const TASK_KIND_SET: ReadonlySet<string> = new Set(["shells", "monitors", "agents", "workflows", "other"]);

/** What a Codex usage reader keeps across a daemon restart. */
export interface CodexUsageState {
  offset: number;
  ino?: number;
  skipping?: boolean;
  totals?: Record<string, ModelTotals>;
  /** The thread's cumulative counters at the last `token_count` read. */
  last?: Partial<CodexCounters>;
  latestIn?: number;
  model?: string;
  at?: number;
}

interface CodexCounters {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

/**
 * A Codex thread's token use (see Usage) from its rollout, read incrementally from the start. `token_count` lines
 * carry the thread's cumulative `total_token_usage` (cached input and cache writes inside `input_tokens`, reasoning
 * inside `output_tokens`); SPEC §45 credits the growth between two of them to the model of the latest `turn_context`
 * before it. v0.6's `tokensIn` is the last call's input (its context now), `tokensOut` the cumulative output.
 */
export class CodexUsageReader {
  private readonly cur: FileCursor = { offset: 0, skipping: false };
  private readonly sums = new UsageTotals();
  private last: CodexCounters | undefined;
  private latestIn = 0;
  private model: string | undefined;
  private at: number | undefined;
  private readonly maxReadBytes: number;

  constructor(
    readonly file: string,
    opts: { maxReadBytes?: number; state?: CodexUsageState } = {},
  ) {
    this.maxReadBytes = opts.maxReadBytes ?? 2 * 1024 * 1024;
    if (opts.state) this.restore(opts.state);
  }

  async read(): Promise<(Usage & { more: boolean }) | undefined> {
    const res = await readNewLines(this.file, this.cur, this.maxReadBytes);
    if (!res) return undefined;
    if (res.restarted) {
      this.sums.clear();
      this.last = undefined;
      this.latestIn = 0;
      this.at = undefined;
    }
    for (const line of res.lines) this.take(line);
    return { ...this.totals(), more: res.more };
  }

  totals(): Usage {
    return { tokensIn: this.latestIn, tokensOut: this.last?.output ?? 0, model: this.model, full: this.sums.toWire(this.at) };
  }

  exportState(): CodexUsageState {
    return {
      offset: this.cur.offset,
      ...(this.cur.ino !== undefined ? { ino: this.cur.ino } : {}),
      ...(this.cur.skipping ? { skipping: true } : {}),
      totals: this.sums.export(),
      ...(this.last ? { last: { ...this.last } } : {}),
      latestIn: this.latestIn,
      ...(this.model ? { model: this.model } : {}),
      ...(this.at !== undefined ? { at: this.at } : {}),
    };
  }

  private restore(st: CodexUsageState): void {
    if (typeof st.offset !== "number" || !Number.isFinite(st.offset) || st.offset < 0) return;
    this.cur.offset = Math.floor(st.offset);
    if (typeof st.ino === "number") this.cur.ino = st.ino;
    this.cur.skipping = st.skipping === true;
    this.sums.merge(UsageTotals.from(st.totals));
    if (st.last && typeof st.last === "object") {
      const l = st.last as Record<string, unknown>;
      this.last = { input: finiteInt(l.input), cached: finiteInt(l.cached), cacheWrite: finiteInt(l.cacheWrite), output: finiteInt(l.output), reasoning: finiteInt(l.reasoning) };
    }
    this.latestIn = finiteInt(st.latestIn);
    this.model = cleanModel(st.model);
    this.at = typeof st.at === "number" && st.at > 0 ? st.at : undefined;
  }

  private take(line: string): void {
    if (line.length > MAX_LINE_BYTES) return;
    const isCount = line.includes('"token_count"');
    const isContext = line.includes('"turn_context"');
    if (!isCount && !isContext) return;
    let e: { type?: unknown; timestamp?: unknown; payload?: Record<string, unknown> };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      return;
    }
    const p = e?.payload;
    if (!p || typeof p !== "object") return;
    if (e.type === "turn_context") {
      this.model = cleanModel(p.model) ?? this.model;
      return;
    }
    if (e.type !== "event_msg" || p.type !== "token_count") return;
    const info = p.info as { total_token_usage?: Record<string, unknown>; last_token_usage?: Record<string, unknown> } | null | undefined;
    const total = info?.total_token_usage;
    if (!total || typeof total !== "object") return; // a rate-limit-only update
    const now: CodexCounters = {
      input: finiteInt(total.input_tokens),
      cached: finiteInt(total.cached_input_tokens),
      cacheWrite: finiteInt(total.cache_write_input_tokens),
      output: finiteInt(total.output_tokens),
      reasoning: finiteInt(total.reasoning_output_tokens),
    };
    const last = info?.last_token_usage;
    this.latestIn = finiteInt(last && typeof last === "object" ? last.input_tokens : total.input_tokens);
    const prev = this.last ?? { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
    this.last = now;
    if (now.input < prev.input || now.output < prev.output || now.cached < prev.cached) return; // counters restarted: a new baseline
    const d = {
      input: now.input - prev.input,
      cached: now.cached - prev.cached,
      cacheWrite: Math.max(0, now.cacheWrite - prev.cacheWrite),
      output: now.output - prev.output,
      reasoning: Math.max(0, now.reasoning - prev.reasoning),
    };
    if (d.input === 0 && d.output === 0) return; // a repeat of the last totals
    this.sums.add(this.model ?? "unknown", {
      input: Math.max(0, d.input - d.cached - d.cacheWrite),
      cacheRead: Math.min(d.cached, d.input),
      cacheWrite: Math.min(d.cacheWrite, Math.max(0, d.input - d.cached)),
      output: d.output,
      reasoning: Math.min(d.reasoning, d.output),
      calls: 1,
    });
    const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : Number.NaN;
    if (Number.isFinite(ts) && ts > 0) this.at = Math.max(this.at ?? 0, ts);
  }
}

export interface CodexThreadMeta {
  /** The thread that spawned this one. */
  parentThreadId?: string;
  agentRole?: string;
  agentNickname?: string;
  /** `/root/<task_name>`: the spawn's task name, the closest thing to a title. */
  agentPath?: string;
  depth?: number;
}

/** Reads a rollout's first line (`session_meta`, ≤ 1 MB: it embeds the base instructions). */
export async function readCodexThreadMeta(file: string): Promise<CodexThreadMeta | undefined> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(file, "r");
    const buf = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
    if (nl < 0) return undefined;
    const e = JSON.parse(buf.subarray(0, nl).toString("utf8")) as { type?: unknown; payload?: Record<string, unknown> };
    if (e?.type !== "session_meta" || !e.payload) return {};
    const p = e.payload;
    const source = p.source as { subagent?: { thread_spawn?: Record<string, unknown> } } | undefined;
    const spawn = source && typeof source === "object" ? source.subagent?.thread_spawn : undefined;
    const str = (v: unknown, max: number): string | undefined =>
      typeof v === "string" && v.trim() ? v.slice(0, max) : undefined;
    const parent = str(spawn?.parent_thread_id ?? p.parent_thread_id, 128);
    return {
      parentThreadId: parent && /^[\w-]{8,128}$/.test(parent) ? parent : undefined,
      agentRole: str(spawn?.agent_role, 64),
      agentNickname: str(spawn?.agent_nickname ?? p.agent_nickname, 64),
      agentPath: str(spawn?.agent_path ?? p.agent_path, 200),
      depth: typeof spawn?.depth === "number" ? spawn.depth : undefined,
    };
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * The Codex home a rollout lives in (`<home>/sessions/YYYY/MM/DD/rollout-*.jsonl`), so a reader follows the
 * `CODEX_HOME` the session ran with rather than the daemon's own environment.
 */
export function codexHomeOfRollout(file: string | undefined): string | undefined {
  if (!file || !path.isAbsolute(file)) return undefined;
  const m = /^(.*)[\\/]sessions[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/][^\\/]+\.jsonl$/.exec(file);
  return m?.[1] || undefined;
}

/**
 * A Codex thread's name as its TUI shows it (generated after the first prompt, or set with /rename): the last
 * `{id, thread_name}` line for the thread in `<home>/session_index.jsonl` (append-only; read from its last 256 KB).
 * Codex 0.164 writes the name nowhere in the rollout. Undefined when there is none.
 */
export async function readCodexThreadName(home: string, threadId: string, tailBytes = 256 * 1024): Promise<string | undefined> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(path.join(home, "session_index.jsonl"), "r");
    const { size } = await fh.stat();
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) lines.shift(); // a cut first line
    const needle = `"${threadId}"`;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes(needle)) continue;
      try {
        const e = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
        if (e.id !== threadId) continue;
        const name = typeof e.thread_name === "string" ? e.thread_name.trim() : "";
        return name ? name.slice(0, 500) : undefined;
      } catch {
        // a torn line: keep looking
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** "/root/review_auth_flow" → "review auth flow" (the spawn's task name as a title). */
export function codexTaskTitle(agentPath: string | undefined): string | undefined {
  if (!agentPath) return undefined;
  const last = agentPath.split("/").filter(Boolean).pop();
  if (!last || last === "root") return undefined;
  return last.replace(/[_-]+/g, " ").trim() || undefined;
}

/** "waiting on 1 shell", "waiting on 2 agents", "waiting on 1 shell, 1 agent"; undefined when nothing runs. */
export function backgroundStatusLine(shells: number, agents: number): string | undefined {
  const parts: string[] = [];
  if (shells > 0) parts.push(`${shells} shell${shells === 1 ? "" : "s"}`);
  if (agents > 0) parts.push(`${agents} agent${agents === 1 ? "" : "s"}`);
  return parts.length > 0 ? `waiting on ${parts.join(", ")}` : undefined;
}

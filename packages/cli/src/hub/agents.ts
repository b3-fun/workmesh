import fs from "node:fs";
import path from "node:path";

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

/**
 * Token use of one Claude Code transcript (see Usage), read incrementally
 * from the start (each pass reads only new complete lines). Output is counted
 * once per API message id: the lines of a multi-block message repeat it.
 */
export class ClaudeUsageReader {
  private readonly cur: FileCursor = { offset: 0, skipping: false };
  private readonly perMessage = new Map<string, number>();
  /** Output of messages evicted from `perMessage` (bounded memory on long agents). */
  private baseOut = 0;
  /** Context of the latest call. */
  private latestIn = 0;
  private model: string | undefined;

  constructor(
    readonly file: string,
    private readonly maxReadBytes = 2 * 1024 * 1024,
    private readonly maxIds = 4000,
  ) {}

  /** Reads what's new; `more` = data past this pass's cap is waiting. Undefined when unreadable. */
  async read(): Promise<(Usage & { more: boolean }) | undefined> {
    const res = await readNewLines(this.file, this.cur, this.maxReadBytes);
    if (!res) return undefined;
    if (res.restarted) {
      this.perMessage.clear();
      this.baseOut = 0;
      this.latestIn = 0;
    }
    for (const line of res.lines) this.take(line);
    return { ...this.totals(), more: res.more };
  }

  totals(): Usage {
    let tokensOut = this.baseOut;
    for (const out of this.perMessage.values()) tokensOut += out;
    return { tokensIn: this.latestIn, tokensOut, model: this.model };
  }

  private take(line: string): void {
    if (line.length > MAX_LINE_BYTES || !line.includes('"usage"') || !line.includes('"assistant"')) return;
    let e: { type?: unknown; isApiErrorMessage?: unknown; message?: { id?: unknown; model?: unknown; usage?: unknown } };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      return;
    }
    if (e?.type !== "assistant" || e.isApiErrorMessage === true) return;
    const m = e.message;
    const u = m?.usage as Record<string, unknown> | undefined;
    if (!m || !u || typeof u !== "object") return;
    const model = cleanModel(m.model);
    if (model) this.model = model;
    const id = typeof m.id === "string" ? m.id : undefined;
    this.latestIn = finiteInt(u.input_tokens) + finiteInt(u.cache_creation_input_tokens) + finiteInt(u.cache_read_input_tokens);
    const out = finiteInt(u.output_tokens);
    if (!id) {
      this.baseOut += out;
      return;
    }
    this.perMessage.delete(id); // re-insert: newest last, so eviction drops the oldest
    this.perMessage.set(id, out);
    while (this.perMessage.size > this.maxIds) {
      const [oldId, old] = this.perMessage.entries().next().value as [string, number];
      this.perMessage.delete(oldId);
      this.baseOut += old;
    }
  }
}

/** Reads the last `bytes` of a file as complete lines (the first partial line dropped). */
async function readTailLines(file: string, bytes: number): Promise<string[] | undefined> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(file, "r");
    const st = await fh.stat();
    const start = Math.max(0, st.size - bytes);
    const buf = Buffer.alloc(st.size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * A Codex thread's token use (see Usage) and model from the end of its
 * rollout: the last `token_count` line's `last_token_usage.input_tokens` is
 * its context now, `total_token_usage.output_tokens` (cumulative) what it has
 * generated. Undefined when the tail holds neither.
 */
export async function readCodexUsage(file: string, tailBytes = 512 * 1024): Promise<Usage | undefined> {
  const lines = await readTailLines(file, tailBytes);
  if (!lines) return undefined;
  let usage: { in: number; out: number } | undefined;
  let model: string | undefined;
  for (let i = lines.length - 1; i >= 0 && (!usage || !model); i--) {
    const line = lines[i]!;
    if (line.length > MAX_LINE_BYTES) continue;
    const isCount = line.includes('"token_count"');
    const isContext = line.includes('"turn_context"');
    if (!isCount && !isContext) continue;
    let e: { type?: unknown; payload?: Record<string, unknown> };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }
    const p = e.payload;
    if (!p || typeof p !== "object") continue;
    if (!usage && e.type === "event_msg" && p.type === "token_count") {
      const info = p.info as { total_token_usage?: Record<string, unknown>; last_token_usage?: Record<string, unknown> } | undefined;
      const total = info?.total_token_usage;
      const last = info?.last_token_usage;
      if (total && typeof total === "object") {
        usage = { in: finiteInt(last && typeof last === "object" ? last.input_tokens : total.input_tokens), out: finiteInt(total.output_tokens) };
      }
    } else if (!model && e.type === "turn_context") {
      model = cleanModel(p.model);
    }
  }
  if (!usage && !model) return undefined;
  return { tokensIn: usage?.in ?? 0, tokensOut: usage?.out ?? 0, model };
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

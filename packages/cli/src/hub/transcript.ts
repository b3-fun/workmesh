import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Transcript tailing for conversation sharing (docs/SPEC.md §9). The hub
 * forwarder keeps one TranscriptTail per shared session and reads only the
 * complete lines appended since its saved byte offset, at most
 * MAX_READ_BYTES per read, asynchronously (never on the hook response path).
 *
 * What a line may yield is fixed here: the agent's own text blocks and the
 * turn-duration record. Thinking, tool inputs, tool results, user lines,
 * subagent (sidechain) lines and API request copies are never parsed into
 * anything.
 */

export const MAX_READ_BYTES = 2 * 1024 * 1024;

export type TranscriptFormat = "claude-code" | "codex";

export type TranscriptItem =
  | { kind: "message"; id: string; ts?: number; text: string }
  | { kind: "turnDuration"; ts?: number; durationMs: number };

export interface TranscriptTail {
  path: string;
  format: TranscriptFormat;
  /** Byte offset of the first line not yet read. */
  offset: number;
  /** Inode at the last read: a different one means the file was replaced. */
  ino?: number;
  /** Inside a line longer than MAX_READ_BYTES: drop bytes up to its newline. */
  skipping: boolean;
}

/**
 * A tail that starts at the file's current end, so nothing written before
 * this moment is ever read (SPEC §8: text only from the moment a session is
 * shared). A file that doesn't exist yet starts at 0: all of it will be new.
 */
export function startTail(file: string, format: TranscriptFormat): TranscriptTail {
  try {
    const st = fs.statSync(file);
    return { path: file, format, offset: st.size, ino: st.ino, skipping: false };
  } catch {
    return { path: file, format, offset: 0, skipping: false };
  }
}

export interface ReadResult {
  items: TranscriptItem[];
  /** More complete data is waiting past this read's cap. */
  more: boolean;
  /** The file was truncated or replaced: the tail moved to its new end. */
  reset?: "truncated" | "replaced";
  /** Could not open or read the file. */
  error?: string;
}

function parseTs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

interface ClaudeBlock {
  type?: unknown;
  text?: unknown;
}

/** One Claude Code transcript line → what it may contribute (main thread only). */
export function parseClaudeLine(line: string): TranscriptItem[] {
  // Cheap prefilter: tool results, attachments and API request copies dominate.
  if (!line.includes('"type":"assistant"') && !line.includes('"turn_duration"')) return [];
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (!e || typeof e !== "object" || e.isSidechain === true) return [];
  const ts = parseTs(e.timestamp);
  if (e.type === "system" && e.subtype === "turn_duration") {
    const ms = e.durationMs;
    return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? [{ kind: "turnDuration", ts, durationMs: Math.round(ms) }] : [];
  }
  if (e.type !== "assistant") return [];
  if (e.isApiErrorMessage === true || e.isMeta === true) return [];
  const message = e.message as { content?: unknown; model?: unknown; id?: unknown } | undefined;
  if (!message || message.model === "<synthetic>" || !Array.isArray(message.content)) return [];
  const base = typeof e.uuid === "string" ? e.uuid : typeof message.id === "string" ? message.id : `${ts ?? ""}`;
  const out: TranscriptItem[] = [];
  (message.content as ClaudeBlock[]).forEach((b, i) => {
    if (!b || b.type !== "text" || typeof b.text !== "string") return; // never thinking or tool_use
    const text = b.text.trim();
    if (!text || text === "(no content)") return;
    out.push({ kind: "message", id: `${base}:${i}`, ts, text: b.text });
  });
  return out;
}

/**
 * One Codex rollout line (codex 0.164 shape, read from real rollout files'
 * structure): assistant text is `response_item` → `message` with role
 * `assistant` and `output_text` blocks; `event_msg` → `task_complete` carries
 * `duration_ms`. Reasoning, tool calls and their output, developer/user
 * messages and inter-agent `agent_message` items yield nothing.
 */
export function parseCodexLine(line: string): TranscriptItem[] {
  if (!line.includes('"assistant"') && !line.includes('"task_complete"')) return [];
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const p = e?.payload as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return [];
  const ts = parseTs(e.timestamp);
  if (e.type === "event_msg" && p.type === "task_complete") {
    const ms = p.duration_ms;
    return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? [{ kind: "turnDuration", ts, durationMs: Math.round(ms) }] : [];
  }
  if (e.type !== "response_item" || p.type !== "message" || p.role !== "assistant" || !Array.isArray(p.content)) {
    return [];
  }
  const base = typeof p.id === "string" ? p.id : `${ts ?? ""}`;
  const out: TranscriptItem[] = [];
  (p.content as ClaudeBlock[]).forEach((b, i) => {
    if (!b || b.type !== "output_text" || typeof b.text !== "string" || !b.text.trim()) return;
    out.push({ kind: "message", id: `${base}:${i}`, ts, text: b.text });
  });
  return out;
}

export function parseLine(format: TranscriptFormat, line: string): TranscriptItem[] {
  return format === "codex" ? parseCodexLine(line) : parseClaudeLine(line);
}

/**
 * Reads the complete lines appended since `tail.offset` (at most `maxBytes`)
 * and advances the offset past them. A partial last line waits for the next
 * read. A truncated or replaced file moves the tail to its new end (its
 * content may predate sharing, so none of it is read).
 */
export async function readTail(tail: TranscriptTail, maxBytes = MAX_READ_BYTES): Promise<ReadResult> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(tail.path, "r");
    const st = await fh.stat();
    if (tail.ino !== undefined && st.ino !== tail.ino) {
      tail.ino = st.ino;
      tail.offset = st.size;
      tail.skipping = false;
      return { items: [], more: false, reset: "replaced" };
    }
    tail.ino = st.ino;
    if (st.size < tail.offset) {
      tail.offset = st.size;
      tail.skipping = false;
      return { items: [], more: false, reset: "truncated" };
    }
    if (st.size === tail.offset) return { items: [], more: false };
    const len = Math.min(st.size - tail.offset, maxBytes);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, tail.offset);
    const chunk = buf.subarray(0, bytesRead);
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl < 0) {
      if (bytesRead >= maxBytes) {
        // One line longer than a whole read (a huge tool result): skip it.
        tail.offset += bytesRead;
        tail.skipping = true;
        return { items: [], more: true };
      }
      return { items: [], more: false }; // a line still being written
    }
    let start = 0;
    if (tail.skipping) {
      start = chunk.indexOf(0x0a) + 1; // the rest of the oversized line
      tail.skipping = false;
    }
    const text = chunk.subarray(start, lastNl).toString("utf8");
    tail.offset += lastNl + 1;
    const items: TranscriptItem[] = [];
    for (const line of text.split("\n")) {
      if (line) items.push(...parseLine(tail.format, line));
    }
    return { items, more: st.size > tail.offset };
  } catch (err) {
    return { items: [], more: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** A Claude Code transcript path the tailer may use: main thread, .jsonl. */
export function acceptClaudeTranscript(file: string | undefined): string | undefined {
  if (!file || !path.isAbsolute(file) || !file.endsWith(".jsonl")) return undefined;
  if (file.split(path.sep).includes("subagents")) return undefined; // subagent transcripts: not in this pass
  return path.normalize(file);
}

/** A Codex rollout path for this thread (a subagent's rollout carries another id). */
export function acceptCodexTranscript(file: string | undefined, sessionId: string): string | undefined {
  if (!file || !path.isAbsolute(file)) return undefined;
  return path.basename(file).endsWith(`-${sessionId}.jsonl`) ? path.normalize(file) : undefined;
}

export function defaultCodexSessionsDir(): string {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(home, "sessions");
}

/** Local YYYY/MM/DD dirs to look in for a UUIDv7 thread id (its first 48 bits are epoch ms). */
export function uuidV7DayDirs(id: string): string[] | undefined {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-/i.exec(id);
  if (!m) return undefined;
  const ms = Number.parseInt(`${m[1]}${m[2]}`, 16);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const out: string[] = [];
  for (const shift of [0, -1, 1]) {
    const d = new Date(ms + shift * 86_400_000);
    out.push(path.join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")));
  }
  return [...new Set(out)];
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Finds `<sessionsDir>/YYYY/MM/DD/rollout-*-<id>.jsonl`. UUIDv7 ids go straight
 * to their day (±1 for time zones); others scan the newest `maxDays` day dirs.
 * Undefined when there is no rollout file: newer Codex builds keep threads in
 * a SQLite store (~/.codex/thread_history_*.sqlite), which is not read.
 */
export async function findCodexRollout(sessionsDir: string, id: string, maxDays = 120): Promise<string | undefined> {
  if (!/^[\w-]{8,128}$/.test(id)) return undefined;
  const suffix = `-${id}.jsonl`;
  const look = async (rel: string): Promise<string | undefined> => {
    const dir = path.join(sessionsDir, rel);
    const hit = (await listDir(dir)).find((f) => f.startsWith("rollout-") && f.endsWith(suffix));
    return hit ? path.join(dir, hit) : undefined;
  };
  const v7 = uuidV7DayDirs(id);
  if (v7) {
    for (const rel of v7) {
      const hit = await look(rel);
      if (hit) return hit;
    }
  }
  let scanned = 0;
  const years = (await listDir(sessionsDir)).filter((y) => /^\d{4}$/.test(y)).sort().reverse();
  for (const y of years) {
    const months = (await listDir(path.join(sessionsDir, y))).filter((m) => /^\d{2}$/.test(m)).sort().reverse();
    for (const mo of months) {
      const days = (await listDir(path.join(sessionsDir, y, mo))).filter((d) => /^\d{2}$/.test(d)).sort().reverse();
      for (const d of days) {
        if (++scanned > maxDays) return undefined;
        const hit = await look(path.join(y, mo, d));
        if (hit) return hit;
      }
    }
  }
  return undefined;
}

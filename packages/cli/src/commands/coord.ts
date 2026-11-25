import pkg from "../../package.json";
import type { CoordCaller, CoordOp, CoordOpResult } from "../daemon/coord-ops";
import { loadConfigSafe } from "../lib/config";
import { coordOp, ensureDaemon } from "../lib/daemon-client";
import { serveMcp } from "../mcp/server";
import { red, yellow } from "../lib/ui";

/**
 * v1 Coordinate from the terminal and as an MCP server (docs/SPEC.md §23). Both go through the daemon, which holds
 * the device token. Run from inside an agent session (an agent's Bash), the call speaks for that session; run by a
 * person at a terminal, for the person.
 */

/** This process as the daemon needs to find its session. */
export function callerOf(client: string): CoordCaller {
  return {
    ppid: process.ppid > 1 ? process.ppid : undefined,
    cwd: process.cwd(),
    claudeSessionId: process.env.CLAUDE_CODE_SESSION_ID || undefined,
    codexThreadId: process.env.CODEX_THREAD_ID || undefined,
    client,
  };
}

const DAEMON_DOWN: CoordOpResult = {
  ok: false,
  text: "Workmesh's daemon isn't running: start it with `workmesh start --detach`.",
};

async function call(op: CoordOp, args: Record<string, unknown>, caller: CoordCaller): Promise<CoordOpResult> {
  const config = loadConfigSafe();
  if (!(await ensureDaemon(config))) return DAEMON_DOWN;
  try {
    return await coordOp(config.port, { op, args, caller });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/responded 404/.test(msg)) {
      return { ok: false, text: "The running daemon predates Workmesh coordination: restart it with `workmesh restart`." };
    }
    return { ok: false, text: `Workmesh's daemon didn't answer: ${msg}` };
  }
}

/** `workmesh mcp`: stdio MCP server. Nothing but JSON-RPC goes to stdout. */
export async function runMcp(): Promise<void> {
  await serveMcp({
    input: process.stdin,
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
    call,
    caller: () => {
      const { client: _client, ...rest } = callerOf("mcp");
      return rest;
    },
    version: pkg.version,
    log: (m) => process.stderr.write(`${m}\n`),
  });
}

export interface CoordCliOptions {
  json?: boolean;
}

async function runOp(op: CoordOp, args: Record<string, unknown>, opts: CoordCliOptions): Promise<void> {
  const r = await call(op, args, callerOf("cli"));
  if (opts.json) {
    console.log(JSON.stringify({ ok: r.ok, ...(r.data === undefined ? {} : { data: r.data }), text: r.text }, null, 2));
  } else {
    console.log(r.ok ? r.text : (r.text.startsWith("Workmesh") ? yellow(r.text) : red(r.text)));
  }
  if (!r.ok) process.exitCode = 1;
}

export function runLeases(opts: CoordCliOptions & { repo?: string }): Promise<void> {
  return runOp("leases", opts.repo ? { repo: opts.repo } : {}, opts);
}

export function runClaims(opts: CoordCliOptions): Promise<void> {
  return runOp("claims", {}, opts);
}

export function runInbox(opts: CoordCliOptions): Promise<void> {
  return runOp("inbox", {}, opts);
}

export function runSend(to: string, words: string[], opts: CoordCliOptions & { kind?: string; thread?: string }): Promise<void> {
  return runOp("send", { to, text: words.join(" "), ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.thread ? { thread: opts.thread } : {}) }, opts);
}

export function runLease(paths: string[], opts: CoordCliOptions & { reason?: string; minutes?: string; repo?: string }): Promise<void> {
  const minutes = opts.minutes ? Number(opts.minutes) : undefined;
  return runOp(
    "lease",
    { paths, ...(opts.reason ? { reason: opts.reason } : {}), ...(minutes && Number.isFinite(minutes) ? { minutes } : {}), ...(opts.repo ? { repo: opts.repo } : {}) },
    opts,
  );
}

export function runUnlease(paths: string[], opts: CoordCliOptions & { id?: string; repo?: string }): Promise<void> {
  return runOp("unlease", { ...(paths.length ? { paths } : {}), ...(opts.id ? { leaseId: opts.id } : {}), ...(opts.repo ? { repo: opts.repo } : {}) }, opts);
}

export function runClaim(issue: string, opts: CoordCliOptions & { note?: string; release?: boolean }): Promise<void> {
  return runOp(opts.release ? "release" : "claim", { issue, ...(opts.note ? { note: opts.note } : {}) }, opts);
}

export function runNote(words: string[], opts: CoordCliOptions & { tag?: string[] }): Promise<void> {
  return runOp("note", { text: words.join(" "), ...(opts.tag?.length ? { tags: opts.tag } : {}) }, opts);
}

export function runNotes(opts: CoordCliOptions & { tag?: string }): Promise<void> {
  return runOp("notes", opts.tag ? { tag: opts.tag } : {}, opts);
}

export function runWhoami(opts: CoordCliOptions): Promise<void> {
  return runOp("whoami", {}, opts);
}

/** `workmesh ask <question…>`: the board's Ask, read-only (SPEC §29). */
export function runAsk(words: string[], opts: CoordCliOptions): Promise<void> {
  return runOp("ask", { question: words.join(" ") }, opts);
}

// --- v2 Delegate (SPEC §31) -----------------------------------------------------------

export function runHandoff(
  to: string,
  words: string[],
  opts: CoordCliOptions & { repo?: string; issue?: string; context?: string },
): Promise<void> {
  return runOp(
    "handoff",
    {
      to,
      task: words.join(" "),
      ...(opts.repo ? { repo: opts.repo } : {}),
      ...(opts.issue ? { issue: opts.issue } : {}),
      ...(opts.context ? { context: opts.context } : {}),
    },
    opts,
  );
}

export function runHandoffs(action: string | undefined, id: string | undefined, opts: CoordCliOptions & { note?: string }): Promise<void> {
  return runOp("handoffs", { action: action ?? "list", ...(id ? { id } : {}), ...(opts.note ? { note: opts.note } : {}) }, opts);
}

export function runGates(action: string | undefined, list: string | undefined, opts: CoordCliOptions): Promise<void> {
  if (action === undefined || action === "list" || action === "show") return runOp("gates", {}, opts);
  if (action === "off" || action === "clear") return runOp("gates", { set: "off" }, opts);
  if (action === "set") return runOp("gates", { set: list ?? "off" }, opts);
  // `workmesh gates merge,deploy` reads as `set`.
  return runOp("gates", { set: action }, opts);
}

export function runApprovals(action: string | undefined, id: string | undefined, opts: CoordCliOptions & { note?: string }): Promise<void> {
  return runOp("approvals", { action: action ?? "list", ...(id ? { id } : {}), ...(opts.note ? { note: opts.note } : {}) }, opts);
}

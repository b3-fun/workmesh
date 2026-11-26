import path from "node:path";
import pkg from "../../package.json";
import type { CoordCaller, CoordOp, CoordOpResult } from "../daemon/coord-ops";
import { loadConfigSafe } from "../lib/config";
import { coordOp, ensureDaemon } from "../lib/daemon-client";
import { serveMcp } from "../mcp/server";
import { confirm, red, yellow } from "../lib/ui";

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

/** Prints one answer the way every coordination command does; a failed one sets exit code 1. */
function report(r: CoordOpResult, opts: CoordCliOptions, print: (line: string) => void = console.log): void {
  if (opts.json) {
    print(JSON.stringify({ ok: r.ok, ...(r.data === undefined ? {} : { data: r.data }), text: r.text }, null, 2));
  } else {
    print(r.ok ? r.text : (r.text.startsWith("Workmesh") ? yellow(r.text) : red(r.text)));
  }
  if (!r.ok) process.exitCode = 1;
}

async function runOp(op: CoordOp, args: Record<string, unknown>, opts: CoordCliOptions): Promise<void> {
  report(await call(op, args, callerOf("cli")), opts);
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

// --- v3 Memory (SPEC §36) ---------------------------------------------------------------

/**
 * `workmesh remember <title…>`: a proposal, from a terminal outside an agent session and from an agent's shell alike
 * (SPEC §35); a person accepts it on the board. From an agent's shell it carries that session's key.
 */
export function runRemember(
  words: string[],
  opts: CoordCliOptions & {
    kind?: string;
    body?: string;
    project?: boolean;
    repo?: string | boolean;
    path?: string[];
    issue?: string[];
    pr?: string[];
    tag?: string[];
    supersedes?: string;
  },
): Promise<void> {
  const scope = opts.project ? "project" : typeof opts.repo === "string" ? opts.repo : opts.repo ? "repo" : undefined;
  // Paths on the command line are relative to this directory (made absolute here), unless `--repo owner/name` names the
  // repo they are relative to.
  const paths =
    typeof opts.repo === "string" ? opts.path : opts.path?.map((p) => (path.isAbsolute(p) || p.startsWith("~") ? p : path.resolve(p)));
  return runOp(
    "remember",
    {
      title: words.join(" "),
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.body ? { body: opts.body } : {}),
      ...(scope ? { scope } : {}),
      ...(paths?.length ? { paths } : {}),
      ...(opts.issue?.length ? { issues: opts.issue } : {}),
      ...(opts.pr?.length ? { prs: opts.pr } : {}),
      ...(opts.tag?.length ? { tags: opts.tag } : {}),
      ...(opts.supersedes ? { supersedes: opts.supersedes } : {}),
    },
    opts,
  );
}

export function runRecall(words: string[], opts: CoordCliOptions & { kind?: string[]; limit?: string; repo?: string }): Promise<void> {
  const limit = opts.limit ? Number(opts.limit) : undefined;
  return runOp(
    "recall",
    {
      query: words.join(" "),
      ...(opts.kind?.length ? { kinds: opts.kind } : {}),
      ...(limit && Number.isFinite(limit) ? { limit } : {}),
      ...(opts.repo ? { repo: opts.repo } : {}),
    },
    opts,
  );
}

export function runForget(id: string, opts: CoordCliOptions & { reason?: string }): Promise<void> {
  return runOp("forget", { id, ...(opts.reason ? { reason: opts.reason } : {}) }, opts);
}

export function runMemories(opts: CoordCliOptions & { kind?: string; tag?: string; repo?: string }): Promise<void> {
  return runOp("memories", { ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.tag ? { tag: opts.tag } : {}), ...(opts.repo ? { repo: opts.repo } : {}) }, opts);
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

/** What `workmesh handoffs` needs around it. Tests pass their own. */
export interface HandoffsDeps {
  /** One coordination call through the daemon. */
  call: (op: CoordOp, args: Record<string, unknown>, caller: CoordCaller) => Promise<CoordOpResult>;
  /** Input and output are a terminal, so a person can be shown the handoff and asked. */
  isTerminal: () => boolean;
  /** Asks a yes-or-no question whose default is no. */
  ask: (question: string) => Promise<boolean>;
  print: (line: string) => void;
}

const handoffsDeps: HandoffsDeps = {
  call,
  isTerminal: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask: (question) => confirm(question, false),
  print: (line) => console.log(line),
};

/** The two answers that start an agent on this machine, and the words each one uses. */
const STARTS = {
  accept: {
    can: "canAccept",
    no: "Not accepted",
    question: "Accept and start an agent?",
    elsewhere: { json: "Run it without --json, or accept in the menu bar or on the board.", pipe: "Accept it in your own terminal, in the menu bar or on the board." },
    notWaiting: (id: string) => `${id} isn't waiting for your answer.`,
    left: (id: string) => `${id} still waits for you (\`workmesh handoffs decline ${id}\` declines it).`,
  },
  run: {
    can: "canRun",
    no: "Not started",
    question: "Run it here and start an agent?",
    elsewhere: { json: "Run it without --json, or confirm it in the menu bar.", pipe: "Confirm it in your own terminal or in the menu bar." },
    notWaiting: (id: string) => `${id} isn't waiting to run on this machine.`,
    left: (id: string) => `${id} still waits: this machine or another of yours can run it.`,
  },
} as const;

/**
 * `workmesh handoffs [list | show <id> | accept <id> | decline <id> | run <id>]`. Accepting starts an agent on this
 * machine with someone else's text as its instructions. So does `run`, for a handoff that was accepted somewhere
 * else. Both always print the whole handoff and what will start, then ask. No option skips the question. Without a
 * terminal to ask in, nothing starts here: the menu bar shows the handoff too.
 */
export async function runHandoffs(
  action: string | undefined,
  id: string | undefined,
  opts: CoordCliOptions & { note?: string },
  deps: HandoffsDeps = handoffsDeps,
): Promise<void> {
  const caller = callerOf("cli");
  const args = { action: action ?? "list", ...(id ? { id } : {}), ...(opts.note ? { note: opts.note } : {}) };
  const send = async (): Promise<void> => report(await deps.call("handoffs", args, caller), opts, deps.print);
  if (action !== "accept" && action !== "run") return send();
  const words = STARTS[action];
  if (!id) return report({ ok: false, text: `\`workmesh handoffs ${action}\` needs the handoff's id (\`workmesh handoffs\` lists them).` }, opts, deps.print);
  if (opts.json || !deps.isTerminal()) {
    const why = opts.json ? "--json leaves no room for the question" : "there is no terminal to ask in";
    return report(
      {
        ok: false,
        text: `${words.no}: ${why}. \`workmesh handoffs ${action}\` shows the whole handoff and asks before it starts an agent. ${opts.json ? words.elsewhere.json : words.elsewhere.pipe}`,
      },
      opts,
      deps.print,
    );
  }
  const view = await deps.call("handoffs", { action: "show", id }, caller);
  if (!view.ok) return report(view, opts, deps.print);
  deps.print(view.text);
  deps.print("");
  if ((view.data as Record<string, unknown> | undefined)?.[words.can] !== true) {
    return report({ ok: false, text: `${words.no}: ${words.notWaiting(id)}` }, opts, deps.print);
  }
  if (!(await deps.ask(words.question))) {
    deps.print(`${words.no}. ${words.left(id)}`);
    return;
  }
  return send();
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

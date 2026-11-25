import readline from "node:readline";
import type { CoordCaller, CoordOp, CoordOpResult } from "../daemon/coord-ops";

/**
 * `workmesh mcp`: a stdio MCP server (JSON-RPC 2.0, one message per line) that gives every agent session the team's
 * coordination tools (docs/SPEC.md §23). It talks to the local daemon only and never holds the device token: each
 * tool call is one `POST /coord/op` to the daemon, which works out which session is asking and calls the hub.
 * Written by hand (no SDK) to keep the CLI's dependencies at two.
 */

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

interface ToolDef {
  name: CoordOp;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
}

const s = (description: string) => ({ type: "string", description });

/** Tool descriptions stay short and exact: agents read them on every turn. */
export const MCP_TOOLS: readonly ToolDef[] = [
  {
    name: "whoami",
    description: "Who you are on Workmesh: your person, this session, the team hub, and whether coordination is on.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "roster",
    description: "Who on the team is working now: each person's agent sessions (name, state, repo), plus active claims.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "send",
    description:
      "Message a teammate or their agent; it reaches their agent at its next tool call. Use it instead of editing files someone else leased.",
    inputSchema: {
      type: "object",
      properties: {
        to: s("A person (name, email or GitHub login), an agent's session name, or a session's hub key."),
        text: s("The message (up to 4,000 characters)."),
        kind: { type: "string", enum: ["person", "agent", "session"], description: "What `to` names, when it is ambiguous." },
        thread: s("A thread id to reply in."),
        wake: { type: "boolean", description: "Wake the recipient if it is idle (default: only a person's messages wake)." },
      },
      required: ["to", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "inbox",
    description: "Messages teammates sent this session that haven't reached you yet (they also arrive on their own at tool calls).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "claim",
    description:
      "Claim the Linear issue you're working on (e.g. B3-123) so no other agent takes it. Fails, naming the holder, if someone has it.",
    inputSchema: {
      type: "object",
      properties: { issue: s("The Linear issue id, e.g. B3-123."), note: s("What you're doing on it (optional).") },
      required: ["issue"],
      additionalProperties: false,
    },
  },
  {
    name: "release",
    description: "Release a Linear issue you claimed.",
    inputSchema: { type: "object", properties: { issue: s("The Linear issue id.") }, required: ["issue"], additionalProperties: false },
  },
  {
    name: "lease",
    description:
      "Reserve files before larger edits: paths, directories or globs (src/hub/**), repo-relative or absolute. Other sessions' edits to them are refused until you unlease or it expires. Fails, naming the holder, on overlap.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Files, directories or globs (up to 50), in one repo." },
        reason: s("What you're doing, shown to teammates (optional)."),
        minutes: { type: "number", description: "How long (1-240, default 30)." },
        repo: s("owner/name, when the paths are repo-relative and this session's directory isn't in that repo."),
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  {
    name: "unlease",
    description: "Release your leases: the paths given, one lease id, or with neither all of this session's leases.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Paths you leased (optional)." },
        leaseId: s("One lease id (optional)."),
        repo: s("owner/name (optional)."),
      },
      additionalProperties: false,
    },
  },
  {
    name: "leases",
    description: "Active file leases on the team: who holds which paths, and for how long.",
    inputSchema: { type: "object", properties: { repo: s("Only this repo, owner/name (optional).") }, additionalProperties: false },
  },
  {
    name: "note",
    description: "Leave a note every teammate's agent can read: a convention, a ruling, a heads-up. Redacted on this machine first.",
    inputSchema: {
      type: "object",
      properties: {
        text: s("The note (up to 4,000 characters)."),
        tags: { type: "array", items: { type: "string" }, description: "Up to 10 one-word tags (optional)." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "notes",
    description: "The team's newest shared notes.",
    inputSchema: { type: "object", properties: { tag: s("Only notes with this tag (optional).") }, additionalProperties: false },
  },
  // v2 Delegate (SPEC §31). Approvals and gates are a person's to decide and set: no tools for them here.
  {
    name: "handoff",
    description:
      "Hand a task to a teammate, or to `me` (one of your person's other machines). Once accepted, their machine starts a new agent for it in a fresh worktree of the repo; you get a message when it is taken and when it is done.",
    inputSchema: {
      type: "object",
      properties: {
        to: s("A person (name, email or GitHub login), or `me`."),
        task: s("What to do, self-contained (up to 4,000 characters): the agent that takes it starts from nothing else."),
        repo: s("owner/name (default: this session's repo)."),
        issue: s("A Linear issue id, e.g. B3-123 (optional)."),
        context: s("Anything else it needs: links, decisions, where to start (optional, up to 4,000 characters)."),
      },
      required: ["to", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "handoffs",
    description: "Handoffs offered to your person and sent by them; accept or decline one for your person when they asked you to.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "accept", "decline"], description: "Default list." },
        id: s("The handoff id (accept, decline)."),
        note: s("Why (decline; optional)."),
      },
      additionalProperties: false,
    },
  },
];

export const MCP_INSTRUCTIONS =
  "Workmesh connects this session to your team's agents. Claim the Linear issue you work on, lease files before larger " +
  "edits (edits to another session's leased files are refused), read your inbox, and message a file's holder with " +
  "`send` instead of editing around them. `handoff` gives a task to a teammate's (or your other machine's) agent.";

export interface McpServerOptions {
  input: NodeJS.ReadableStream;
  /** Writes one JSON-RPC message (a line). */
  write: (line: string) => void;
  /** One coordination call through the daemon. */
  call: (op: CoordOp, args: Record<string, unknown>, caller: CoordCaller) => Promise<CoordOpResult>;
  /** Who this process is, for the daemon to find its session. */
  caller: () => Omit<CoordCaller, "client">;
  version: string;
  log?: (message: string) => void;
}

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

/** Handles one parsed message; resolves to the response, or undefined for a notification. */
export async function handleMcpMessage(
  msg: JsonRpcRequest,
  opts: Pick<McpServerOptions, "call" | "caller" | "version">,
  session: { client?: string },
): Promise<unknown | undefined> {
  const id = msg.id;
  const isRequest = id !== undefined && id !== null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (typeof msg.method !== "string") return isRequest ? error(-32600, "invalid request") : undefined;
  const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
  switch (msg.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
      const info = params.clientInfo as { name?: unknown } | undefined;
      if (typeof info?.name === "string") session.client = info.name.slice(0, 80);
      const protocolVersion =
        asked && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
      return reply({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "workmesh", title: "Workmesh", version: opts.version },
        instructions: MCP_INSTRUCTIONS,
      });
    }
    case "ping":
      return isRequest ? reply({}) : undefined;
    case "tools/list":
      return reply({ tools: MCP_TOOLS });
    case "tools/call": {
      const name = params.name;
      const tool = MCP_TOOLS.find((t) => t.name === name);
      if (!tool) return error(-32602, `unknown tool: ${String(name)}`);
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
      let result: CoordOpResult;
      try {
        result = await opts.call(tool.name, args, { ...opts.caller(), client: session.client });
      } catch (err) {
        result = {
          ok: false,
          text: `Workmesh's daemon didn't answer (${err instanceof Error ? err.message : String(err)}). Start it with \`workmesh start --detach\`.`,
        };
      }
      return reply({ content: [{ type: "text", text: result.text }], isError: !result.ok });
    }
    default:
      if (msg.method.startsWith("notifications/")) return undefined;
      return isRequest ? error(-32601, `method not found: ${msg.method}`) : undefined;
  }
}

/** Serves MCP over `input`/`write` until the input ends. */
export function serveMcp(opts: McpServerOptions): Promise<void> {
  const session: { client?: string } = {};
  const rl = readline.createInterface({ input: opts.input, crlfDelay: Number.POSITIVE_INFINITY });
  const pending = new Set<Promise<void>>();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line) as unknown;
    } catch {
      opts.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      return;
    }
    const items = Array.isArray(msg) ? msg : [msg];
    for (const item of items) {
      const p = handleMcpMessage((item ?? {}) as JsonRpcRequest, opts, session)
        .then((res) => {
          if (res !== undefined) opts.write(JSON.stringify(res));
        })
        .catch((err: unknown) => opts.log?.(`mcp: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => pending.delete(p));
      pending.add(p);
    }
  });
  return new Promise((resolve) => {
    rl.on("close", () => {
      void Promise.allSettled([...pending]).then(() => resolve());
    });
  });
}

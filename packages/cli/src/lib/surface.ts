import crypto from "node:crypto";
import { CLAUDE_HOOK_EVENTS } from "../adapters/claude-code";
import { CODEX_HOOK_EVENTS } from "../adapters/codex";
import { MCP_TOOLS } from "../mcp/server";

/**
 * What a running agent session took from Workmesh when it started and keeps until it restarts: the MCP tools (the
 * `workmesh mcp` process lives as long as the session) and the hook entries. Two versions with the same fingerprint
 * gave sessions the same tools, so an update between them needs no restart (SPEC §41: the stale-session note).
 * Descriptions are left out: rewording a tool doesn't make a session that has it stale.
 */
export function surfaceFingerprint(): string {
  const surface = {
    tools: MCP_TOOLS.map((t) => ({ name: t.name, input: t.inputSchema })),
    claude: [...CLAUDE_HOOK_EVENTS, "Stop:wake"],
    codex: [...CODEX_HOOK_EVENTS],
  };
  return crypto.createHash("sha256").update(JSON.stringify(surface)).digest("hex").slice(0, 16);
}

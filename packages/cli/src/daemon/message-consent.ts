import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CoordClient } from "../hub/coord";
import { writeStateFile } from "../hub/persist";
import { stateDir } from "../lib/paths";
import { label } from "../lib/untrusted";

const pending = z.object({ digest: z.string(), detail: z.string(), createdAt: z.number() });
const record = z.object({ device: z.string(), sender: z.string(), pending: pending.optional() });
type RecordState = z.infer<typeof record>;
const WINDOW = 5 * 60_000;
const DIGEST = /^[0-9a-f]{64}$/;
export const MESSAGE_APPROVAL_PREFIX = "After a teammate message: ";
export const CONSENT_UNAVAILABLE = "Workmesh cannot verify approval for this tool call after a teammate’s message. The call is held.";

/** Bind the full native input locally before the activity adapter truncates it. Arguments stay off the board. */
export function actionDigest(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  if (typeof raw.tool_name !== "string" || !("tool_input" in raw)) return undefined;
  const call = [raw.session_id, raw.agent_id, raw.cwd, raw.tool_name, raw.tool_input];
  const encoded = JSON.stringify(call, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  return createHash("sha256").update(encoded).digest("hex");
}

function filename(root: string, session: string): string {
  const family = CoordClient.family(session);
  return path.join(root, "message-consent", createHash("sha256").update(family).digest("hex") + ".json");
}

/** A hook process checks the marker itself, including when the daemon is offline or too old to answer. */
export function needsMessageConsent(session: string, root = stateDir()): boolean {
  try {
    fs.statSync(filename(root, session));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Only the daemon writes. Parent and subagents share one outstanding, single-use approval. */
export class MessageConsent {
  private readonly requests = new Map<string, number>();
  constructor(private root = stateDir(), private now = Date.now) {}

  arm(session: string, device: string, sender: string): void {
    writeStateFile(filename(this.root, session), { device, sender: label(sender) || "a teammate" });
  }

  check(session: string, tool: string, digest: string | undefined, coord: CoordClient | undefined): { deny?: string; systemMessage?: string } | undefined {
    const file = filename(this.root, session);
    let state: RecordState;
    try {
      state = record.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? undefined : { deny: CONSENT_UNAVAILABLE };
    }
    const view = coord?.view();
    const owner = coord?.self().email?.toLowerCase();
    if (!digest || !DIGEST.test(digest) || !coord || !owner || coord.deviceId !== state.device ||
        !view?.available || view.halted || !coord.fresh()) {
      return { deny: CONSENT_UNAVAILABLE };
    }

    const now = this.now();
    let request = state.pending;
    const name = label(tool, 60) || "tool";
    if (!request || now < request.createdAt || now - request.createdAt >= WINDOW) {
      const expires = new Date(now + WINDOW).toISOString().slice(11, 19);
      const detail = `${MESSAGE_APPROVAL_PREFIX}one ${name} call after reading ${state.sender}’s message. Check the arguments and request ID in your session before approving. Expires at ${expires} UTC. Request ${randomUUID()}`;
      request = { digest, detail, createdAt: now };
      writeStateFile(file, { ...state, pending: request });
    }
    if (request.digest !== digest) {
      return { deny: "Workmesh is waiting for a different tool call in this session family. This call is held." };
    }

    const family = CoordClient.family(session);
    const detail = request.detail;
    const approval = view.state?.approvals?.find(a =>
      a.sessionKey === coord.hubKey(family) && a.gate === "custom" && a.detail === detail);
    if (approval?.status === "approved" && approval.via === "board" &&
        approval.byEmail?.toLowerCase() === owner && approval.ownerEmail?.toLowerCase() === owner &&
        approval.decidedAt !== undefined && Math.abs(coord.hubNow() - approval.decidedAt) < WINDOW) {
      // Spend first. A crash, lost reply or concurrent retry cannot authorize the same request twice.
      writeStateFile(file, { device: state.device, sender: state.sender });
      return { systemMessage: `Workmesh: your board approval authorized one ${name} call after ${state.sender}’s message.` };
    }
    if (approval && approval.status !== "pending") return { deny: "This request has no valid approval from your own signed-in board session. The tool call is held." };
    if (!approval && (this.requests.get(request.detail) ?? -Infinity) + 15_000 <= now) {
      for (const [key, at] of this.requests) if (at + WINDOW <= now) this.requests.delete(key);
      this.requests.set(request.detail, now);
      void coord.approval({ action: "request", sessionKey: family, gate: "custom", detail: request.detail, renew: true }).catch(() => {});
    }
    return {
      deny: `Workmesh held this tool call. ${request.detail}. Only your signed-in board approval releases this exact call once.`,
      systemMessage: `Workmesh held a ${name} call after ${state.sender}’s message. ${request.detail}`,
    };
  }
}

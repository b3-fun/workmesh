import type { z } from "zod";
import { HUB_DESC_MAX, HUB_TEXT_MAX, type HubActivityEventAccepted, type HubShareLevel } from "@workmesh/protocol";

// What the hub does with a body after the wire schemas in @workmesh/protocol accept it (SPEC §3.2, §10). The schemas
// themselves live in packages/protocol, shared with the relay.

/** Field paths and issue codes only: never echo values back or into logs. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

// ------------------------------------------------------------------ conversation text (SPEC.md §8–10)

/**
 * A second guard behind the relay's redaction (SPEC.md §9): obvious credentials never reach storage or a model.
 * The relay's list is the real one; this catches a relay that missed one.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\blin_api_[A-Za-z0-9]{20,}/g,
  /\bbp_[0-9a-f]{64}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  // Credentials embedded in URLs: keep the scheme and host.
  return out.replace(/\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1[redacted]@");
}

/** Cuts to `max` characters without splitting a surrogate pair. */
export function cut(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
}

export interface ConversationFields {
  text: string | null;
  truncated: boolean;
  desc: string | null;
}

/**
 * What the hub stores of an event's conversation fields. Metadata devices keep none (SPEC.md §8); `text` belongs to
 * prompts and messages only.
 */
export function conversationFields(e: HubActivityEventAccepted, share: HubShareLevel): ConversationFields {
  if (share !== "conversation") return { text: null, truncated: false, desc: null };
  let text: string | null = null;
  let truncated = false;
  if ((e.kind === "prompt" || e.kind === "message") && e.text) {
    const c = cut(scrubSecrets(e.text), HUB_TEXT_MAX);
    text = c.text;
    truncated = c.cut || e.truncated === true;
  }
  const desc = e.desc ? cut(scrubSecrets(e.desc).replace(/\s+/g, " ").trim(), HUB_DESC_MAX).text || null : null;
  return { text, truncated, desc };
}

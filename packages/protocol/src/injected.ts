// System-injected content in agent text (public SPEC §9, v0.7). No zod here: the hub's board imports this file on its
// own (`@workmesh/protocol/injected`) and must not pull the wire schemas into its bundle.
//
// Agent tools put their own markup into the text a relay reads: a background task's completion notice arrives as a
// "prompt" (`<task-notification>…`), another agent's message arrives wrapped (`<agent-message from="…">…`), a message
// can open with provenance markers (`<artifact-content-authored-by-others/>` and a one-line notice), and reminders
// (`<system-reminder>…`) ride along anywhere. None of it was written by the person or the agent, so none of it is shown
// or sent as theirs. The relay cleans text before it is queued; the hub cleans it again on ingest and the board when it
// reads older rows (a backstop for relays from before v0.7).

/** What `stripInjected` found at the start of the text. */
export type InjectedKind =
  /** Nothing injected: the text is as written. */
  | "none"
  /** Injected blocks were removed; what is left was written by the person or the agent. */
  | "stripped"
  /** The whole text was injected (a task notice, a hook's output): nobody wrote it. */
  | "notice"
  /** Another agent's message in a wrapper: the text is that message's body. */
  | "wrapped";

export interface Uninjected {
  /** The text without injected content; empty when nothing written by a person or an agent is left. */
  text: string;
  kind: InjectedKind;
}

/** Wrappers whose body is a real message from another agent or session: the body is kept. */
const WRAPPERS: ReadonlySet<string> = new Set(["agent-message", "cross-session-message", "teammate-message"]);

/** Tags injected anywhere in a text (not only at its start), removed wherever they appear. */
const ANYWHERE_RE = /<(system-reminder)\b[^<>]*>[\s\S]*?<\/\1\s*>/gi;

/** An opening or self-closing tag at the very start: `<name attr="…">` or `<name/>`. */
const OPEN_RE = /^<([A-Za-z][\w.:-]*)((?:\s+[\w.:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>/=`]+))?)*)\s*(\/)?>/;

/**
 * Whether a leading tag is injected markup rather than something a person typed or pasted: a lowercase name joined by
 * `-` or `_` (`task-notification`, `system-reminder`, `local-command-stdout`, `environment_context`). Plain HTML
 * (`<div>`, `<p>`, `<time>`) is left alone.
 */
function isSystemTag(name: string): boolean {
  return /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/.test(name);
}

/** Index of the `</name>` that closes a block opened just before `from`, counting nested blocks of the same name. */
function findClose(s: string, name: string, from: number): { start: number; end: number } | null {
  const re = new RegExp(`<(/?)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s/>])[^<>]*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const selfClosing = m[0].endsWith("/>");
    if (m[1]) depth--;
    else if (!selfClosing) depth++;
    if (depth === 0) return { start: m.index, end: m.index + m[0].length };
  }
  return null;
}

/** Text after the line a self-closing marker sits on, and its one-line notice when the marker is alone on its line. */
function afterMarker(rest: string): string {
  const nl = rest.indexOf("\n");
  const sameLine = nl < 0 ? rest : rest.slice(0, nl);
  if (sameLine.trim()) return nl < 0 ? "" : rest.slice(nl + 1); // the notice sits on the marker's own line
  if (nl < 0) return "";
  const next = rest.slice(nl + 1);
  if (next.trimStart().startsWith("<")) return next; // another marker or block, no notice line
  const nl2 = next.indexOf("\n");
  return nl2 < 0 ? "" : next.slice(nl2 + 1);
}

/** Slash command markup (`<command-name>/x</command-name>` and its args) as the person typed it: `/x args`. */
function slashCommand(s: string): { text: string; rest: string } | null {
  let rest = s;
  const parts: Record<string, string> = {};
  for (let i = 0; i < 4; i++) {
    const m = /^\s*<(command-name|command-message|command-args)>([\s\S]*?)<\/\1>/.exec(rest);
    if (!m) break;
    parts[m[1]!] = m[2]!.trim();
    rest = rest.slice(m[0].length);
  }
  const name = parts["command-name"];
  if (!name) return null;
  return { text: [name.startsWith("/") ? name : `/${name}`, parts["command-args"]].filter(Boolean).join(" "), rest };
}

/**
 * Removes system-injected content from agent text: leading injected blocks and markers (and their notice lines),
 * wrappers around another agent's message (keeping its body), and `<system-reminder>` blocks anywhere. Never throws;
 * bounded work on any input.
 */
export function stripInjected(raw: string | null | undefined, depth = 0): Uninjected {
  if (!raw) return { text: "", kind: "none" };
  let s = raw.includes("<system-reminder") ? raw.replace(ANYWHERE_RE, "") : raw;
  let stripped = s !== raw;
  for (let i = 0; i < 32; i++) {
    const lead = s.trimStart();
    if (!lead.startsWith("<")) break;
    const slash = slashCommand(lead);
    if (slash) {
      // The person typed a slash command; keep it as they typed it.
      s = `${slash.text}${slash.rest.trim() ? `\n${slash.rest.trimStart()}` : ""}`;
      stripped = true;
      break;
    }
    const m = OPEN_RE.exec(lead);
    if (!m) break;
    const name = m[1]!.toLowerCase();
    if (!isSystemTag(name)) break;
    stripped = true;
    if (m[3]) {
      s = afterMarker(lead.slice(m[0].length));
      continue;
    }
    const close = findClose(lead, name, m[0].length);
    if (WRAPPERS.has(name)) {
      // Another agent's message: its body is the text (cleaned of its own markers), anything after the wrapper is
      // more injected content.
      const inner = close ? lead.slice(m[0].length, close.start) : lead.slice(m[0].length);
      const body = depth < 4 ? stripInjected(inner, depth + 1).text : inner.trim();
      return { text: body, kind: "wrapped" };
    }
    // A notice, a hook's output, an instruction block: gone with everything inside it. An unclosed one (text cut at
    // its cap) takes the rest of the text with it.
    s = close ? lead.slice(close.end) : "";
  }
  const text = s.trim();
  if (!stripped) return { text: raw.trim(), kind: "none" };
  return { text, kind: text ? "stripped" : "notice" };
}

/**
 * A prompt the agent tool injected rather than a person typed (a task notice, another agent's message): no person
 * spoke, so it is not a prompt at all (the relay sends a turn start without one; the hub and board drop it).
 */
export function isInjectedPrompt(prompt: string | null | undefined): boolean {
  const k = stripInjected(prompt).kind;
  return k === "notice" || k === "wrapped";
}

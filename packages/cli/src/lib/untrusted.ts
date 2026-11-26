/**
 * Text another person or their agent wrote, on its way into an agent's context or onto a person's terminal: a
 * message, a note, a session name, a handoff's task, a hold's reason. The hub passes it on as written, so the relay
 * cleans it here, on the machine that reads it. Three rules:
 *
 * - nothing the reader cannot see stays in it (escape sequences, control and invisible characters);
 * - a name, a note or a reason is one line;
 * - a message's body is marked line by line, so no line of it can read as Workmesh's own words or the person's.
 *
 * Marking is a second layer. What a session may be sent, and what may wake it, is decided elsewhere.
 */

/* eslint-disable no-control-regex */

/** Terminal escape sequences: CSI (`ESC [ … m`), OSC (`ESC ] … BEL`) and the two-character ones. */
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;

/** Every way a text can break a line, read as one. */
const NEWLINE_RE = /\r\n?|[\u0085\u2028\u2029]/g;

/** C0 controls except tab and line feed, DEL, and the C1 block. */
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Characters a person cannot see and a model still reads: the soft hyphen, zero-width space and word joiner, the
 * byte-order mark, direction marks, embeddings, overrides and isolates, the invisible operators, interlinear
 * annotation marks, the Unicode tag block (U+E0000–U+E007F) and the variation selector supplement
 * (U+E0100–U+E01EF). The zero-width joiner and non-joiner stay: emoji and several scripts need them.
 */
const INVISIBLE_RE =
  /[\u00ad\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]|\udb40[\udc00-\udc7f\udd00-\uddef]/g;

/**
 * An opening or closing tag that an agent tool or Workmesh would write: a name with `-`, `_` or `:` in it
 * (`system-reminder`, `environment_context`, `workmesh-message`). Plain HTML and code (`<div>`, `Array<string>`,
 * `a<b_c) {`) are left alone.
 */
const MARKUP_RE = /<(?=\/?[a-z][a-z0-9]*(?:[-_:][a-z0-9]+)+(?:\s[^<>]*)?\/?>)/gi;

/** What every line of someone else's text starts with. */
export const QUOTE_MARK = "│";

/** `s` cut to `max` characters, never through the middle of a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const end = Math.max(0, max);
  const last = s.charCodeAt(end - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

/** `s` with nothing unseen in it; every line break is `\n`. */
export function cleanText(s: string): string {
  return s.replace(ANSI_RE, "").replace(NEWLINE_RE, "\n").replace(CONTROL_RE, "").replace(INVISIBLE_RE, "");
}

/** A name, a note or a reason as one line of at most `max` characters. */
export function oneLine(s: string, max = 200): string {
  const one = cleanText(s).replace(/\s+/g, " ").trim();
  return one.length > max ? `${cut(one, max - 1)}…` : one;
}

/** A name for a label: one line, without the characters that would end a quoted value or open a tag. */
export function label(s: string, max = 80): string {
  return oneLine(s.replace(/["<>]/g, ""), max);
}

/**
 * A body as marked lines: cleaned, tool markup defused (`<system-reminder>` reads `&lt;system-reminder>`), at most
 * `max` characters of it, and every line behind `QUOTE_MARK`.
 */
export function quoted(text: string, max = Number.POSITIVE_INFINITY): string {
  let body = cleanText(text).replace(MARKUP_RE, "&lt;").replace(/\n{3,}/g, "\n\n").trim();
  if (body.length > max) body = `${cut(body, max - 1).trimEnd()}…`;
  return body
    .split("\n")
    .map((line) => (line ? `${QUOTE_MARK} ${line}` : QUOTE_MARK))
    .join("\n");
}

/**
 * One message from a teammate as a block: who it is from on the opening line, the text as marked lines. The sender
 * chooses the text and the session name, so neither can leave the block or add a line to it.
 *
 * `via` says where the hub made the message from when no paired machine sent it (SPEC §23): `linear` for a Linear
 * user's prompt, `other` for a source this relay does not know. The opening line then ends with one of these two
 * words, written here and never copied from the hub.
 */
export function messageBlock(
  from: { person: string; sessionName?: string | undefined },
  text: string,
  max?: number,
  via?: "linear" | "other" | undefined,
): string {
  const session = from.sessionName ? label(from.sessionName) : "";
  const source = via === undefined ? "" : via === "linear" ? ' via="linear"' : ' via="other"';
  const who = `from="${label(from.person)}"${session ? ` session="${session}"` : ""}${source}`;
  return `<workmesh-message ${who}>\n${quoted(text, max)}\n</workmesh-message>`;
}

/**
 * A structured answer (a tool result's `data`, which `--json` prints) with every string in it cleaned as `cleanText`
 * does. Keys, numbers and the shape stay as they are. JSON already keeps a string's line breaks inside the string, so
 * only what a reader cannot see has to go.
 */
export function cleanData<T>(value: T): T {
  if (typeof value === "string") return cleanText(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => cleanData(item)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = cleanData(item);
    return out as T;
  }
  return value;
}

/**
 * Text that came from a hub or another machine, made fit to show on one line of a terminal, a log or a notification.
 * Control characters and line breaks become spaces, invisible formatting characters are dropped, runs of whitespace
 * collapse, and the result is cut to `max` characters.
 *
 * A small local helper. Where `lib/untrusted.ts` exists, its `oneLine` does this job and this file can go.
 */
export function oneLine(text: string, max = 200): string {
  const flat = text
    // Control characters, and the line and paragraph separators: a break in the line.
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    // Format characters (zero-width, direction marks and overrides) and lone surrogates: never shown as text.
    .replace(/[\p{Cf}\p{Cs}]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

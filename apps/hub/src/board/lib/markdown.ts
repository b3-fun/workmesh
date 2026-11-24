// A small, safe markdown subset for agent messages and prompts (SPEC.md §12): code spans and blocks, bold, italics,
// lists, links, headings, quotes and simple tables. It produces a tree that React renders as text nodes, so raw HTML
// in the source shows up as text and never as markup.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] };

export interface ListItem {
  level: number;
  c: Inline[];
}

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "quote"; c: Inline[] }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] };

/** http(s) and mailto only; anything else (javascript:, data:, relative) renders as plain text. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (!/^(https?:\/\/|mailto:)/i.test(href)) return null;
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.href : null;
  } catch {
    return null;
  }
}

const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]+?)\*\*|__(?=\S)([\s\S]+?)__|\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|(?<![\w*])\*(?=[^\s*])([^*\n]+?)\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_\n]+?)_(?![\w_])|(https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"])/g;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (v: string) => {
    if (!v) return;
    const prev = out[out.length - 1];
    if (prev?.t === "text") prev.v += v;
    else out.push({ t: "text", v });
  };
  for (const m of src.matchAll(INLINE)) {
    const i = m.index ?? 0;
    push(src.slice(last, i));
    last = i + m[0].length;
    if (m[1] != null) {
      const v = m[2]!;
      out.push({ t: "code", v: v.length > 2 && v.startsWith(" ") && v.endsWith(" ") ? v.slice(1, -1) : v });
    } else if (m[3] != null || m[4] != null) out.push({ t: "strong", c: parseInline(m[3] ?? m[4]!) });
    else if (m[5] != null) {
      const href = safeHref(m[6]!);
      if (href) out.push({ t: "link", href, c: parseInline(m[5]) });
      else push(m[5]);
    } else if (m[7] != null || m[8] != null) out.push({ t: "em", c: parseInline(m[7] ?? m[8]!) });
    else if (m[9] != null) {
      const href = safeHref(m[9]);
      if (href) out.push({ t: "link", href, c: [{ t: "text", v: m[9] }] });
      else push(m[9]);
    }
  }
  push(src.slice(last));
  return out;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|")) l = l.slice(0, -1);
  return l.split("|").map((c) => c.trim());
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join(" ")) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      const close = fence[1]!;
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(close); i++) body.push(lines[i]!);
      blocks.push({ t: "code", lang: fence[2] ?? "", v: body.join("\n") });
      continue;
    }
    if (!line.trim() || RULE.test(line)) {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ t: "h", c: parseInline(h[1]!) });
      continue;
    }
    if (line.trim().startsWith("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      flush();
      const head = cells(line).map(parseInline);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && lines[i]!.trim().startsWith("|"); i++) rows.push(cells(lines[i]!).map(parseInline));
      i--;
      blocks.push({ t: "table", head, rows });
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]!); i++) quote.push(lines[i]!.replace(/^\s{0,3}>\s?/, ""));
      i--;
      blocks.push({ t: "quote", c: parseInline(quote.join(" ")) });
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]!);
      const raw: { level: number; text: string }[] = [];
      const base = li[1]!.length;
      for (; i < lines.length; i++) {
        const l = lines[i]!;
        const m = LIST.exec(l);
        if (m && /\d/.test(m[2]!) === ordered) {
          raw.push({ level: Math.min(3, Math.floor(Math.max(0, m[1]!.length - base) / 2)), text: m[3]! });
        } else if (m && m[1]!.length > base) {
          // A nested list of the other kind stays in this list, one level in.
          raw.push({ level: Math.min(3, 1 + Math.floor(Math.max(0, m[1]!.length - base - 2) / 2)), text: m[3]! });
        } else if (m) {
          break;
        } else if (l.trim() && /^\s+/.test(l) && raw.length) {
          raw[raw.length - 1]!.text += ` ${l.trim()}`;
        } else break;
      }
      i--;
      const items: ListItem[] = raw.map((r) => ({ level: r.level, c: parseInline(r.text) }));
      blocks.push({ t: "list", ordered, start: ordered ? Number.parseInt(li[2]!, 10) || 1 : 1, items });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

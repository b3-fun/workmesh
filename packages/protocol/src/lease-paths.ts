// File-lease paths (public SPEC §21, v1 Coordinate). No zod here: the relay's hooks, the hub's lease table and the
// board all read lease paths the same way, from this one file.
//
// A lease entry is a repo-relative path or glob. `*` matches within one path segment, `?` one character of it, `**` any
// number of whole segments (zero included). Every other character is literal (`app/[id]/page.tsx` is a plain path).
// An entry covers the paths it matches **and everything under them**: `packages/cli` covers
// `packages/cli/src/index.ts`, `packages/*` covers every file of every package, `**` the whole repo.

/** Longest lease path (the same cap as an event's `path`). */
export const LEASE_PATH_MAX = 400;

const GLOB_CHARS = /[*?]/;

/**
 * A lease path as a relay sends it: repo-relative (no leading `/`, `~`, `\` or drive letter, no `..`), no `.` or empty
 * segments, no trailing `/`, no control characters, at most LEASE_PATH_MAX chars, and `**` only as a whole segment.
 */
export function isLeasePath(p: string): boolean {
  if (p.length === 0 || p.length > LEASE_PATH_MAX) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects
  if (/[\u0000-\u001f\u007f\\]/.test(p)) return false;
  if (p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:/.test(p)) return false;
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return false;
    if (s.includes("**") && s !== "**") return false;
  }
  return true;
}

/**
 * The form a relay sends: `./a//b/` → `a/b`, backslashes as `/`. Undefined when nothing sendable is left
 * (absolute, escaping the repo, empty).
 */
export function normalizeLeasePath(raw: string): string | undefined {
  let p = raw.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = p
    .split("/")
    .filter((s) => s !== ".")
    .join("/")
    .replace(/\/+$/, "");
  return isLeasePath(p) ? p : undefined;
}

/** True when the entry has `*` or `?` (a glob), false for a plain path. */
export function isLeaseGlob(entry: string): boolean {
  return GLOB_CHARS.test(entry);
}

const segRegexCache = new Map<string, RegExp>();

/** One glob segment (`*.ts`, `a?c`) as a regex over one literal segment. */
function segRegex(pattern: string): RegExp {
  let re = segRegexCache.get(pattern);
  if (!re) {
    const body = pattern
      .split("")
      .map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("");
    re = new RegExp(`^${body}$`);
    if (segRegexCache.size > 500) segRegexCache.clear();
    segRegexCache.set(pattern, re);
  }
  return re;
}

/** Whether two single-segment patterns (with `*` and `?`) can match one same segment. */
function segmentsIntersect(a: string, b: string): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const k = i * (b.length + 1) + j;
    const hit = memo.get(k);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (i === a.length && j === b.length) r = true;
    else if (i < a.length && a[i] === "*") r = go(i + 1, j) || (j < b.length && go(i, j + 1));
    else if (j < b.length && b[j] === "*") r = go(i, j + 1) || (i < a.length && go(i + 1, j));
    else if (i < a.length && j < b.length) {
      const ca = a[i]!;
      const cb = b[j]!;
      r = (ca === cb || ca === "?" || cb === "?") && go(i + 1, j + 1);
    } else r = false;
    memo.set(k, r);
    return r;
  };
  return go(0, 0);
}

/**
 * Whether a lease entry covers a concrete repo-relative file path: the entry matches the path or one of its parent
 * directories. Both sides are compared in their normalized form; an entry or path that isn't one is never covered.
 */
export function leasePathCovers(entry: string, filePath: string): boolean {
  const e = normalizeLeasePath(entry);
  const p = normalizeLeasePath(filePath);
  if (e === undefined || p === undefined) return false;
  if (!isLeaseGlob(e)) return p === e || p.startsWith(`${e}/`);
  const E = e.split("/");
  const P = p.split("/");
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const k = i * (P.length + 1) + j;
    const hit = memo.get(k);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (i === E.length) r = true; // the entry matched the path or a parent of it
    else if (E[i] === "**") r = go(i + 1, j) || (j < P.length && go(i, j + 1));
    else if (j === P.length) r = false;
    else r = segRegex(E[i]!).test(P[j]!) && go(i + 1, j + 1);
    memo.set(k, r);
    return r;
  };
  return go(0, 0);
}

/**
 * Whether two lease entries can cover one same file (the hub's exclusivity check). Exact for plain paths; for globs it
 * answers whether some path matched by one is the other's match or sits under it, which is what "covers" means.
 */
export function leasePathsOverlap(a: string, b: string): boolean {
  const x = normalizeLeasePath(a);
  const y = normalizeLeasePath(b);
  if (x === undefined || y === undefined) return false;
  if (!isLeaseGlob(x) && !isLeaseGlob(y)) return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
  const A = x.split("/");
  const B = y.split("/");
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const k = i * (B.length + 1) + j;
    const hit = memo.get(k);
    if (hit !== undefined) return hit;
    let r: boolean;
    // One side is used up: what the other matches from here sits under (or is) that match.
    if (i === A.length || j === B.length) r = true;
    else if (A[i] === "**") r = go(i + 1, j) || go(i, j + 1);
    else if (B[j] === "**") r = go(i, j + 1) || go(i + 1, j);
    else r = segmentsIntersect(A[i]!, B[j]!) && go(i + 1, j + 1);
    memo.set(k, r);
    return r;
  };
  return go(0, 0);
}

/** The entries of `entries` that cover `filePath` (for a deny message: "packages/cli/** covers it"). */
export function leaseEntriesCovering(entries: readonly string[], filePath: string): string[] {
  return entries.filter((e) => leasePathCovers(e, filePath));
}

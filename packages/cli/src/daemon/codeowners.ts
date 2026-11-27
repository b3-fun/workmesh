import fs from "node:fs";
import path from "node:path";

/**
 * CODEOWNERS for a review request (docs/SPEC.md §52, §53): who owns the files a PR changes, read from the author's
 * own checkout. GitHub's rules: the file is `.github/CODEOWNERS`, `CODEOWNERS` or `docs/CODEOWNERS` (first found);
 * each line is a gitignore-style pattern and its owners (`@login`, `@org/team`, an email); the last matching line
 * wins, and a line with no owners leaves the path unowned. The hub reads the owners as a routing hint only.
 */

export const CODEOWNERS_FILES = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;
/** The largest CODEOWNERS file read (GitHub's own limit is 3 MB). */
const MAX_BYTES = 3 * 1024 * 1024;
const OWNER_RE = /^(?:@[\w.-]+(?:\/[\w.-]+)?|[^\s@]+@[^\s@]+)$/;

export interface CodeownersRule {
  pattern: string;
  re: RegExp;
  owners: string[];
}

/** A gitignore-style CODEOWNERS pattern as a regex over a repo-relative path. */
export function patternRegex(pattern: string): RegExp {
  let p = pattern.trim();
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.replace(/\/+$/, "");
  // A leading slash, or a slash inside the pattern, anchors it at the repo's root (gitignore).
  const anchored = p.startsWith("/") || p.includes("/");
  p = p.replace(/^\/+/, "");
  let src = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        // `**/` any number of directories, `/**` everything under, `**` anything.
        if (p[i + 2] === "/") {
          src += "(?:.*/)?";
          i += 2;
        } else {
          src += ".*";
          i += 1;
        }
      } else {
        src += "[^/]*";
      }
    } else if (c === "?") {
      src += "[^/]";
    } else {
      src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  if (p === "*") return /^.*$/;
  const head = anchored ? "^" : "^(?:.*/)?";
  // A directory pattern covers what is under it. A plain name matches the file, or a directory and what's under it.
  // One whose last part is a glob (`docs/*`, `*.ts`) matches what it names only: GitHub's `docs/*` leaves
  // `docs/a/b.md` alone.
  const last = p.split("/").pop() ?? "";
  const tail = dirOnly ? "/.*$" : /[*?]/.test(last) ? "$" : "(?:/.*)?$";
  return new RegExp(`${head}${src}${tail}`);
}

/** The rules in a CODEOWNERS file, in order. Bad lines are skipped. */
export function parseCodeowners(text: string): CodeownersRule[] {
  const out: CodeownersRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0]!;
    if (pattern.startsWith("!") || pattern.startsWith("[")) continue; // negation and sections aren't CODEOWNERS syntax
    const owners = parts.slice(1).filter((o) => OWNER_RE.test(o) && o.length <= 120);
    try {
      out.push({ pattern, re: patternRegex(pattern), owners });
    } catch {
      // skip a pattern that won't compile
    }
  }
  return out;
}

/** The owners of one path: the last rule that matches it decides. */
export function ownersOf(rules: readonly CodeownersRule[], file: string): string[] {
  let owners: string[] = [];
  for (const r of rules) if (r.re.test(file)) owners = r.owners;
  return owners;
}

/** Every owner of any of these paths, in the order first met, at most `max`. */
export function ownersOfPaths(rules: readonly CodeownersRule[], files: readonly string[], max = 50): string[] {
  const out = new Set<string>();
  for (const f of files) {
    for (const o of ownersOf(rules, f)) {
      out.add(o);
      if (out.size >= max) return [...out];
    }
  }
  return [...out];
}

/** The checkout's CODEOWNERS rules (none when it has no such file). */
export function readCodeowners(root: string): CodeownersRule[] {
  for (const rel of CODEOWNERS_FILES) {
    const file = path.join(root, rel);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      return parseCodeowners(fs.readFileSync(file, "utf8"));
    } catch {
      // next
    }
  }
  return [];
}

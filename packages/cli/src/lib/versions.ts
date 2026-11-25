/**
 * Release versions (`0.12.1`, `1.0.0-beta.2`): compare them the way npm does (a prerelease sorts before its
 * release), and tell how big a step is, for `workmesh update --auto` (SPEC §41: patch releases only by default).
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

const VERSION_RE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(v: string | undefined | null): Version | undefined {
  if (typeof v !== "string") return undefined;
  const m = VERSION_RE.exec(v.trim());
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

/** -1, 0 or 1, by semver precedence. An unparseable version sorts before any parseable one. */
export function compareVersions(a: string | undefined | null, b: string | undefined | null): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** `candidate` is a newer release than `current` (false when either doesn't parse). */
export function isNewer(candidate: string | undefined | null, current: string | undefined | null): boolean {
  return parseVersion(candidate) !== undefined && parseVersion(current) !== undefined && compareVersions(candidate, current) > 0;
}

export type UpdateScope = "patch" | "minor";

/**
 * Whether moving `from` → `to` stays within `scope`: `patch` = same major and minor (0.12.0 → 0.12.3), `minor` = same
 * major (0.12.0 → 0.13.0, 1.2.0 → 1.5.0). A prerelease is never inside a scope, so auto-update never takes one.
 */
export function withinScope(from: string, to: string, scope: UpdateScope): boolean {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b || !isNewer(to, from) || b.pre.length > 0) return false;
  if (a.major !== b.major) return false;
  return scope === "minor" || a.minor === b.minor;
}

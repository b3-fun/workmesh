import fs from "node:fs";
import path from "node:path";

/**
 * Resolves a path to its git repository by reading .git metadata directly (no
 * `git` subprocess: the forwarder runs inside the daemon's request path and
 * must stay cheap). Linked worktrees resolve to their main repository's
 * remote; the worktree's own top-level dir and branch are kept for
 * repo-relative paths.
 */
export interface RepoInfo {
  /** Top-level dir of the checkout the path is in (a linked worktree's own dir). */
  root: string;
  /** Top-level dir of the main repository (same as root unless a linked worktree). */
  mainRoot: string;
  /** origin, normalized to "host/owner/name" with no credentials or .git suffix. */
  remote?: string;
  /** "owner/name" from origin, when it has exactly that shape. */
  repo?: string;
  /** Checked-out branch; undefined when HEAD is detached. */
  branch?: string;
}

/** Normalizes a git remote URL to "host/path" (lowercase host, no user, port, or .git). */
export function normalizeRemote(url: string): string | undefined {
  const raw = url.trim();
  if (!raw) return undefined;
  let host: string;
  let pathname: string;
  // scp-like syntax: [user@]host:owner/name(.git)
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(raw);
  if (scp && !raw.includes("://")) {
    host = scp[1]!;
    pathname = scp[2]!;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return undefined; // a local path remote: nothing to match on
    }
    if (!parsed.hostname || parsed.protocol === "file:") return undefined;
    host = parsed.hostname;
    pathname = parsed.pathname;
  }
  const clean = pathname
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  if (!clean) return undefined;
  return `${host.toLowerCase()}/${clean}`;
}

/** "owner/name" from a normalized remote, only when the path has exactly two segments. */
export function repoFromRemote(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const parts = remote.split("/").slice(1);
  if (parts.length !== 2) return undefined;
  const name = parts.join("/");
  return /^[\w.-]+\/[\w.-]+$/.test(name) && name.length <= 200 ? name : undefined;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** url of [remote "origin"] in a git config file. */
export function originUrlFromConfig(config: string): string | undefined {
  let inOrigin = false;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1]!.trim());
      continue;
    }
    if (!inOrigin) continue;
    const kv = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (kv) return kv[1]!.replace(/^"(.*)"$/, "$1");
  }
  return undefined;
}

interface GitDirs {
  root: string;
  gitDir: string;
}

/** Walks up from `start` to the nearest dir holding a .git dir or .git file. */
function findCheckout(start: string): GitDirs | undefined {
  let dir = start;
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) return { root: dir, gitDir: dotGit };
    if (stat?.isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? "");
      if (pointer) return { root: dir, gitDir: path.resolve(dir, pointer[1]!) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Nearest existing directory at or above `p` (new files don't exist yet). */
function existingDir(p: string): string {
  let dir = p;
  for (;;) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      // missing: walk up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

export interface GitResolverOptions {
  /** How long a resolved checkout (remote, branch) is reused. Default 5 s. */
  ttlMs?: number;
  now?: () => number;
}

export class GitResolver {
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** start dir → checkout (or null = not in a repo) */
  private readonly checkouts = new Map<string, { at: number; dirs: GitDirs | null }>();
  /** checkout root → resolved info */
  private readonly infos = new Map<string, { at: number; info: RepoInfo }>();

  constructor(opts: GitResolverOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5000;
    this.now = opts.now ?? Date.now;
  }

  /** The repository `absPath` is in, or undefined when it isn't in one. */
  resolve(absPath: string): RepoInfo | undefined {
    if (!path.isAbsolute(absPath)) return undefined;
    const now = this.now();
    const start = existingDir(path.normalize(absPath));
    let hit = this.checkouts.get(start);
    if (!hit || now - hit.at > this.ttlMs) {
      hit = { at: now, dirs: findCheckout(start) ?? null };
      this.checkouts.set(start, hit);
      if (this.checkouts.size > 2000) this.checkouts.clear(); // bound memory
    }
    if (!hit.dirs) return undefined;
    const cached = this.infos.get(hit.dirs.root);
    if (cached && now - cached.at <= this.ttlMs) return cached.info;
    const info = this.read(hit.dirs);
    this.infos.set(hit.dirs.root, { at: now, info });
    return info;
  }

  private read({ root, gitDir }: GitDirs): RepoInfo {
    // Linked worktrees: <main>/.git/worktrees/<name>/commondir → "../.."
    const common = readText(path.join(gitDir, "commondir"))?.trim();
    const commonDir = common ? path.resolve(gitDir, common) : gitDir;
    const mainRoot = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : root;
    const url = originUrlFromConfig(readText(path.join(commonDir, "config")) ?? "");
    const remote = url ? normalizeRemote(url) : undefined;
    const head = readText(path.join(gitDir, "HEAD"))?.trim() ?? "";
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    const branch = ref && ref[1]!.length <= 200 ? ref[1] : undefined;
    return { root, mainRoot, remote, repo: repoFromRemote(remote), branch };
  }
}

import fs from "node:fs";
import path from "node:path";

/**
 * The Node binary Workmesh writes into everything that starts it later: Claude Code's and Codex's hooks, Codex's
 * notify, both MCP registrations, and the launchd / systemd service (0.12.1).
 *
 * Node reports its own resolved path (`process.execPath`). For Homebrew that is the Cellar's versioned one
 * (`/opt/homebrew/Cellar/node/25.8.2/bin/node`), which `brew upgrade` (and the cleanup after it) deletes, so every
 * hook stopped without a word. So the path written is a stable name for the same binary when one exists:
 *
 * - Homebrew: `<prefix>/bin/node` (linked formula) or `<prefix>/opt/<formula>/bin/node` (keg-only, e.g. `node@22`).
 *   Both follow upgrades.
 * - nvm's `current` link (`NVM_SYMLINK_CURRENT`), fnm's `aliases/default`, mise's major-version link
 *   (`installs/node/22`): each written only while it resolves to this very binary.
 * - Otherwise `node` on PATH when it is this binary and not itself inside a version's tree (`/usr/local/bin`, a
 *   distro's `/usr/bin`).
 * - Otherwise this binary as is.
 *
 * Shims (Volta's `~/.volta/bin/node`, asdf's and mise's `shims/node`) are never written: they choose a Node per
 * project, and a project pinned to an older Node would run every hook on it. `#!/usr/bin/env node` isn't used either:
 * agents launched from the Dock or an IDE don't inherit the shell's PATH (why hooks are absolute in the first place),
 * and under nvm, fnm, asdf or Volta a global install of Workmesh lives in the same version's tree as its Node, so
 * after that version is removed there is no CLI left for a PATH lookup to run. There the fix is to install Workmesh
 * under the new Node and run `workmesh setup --hooks-only` (or `workmesh update`), which `doctor` says.
 */

/** Who put a Node binary at a path that names its version. */
export type NodeManager = "homebrew" | "nvm" | "fnm" | "volta" | "asdf" | "mise" | "n";

/** The file system reads this module makes (tests pass fakes). */
export interface NodePathFs {
  realpath(p: string): string;
}

const realFs: NodePathFs = { realpath: (p) => fs.realpathSync(p) };

const slash = (p: string): string => p.replace(/\\/g, "/");

/**
 * The manager whose versioned tree `p` is in: a path that names one Node version, which an upgrade (Homebrew) or an
 * uninstall (the version managers) deletes. Undefined for a stable path (`/opt/homebrew/bin/node`, `/usr/bin/node`,
 * an alias such as fnm's `aliases/default` or mise's `installs/node/22`).
 */
export function nodeManagerOf(p: string): NodeManager | undefined {
  const s = slash(p);
  if (/\/Cellar\/[^/]+\/[^/]+\/bin\/node$/.test(s)) return "homebrew";
  if (/\/\.volta\/tools\/image\/node\//.test(s)) return "volta";
  if (/\/\.asdf\/installs\/nodejs\//.test(s)) return "asdf";
  if (/\/(?:mise|rtx)\/installs\/node(?:js)?\/\d+\.\d+\.\d+[^/]*\//.test(s)) return "mise";
  if (/\/(?:\.?fnm|fnm_multishells)\//.test(s) && /\/node-versions\/|\/fnm_multishells\//.test(s)) return "fnm";
  if (/\/\.?nvm\/(?:versions\/node\/)?v\d+[^/]*\/bin\/node$/.test(s)) return "nvm";
  if (/\/n\/versions\/node\//.test(s)) return "n";
  return undefined;
}

/** A version manager's tree (not Homebrew): the old `versionManagedNode` reading, kept for setup's note. */
export function versionManagedNode(p: string): boolean {
  const m = nodeManagerOf(p);
  return m !== undefined && m !== "homebrew";
}

/** Names that a manager keeps pointing at the current binary, for a binary in its versioned tree. */
function managerAliases(real: string): string[] {
  const s = slash(real);
  const brew = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(s);
  if (brew) return [`${brew[1]}/bin/node`, `${brew[1]}/opt/${brew[2]}/bin/node`];
  const nvm = /^(.*\/\.?nvm)\/(?:versions\/node\/)?v\d+[^/]*\/bin\/node$/.exec(s);
  if (nvm) return [`${nvm[1]}/current/bin/node`];
  const fnm = /^(.*)\/node-versions\/[^/]+\/installation\/bin\/node$/.exec(s);
  if (fnm) return [`${fnm[1]}/aliases/default/bin/node`];
  const mise = /^(.*\/(?:mise|rtx)\/installs\/node(?:js)?)\/(\d+)\.\d+\.\d+[^/]*\/bin\/node$/.exec(s);
  if (mise) return [`${mise[1]}/${mise[2]}/bin/node`];
  return [];
}

/**
 * The stable path for the Node binary at `execPath` (see the module comment), or `execPath` itself when there is
 * none. `pathEnv` is searched for a `node` that is the same program; a candidate counts only when it resolves to the
 * same file now, so an alias that points at another version is never written.
 */
export function stableNodePath(execPath = process.execPath, pathEnv = process.env.PATH ?? "", io: NodePathFs = realFs): string {
  let real: string;
  try {
    real = io.realpath(execPath);
  } catch {
    return execPath;
  }
  const same = (candidate: string): boolean => {
    try {
      return io.realpath(candidate) === real;
    } catch {
      return false;
    }
  };
  // The aliases of the path as given first (it may sit under a symlinked prefix, e.g. /var → /private/var), then of
  // the resolved one.
  for (const alias of [...new Set([...managerAliases(execPath), ...managerAliases(real)])]) if (same(alias)) return alias;
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "node");
    if (nodeManagerOf(candidate) === undefined && same(candidate)) return candidate;
  }
  return execPath;
}

/** What `doctor` says about one Node path that hooks, MCP entries or the service run. */
export interface NodePathFinding {
  node: string;
  /** missing: no such file; versioned: a stable path exists for it; pinned: versioned with no stable name. */
  status: "missing" | "versioned" | "pinned" | "ok";
  manager?: NodeManager;
  /** The path `workmesh setup --hooks-only` would write instead (versioned). */
  stable?: string;
}

/** Reads one pinned Node path: gone, versioned with a stable alternative, versioned with none, or fine. */
export function judgeNodePath(
  node: string,
  opts: { pathEnv?: string; io?: NodePathFs; exists?: (p: string) => boolean } = {},
): NodePathFinding {
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  const manager = nodeManagerOf(node);
  if (!exists(node)) return { node, status: "missing", ...(manager ? { manager } : {}) };
  if (!manager) return { node, status: "ok" };
  const stable = stableNodePath(node, opts.pathEnv ?? process.env.PATH ?? "", opts.io ?? realFs);
  if (stable !== node && nodeManagerOf(stable) === undefined) return { node, status: "versioned", manager, stable };
  // Homebrew already links another version: this one goes at the next cleanup, and setup writes the link.
  if (manager === "homebrew") {
    const linked = managerAliases(node).find((a) => exists(a));
    if (linked) return { node, status: "versioned", manager, stable: linked };
  }
  return { node, status: "pinned", manager };
}

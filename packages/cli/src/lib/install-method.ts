import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * How this Workmesh was installed, read from the path of the CLI file that is running (SPEC §41). `workmesh update`
 * installs a new version only where it can do so the way the person did (a global npm, pnpm, bun, yarn or Volta
 * install); for a git checkout, a project dependency or npx it changes nothing and says what to do instead.
 */

export const PACKAGE_NAME = "@b3os/workmesh";

export type InstallMethod = "npm" | "pnpm" | "bun" | "yarn" | "volta" | "git" | "npx" | "local" | "unknown";

export interface InstallInfo {
  method: InstallMethod;
  /** `workmesh update` can install another version here. */
  canUpdate: boolean;
  /** The CLI file that runs (`…/dist/index.js`), resolved. */
  entry: string;
  /** The package's directory (holds package.json), when found. */
  packageDir?: string;
  /** npm: the global prefix the package lives under (`/opt/homebrew`). */
  prefix?: string;
  /** git: the checkout's root. */
  gitRoot?: string;
  /** When it can't update: what to do instead, one or two sentences with commands in backticks. */
  hint?: string;
}

export interface DetectDeps {
  realpath?: (p: string) => string;
  exists?: (p: string) => boolean;
  readJson?: (p: string) => unknown;
  writable?: (p: string) => boolean;
  home?: string;
}

const defaultReadJson = (p: string): unknown => JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
const defaultWritable = (p: string): boolean => {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};
const safeRealpath = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** `/Users/sean/x` → `~/x` for messages. */
export function tildify(p: string, home = os.homedir()): string {
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

/** The directory holding this package's package.json, walking up from the entry (dist/ → package). */
function findPackageDir(entry: string, exists: (p: string) => boolean, readJson: (p: string) => unknown): string | undefined {
  let dir = path.dirname(entry);
  for (let i = 0; i < 4; i++) {
    const file = path.join(dir, "package.json");
    if (exists(file)) {
      try {
        const pkg = readJson(file) as { name?: unknown };
        if (pkg?.name === PACKAGE_NAME) return dir;
      } catch {
        // unreadable: keep looking
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** A git checkout's root above `dir`, unless a node_modules lies between (an installed copy inside a repo). */
function findGitRoot(dir: string, exists: (p: string) => boolean): string | undefined {
  let cur = dir;
  for (let i = 0; i < 12; i++) {
    if (path.basename(cur) === "node_modules") return undefined;
    if (exists(path.join(cur, ".git"))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
  return undefined;
}

const UPDATE_LATER = "then run `workmesh update` to refresh hooks and the daemon";

export function detectInstall(entryPath: string, deps: DetectDeps = {}): InstallInfo {
  const realpath = deps.realpath ?? safeRealpath;
  const exists = deps.exists ?? fs.existsSync;
  const readJson = deps.readJson ?? defaultReadJson;
  const writable = deps.writable ?? defaultWritable;
  const home = deps.home ?? os.homedir();
  const entry = realpath(entryPath);
  const p = entry.split(path.sep).join("/");
  const packageDir = findPackageDir(entry, exists, readJson);
  const base = { entry, ...(packageDir ? { packageDir } : {}) };

  if (p.includes("/_npx/")) {
    return {
      ...base,
      method: "npx",
      canUpdate: false,
      hint: `npx runs whichever Workmesh it fetched. For hooks and a daemon that stay current, install it: \`npm i -g ${PACKAGE_NAME} && workmesh update\`.`,
    };
  }
  const gitRoot = findGitRoot(packageDir ?? path.dirname(entry), exists);
  if (gitRoot) {
    const root = tildify(gitRoot, home);
    return {
      ...base,
      method: "git",
      canUpdate: false,
      gitRoot,
      hint:
        `This Workmesh runs from a git checkout (${root}), so \`workmesh update\` leaves it alone. To update it: ` +
        `\`git -C ${root} pull\`, build it (\`npm ci && npm run build -w ${PACKAGE_NAME}\` there), then \`workmesh restart\` ` +
        "(and `workmesh setup --hooks-only` when its hooks changed).",
    };
  }
  if (p.includes("/.pnpm/") || p.includes("/pnpm/global/")) {
    // pnpm keeps each version in its own store dir (`…/node_modules/.pnpm/@b3os+workmesh@0.11.1/node_modules/…`) behind
    // a symlink (`…/node_modules/@b3os/workmesh`): use the symlink, which points at whatever version is installed.
    const store = p.indexOf("/.pnpm/");
    if (store > 0) {
      const stableDir = path.join(entry.slice(0, store), ...PACKAGE_NAME.split("/"));
      if (exists(path.join(stableDir, "package.json"))) {
        return { entry: path.join(stableDir, path.relative(packageDir ?? path.dirname(path.dirname(entry)), entry)), packageDir: stableDir, method: "pnpm", canUpdate: true };
      }
    }
    return { ...base, method: "pnpm", canUpdate: true };
  }
  if (p.includes("/.bun/install/global/")) return { ...base, method: "bun", canUpdate: true };
  if (p.includes("/.volta/tools/")) return { ...base, method: "volta", canUpdate: true };
  if (p.includes("/yarn/global/node_modules/") || p.includes("/.yarn/global/") || p.includes("/.config/yarn/global/")) {
    return { ...base, method: "yarn", canUpdate: true };
  }
  const marker = `/lib/node_modules/${PACKAGE_NAME}/`;
  const at = p.indexOf(marker);
  if (at > 0) {
    const prefix = entry.slice(0, at);
    const modules = path.join(prefix, "lib", "node_modules");
    if (!writable(modules)) {
      return {
        ...base,
        method: "npm",
        canUpdate: false,
        prefix,
        hint: `Workmesh is installed under ${prefix}, which this user can't write: \`sudo npm i -g ${PACKAGE_NAME}@latest\`, ${UPDATE_LATER}.`,
      };
    }
    return { ...base, method: "npm", canUpdate: true, prefix };
  }
  if (p.includes(`/node_modules/${PACKAGE_NAME}/`)) {
    const dir = tildify(entry.slice(0, p.indexOf(`/node_modules/${PACKAGE_NAME}/`)), home);
    return {
      ...base,
      method: "local",
      canUpdate: false,
      hint: `This Workmesh is a dependency of the project in ${dir}: update it with that project's package manager, ${UPDATE_LATER}.`,
    };
  }
  return {
    ...base,
    method: "unknown",
    canUpdate: false,
    hint: `Workmesh can't tell how it was installed here (${tildify(entry, home)}): \`npm i -g ${PACKAGE_NAME}@latest\`, ${UPDATE_LATER}.`,
  };
}

/** A package manager's binary: beside this Node first (nvm, Homebrew), then its usual homes, then PATH. */
export function managerBin(
  name: "npm" | "pnpm" | "bun" | "yarn" | "volta",
  opts: { execPath?: string; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean; home?: string } = {},
): string {
  const exists = opts.exists ?? fs.existsSync;
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const near = [path.dirname(opts.execPath ?? process.execPath)];
  if (name === "pnpm" && env.PNPM_HOME) near.push(env.PNPM_HOME);
  if (name === "bun") near.push(env.BUN_INSTALL ? path.join(env.BUN_INSTALL, "bin") : path.join(home, ".bun", "bin"));
  if (name === "volta") near.push(env.VOLTA_HOME ? path.join(env.VOLTA_HOME, "bin") : path.join(home, ".volta", "bin"));
  for (const dir of near) {
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return name;
}

/** The command that installs `spec` (`@b3os/workmesh@0.12.1`) the way this copy was installed. */
export function installCommand(info: InstallInfo, spec: string, opts: Parameters<typeof managerBin>[1] = {}): { cmd: string; args: string[] } | undefined {
  if (!info.canUpdate) return undefined;
  switch (info.method) {
    case "npm":
      return {
        cmd: managerBin("npm", opts),
        args: ["install", "--global", ...(info.prefix ? ["--prefix", info.prefix] : []), "--no-fund", "--no-audit", spec],
      };
    case "pnpm":
      return { cmd: managerBin("pnpm", opts), args: ["add", "--global", spec] };
    case "bun":
      return { cmd: managerBin("bun", opts), args: ["add", "--global", spec] };
    case "yarn":
      return { cmd: managerBin("yarn", opts), args: ["global", "add", spec] };
    case "volta":
      return { cmd: managerBin("volta", opts), args: ["install", spec] };
    default:
      return undefined;
  }
}

import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectInstall, installCommand, managerBin, tildify } from "../src/lib/install-method";
import type { InstallMethod } from "../src/lib/install-method";
import { compareVersions, isNewer, parseVersion, withinScope } from "../src/lib/versions";

/**
 * 0.12 (SPEC §41): `workmesh update` reads how it was installed from the path of the CLI file that runs, and installs
 * the new version the same way, or leaves the install alone and says what to do.
 */

const HOME = "/Users/an";
const PKG = { name: "@b3os/workmesh", version: "0.12.0" };

/** A fake file system: the files that exist, symlinks to resolve, dirs that can't be written. */
function fakeFs(opts: { files: string[]; links?: Record<string, string>; readOnly?: string[] }) {
  const files = new Set(opts.files);
  return {
    home: HOME,
    exists: (p: string) => files.has(p) || [...files].some((f) => f.startsWith(`${p}/`)),
    readJson: (p: string) => {
      if (!files.has(p)) throw new Error("ENOENT");
      return PKG;
    },
    realpath: (p: string) => {
      for (const [from, to] of Object.entries(opts.links ?? {})) if (p.startsWith(from)) return to + p.slice(from.length);
      return p;
    },
    writable: (p: string) => !(opts.readOnly ?? []).some((d) => p === d || p.startsWith(`${d}/`)),
  };
}

const pkgFiles = (dir: string) => [`${dir}/package.json`, `${dir}/dist/index.js`];

interface Row {
  name: string;
  entry: string;
  fs: Parameters<typeof fakeFs>[0];
  method: InstallMethod;
  canUpdate: boolean;
  /** A hint must mention this. */
  hint?: string;
  prefix?: string;
  packageDir?: string;
}

const TABLE: Row[] = [
  {
    name: "npm global under Homebrew",
    entry: "/opt/homebrew/lib/node_modules/@b3os/workmesh/dist/index.js",
    fs: { files: pkgFiles("/opt/homebrew/lib/node_modules/@b3os/workmesh") },
    method: "npm",
    canUpdate: true,
    prefix: "/opt/homebrew",
  },
  {
    name: "npm global under nvm",
    entry: `${HOME}/.nvm/versions/node/v22.11.0/lib/node_modules/@b3os/workmesh/dist/index.js`,
    fs: { files: pkgFiles(`${HOME}/.nvm/versions/node/v22.11.0/lib/node_modules/@b3os/workmesh`) },
    method: "npm",
    canUpdate: true,
    prefix: `${HOME}/.nvm/versions/node/v22.11.0`,
  },
  {
    name: "npm global in a root-owned prefix (Linux /usr)",
    entry: "/usr/lib/node_modules/@b3os/workmesh/dist/index.js",
    fs: { files: pkgFiles("/usr/lib/node_modules/@b3os/workmesh"), readOnly: ["/usr/lib/node_modules"] },
    method: "npm",
    canUpdate: false,
    hint: "sudo npm i -g @b3os/workmesh@latest",
  },
  {
    name: "pnpm global (store path behind a symlink)",
    entry: `${HOME}/Library/pnpm/global/5/node_modules/.pnpm/@b3os+workmesh@0.12.0/node_modules/@b3os/workmesh/dist/index.js`,
    fs: {
      files: [
        ...pkgFiles(`${HOME}/Library/pnpm/global/5/node_modules/.pnpm/@b3os+workmesh@0.12.0/node_modules/@b3os/workmesh`),
        ...pkgFiles(`${HOME}/Library/pnpm/global/5/node_modules/@b3os/workmesh`),
      ],
    },
    method: "pnpm",
    canUpdate: true,
    packageDir: `${HOME}/Library/pnpm/global/5/node_modules/@b3os/workmesh`,
  },
  {
    name: "bun global",
    entry: `${HOME}/.bun/install/global/node_modules/@b3os/workmesh/dist/index.js`,
    fs: { files: pkgFiles(`${HOME}/.bun/install/global/node_modules/@b3os/workmesh`) },
    method: "bun",
    canUpdate: true,
  },
  {
    name: "yarn classic global",
    entry: `${HOME}/.config/yarn/global/node_modules/@b3os/workmesh/dist/index.js`,
    fs: { files: pkgFiles(`${HOME}/.config/yarn/global/node_modules/@b3os/workmesh`) },
    method: "yarn",
    canUpdate: true,
  },
  {
    name: "Volta",
    entry: `${HOME}/.volta/tools/image/packages/@b3os/workmesh/lib/node_modules/@b3os/workmesh/dist/index.js`,
    fs: { files: pkgFiles(`${HOME}/.volta/tools/image/packages/@b3os/workmesh/lib/node_modules/@b3os/workmesh`) },
    method: "volta",
    canUpdate: true,
  },
  {
    name: "a git checkout (Sean's ~/Documents/workmesh): left alone",
    entry: `${HOME}/Documents/workmesh/packages/cli/dist/index.js`,
    fs: { files: [...pkgFiles(`${HOME}/Documents/workmesh/packages/cli`), `${HOME}/Documents/workmesh/.git`] },
    method: "git",
    canUpdate: false,
    hint: "git -C ~/Documents/workmesh pull",
  },
  {
    name: "a worktree of the checkout (.git is a file): left alone",
    entry: `${HOME}/Documents/workmesh-dev/packages/cli/dist/index.js`,
    fs: { files: [...pkgFiles(`${HOME}/Documents/workmesh-dev/packages/cli`), `${HOME}/Documents/workmesh-dev/.git`] },
    method: "git",
    canUpdate: false,
  },
  {
    name: "npm link: the global entry resolves into a checkout, which wins",
    entry: "/opt/homebrew/lib/node_modules/@b3os/workmesh/dist/index.js",
    fs: {
      files: [...pkgFiles(`${HOME}/src/workmesh/packages/cli`), `${HOME}/src/workmesh/.git`],
      links: { "/opt/homebrew/lib/node_modules/@b3os/workmesh": `${HOME}/src/workmesh/packages/cli` },
    },
    method: "git",
    canUpdate: false,
  },
  {
    name: "npx cache",
    entry: `${HOME}/.npm/_npx/4f1c2a/node_modules/@b3os/workmesh/dist/index.js`,
    fs: { files: pkgFiles(`${HOME}/.npm/_npx/4f1c2a/node_modules/@b3os/workmesh`) },
    method: "npx",
    canUpdate: false,
    hint: "npm i -g @b3os/workmesh",
  },
  {
    name: "a project's dependency (inside a git repo: the node_modules boundary wins)",
    entry: `${HOME}/src/app/node_modules/@b3os/workmesh/dist/index.js`,
    fs: { files: [...pkgFiles(`${HOME}/src/app/node_modules/@b3os/workmesh`), `${HOME}/src/app/.git`] },
    method: "local",
    canUpdate: false,
    hint: "~/src/app",
  },
  {
    name: "somewhere else",
    entry: "/opt/tools/workmesh/index.js",
    fs: { files: ["/opt/tools/workmesh/index.js"] },
    method: "unknown",
    canUpdate: false,
    hint: "npm i -g @b3os/workmesh@latest",
  },
];

describe("install method detection (SPEC §41)", () => {
  for (const row of TABLE) {
    it(row.name, () => {
      const info = detectInstall(row.entry, fakeFs(row.fs));
      expect(info.method).toBe(row.method);
      expect(info.canUpdate).toBe(row.canUpdate);
      if (row.canUpdate) expect(info.hint).toBeUndefined();
      else expect(info.hint).toBeTruthy();
      if (row.hint) expect(info.hint).toContain(row.hint);
      if (row.prefix) expect(info.prefix).toBe(row.prefix);
      if (row.packageDir) {
        expect(info.packageDir).toBe(row.packageDir);
        expect(info.entry).toBe(path.join(row.packageDir, "dist", "index.js"));
      }
    });
  }

  it("installs the new version the way the old one came", () => {
    const fsx = { exists: () => false, execPath: "/opt/homebrew/bin/node", env: {} as NodeJS.ProcessEnv, home: HOME };
    const npm = detectInstall(TABLE[0]!.entry, fakeFs(TABLE[0]!.fs));
    expect(installCommand(npm, "@b3os/workmesh@0.12.1", fsx)).toEqual({
      cmd: "npm",
      args: ["install", "--global", "--prefix", "/opt/homebrew", "--no-fund", "--no-audit", "@b3os/workmesh@0.12.1"],
    });
    const byMethod = (m: InstallMethod) => installCommand({ method: m, canUpdate: true, entry: "/x" }, "@b3os/workmesh@0.12.1", fsx);
    expect(byMethod("pnpm")).toEqual({ cmd: "pnpm", args: ["add", "--global", "@b3os/workmesh@0.12.1"] });
    expect(byMethod("bun")).toEqual({ cmd: "bun", args: ["add", "--global", "@b3os/workmesh@0.12.1"] });
    expect(byMethod("yarn")).toEqual({ cmd: "yarn", args: ["global", "add", "@b3os/workmesh@0.12.1"] });
    expect(byMethod("volta")).toEqual({ cmd: "volta", args: ["install", "@b3os/workmesh@0.12.1"] });
    for (const m of ["git", "npx", "local", "unknown"] as const) {
      expect(installCommand({ method: m, canUpdate: false, entry: "/x" }, "@b3os/workmesh@0.12.1")).toBeUndefined();
    }
  });

  it("finds the package manager beside this Node first (nvm, Homebrew), then its own home", () => {
    const has = (p: string) => p === "/opt/homebrew/bin/npm" || p === `${HOME}/.bun/bin/bun`;
    expect(managerBin("npm", { execPath: "/opt/homebrew/bin/node", exists: has, env: {}, home: HOME })).toBe("/opt/homebrew/bin/npm");
    expect(managerBin("bun", { execPath: "/opt/homebrew/bin/node", exists: has, env: {}, home: HOME })).toBe(`${HOME}/.bun/bin/bun`);
    expect(managerBin("pnpm", { execPath: "/opt/homebrew/bin/node", exists: has, env: {}, home: HOME })).toBe("pnpm");
  });

  it("says ~ for the home dir", () => {
    expect(tildify(`${HOME}/Documents/workmesh`, HOME)).toBe("~/Documents/workmesh");
    expect(tildify("/opt/homebrew", HOME)).toBe("/opt/homebrew");
  });
});

describe("versions", () => {
  it("compare like npm: numbers, then a prerelease before its release", () => {
    expect(compareVersions("0.12.1", "0.12.0")).toBe(1);
    expect(compareVersions("0.12.0", "0.12.0")).toBe(0);
    expect(compareVersions("0.9.9", "0.12.0")).toBe(-1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBe(1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(isNewer("0.12.1", "0.12.0")).toBe(true);
    expect(isNewer("0.12.0", "0.12.0")).toBe(false);
    expect(isNewer("latest", "0.12.0")).toBe(false);
    expect(parseVersion("v0.12.1")).toMatchObject({ major: 0, minor: 12, patch: 1 });
  });

  it("auto-update scope: patch by default, minor when asked, never a major or a prerelease", () => {
    expect(withinScope("0.12.0", "0.12.3", "patch")).toBe(true);
    expect(withinScope("0.12.0", "0.13.0", "patch")).toBe(false);
    expect(withinScope("0.12.0", "0.13.0", "minor")).toBe(true);
    expect(withinScope("0.12.0", "1.0.0", "minor")).toBe(false);
    expect(withinScope("0.12.0", "0.12.1-rc.1", "patch")).toBe(false);
    expect(withinScope("0.12.1", "0.12.0", "minor")).toBe(false);
    expect(withinScope("0.12.0", "0.12.0", "patch")).toBe(false);
  });
});

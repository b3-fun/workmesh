import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeHookCommand, installClaudeHooks } from "../src/adapters/claude-code";
import { installCodexHooks, installCodexNotify } from "../src/adapters/codex";
import { installClaudeMcp, installCodexMcp } from "../src/adapters/mcp-install";
import { nodePathChecks, pinnedNodeUses } from "../src/commands/doctor";
import { nodePathWarning } from "../src/commands/setup";
import { judgeNodePath, nodeManagerOf, stableNodePath } from "../src/lib/node-path";
import { installService, serviceStatus } from "../src/lib/service";

// 0.12.1: hooks, MCP entries, Codex notify and the service run Node by a path that survives upgrades.

let root: string;
let execPath: string;

/** Makes `file` (and its directories) as an empty "binary". */
function bin(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "", { mode: 0o755 });
  return file;
}
/** A relative symlink at `link` to `target`, as Homebrew and the version managers make them. */
function link(target: string, at: string): string {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(at), target), at);
  return at;
}
/** Runs `fn` as if this process's Node were `node` (the hook writers read process.execPath). */
function asNode<T>(node: string, fn: () => T): T {
  process.execPath = node;
  try {
    return fn();
  } finally {
    process.execPath = execPath;
  }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-node-path-")));
  execPath = process.execPath;
});
afterEach(() => {
  process.execPath = execPath;
  fs.rmSync(root, { recursive: true, force: true });
});

/** Homebrew: `node` linked into bin and opt; `node@22` keg-only (opt only). */
function brew() {
  const prefix = path.join(root, "homebrew");
  const cellar = bin(path.join(prefix, "Cellar", "node", "25.8.2", "bin", "node"));
  link(cellar, path.join(prefix, "bin", "node"));
  link(path.join(prefix, "Cellar", "node", "25.8.2"), path.join(prefix, "opt", "node"));
  const keg = bin(path.join(prefix, "Cellar", "node@22", "22.11.0", "bin", "node"));
  link(path.join(prefix, "Cellar", "node@22", "22.11.0"), path.join(prefix, "opt", "node@22"));
  return { prefix, cellar, keg, stable: path.join(prefix, "bin", "node"), kegStable: path.join(prefix, "opt", "node@22", "bin", "node") };
}

describe("which paths name one Node version", () => {
  it.each([
    ["/opt/homebrew/Cellar/node/25.8.2/bin/node", "homebrew"],
    ["/usr/local/Cellar/node@22/22.11.0/bin/node", "homebrew"],
    ["/home/linuxbrew/.linuxbrew/Cellar/node/25.8.2/bin/node", "homebrew"],
    ["/Users/me/.nvm/versions/node/v22.1.0/bin/node", "nvm"],
    ["/home/me/.local/share/nvm/v26.13.0/bin/node", "nvm"],
    ["/home/me/.local/share/fnm/node-versions/v22.1.0/installation/bin/node", "fnm"],
    ["/Users/me/Library/Application Support/fnm/node-versions/v22.1.0/installation/bin/node", "fnm"],
    ["/Users/me/.volta/tools/image/node/22.1.0/bin/node", "volta"],
    ["/Users/me/.asdf/installs/nodejs/22.1.0/bin/node", "asdf"],
    ["/home/me/.local/share/mise/installs/node/22.11.0/bin/node", "mise"],
    ["/usr/local/n/versions/node/22.1.0/bin/node", "n"],
  ])("%s → %s", (p, manager) => {
    expect(nodeManagerOf(p)).toBe(manager);
  });

  it.each([
    "/opt/homebrew/bin/node",
    "/opt/homebrew/opt/node@22/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    "/home/me/.local/share/fnm/aliases/default/bin/node",
    "/home/me/.local/share/mise/installs/node/22/bin/node",
    "/Users/me/.nvm/current/bin/node",
    "/Users/me/.volta/bin/node",
  ])("%s is stable", (p) => {
    expect(nodeManagerOf(p)).toBeUndefined();
  });
});

describe("stableNodePath", () => {
  it("Homebrew: the linked bin path, or opt/<formula> for a keg-only formula, whatever PATH says", () => {
    const b = brew();
    expect(stableNodePath(b.cellar, "")).toBe(b.stable);
    expect(stableNodePath(b.keg, "/usr/bin")).toBe(b.kegStable);
  });

  it("Homebrew linked to another version: the Cellar path stays (it is not the same Node)", () => {
    const prefix = path.join(root, "homebrew");
    const old = bin(path.join(prefix, "Cellar", "node", "25.8.2", "bin", "node"));
    link(bin(path.join(prefix, "Cellar", "node", "25.9.0", "bin", "node")), path.join(prefix, "bin", "node"));
    expect(stableNodePath(old, "")).toBe(old);
    // doctor still calls it versioned and names the link setup would write.
    expect(judgeNodePath(old)).toEqual({ node: old, status: "versioned", manager: "homebrew", stable: path.join(prefix, "bin", "node") });
  });

  it("a node on PATH that is the same binary and not in a version's tree", () => {
    const real = bin(path.join(root, "opt", "node-v22", "bin", "node"));
    const usrLocal = link(real, path.join(root, "usr", "local", "bin", "node"));
    expect(stableNodePath(real, `/nope:${path.dirname(usrLocal)}`)).toBe(usrLocal);
    // A plain binary already at a stable path stays as it is.
    const plain = bin(path.join(root, "usr", "bin", "node"));
    expect(stableNodePath(plain, path.dirname(usrLocal))).toBe(plain);
  });

  it("nvm: its `current` link when it points at this version, else the version's path", () => {
    const v22 = bin(path.join(root, ".nvm", "versions", "node", "v22.1.0", "bin", "node"));
    expect(stableNodePath(v22, path.dirname(v22))).toBe(v22);
    link(path.join(root, ".nvm", "versions", "node", "v22.1.0"), path.join(root, ".nvm", "current"));
    expect(stableNodePath(v22, path.dirname(v22))).toBe(path.join(root, ".nvm", "current", "bin", "node"));
    // `current` moved to another version: not this Node, not written.
    const v24 = bin(path.join(root, ".nvm", "versions", "node", "v24.0.0", "bin", "node"));
    expect(stableNodePath(v24, "")).toBe(v24);
  });

  it("fnm's default alias and mise's major-version link, when they are this Node", () => {
    const fnm = bin(path.join(root, "fnm", "node-versions", "v22.1.0", "installation", "bin", "node"));
    link(path.join(root, "fnm", "node-versions", "v22.1.0", "installation"), path.join(root, "fnm", "aliases", "default"));
    expect(stableNodePath(fnm, "")).toBe(path.join(root, "fnm", "aliases", "default", "bin", "node"));
    const mise = bin(path.join(root, "mise", "installs", "node", "22.11.0", "bin", "node"));
    link(path.join(root, "mise", "installs", "node", "22.11.0"), path.join(root, "mise", "installs", "node", "22"));
    expect(stableNodePath(mise, "")).toBe(path.join(root, "mise", "installs", "node", "22", "bin", "node"));
  });

  it("never a shim that picks a Node per project (Volta, asdf)", () => {
    const volta = bin(path.join(root, ".volta", "tools", "image", "node", "22.1.0", "bin", "node"));
    const voltaShim = bin(path.join(root, ".volta", "bin", "node"));
    expect(stableNodePath(volta, path.dirname(voltaShim))).toBe(volta);
    const asdf = bin(path.join(root, ".asdf", "installs", "nodejs", "22.1.0", "bin", "node"));
    const asdfShim = bin(path.join(root, ".asdf", "shims", "node"));
    expect(stableNodePath(asdf, path.dirname(asdfShim))).toBe(asdf);
  });

  it("a path that can't be read is returned as is", () => {
    expect(stableNodePath(path.join(root, "nope", "node"), "")).toBe(path.join(root, "nope", "node"));
  });
});

describe("hooks, MCP, notify and the service are written with the stable path, and repointed", () => {
  const entry = "/x/node_modules/@b3os/workmesh/dist/index.js";
  const pinned = (node: string, what: string) => `"${node}" "${entry}" ${what}`;

  it("setup repoints hooks pinned to a Cellar path; other tools' hooks are left alone", () => {
    const b = brew();
    const settings = path.join(root, ".claude", "settings.json");
    const other = { type: "command", command: '"/opt/homebrew/Cellar/node/25.8.2/bin/node" /other/tool.js' };
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(
      settings,
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: pinned(b.cellar, "hook claude-code") }, other] }] } }),
    );
    const r = asNode(b.cellar, () => installClaudeHooks(settings));
    expect(r.changed).toBe(true);
    expect(r.backupPath && fs.existsSync(r.backupPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(settings, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const commands = Object.values(written.hooks).flatMap((list) => list.flatMap((e) => e.hooks.map((h) => h.command)));
    const ours = commands.filter((c) => c !== other.command);
    expect(ours.length).toBeGreaterThan(5); // every event, plus the wake hook
    for (const c of ours) expect(c.startsWith(`"${b.stable}" "`)).toBe(true);
    expect(commands).toContain(other.command);
    // Run again: nothing to change.
    expect(asNode(b.cellar, () => installClaudeHooks(settings)).changed).toBe(false);
    expect(asNode(b.cellar, () => claudeHookCommand())).toMatch(new RegExp(`^"${b.stable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" "`));
  });

  it("Codex hooks, notify and both MCP registrations follow", () => {
    const b = brew();
    const hooksJson = path.join(root, ".codex", "hooks.json");
    const config = path.join(root, ".codex", "config.toml");
    const claudeJson = path.join(root, ".claude.json");
    fs.mkdirSync(path.dirname(hooksJson), { recursive: true });
    fs.writeFileSync(hooksJson, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: pinned(b.cellar, "hook codex-hooks"), timeout: 5 }] }] } }));
    fs.writeFileSync(
      config,
      `notify = [${JSON.stringify(b.cellar)}, ${JSON.stringify(entry)}, "hook", "codex"]\n\n[mcp_servers.workmesh]\ncommand = ${JSON.stringify(b.cellar)}\nargs = [${JSON.stringify(entry)}, "mcp"]\n`,
    );
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { workmesh: { type: "stdio", command: b.cellar, args: [entry, "mcp"], env: {} } } }));

    const before = pinnedNodeUses({ settingsPath: path.join(root, "none.json"), claudeJson, codexHooks: hooksJson, codexConfig: config });
    expect(before.map((u) => [u.what, u.node])).toEqual([
      ["claude code mcp", b.cellar],
      ["codex hooks", b.cellar],
      ["codex mcp", b.cellar],
      ["codex notify", b.cellar],
    ]);
    const warned = nodePathChecks(before);
    expect(warned).toEqual([
      {
        name: "node path",
        status: "warn",
        detail: `claude code mcp, codex hooks, codex mcp and codex notify run ${b.cellar}, Homebrew's versioned path, which \`brew upgrade node\` deletes → \`workmesh setup --hooks-only\` points them at ${b.stable}`,
      },
    ]);

    asNode(b.cellar, () => {
      expect(installCodexHooks(hooksJson).changed).toBe(true);
      expect(installCodexNotify(config)).toBe("installed");
      expect(installCodexMcp(config).result).toBe("updated");
      expect(installClaudeMcp({ file: claudeJson, claudeBin: null }).result).toBe("updated");
    });
    const after = pinnedNodeUses({ settingsPath: path.join(root, "none.json"), claudeJson, codexHooks: hooksJson, codexConfig: config });
    expect(new Set(after.map((u) => u.node))).toEqual(new Set([b.stable]));
    expect(after.map((u) => u.what)).toEqual(["claude code mcp", "codex hooks", "codex mcp", "codex notify"]);
    expect(nodePathChecks(after)).toEqual([
      { name: "node path", status: "ok", detail: `claude code mcp, codex hooks, codex mcp and codex notify run ${b.stable}` },
    ]);
  });

  it("the service runs the stable path", () => {
    const b = brew();
    const run = (cmd: string, args: string[]): string => {
      if (cmd === "launchctl" && args[0] === "print") throw new Error("Could not find service");
      return "";
    };
    asNode(b.cellar, () => installService({ home: root, run, kind: "launchd", entry, env: {}, waitMs: 0 }));
    expect(serviceStatus({ home: root, run, kind: "launchd" }).program).toEqual([b.stable, entry]);
    const uses = pinnedNodeUses({
      settingsPath: path.join(root, "none.json"),
      claudeJson: path.join(root, "none.json"),
      service: { installed: true, kind: "launchd", program: [b.cellar, entry] },
    });
    expect(uses).toEqual([{ what: "the daemon's launchd service", node: b.cellar }]);
  });
});

describe("doctor: a Node that is gone, versioned, or a version manager's", () => {
  it("gone: fail, with the fix and the Node setup would write", () => {
    const gone = path.join(root, ".nvm", "versions", "node", "v20.0.0", "bin", "node");
    const checks = nodePathChecks(
      [
        { what: "claude code hooks", node: gone },
        { what: "the daemon's launchd service", node: gone },
      ],
      { current: "/opt/homebrew/bin/node" },
    );
    expect(checks).toEqual([
      {
        name: "node path",
        status: "fail",
        detail: `claude code hooks and the daemon's launchd service run ${gone}, which no longer exists, so they fail → \`workmesh setup --hooks-only\` points them at /opt/homebrew/bin/node`,
      },
    ]);
  });

  it("a version manager's path with no stable name is fine until that version goes, and says so", () => {
    const v22 = bin(path.join(root, ".nvm", "versions", "node", "v22.1.0", "bin", "node"));
    const [check] = nodePathChecks([{ what: "claude code hooks", node: v22 }], { pathEnv: "" });
    expect(check).toEqual({
      name: "node path",
      status: "ok",
      detail: `claude code hooks run ${v22} (nvm's; after removing that version, install Workmesh under your new Node and run \`workmesh setup --hooks-only\`)`,
    });
  });

  it("several paths: only the problems are listed", () => {
    const b = brew();
    const checks = nodePathChecks([
      { what: "claude code hooks", node: b.stable },
      { what: "codex hooks", node: b.cellar },
      { what: "claude code mcp", node: path.join(root, "gone", "node") },
    ]);
    expect(checks.map((c) => c.status)).toEqual(["warn", "fail"]);
    expect(nodePathChecks([])).toEqual([]);
  });

  it("setup's note is for a version manager's path only, never Homebrew's", () => {
    expect(nodePathWarning("/opt/homebrew/bin/node")).toBeUndefined();
    expect(nodePathWarning("/Users/me/.nvm/versions/node/v22.1.0/bin/node")).toContain("setup --hooks-only");
  });
});

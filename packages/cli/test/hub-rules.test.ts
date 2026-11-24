import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitResolver, normalizeRemote, originUrlFromConfig, repoFromRemote } from "../src/hub/git";
import {
  absolutePathsIn,
  extractCmd,
  extractIssues,
  extractPr,
  hubLabel,
  hubToolName,
  mentionedRoot,
  shellTokens,
} from "../src/hub/rules";

describe("extractCmd (rule 5)", () => {
  it.each([
    ["cargo test --release", "cargo test"],
    ["git commit -m \"B3-7166: fix the vm\"", "git commit"],
    ["gh pr create --title 'x' --body 'y'", "gh pr"],
    ["npm run build", "npm run"],
    ["npx vitest run test/a.test.ts", "npx vitest"],
    ["pnpm -r build", "pnpm"],
    ["python3 -m pytest -q", "python3"],
    ["node dist/index.js hook claude-code", "node"],
    ["/opt/homebrew/bin/git status", "git status"],
    ["./node_modules/.bin/tsc -b", "tsc"],
    ["cd /Users/dev/b3/b3os-beta && cargo build", "cargo build"],
    ["cd ~/x; cd y && git push origin main", "git push"],
    ["FOO=1 BAR=secret npm test", "npm test"],
    ["export TOKEN=abc && npm run deploy -- --token abc", "npm run"],
    ["source .env; pnpm dev", "pnpm dev"],
    ["time env NODE_ENV=test npx jest --ci", "npx jest"],
    ["sudo docker compose up -d", "docker compose"],
    ["git -C /Users/dev/b3/b3os-beta status --short", "git status"],
    ["git --no-pager log -1", "git log"],
    ["wrangler deploy --env production", "wrangler deploy"],
    ["kubectl get pods -n secret-ns", "kubectl get"],
    ["git checkout FEATURE/Secret", "git checkout"],
    ["git ABC", "git"],
  ])("%s → %s", (command, expected) => {
    expect(extractCmd(command)).toBe(expected);
  });

  it.each([
    'curl -H "Authorization: Bearer x" https://api.example.com',
    "cat ~/.ssh/id_rsa",
    "echo $SECRET | base64",
    "rm -rf /",
    "cd /tmp",
    "",
  ])("sends nothing for %j", (command) => {
    expect(extractCmd(command)).toBeUndefined();
  });

  it("never returns more than a program and one word", () => {
    for (const c of ["gh pr create", "linear issue create --title x", "docker compose up"]) {
      expect(extractCmd(c)?.split(" ").length).toBeLessThanOrEqual(2);
    }
  });

  it("tokenizes quotes and operators", () => {
    expect(shellTokens(`a "b c" 'd' e&&f|g;h`)).toEqual(["a", "b c", "d", "e", "&&", "f", "|", "g", ";", "h"]);
  });
});

describe("extractIssues (rule 6)", () => {
  it("finds ids for the configured keys only, upper-cased and de-duplicated", () => {
    expect(extractIssues("fix B3-7166 and b3-12, see ENG-4 and B3-7166 again", ["B3"])).toEqual(["B3-7166", "B3-12"]);
    expect(extractIssues("git checkout sean/b3-7166-relay", ["B3"])).toEqual(["B3-7166"]);
  });
  it("ignores look-alikes", () => {
    expect(extractIssues("AB3-12 B3-1234567 B3-x xB3-5", ["B3"])).toEqual([]);
    expect(extractIssues("B3-1", [])).toEqual([]);
    expect(extractIssues(undefined, ["B3"])).toEqual([]);
  });
  it("caps the list", () => {
    const text = Array.from({ length: 30 }, (_, i) => `B3-${i + 1}`).join(" ");
    expect(extractIssues(text, ["B3"])).toHaveLength(20);
  });
});

describe("extractPr (rule 7)", () => {
  it("takes the first PR URL from gh pr create|view|merge output", () => {
    expect(
      extractPr("gh pr create --fill", "Creating pull request\nhttps://github.com/b3-fun/b3os-beta/pull/42\n"),
    ).toEqual({ url: "https://github.com/b3-fun/b3os-beta/pull/42", repo: "b3-fun/b3os-beta" });
    expect(extractPr("cd x && gh pr view 7 --json url", '{"url":"https://github.com/o/r/pull/7"}')?.url).toBe(
      "https://github.com/o/r/pull/7",
    );
  });
  it("ignores other commands", () => {
    expect(extractPr("curl https://github.com/o/r/pull/1", "https://github.com/o/r/pull/1")).toBeUndefined();
    expect(extractPr("gh pr list", "https://github.com/o/r/pull/1")).toBeUndefined();
    expect(extractPr("gh pr create", "no url")).toBeUndefined();
  });
});

describe("path helpers (rule 4)", () => {
  it("finds absolute and home paths in a command", () => {
    expect(absolutePathsIn(`cat "/a/b c" ~/x/y --out=/tmp/z`, "/home/me")).toEqual(["/a/b", "/home/me/x/y", "/tmp/z"]);
  });
  it("matches a root only when a path sits inside it", () => {
    const roots = ["/w/b3/b3os-beta"];
    expect(mentionedRoot("cargo test --manifest-path /w/b3/b3os-beta/Cargo.toml", roots)).toBe("/w/b3/b3os-beta");
    expect(mentionedRoot("ls /w/b3/b3os-beta-other", roots)).toBeUndefined();
    expect(mentionedRoot("ls /w/b3", roots)).toBeUndefined();
    expect(mentionedRoot("cargo test", roots)).toBeUndefined();
  });
});

describe("labels and tool names", () => {
  it("passes fixed labels, reduces file names outside shared repos", () => {
    expect(hubLabel("running commands")).toBe("running commands");
    expect(hubLabel("editing vm.rs", new Set(["vm.rs"]))).toBe("editing vm.rs");
    expect(hubLabel("editing .env")).toBe("editing files");
    expect(hubLabel("using mcp__linear__get_issue")).toBe("using linear");
    expect(hubLabel("using mcp__claude-in-chrome__browser_batch")).toBe("using claude-in-chrome");
    expect(hubLabel("using mcp__plugin_slack_slack__slack_send_message")).toBe("using slack");
    expect(hubLabel("using WebFetch")).toBe("using WebFetch");
    // a session outside shared repos, on an event that touched no shared file
    expect(hubLabel("using mcp__claude-in-chrome__browser_batch", new Set(), { toolNames: false })).toBe("working");
    expect(hubLabel("editing notes.md", new Set(), { toolNames: false })).toBe("editing files");
    expect(hubLabel("running commands", new Set(), { toolNames: false })).toBe("running commands");
    expect(hubLabel("I refactored the auth module and rotated the key")).toBeUndefined();
  });
  it("accepts plain tool names only", () => {
    expect(hubToolName("apply_patch")).toBe("apply_patch");
    expect(hubToolName("Bash")).toBe("Bash");
    expect(hubToolName("rm -rf /")).toBeUndefined();
  });
});

describe("git resolution", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-git-")));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("normalizes remote URLs without credentials", () => {
    expect(normalizeRemote("git@github.com:b3-fun/b3os-beta.git")).toBe("github.com/b3-fun/b3os-beta");
    expect(normalizeRemote("https://user:ghp_secret@GitHub.com/b3-fun/b3os-beta.git")).toBe(
      "github.com/b3-fun/b3os-beta",
    );
    expect(normalizeRemote("ssh://git@github.com:22/b3-fun/x/")).toBe("github.com/b3-fun/x");
    expect(normalizeRemote("/srv/git/x.git")).toBeUndefined();
    expect(repoFromRemote("github.com/b3-fun/x")).toBe("b3-fun/x");
    expect(repoFromRemote("gitlab.com/group/sub/x")).toBeUndefined();
  });

  it("reads origin from a git config", () => {
    const config = '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:a/b.git\n[remote "origin"]\n\turl = git@github.com:b3-fun/c.git\n';
    expect(originUrlFromConfig(config)).toBe("git@github.com:b3-fun/c.git");
  });

  it("resolves a real worktree to its main repository", async () => {
    const { execFileSync } = await import("node:child_process");
    const main = path.join(dir, "main");
    fs.mkdirSync(main);
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: main, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "git@github.com:b3-fun/demo.git");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const wt = path.join(dir, "wt");
    git("worktree", "add", "-q", "-b", "feature/b3-9", wt);

    const resolver = new GitResolver();
    const fromMain = resolver.resolve(path.join(main, "src", "new-file.ts"));
    expect(fromMain).toMatchObject({ root: main, mainRoot: main, repo: "b3-fun/demo", branch: "main" });
    const fromWt = resolver.resolve(path.join(wt, "a.ts"));
    expect(fromWt).toMatchObject({ root: wt, mainRoot: main, repo: "b3-fun/demo", branch: "feature/b3-9" });
    expect(resolver.resolve(path.join(dir, "elsewhere"))).toBeUndefined();
  });
});

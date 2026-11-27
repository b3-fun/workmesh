import os from "node:os";
import path from "node:path";
import { shellCommands } from "../hub/shell-writes";
import { matchGates, unwrap } from "./gates";

/**
 * Review exchange (docs/SPEC.md §53): what a review run may not do. A review handoff's agent works in a throwaway
 * checkout of someone else's PR, and the PR's text and code are untrusted input: an instruction hidden in them must
 * not be able to change the PR, the repo or anything on GitHub. So for a review run the daemon refuses, at
 * `PreToolUse`:
 *
 * - every file edit tool (Edit, Write, MultiEdit, NotebookEdit, Codex's apply_patch): a reviewer reports what it would
 *   change as a finding;
 * - every write to git's remotes: `git push`, `git remote add|set-url|rename|remove`, `git config` of a remote, a push
 *   URL or a credential helper, `git credential`;
 * - every GitHub write through `gh`: `gh pr merge|review|comment|close|reopen|edit|ready|create|lock`, `gh issue`
 *   writes, `gh release`, `gh repo` writes, workflows and runs, secrets, variables, labels, gists, `gh auth`, and
 *   `gh api` with any method but GET or with fields (which make it a POST); `glab mr merge|approve|note`, `hub`;
 * - everything an approval gate matches (merges, deploys, publishes, force pushes, paid infra, SPEC §31).
 *
 * Reading stays open: `git diff`, `git log`, `gh pr view|diff|checks`, `gh api` GETs, tests and builds in the
 * checkout. The relay posts the review itself, after the run, and only when the reviewer opted in.
 *
 * Like every gate this is a cooperative guard rail on the person's own machine, not a sandbox (SPEC §31): the
 * checkout also has no push URL, and Claude Code runs without its edit tools.
 */

/** The file edit tools a review run may not use. */
export const REVIEW_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);

/** Shell tools whose command the gate reads (Claude Code `Bash`, Codex's names). */
const SHELL_TOOLS = new Set(["Bash", "shell", "shell_command", "local_shell", "exec_command", "unified_exec", "container.exec"]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);

const GH_PR_WRITES = new Set(["merge", "review", "comment", "close", "reopen", "edit", "ready", "create", "lock", "unlock", "update-branch", "revert"]);
const GH_ISSUE_WRITES = new Set(["create", "comment", "edit", "close", "reopen", "delete", "lock", "unlock", "pin", "unpin", "transfer", "develop"]);
const GH_REPO_WRITES = new Set(["create", "delete", "edit", "fork", "rename", "archive", "unarchive", "sync", "set-default", "deploy-key"]);
/** `gh <group>` commands that only write, whatever follows. */
const GH_WRITE_GROUPS = new Set(["release", "secret", "variable", "label", "gist", "auth", "ruleset", "cache", "codespace", "attestation"]);
const GH_RUN_WRITES = new Set(["rerun", "cancel", "delete"]);
const GH_WORKFLOW_WRITES = new Set(["run", "enable", "disable"]);
const GIT_REMOTE_WRITES = new Set(["add", "set-url", "rename", "remove", "rm", "set-head", "set-branches", "prune", "update"]);

const READ_ONLY_REASON =
  "This is a read-only review of a teammate's PR: Workmesh doesn't let it change the PR, the repo or GitHub.";

/** Why a review run may not run this tool call, or undefined when it may. */
export function reviewRefusal(tool: string | undefined, command: string | undefined, cwd: string | undefined, home = os.homedir()): string | undefined {
  if (!tool) return undefined;
  if (REVIEW_EDIT_TOOLS.has(tool)) {
    return `${READ_ONLY_REASON} Don't edit files: report what you would change as a finding (file, line, suggestion) in your review.`;
  }
  if (!SHELL_TOOLS.has(tool) || !command) return undefined;
  const why = shellRefusal(command, cwd, home);
  return why ? `${READ_ONLY_REASON} ${why} Report it in your review instead; the review is posted for you when your person opted in.` : undefined;
}

/** The first thing in a shell command a review may not do, in a few words, or undefined. */
export function shellRefusal(command: string, cwd: string | undefined, home = os.homedir()): string | undefined {
  // Merges, deploys, publishes, force pushes and paid infra: whatever an approval gate would ask about.
  const gated = matchGates(command, cwd, { home })[0];
  if (gated) return `It may not ${gated.gate === "force_push" ? "force-push" : gated.gate} (${gated.detail}).`;
  const visit = (cmd: string, dir: string | undefined, depth: number): string | undefined => {
    for (const simple of shellCommands(cmd, dir, home)) {
      const argv = unwrap(simple.argv);
      if (argv.length === 0) continue;
      const prog = path.basename(argv[0]!).replace(/(.)@[\w.^~-]*$/, "$1");
      if (SHELLS.has(prog) && depth < 2) {
        const i = argv.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
        const script = i === -1 ? undefined : argv[i + 1];
        if (script) {
          const inner = visit(script, simple.cwd, depth + 1);
          if (inner) return inner;
          continue;
        }
      }
      const why = refusalOf(prog, argv.slice(1));
      if (why) return why;
    }
    return undefined;
  };
  return visit(command, cwd, 0);
}

/** Positional words, skipping flags (and the value of a `-C dir` / `-c k=v` git option). */
function words(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "-R" || a === "--repo") {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    out.push(a);
  }
  return out;
}

function refusalOf(prog: string, args: readonly string[]): string | undefined {
  if (prog === "git") {
    const [sub, next] = words(args);
    if (sub === "push") return "It may not push (git push).";
    if (sub === "send-pack" || sub === "http-push") return `It may not push (git ${sub}).`;
    if (sub === "remote" && next && GIT_REMOTE_WRITES.has(next)) return `It may not change git's remotes (git remote ${next}).`;
    if (sub === "credential" || sub === "credential-store" || sub === "credential-cache") return "It may not use git's credentials directly.";
    if (sub === "config") {
      const all = args.join(" ").toLowerCase();
      if (/\b(remote\.|url\.|credential|pushurl|pushinsteadof|insteadof|push\.)/.test(all)) return "It may not change where git pushes or how it signs in (git config).";
    }
    return undefined;
  }
  if (prog === "gh") {
    const w = words(args);
    const [group, sub] = w;
    if (!group) return undefined;
    if (group === "pr" && sub && GH_PR_WRITES.has(sub)) return `It may not write to the PR (gh pr ${sub}).`;
    if (group === "issue" && sub && GH_ISSUE_WRITES.has(sub)) return `It may not write to GitHub issues (gh issue ${sub}).`;
    if (group === "repo" && sub && GH_REPO_WRITES.has(sub)) return `It may not change repositories (gh repo ${sub}).`;
    if (group === "run" && sub && GH_RUN_WRITES.has(sub)) return `It may not change workflow runs (gh run ${sub}).`;
    if (group === "workflow" && sub && GH_WORKFLOW_WRITES.has(sub)) return `It may not run or change workflows (gh workflow ${sub}).`;
    if (GH_WRITE_GROUPS.has(group)) return `It may not use gh ${group}.`;
    if (group === "api") {
      const method = flagValue(args, "-X", "--method")?.toUpperCase();
      if (method && method !== "GET") return `It may not call GitHub's API with ${method} (gh api).`;
      if (args.some((a) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a) || /^-[fF]./.test(a))) {
        // Fields make `gh api` a POST unless GET was asked for.
        if (method !== "GET") return "It may not call GitHub's API with fields (gh api -f makes a POST).";
      }
      if (args.some((a) => /graphql/i.test(a)) && args.some((a) => /\bmutation\b/i.test(a))) return "It may not send a GraphQL mutation (gh api graphql).";
      return undefined;
    }
    return undefined;
  }
  if (prog === "glab") {
    const [group, sub] = words(args);
    if (group === "mr" && sub && ["merge", "approve", "note", "close", "update", "create", "rebase"].includes(sub)) return `It may not write to the merge request (glab mr ${sub}).`;
    return undefined;
  }
  if (prog === "curl" || prog === "wget" || prog === "http" || prog === "https" || prog === "xh") {
    // A write to GitHub by hand: a method other than GET, or a body.
    if (!args.some((a) => /github\.com|githubusercontent\.com/i.test(a))) return undefined;
    const method = flagValue(args, "-X", "--request", "--method")?.toUpperCase();
    const body = args.some((a) => /^(-d|--data\S*|-F|--form\S*|-T|--upload-file|--json|--post-data|--post-file|--body-data|--body-file)(=|$)/.test(a) || /^-[dFT]./.test(a));
    const verb = prog === "http" || prog === "https" || prog === "xh" ? args.find((a) => /^(POST|PUT|PATCH|DELETE)$/i.test(a)) : undefined;
    if ((method && method !== "GET" && method !== "HEAD") || body || verb) return `It may not write to GitHub by hand (${prog}).`;
    return undefined;
  }
  if (prog === "hub") {
    const [sub] = words(args);
    if (sub && ["push", "merge", "pull-request", "release", "create", "delete", "api"].includes(sub)) return `It may not use hub ${sub}.`;
  }
  return undefined;
}

function flagValue(args: readonly string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n) return args[i + 1];
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
      if (n.length === 2 && a.startsWith(n) && a.length > 2 && !a.startsWith("--")) return a.slice(2);
    }
  }
  return undefined;
}

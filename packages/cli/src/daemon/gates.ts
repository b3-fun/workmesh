import os from "node:os";
import path from "node:path";
import type { HubGateAction } from "@workmesh/protocol";
import { shellCommands } from "../hub/shell-writes";
import { scrubText } from "../hub/redact";

/**
 * v2 approval gates, the matcher (docs/SPEC.md §31): which risky action a shell command takes, read from its words
 * the way the shell would split them. A small, tested table, not a parser of every CLI: `gh pr merge`, deploys
 * (wrangler, vercel --prod, fly, railway, netlify --prod, firebase, kubectl, helm, terraform, pulumi, cdk,
 * serverless, gcloud, aws, `npm run deploy`, `make deploy`), publishes (npm/pnpm/yarn/bun, cargo, twine, uv, poetry,
 * gem, docker push, gh release create, vsce), force pushes, and a few paid-infra creates (spend). `cd` moves the base,
 * env assignments and wrappers (sudo, env, npx, bunx, pnpm dlx, …) are looked through, and `sh -c "…"` is read
 * inside.
 *
 * The `detail` names the action in a few words for the person approving it ("gh pr merge 212 --squash in
 * b3-fun/b3os-beta"): program, subcommand, the PR or target, safe flags, and the repo. It never carries a value
 * that could be a secret (no `--token=…`, no env values) and is redacted (§9) besides.
 */

export interface GateMatch {
  gate: HubGateAction;
  /** A few words for the person approving it. */
  detail: string;
}

export interface MatchGatesOptions {
  /** The repo (`owner/name`) a directory is in, if this machine knows (the forwarder's §3.3 reading). */
  repoOf?: (dir: string) => string | undefined;
  /** The person's own patterns for `custom` (case-insensitive regex sources, matched against one simple command). */
  custom?: readonly string[];
  home?: string;
}

/** Wrappers that run the next word as the command. */
const WRAPPERS = new Set(["sudo", "command", "env", "time", "nohup", "nice", "exec", "builtin", "caffeinate", "doas"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);
/** Flags safe to show in a detail (no values a secret could hide in). */
const SAFE_FLAG = /^--?[a-z][a-z0-9-]{0,30}$/i;
const DETAIL_WORDS = 10;

/** Strips env assignments, wrappers and package runners: the argv of the program that actually runs. */
export function unwrap(argv0: readonly string[]): string[] {
  let argv = [...argv0];
  for (let guard = 0; guard < 8 && argv.length > 0; guard++) {
    const w = argv[0]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      argv = argv.slice(1);
      continue;
    }
    const base = path.basename(w);
    if (WRAPPERS.has(base)) {
      argv = argv.slice(1);
      while (argv[0]?.startsWith("-")) argv = argv.slice(1);
      continue;
    }
    if (base === "npx" || base === "bunx" || base === "uvx" || base === "pnpx") {
      argv = argv.slice(1);
      while (argv[0]?.startsWith("-")) argv = argv.slice(1);
      continue;
    }
    if ((base === "pnpm" || base === "yarn") && (argv[1] === "dlx" || argv[1] === "exec")) {
      argv = argv.slice(2);
      while (argv[0]?.startsWith("-")) argv = argv.slice(1);
      continue;
    }
    if (base === "npm" && argv[1] === "exec") {
      argv = argv.slice(2);
      while (argv[0]?.startsWith("-")) argv = argv.slice(1);
      if (argv[0] === "--") argv = argv.slice(1);
      continue;
    }
    break;
  }
  return argv;
}

const words = (args: readonly string[]): string[] => args.filter((a) => !a.startsWith("-"));
const has = (args: readonly string[], ...flags: string[]): boolean =>
  args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith("--") && a.startsWith(`${f}=`)));
/** The value of `-R x` / `--repo x` / `--repo=x`. */
function flagValue(args: readonly string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n) return args[i + 1];
      if (n.startsWith("--") && a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return undefined;
}
const safeFlags = (args: readonly string[], keep?: ReadonlySet<string>): string[] =>
  args.filter((a) => SAFE_FLAG.test(a) && (!keep || keep.has(a)));

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
const MERGE_FLAGS = new Set(["--merge", "--squash", "--rebase", "--auto", "--admin", "-m", "-s", "-r", "--delete-branch", "-d"]);

/** The first word of a script name (`deploy:prod` → deploy, `release-it` → release). */
function scriptKind(name: string | undefined): "deploy" | "publish" | undefined {
  if (!name) return undefined;
  if (/^deploy(?:$|[:_.-])/i.test(name) || /^(?:ship|promote)(?:$|[:_.-])/i.test(name)) return "deploy";
  if (/^(?:publish|release)(?:$|[:_.-])/i.test(name)) return "publish";
  return undefined;
}

interface Rule {
  gate: HubGateAction;
  /** The words of the detail (before " in <repo>"); the repo override, if the command names one. */
  words: string[];
  repo?: string;
}

/** One simple command (already unwrapped) → the gated action it takes, if any. */
function classify(argv: readonly string[]): Rule | undefined {
  // `wrangler@4` (npx with a version) is wrangler.
  const prog = path.basename(argv[0] ?? "").replace(/(.)@[\w.^~-]*$/, "$1");
  const args = argv.slice(1);
  const w = words(args);
  const sub = w[0];
  const sub2 = w[1];
  switch (prog) {
    case "gh": {
      const repo = flagValue(args, "-R", "--repo");
      if (sub === "pr" && sub2 === "merge") {
        const target = w[2];
        const url = target ? PR_URL.exec(target) : null;
        const ref = url ? url[2]! : target && /^#?\d{1,7}$/.test(target) ? target.replace(/^#/, "") : target ? "(branch)" : undefined;
        return {
          gate: "merge",
          words: ["gh pr merge", ...(ref ? [ref] : []), ...safeFlags(args, MERGE_FLAGS)],
          repo: url ? url[1] : repo,
        };
      }
      if (sub === "api") {
        const p = w.find((x) => /\/pulls\/\d+\/merge\b/.test(x));
        const method = (flagValue(args, "-X", "--method") ?? "").toUpperCase();
        if (p && method === "PUT") {
          const m = /repos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)/.exec(p);
          return { gate: "merge", words: ["gh api merge", ...(m ? [m[2]!] : [])], repo: m?.[1] ?? repo };
        }
        return undefined;
      }
      if (sub === "release" && sub2 === "create") return { gate: "publish", words: ["gh release create", ...(w[2] && /^v?[\w.-]{1,40}$/.test(w[2]) ? [w[2]] : [])], repo };
      return undefined;
    }
    case "glab":
      if (sub === "mr" && sub2 === "merge") return { gate: "merge", words: ["glab mr merge", ...(w[2] && /^\d{1,7}$/.test(w[2]) ? [w[2]] : [])] };
      return undefined;
    case "git": {
      if (sub !== "push") return undefined;
      const rest = args.slice(args.indexOf("push") + 1);
      const force =
        rest.some((a) => a === "--force" || a === "--force-with-lease" || a.startsWith("--force-with-lease=") || a === "--force-if-includes" || a === "--mirror") ||
        rest.some((a) => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) ||
        words(rest).some((a) => a.startsWith("+"));
      if (!force) return undefined;
      const flags = rest.filter((a) => /^--force(?:-with-lease(?:=.*)?|-if-includes)?$/.test(a) || a === "--mirror" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)).map((a) => (a.startsWith("--force-with-lease") ? "--force-with-lease" : a));
      const targets = words(rest)
        .slice(0, 2)
        .map((a) => a.replace(/^\+/, ""))
        .filter((a) => /^[\w./:-]{1,80}$/.test(a) && !a.includes("://") && !a.includes("@"));
      return { gate: "force_push", words: ["git push", ...flags, ...targets] };
    }
    case "wrangler": {
      if (sub === "deploy" || sub === "publish" || sub === "rollback") return { gate: "deploy", words: [`wrangler ${sub}`, ...envFlag(args)] };
      if ((sub === "pages" || sub === "versions") && (sub2 === "deploy" || sub2 === "publish")) return { gate: "deploy", words: [`wrangler ${sub} ${sub2}`, ...envFlag(args)] };
      return undefined;
    }
    case "vercel":
      if (sub === "promote" || sub === "rollback") return { gate: "deploy", words: [`vercel ${sub}`] };
      if (has(args, "--prod", "--production") && (sub === undefined || sub === "deploy")) return { gate: "deploy", words: ["vercel deploy --prod"] };
      return undefined;
    case "netlify":
      if (sub === "deploy" && has(args, "--prod", "--production")) return { gate: "deploy", words: ["netlify deploy --prod"] };
      return undefined;
    case "fly":
    case "flyctl":
      if (sub === "deploy") return { gate: "deploy", words: [`${prog} deploy`] };
      if (sub === "scale" || (sub === "machine" && (sub2 === "run" || sub2 === "create"))) return { gate: "spend", words: [`${prog} ${sub}${sub2 && sub === "machine" ? ` ${sub2}` : ""}`] };
      return undefined;
    case "railway":
      if (sub === "up" || sub === "redeploy") return { gate: "deploy", words: [`railway ${sub}`] };
      return undefined;
    case "firebase":
      if (sub === "deploy") return { gate: "deploy", words: ["firebase deploy"] };
      return undefined;
    case "kubectl":
      if (sub && ["apply", "replace", "rollout", "set", "patch", "scale", "delete"].includes(sub)) return { gate: "deploy", words: [`kubectl ${sub}`, ...(sub === "rollout" && sub2 ? [sub2] : [])] };
      return undefined;
    case "helm":
      if (sub && ["install", "upgrade", "rollback", "uninstall"].includes(sub)) return { gate: "deploy", words: [`helm ${sub}`] };
      return undefined;
    case "terraform":
    case "tofu":
      if (sub === "apply" || sub === "destroy") return { gate: "deploy", words: [`${prog} ${sub}`] };
      return undefined;
    case "pulumi":
      if (sub === "up" || sub === "update" || sub === "destroy") return { gate: "deploy", words: [`pulumi ${sub}`] };
      return undefined;
    case "cdk":
      if (sub === "deploy" || sub === "destroy") return { gate: "deploy", words: [`cdk ${sub}`] };
      return undefined;
    case "serverless":
    case "sls":
      if (sub === "deploy") return { gate: "deploy", words: [`${prog} deploy`] };
      return undefined;
    case "modal":
      if (sub === "deploy") return { gate: "deploy", words: ["modal deploy"] };
      return undefined;
    case "gcloud": {
      if (w.includes("deploy")) return { gate: "deploy", words: [`gcloud ${w.slice(0, w.indexOf("deploy") + 1).join(" ")}`] };
      if (sub === "compute" && sub2 === "instances" && w[2] === "create") return { gate: "spend", words: ["gcloud compute instances create"] };
      return undefined;
    }
    case "aws": {
      if (sub === "cloudformation" && sub2 && ["deploy", "create-stack", "update-stack", "delete-stack"].includes(sub2)) return { gate: "deploy", words: [`aws cloudformation ${sub2}`] };
      if (sub === "lambda" && sub2 && ["update-function-code", "update-function-configuration", "publish-version"].includes(sub2)) return { gate: "deploy", words: [`aws lambda ${sub2}`] };
      if (sub === "ecs" && sub2 === "update-service") return { gate: "deploy", words: ["aws ecs update-service"] };
      if (sub === "amplify" && sub2 === "start-deployment") return { gate: "deploy", words: ["aws amplify start-deployment"] };
      if (sub === "ec2" && (sub2 === "run-instances" || sub2 === "request-spot-instances")) return { gate: "spend", words: [`aws ec2 ${sub2}`] };
      return undefined;
    }
    case "doctl":
      if (w.includes("create") && (sub === "compute" || sub === "kubernetes" || sub === "databases")) return { gate: "spend", words: [`doctl ${w.slice(0, 3).join(" ")}`] };
      return undefined;
    case "hcloud":
      if (sub === "server" && sub2 === "create") return { gate: "spend", words: ["hcloud server create"] };
      return undefined;
    case "vastai":
      if (sub === "create" && sub2 === "instance") return { gate: "spend", words: ["vastai create instance"] };
      return undefined;
    case "runpodctl":
      if (sub === "create") return { gate: "spend", words: [`runpodctl create${sub2 ? ` ${sub2}` : ""}`] };
      return undefined;
    case "docker":
    case "podman":
      if (sub === "push" || (sub === "image" && sub2 === "push") || (sub === "buildx" && has(args, "--push"))) return { gate: "publish", words: [`${prog} push`] };
      return undefined;
    case "npm":
    case "pnpm":
    case "bun": {
      if (sub === "publish") return { gate: "publish", words: [`${prog} publish`, ...safeFlags(args, new Set(["--dry-run"]))] };
      if (sub === "run" || sub === "run-script") {
        const kind = scriptKind(w[1]);
        return kind ? { gate: kind, words: [`${prog} run ${w[1]}`] } : undefined;
      }
      // pnpm's own `deploy` copies a workspace package; it isn't a deployment.
      return undefined;
    }
    case "yarn": {
      if (sub === "publish" || (sub === "npm" && sub2 === "publish")) return { gate: "publish", words: ["yarn publish"] };
      const script = sub === "run" ? w[1] : sub;
      const kind = scriptKind(script);
      return kind ? { gate: kind, words: [`yarn ${sub === "run" ? "run " : ""}${script}`] } : undefined;
    }
    case "make":
    case "just":
    case "task": {
      const target = w.find((x) => !x.includes("="));
      const kind = scriptKind(target);
      return kind ? { gate: kind, words: [`${prog} ${target}`] } : undefined;
    }
    case "cargo":
      if (sub === "publish") return { gate: "publish", words: ["cargo publish", ...safeFlags(args, new Set(["--dry-run"]))] };
      return undefined;
    case "twine":
      if (sub === "upload") return { gate: "publish", words: ["twine upload"] };
      return undefined;
    case "uv":
    case "poetry":
    case "hatch":
    case "flit":
    case "vsce":
    case "ovsx":
      if (sub === "publish") return { gate: "publish", words: [`${prog} publish`] };
      return undefined;
    case "gem":
      if (sub === "push") return { gate: "publish", words: ["gem push"] };
      return undefined;
    case "changeset":
      if (sub === "publish") return { gate: "publish", words: ["changeset publish"] };
      return undefined;
    case "semantic-release":
      return has(args, "--dry-run", "-d") ? undefined : { gate: "publish", words: ["semantic-release"] };
    case "goreleaser":
      if (sub === "release") return { gate: "publish", words: ["goreleaser release"] };
      return undefined;
    default:
      return undefined;
  }
}

function envFlag(args: readonly string[]): string[] {
  const env = flagValue(args, "--env", "-e");
  return env && /^[\w-]{1,30}$/.test(env) ? ["--env", env] : [];
}

/** Every gated action in a shell command, in order (one per simple command at most). */
export function matchGates(command: string, cwd: string | undefined, opts: MatchGatesOptions = {}): GateMatch[] {
  const home = opts.home ?? os.homedir();
  const out: GateMatch[] = [];
  const custom = (opts.custom ?? [])
    .map((src) => {
      try {
        return new RegExp(src, "i");
      } catch {
        return undefined;
      }
    })
    .filter((r): r is RegExp => r !== undefined);
  const visit = (cmd: string, dir: string | undefined, depth: number): void => {
    for (const simple of shellCommands(cmd, dir, home)) {
      const argv = unwrap(simple.argv);
      if (argv.length === 0) continue;
      const prog = path.basename(argv[0]!).replace(/(.)@[\w.^~-]*$/, "$1");
      // `bash -c "…"`, `sh -lc '…'`: read the script too.
      if (SHELLS.has(prog) && depth < 2) {
        const i = argv.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
        const script = i === -1 ? undefined : argv[i + 1];
        if (script) {
          visit(script, simple.cwd, depth + 1);
          continue;
        }
      }
      const rule = classify(argv);
      const repo = rule?.repo ?? (simple.cwd ? opts.repoOf?.(simple.cwd) : undefined);
      if (rule) {
        out.push({ gate: rule.gate, detail: detailOf(rule.words, repo, home) });
        continue;
      }
      const text = argv.join(" ");
      if (custom.some((r) => r.test(text))) {
        const shown = [prog, ...words(argv.slice(1)).slice(0, 2).filter((x) => /^[\w.:/-]{1,40}$/.test(x))];
        out.push({ gate: "custom", detail: detailOf(shown, repo, home) });
      }
    }
  };
  visit(command, cwd, 0);
  return out;
}

function detailOf(parts: readonly string[], repo: string | undefined, home: string): string {
  const text = `${parts.slice(0, DETAIL_WORDS).join(" ")}${repo ? ` in ${repo}` : ""}`;
  return scrubText(text, { home, max: 300 })?.text ?? parts[0] ?? "a gated action";
}

/** The words a person reads: "merge", "deploy", "publish", "force-push", "spend", "run". */
export function gateVerb(gate: HubGateAction): string {
  switch (gate) {
    case "force_push":
      return "force-push";
    case "custom":
      return "run";
    default:
      return gate;
  }
}

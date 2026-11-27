import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HUB_REVIEW_OWNERS_MAX, HUB_REVIEW_PATHS_MAX, normalizeLeasePath } from "@workmesh/protocol";
import { ownersOfPaths, readCodeowners } from "./codeowners";

/**
 * Review exchange, what touches git and GitHub on this machine (docs/SPEC.md §53). The reviewer's side: read the PR
 * with the person's own `gh` (title, description, files, head, base, earlier bot reviews), make a fresh checkout of
 * its head that can't push, and post a finished review as a plain comment when the person opted in. The author's
 * side: the PR's changed files and their CODEOWNERS owners, from the person's checkout. Every command runs with a
 * timeout and an argument list (no shell), and none of them writes to GitHub except `postReview`.
 */

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}
export type Run = (bin: string, args: string[], o?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<RunResult>;

export const run: Run = (bin, args, o = {}) =>
  new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd: o.cwd, timeout: o.timeoutMs ?? 60_000, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, ...(o.env ? { env: o.env } : {}) },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
    );
  });

/** What `gh pr view` says about a PR, as a review needs it. */
export interface PrFacts {
  title?: string;
  body?: string;
  authorLogin?: string;
  headSha?: string;
  headRef?: string;
  baseRef?: string;
  isDraft?: boolean;
  state?: string;
  files: string[];
  /** Comments and reviews by bots (CI's AI reviews), newest first. */
  botReviews: Array<{ by: string; text: string }>;
}

const SHA_RE = /^[0-9a-f]{7,40}$/;
const REF_RE = /^[\w./-]{1,200}$/;

function isBot(login: unknown): login is string {
  return typeof login === "string" && (/\[bot\]$/.test(login) || login === "github-actions" || /^app\//.test(login));
}

/** The PR as the person's `gh` reads it. Missing pieces stay undefined; `gh` failing gives undefined. */
export async function prFacts(repo: string, pr: number, o: { run?: Run; gh?: string; env?: NodeJS.ProcessEnv } = {}): Promise<PrFacts | undefined> {
  const r = await (o.run ?? run)(
    o.gh ?? "gh",
    ["pr", "view", String(pr), "--repo", repo, "--json", "title,body,author,headRefOid,headRefName,baseRefName,isDraft,state,files,comments,reviews"],
    { timeoutMs: 30_000, ...(o.env ? { env: o.env } : {}) },
  );
  if (!r.ok) return undefined;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const s = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const files: string[] = [];
  for (const f of Array.isArray(j.files) ? j.files : []) {
    const p = normalizeLeasePath(String((f as { path?: unknown })?.path ?? ""));
    if (p && !files.includes(p)) files.push(p);
    if (files.length >= HUB_REVIEW_PATHS_MAX) break;
  }
  const bots: Array<{ by: string; text: string; at: string }> = [];
  for (const c of [...(Array.isArray(j.comments) ? j.comments : []), ...(Array.isArray(j.reviews) ? j.reviews : [])]) {
    const item = c as { author?: { login?: unknown }; body?: unknown; createdAt?: unknown; submittedAt?: unknown };
    const login = item.author?.login;
    const body = s(item.body);
    if (!isBot(login) || !body) continue;
    bots.push({ by: login, text: body, at: String(item.createdAt ?? item.submittedAt ?? "") });
  }
  bots.sort((a, b) => (a.at < b.at ? 1 : -1));
  const head = s(j.headRefOid);
  const headRef = s(j.headRefName);
  const baseRef = s(j.baseRefName);
  return {
    title: s(j.title),
    body: s(j.body),
    authorLogin: s((j.author as { login?: unknown } | undefined)?.login),
    headSha: head && SHA_RE.test(head) ? head : undefined,
    headRef: headRef && REF_RE.test(headRef) ? headRef : undefined,
    baseRef: baseRef && REF_RE.test(baseRef) ? baseRef : undefined,
    isDraft: typeof j.isDraft === "boolean" ? j.isDraft : undefined,
    state: s(j.state),
    files,
    botReviews: bots.slice(0, 6).map(({ by, text }) => ({ by, text })),
  };
}

/** The refs a review checkout keeps: the PR's head and its base, under names nobody else uses. */
export const REVIEW_HEAD_REF = "workmesh-review-head";
export const REVIEW_BASE_REF = "workmesh-review-base";
/** A push URL no transport takes: `git push` from the checkout fails even if a gate is bypassed. */
export const NO_PUSH_URL = "workmesh-review-no-push://";

export interface ReviewCheckout {
  dir: string;
  headSha: string;
  /** The local branch the base was fetched as, when the fetch worked. */
  baseRef?: string;
}

/**
 * A fresh checkout of a PR's head for a review, in `dir` (which must not exist): a local clone of the person's
 * checkout when there is one (`--shared`: fast, nothing copied), else a partial clone from GitHub. Its origin is
 * GitHub (the checkout's own origin URL), its push URL is one no transport takes, and the PR's head and base are
 * fetched under `workmesh-review-*` names. Nothing in the person's checkout changes.
 */
export async function prepareReviewCheckout(o: {
  repo: string;
  pr: number;
  dir: string;
  checkout?: string;
  headRef?: string;
  baseRef?: string;
  run?: Run;
  env?: NodeJS.ProcessEnv;
}): Promise<ReviewCheckout | { error: string }> {
  const r = o.run ?? run;
  const env = o.env;
  const git = (args: string[], cwd?: string, timeoutMs = 120_000) => r("git", args, { ...(cwd ? { cwd } : {}), timeoutMs, ...(env ? { env } : {}) });
  if (fs.existsSync(o.dir)) return { error: `${o.dir} already exists` };
  fs.mkdirSync(path.dirname(o.dir), { recursive: true, mode: 0o700 });
  let origin = `https://github.com/${o.repo}.git`;
  if (o.checkout) {
    const url = await git(["-C", o.checkout, "remote", "get-url", "origin"], undefined, 10_000);
    if (url.ok && url.stdout.trim()) origin = url.stdout.trim();
    const clone = await git(["clone", "--quiet", "--no-checkout", "--shared", o.checkout, o.dir]);
    if (!clone.ok) return { error: `git clone failed: ${lastLine(clone.stderr)}` };
  } else {
    const clone = await git(["clone", "--quiet", "--no-checkout", "--filter=blob:none", origin, o.dir], undefined, 300_000);
    if (!clone.ok) return { error: `git clone failed: ${lastLine(clone.stderr)}` };
  }
  for (const args of [
    ["remote", "set-url", "origin", origin],
    ["remote", "set-url", "--push", "origin", NO_PUSH_URL],
    ["config", "push.default", "nothing"],
    ["config", "advice.detachedHead", "false"],
  ]) {
    const done = await git(args, o.dir, 10_000);
    if (!done.ok) return { error: `git ${args.slice(0, 2).join(" ")} failed: ${lastLine(done.stderr)}` };
  }
  // The PR's head: GitHub's pull ref, else its branch (a fork's branch isn't on origin, so the pull ref comes first).
  const heads = [`+refs/pull/${o.pr}/head:refs/heads/${REVIEW_HEAD_REF}`, ...(o.headRef ? [`+refs/heads/${o.headRef}:refs/heads/${REVIEW_HEAD_REF}`] : [])];
  let fetched = false;
  let why = "";
  for (const spec of heads) {
    const f = await git(["fetch", "--quiet", "--no-tags", "origin", spec], o.dir, 300_000);
    if (f.ok) {
      fetched = true;
      break;
    }
    why = lastLine(f.stderr);
  }
  if (!fetched) return { error: `couldn't fetch PR #${o.pr}'s head: ${why}` };
  let baseRef: string | undefined;
  if (o.baseRef) {
    const b = await git(["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${o.baseRef}:refs/heads/${REVIEW_BASE_REF}`], o.dir, 300_000);
    if (b.ok) baseRef = REVIEW_BASE_REF;
  }
  const co = await git(["checkout", "--quiet", "--detach", REVIEW_HEAD_REF], o.dir, 120_000);
  if (!co.ok) return { error: `git checkout failed: ${lastLine(co.stderr)}` };
  const sha = await git(["rev-parse", "HEAD"], o.dir, 10_000);
  const headSha = sha.stdout.trim();
  if (!sha.ok || !SHA_RE.test(headSha)) return { error: "couldn't read the checked-out head" };
  return { dir: o.dir, headSha, ...(baseRef ? { baseRef } : {}) };
}

function lastLine(text: string): string {
  return (
    text
      .trim()
      .split("\n")
      .pop()
      ?.replace(/https?:\/\/[^\s@]*@/g, "https://")
      .slice(0, 200) || "error"
  );
}

/**
 * Posts a finished review on the PR as a plain review comment through the person's own `gh` (`gh pr review
 * --comment`): never `--approve` or `--request-changes`, so it never counts toward a merge.
 */
export async function postReview(repo: string, pr: number, bodyFile: string, o: { run?: Run; gh?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ ok: boolean; error?: string }> {
  const r = await (o.run ?? run)(o.gh ?? "gh", ["pr", "review", String(pr), "--repo", repo, "--comment", "--body-file", bodyFile], {
    timeoutMs: 60_000,
    ...(o.env ? { env: o.env } : {}),
  });
  return r.ok ? { ok: true } : { ok: false, error: lastLine(r.stderr) };
}

/**
 * The author's side of a request: the PR's changed files (from `gh`, else `git diff` against the remote's default
 * branch in the session's checkout) and their CODEOWNERS owners from that checkout. Paths are repo-relative; nothing
 * else is read.
 */
export async function prChanges(o: {
  repo: string;
  pr: number;
  root?: string;
  run?: Run;
  gh?: string;
}): Promise<{ paths: string[]; owners: string[]; headSha?: string; isDraft?: boolean }> {
  const facts = await prFacts(o.repo, o.pr, { run: o.run, gh: o.gh });
  let paths = facts?.files ?? [];
  if (paths.length === 0 && o.root) {
    const r = o.run ?? run;
    const base = await r("git", ["-C", o.root, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { timeoutMs: 10_000 });
    const ref = base.ok && base.stdout.trim() ? base.stdout.trim() : "origin/main";
    const diff = await r("git", ["-C", o.root, "diff", "--name-only", `${ref}...HEAD`], { timeoutMs: 30_000 });
    if (diff.ok) {
      paths = [
        ...new Set(
          diff.stdout
            .split("\n")
            .map((p) => normalizeLeasePath(p.trim()))
            .filter((p): p is string => p !== undefined),
        ),
      ].slice(0, HUB_REVIEW_PATHS_MAX);
    }
  }
  const owners = o.root && paths.length > 0 ? ownersOfPaths(readCodeowners(o.root), paths, HUB_REVIEW_OWNERS_MAX) : [];
  return {
    paths,
    owners,
    ...(facts?.headSha ? { headSha: facts.headSha } : {}),
    ...(facts?.isDraft === undefined ? {} : { isDraft: facts.isDraft }),
  };
}

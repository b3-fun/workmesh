import { createHash } from "node:crypto";
import type { AgentSession, SessionEvent } from "@workmesh/core";
import { HUB_REVIEW_FOCUS_MAX, HUB_REVIEW_ROUNDS_MAX } from "@workmesh/protocol";
import type { HubHandoffAccepted, HubReviewAgent, HubReviewRequest, HubReviewResultAccepted, HubSyncAccepted } from "@workmesh/protocol";
import { CoordClient } from "../hub/coord";
import { scrubText } from "../hub/redact";
import { extractGithubLink } from "../hub/rules";
import { shellCommands } from "../hub/shell-writes";
import type { ReviewSettings } from "../lib/config";
import { label, oneLine } from "../lib/untrusted";
import { unwrap } from "./gates";
import { reviewRefusal } from "./review-gate";
import { prChanges } from "./review-git";
import type { Run } from "./review-git";
import { findingCounts, reviewNotice } from "./review-text";

/**
 * Review exchange, the relay side (docs/SPEC.md §53), apart from running a review (daemon/handoff-runner.ts):
 *
 * - **The machine's policy.** Sent to the hub (`policy`) once the hub has reviews, and again when it changes, so the
 *   hub routes reviews to this person only while a machine of theirs takes them.
 * - **A PR opened or made ready.** At `PostToolUse` of `gh pr create` (not a draft) or `gh pr ready` in a shared
 *   session, the session is told it can ask for an agent review; with the person's standing rule on, the relay asks by
 *   itself and says so.
 * - **The request** (`request_review` for MCP and the CLI): the PR, its changed files and CODEOWNERS owners from the
 *   person's checkout, the author's agent and model.
 * - **The answer.** A review a session here asked for comes back as a notice with the findings as data (wakes it).
 * - **Read-only runs.** A review run's tool calls that would change the PR, the repo or GitHub are refused
 *   (daemon/review-gate.ts).
 */

const SHELL_TOOLS = new Set(["Bash", "shell", "shell_command", "local_shell", "exec_command", "unified_exec", "container.exec"]);
/** The policy is sent again at least this often (a hub that lost it, or restarted, has it back within this long). */
const POLICY_RESEND_MS = 6 * 60 * 60_000;
/** A PR seen opened here is the session's default for `request_review` this long. */
const PR_MEMORY_MS = 24 * 60 * 60_000;

export interface ReviewsDeps {
  coord: () => CoordClient | undefined;
  settings: () => ReviewSettings;
  getSession: (key: string) => AgentSession | undefined;
  isShared: (key: string) => boolean;
  /** The checkout root and repo a directory is in (the forwarder's §3.3 reading). */
  classify: (dir: string) => { root: string; repo?: string } | undefined;
  /** The agent CLI and model this machine reviews with (what the runner would start), for the policy. */
  reviewAgent: () => { agent?: HubReviewAgent; model?: string };
  /** A review run's id for a session key, when that session is one (the runner's records). */
  reviewRunOf: (key: string) => string | undefined;
  /** Handoff ids of review runs going on here. */
  isReviewRun: (handoffId: string) => boolean;
  /** A session's model as its transcript says it (the forwarder's mirror). */
  modelOf?: (key: string) => string | undefined;
  run?: Run;
  now?: () => number;
  log?: (m: string) => void;
}

interface SeenPr {
  repo: string;
  pr: number;
  url: string;
  draft: boolean;
  at: number;
}

export interface RequestArgs {
  pr?: string | number;
  repo?: string;
  focus?: string;
  reviewers?: string[];
  count?: number;
}

/** `212`, `#212`, `owner/name#212` or a PR URL → the PR (and its repo when the text names one). */
export function parsePrRef(v: string | number | undefined): { repo?: string; pr: number } | undefined {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 && v <= 1e9 ? { pr: v } : undefined;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,9})(?:[/?#].*)?$/.exec(t);
  if (url) return { repo: url[1]!, pr: Number(url[2]) };
  const full = /^([\w.-]+\/[\w.-]+)#(\d{1,9})$/.exec(t);
  if (full) return { repo: full[1]!, pr: Number(full[2]) };
  const n = /^#?(\d{1,9})$/.exec(t);
  return n ? { pr: Number(n[1]) } : undefined;
}

/**
 * What a shell command did to a PR, read from its words: `gh pr create` (a draft with `--draft`/`-d`) or `gh pr
 * ready` (`--undo` makes it a draft again). Undefined for anything else.
 */
export function prMove(command: string): "created" | "created-draft" | "ready" | "draft" | undefined {
  for (const simple of shellCommands(command, undefined)) {
    const argv = unwrap(simple.argv);
    if (argv[0]?.replace(/.*\//, "") !== "gh") continue;
    const words = argv.slice(1).filter((a) => !a.startsWith("-"));
    if (words[0] !== "pr") continue;
    const flags = argv.slice(1);
    if (words[1] === "create") return flags.some((f) => f === "--draft" || f === "-d") ? "created-draft" : "created";
    if (words[1] === "ready") return flags.includes("--undo") ? "draft" : "ready";
  }
  return undefined;
}

export class Reviews {
  private readonly deps: ReviewsDeps;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  /** The policy last sent, as a hash, and when. */
  private policySent: { hash: string; at: number } | undefined;
  private policyInFlight = false;
  /** PRs a session here opened or made ready: its default for `request_review`. */
  private readonly prs = new Map<string, SeenPr>();
  /** PRs this machine asked about by itself (`repo#pr`), so it asks once. */
  private readonly autoAsked = new Set<string>();
  /** Review handoffs' statuses as last seen, for the author's notices. */
  private readonly status = new Map<string, string>();
  private seeded = false;
  /** Review results told to their session (handoff ids). */
  private readonly told = new Set<string>();

  constructor(deps: ReviewsDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  // --- the policy -------------------------------------------------------------------

  /** What this machine tells the hub about the reviews it takes (SPEC §52 `policy`). */
  policy(): Extract<HubReviewRequest, { action: "policy" }> {
    const s = this.deps.settings();
    const a = this.deps.reviewAgent();
    return {
      action: "policy",
      accept: s.accept,
      ...(a.agent ? { agent: a.agent } : {}),
      ...(a.model ? { model: a.model } : {}),
      post: s.postToGitHub,
    };
  }

  /** Sends the policy when the hub has reviews and it changed, or wasn't sent for a while. Never throws. */
  maybeSendPolicy(): void {
    const coord = this.deps.coord();
    if (!coord || !coord.reviewsAvailable() || this.policyInFlight) return;
    const body = this.policy();
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
    const sent = this.policySent;
    if (sent && sent.hash === hash && this.now() - sent.at < POLICY_RESEND_MS) return;
    this.policyInFlight = true;
    void coord
      .review(body)
      .then((r) => {
        if (r.ok && r.body.ok) {
          this.policySent = { hash, at: this.now() };
          this.log(`reviews: told the hub this machine's policy (${body.accept}${body.agent ? `, ${body.agent}` : ""}${body.post ? ", posts on the PR" : ""})`);
        } else {
          // Asked again at a later sync; a hub without reviews stops being asked (404 remembered for 10 min).
          this.policySent = { hash: "", at: this.now() - POLICY_RESEND_MS + 60_000 };
        }
      })
      .catch(() => {})
      .finally(() => {
        this.policyInFlight = false;
      });
  }

  // --- the author's side: a PR opened, a request, the answer ------------------------

  /**
   * `PostToolUse` of a shell tool in a shared session: a PR this session opened (not a draft) or marked ready. The
   * answer is the context line for the session: an offer, or (the person's standing rule) that a review was asked
   * for. Never a network call in the hook path: an automatic request goes out in the background.
   */
  afterTool(event: SessionEvent, hook: string | undefined): string | undefined {
    if (hook !== "PostToolUse") return undefined;
    const d = event.detail;
    if (!d?.tool || !SHELL_TOOLS.has(d.tool) || !d.command || d.ok === false) return undefined;
    const coord = this.deps.coord();
    if (!coord || !coord.reviewsAvailable()) return undefined;
    const key = `${event.source}:${event.sessionId}`;
    if (event.detail?.agentId || !this.deps.isShared(key)) return undefined;
    // A review run reviews; it doesn't open PRs.
    if (this.deps.reviewRunOf(key)) return undefined;
    const move = prMove(d.command);
    if (!move) return undefined;
    const link = extractGithubLink(d.command, d.toolResponseText);
    if (link?.type !== "github_pr") return undefined;
    const repo = link.repo;
    if (event.cwd && this.deps.classify(event.cwd)?.repo !== repo) return undefined;
    const draft = move === "created-draft" || move === "draft";
    this.prs.set(key, { repo, pr: link.number, url: link.url, draft, at: this.now() });
    this.trim();
    if (draft) return undefined;
    const ref = `${repo}#${link.number}`;
    if (this.isAuto(repo)) {
      if (this.autoAsked.has(ref)) return undefined;
      this.autoAsked.add(ref);
      if (this.autoAsked.size > 500) this.autoAsked.clear();
      void this.request(key, { pr: link.number, repo }, { auto: true }).then((r) => {
        this.log(`reviews: asked by the standing rule for ${ref}: ${r.ok ? "taken" : oneLine(r.text, 200)}`);
        if (r.ok) coord.notify(key, r.text, { wake: false });
      });
      return (
        `Workmesh: your person's standing rule asks a teammate's agent to review PR ${ref} when it is ready, so Workmesh asked for one now. ` +
        "The findings come back to this session as a Workmesh message. Carry on meanwhile; agent reviews never approve, a person does."
      );
    }
    return (
      `Workmesh: PR ${ref} is ready. A teammate's agent can review it (read-only, on their machine): call the workmesh \`request_review\` tool ` +
      `with pr ${link.number}, and \`focus\` for what to look at. The findings come back here. Agent reviews never approve; a person does.`
    );
  }

  /** The person's standing rule for this repo: this machine's config, else their board setting or the team's repos. */
  isAuto(repo: string): boolean {
    const local = this.deps.settings().auto;
    if (local !== undefined) return local;
    const hub = this.deps.coord()?.reviewAuto();
    return hub ? hub.auto || hub.autoRepos.includes(repo) : false;
  }

  /** The PR a session here opened or made ready last (its `request_review` default). */
  lastPr(key: string | undefined): SeenPr | undefined {
    if (!key) return undefined;
    const p = this.prs.get(CoordClient.family(key));
    return p && this.now() - p.at < PR_MEMORY_MS ? p : undefined;
  }

  private trim(): void {
    if (this.prs.size <= 1000) return;
    const cutoff = this.now() - PR_MEMORY_MS;
    for (const [k, p] of this.prs) if (p.at < cutoff) this.prs.delete(k);
  }

  /**
   * Asks the hub for a review (MCP `request_review`, the CLI, the standing rule). `key` is the asking session (absent:
   * the person at a terminal). Reviewers are names the caller resolved already (`reviewers` as `{person, email?}`).
   */
  async request(
    key: string | undefined,
    args: { pr?: string | number; repo?: string; focus?: string; count?: number },
    o: { auto?: boolean; reviewers?: Array<{ person: string; email?: string }>; cwd?: string } = {},
  ): Promise<{ ok: boolean; text: string; data?: unknown }> {
    const coord = this.deps.coord();
    if (!coord) return { ok: false, text: "This machine isn't connected to a Workmesh hub." };
    if (!coord.reviewsAvailable()) return { ok: false, text: "This team's hub has no review exchange yet; nothing was asked." };
    const session = key ? this.deps.getSession(CoordClient.family(key)) : undefined;
    const cwd = session?.cwd ?? o.cwd;
    const here = cwd ? this.deps.classify(cwd) : undefined;
    const parsed = parsePrRef(args.pr);
    const last = this.lastPr(key);
    if (args.pr !== undefined && !parsed) return { ok: false, text: "`pr` is a PR number (212), owner/name#212, or the PR's URL." };
    const pr = parsed?.pr ?? last?.pr;
    const repo = parsed?.repo ?? args.repo ?? (parsed ? here?.repo : last?.repo) ?? here?.repo;
    if (!pr) return { ok: false, text: "Name the PR: `request_review` takes `pr` (212, owner/name#212 or the PR's URL)." };
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, text: "Name the repo (`repo`: owner/name), or ask from a session in its checkout." };
    const focus = scrubText(args.focus, { max: HUB_REVIEW_FOCUS_MAX })?.text || undefined;
    // What the person's checkout says about the PR: its changed files and their CODEOWNERS owners. A failure leaves
    // them out: the hub then routes by recent work and who is free.
    const root = here?.repo === repo ? here.root : undefined;
    let changes: Awaited<ReturnType<typeof prChanges>> = { paths: [], owners: [] };
    try {
      changes = await prChanges({ repo, pr, ...(root ? { root } : {}), ...(this.deps.run ? { run: this.deps.run } : {}) });
    } catch {
      // routed without them
    }
    if (changes.isDraft === true && !o.reviewers?.length && o.auto) {
      return { ok: false, text: `PR ${repo}#${pr} is a draft: Workmesh asks for a review when it is marked ready.` };
    }
    const agent: HubReviewAgent | undefined = session?.source === "codex" ? "codex" : session?.source === "claude-code" ? "claude" : undefined;
    const rawModel = key ? this.deps.modelOf?.(CoordClient.family(key)) : undefined;
    const model = rawModel && /^[\w.:[\]/-]{1,80}$/.test(rawModel) ? rawModel : undefined;
    const count = args.count === 2 ? 2 : args.count === 1 ? 1 : this.deps.settings().count;
    const r = await coord.review({
      action: "request",
      ...(key ? { from: CoordClient.family(key) } : {}),
      repo,
      pr,
      ...(focus ? { focus } : {}),
      ...(o.reviewers?.length ? { reviewers: o.reviewers.slice(0, 2).map((p) => ({ person: p.person, ...(p.email ? { email: p.email } : {}) })) } : {}),
      ...(count === 2 ? { count: 2 } : {}),
      ...(o.auto ? { auto: true as const } : {}),
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(changes.headSha ? { headSha: changes.headSha } : {}),
      ...(changes.paths.length ? { paths: changes.paths } : {}),
      ...(changes.owners.length ? { owners: changes.owners } : {}),
    });
    const ref = `${repo}#${pr}`;
    if (!r.ok) {
      return {
        ok: false,
        text: r.unavailable ? "This team's hub has no review exchange yet; nothing was asked." : `Workmesh: ${oneLine(r.error, 300)}`,
      };
    }
    const b = r.body;
    if (!b.ok) {
      const who = b.reviewers?.length ? ` (${b.reviewers.map((x) => label(x.to.person)).join(", ")})` : "";
      const choices = b.candidates?.length ? ` Which one: ${b.candidates.map((c) => `${label(c.person)}${c.email ? ` <${oneLine(c.email, 120)}>` : ""}`).join(", ")}?` : "";
      return { ok: false, text: `Workmesh: ${oneLine(b.error, 300) || `the hub didn't take the review of ${ref}`}${who}.${choices}`, data: b };
    }
    const reviewers = b.reviewers ?? [];
    const names = reviewers.map((x) => `${label(x.to.person)}${x.agent ? ` (${x.agent === "codex" ? "Codex" : "Claude Code"})` : ""}`).join(" and ");
    const round = b.round ?? 1;
    const rounds = b.rounds ?? HUB_REVIEW_ROUNDS_MAX;
    return {
      ok: true,
      text:
        `Asked ${names || "a teammate"} for an agent review of PR ${ref} (round ${round} of ${rounds}). Their machine runs it read-only ` +
        "once they (or their standing rule) accept; the findings come back to this session as a Workmesh message. Carry on meanwhile.",
      data: b,
    };
  }

  /** After each good sync: the policy, and news about reviews this machine's sessions asked for. */
  onSync(next: HubSyncAccepted): void {
    this.maybeSendPolicy();
    const coord = this.deps.coord();
    if (!coord) return;
    const seed = !this.seeded;
    this.seeded = true;
    for (const h of next.handoffs ?? []) {
      if (h.kind !== "review") continue;
      const prev = this.status.get(h.id);
      this.status.set(h.id, h.status);
      if (seed || prev === h.status) continue;
      const fromLocal = h.from.sessionKey ? coord.localKey(h.from.sessionKey) : undefined;
      if (!fromLocal) continue;
      this.tellAuthor(coord, h, CoordClient.family(fromLocal), prev);
    }
    if (this.status.size > 2000) {
      const keep = new Set((next.handoffs ?? []).map((h) => h.id));
      for (const id of this.status.keys()) if (!keep.has(id)) this.status.delete(id);
    }
  }

  private tellAuthor(coord: CoordClient, h: HubHandoffAccepted, local: string, prev: string | undefined): void {
    const who = label(h.to.person);
    const ref = `${h.repo ?? "?"}#${h.review?.pr ?? "?"}`;
    const round = h.review?.round ?? 1;
    const said = h.note ? oneLine(h.note, 300) : "";
    switch (h.status) {
      case "accepted":
        if (prev === "offered") coord.notify(local, `Workmesh: ${who} took the review of PR ${ref} (round ${round}); their machine runs it read-only.`, { wake: false, from: who });
        return;
      case "declined":
        coord.notify(
          local,
          `Workmesh: ${who} declined to review PR ${ref}${said ? `: ${said}` : "."} Ask someone else with the workmesh \`request_review\` tool (\`reviewers\`), or carry on.`,
          { wake: true, from: who },
        );
        return;
      case "failed":
        coord.notify(
          local,
          `Workmesh: ${who}'s machine couldn't finish the review of PR ${ref} (round ${round})${said ? `: ${said}` : "."} Ask again with \`request_review\` if you still want one.`,
          { wake: true, from: who },
        );
        return;
      case "done":
        void this.tellResult(coord, h, local);
        return;
      default:
        return;
    }
  }

  /** A review is done: fetch its whole result and give it to the session that asked, as data. */
  private async tellResult(coord: CoordClient, h: HubHandoffAccepted, local: string): Promise<void> {
    if (this.told.has(h.id)) return;
    this.told.add(h.id);
    if (this.told.size > 2000) this.told.clear();
    let result: HubReviewResultAccepted | undefined;
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      const r = await coord.review({ action: "result", id: h.id });
      if (r.ok && r.body.ok) result = r.body.result;
      if (!result) await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)).unref?.());
    }
    const who = label(h.to.person);
    const ref = `${h.repo ?? "?"}#${h.review?.pr ?? "?"}`;
    if (!result) {
      const o = h.review?.outcome;
      const counts = o ? findingCounts(o) : "";
      coord.notify(
        local,
        `Workmesh: ${who}'s agent finished the review of PR ${ref}${counts ? ` (${counts})` : ""}, but its findings didn't come through. ` +
          `Read them with \`workmesh reviews show ${h.id}\` or on the board.`,
        { wake: true, from: who },
      );
      return;
    }
    coord.notify(local, reviewNotice(h, result), { wake: true, from: who });
    this.log(`reviews: ${ref} round ${h.review?.round ?? 1} back from ${who} (${result.verdict}, ${result.findings.length} findings) → ${local.slice(0, 24)}`);
  }

  // --- the reviewer's side: read-only runs ------------------------------------------

  /** `PreToolUse` in a review run: why this tool call may not run (daemon/review-gate.ts), or undefined. */
  gateRefusal(event: SessionEvent, hook: string | undefined, handoff: string | undefined): string | undefined {
    if (hook !== "PreToolUse") return undefined;
    const key = `${event.source}:${event.sessionId}`;
    const isRun = (handoff !== undefined && this.deps.isReviewRun(handoff)) || this.deps.reviewRunOf(CoordClient.family(key)) !== undefined;
    if (!isRun) return undefined;
    return reviewRefusal(event.detail?.tool, event.detail?.command, event.cwd);
  }
}

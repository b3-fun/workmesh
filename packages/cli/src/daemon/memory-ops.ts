import os from "node:os";
import path from "node:path";
import {
  HUB_ISSUE_RE,
  HUB_MEMORY_BODY_MAX,
  HUB_MEMORY_ID_RE,
  HUB_MEMORY_KINDS,
  HUB_MEMORY_MAX_LINKS,
  HUB_MEMORY_MAX_PATHS,
  HUB_MEMORY_MAX_TAGS,
  HUB_MEMORY_REASON_MAX,
  HUB_MEMORY_TITLE_MAX,
  HUB_RECALL_MAX,
  HUB_RECALL_QUERY_MAX,
  HUB_REPO_RE,
  LEASE_PATH_MAX,
  normalizeLeasePath,
  prLink,
} from "@workmesh/protocol";
import type { HubMemoryAccepted, HubMemoryKind, HubMemoryRequest, HubMemoryScope } from "@workmesh/protocol";
import { CoordClient, NO_MEMORY } from "../hub/coord";
import type { CoordResult, MemoryBriefItem } from "../hub/coord";
import { scrubText } from "../hub/redact";
import { QUOTE_MARK, cleanText, label, oneLine as cleanLine, quoted } from "../lib/untrusted";
import type { CoordOpResult } from "./coord-ops";
import { firstSentence } from "./memory";

/**
 * v3 Memory operations for the MCP server and the CLI (docs/SPEC.md §36): `remember`, `recall`, `forget`, `memories`,
 * and `note`/`notes` on a hub with memory. Text (title, body, reason, query) is redacted on the machine (§9) before it
 * is sent. A call with no agent session behind it (a terminal) goes without a `sessionKey`. It is a proposal all the
 * same (§35): a person accepts it on the board.
 *
 * A memory the hub sends back is its writer's text. Its title, body, author and paths go into an answer through
 * `lib/untrusted.ts`: one line each, and a body as marked lines.
 */

export interface MemoryOpContext {
  coord: CoordClient;
  /** The calling session's local key; undefined = the person at a terminal. */
  key: string | undefined;
  cwd: string | undefined;
  home?: string;
  now: number;
  classify: (absPath: string) => { root: string; repo?: string } | undefined;
}

type Args = Record<string, unknown>;

const TAG_RE = /^[\w.:-]{1,32}$/;
const RULE_TAGS: Record<string, HubMemoryKind> = { rule: "rule", rules: "rule", convention: "convention", conventions: "convention" };
const RECALL_BODY_MAX = 600;
const LIST_MAX = 50;

export const NO_MEMORY_WRITE =
  "This team's hub has no memory yet (it predates Workmesh v3), so nothing was saved. `note` leaves a note every teammate's agent can read.";
export const NO_MEMORY_READ = "This team's hub has no memory yet (it predates Workmesh v3). `notes` lists the team's notes.";

const fail = (text: string, data?: unknown): CoordOpResult => ({ ok: false, text, data });
const str = (v: unknown, max = 4000): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
const strList = (v: unknown, max = 50): string[] | undefined => {
  if (typeof v === "string" && v.trim()) return v.split(",").map((x) => x.trim()).filter(Boolean).slice(0, max);
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((x): x is string => typeof x === "string" && x.trim() !== "")
    .flatMap((x) => x.split(","))
    .map((x) => x.trim())
    .filter(Boolean);
  return out.length > 0 ? out.slice(0, max) : undefined;
};

/** A kind as people write it (`Gotcha`, `rules`) → the wire's, else undefined. */
export function memoryKind(v: unknown): HubMemoryKind | undefined {
  const k = typeof v === "string" ? v.trim().toLowerCase() : "";
  const kinds = HUB_MEMORY_KINDS as readonly string[];
  if (kinds.includes(k)) return k as HubMemoryKind;
  if (k.endsWith("s") && kinds.includes(k.slice(0, -1))) return k.slice(0, -1) as HubMemoryKind;
  return undefined;
}

/** `m12`, `M12`, `#12`, `12` → `m12`; anything else undefined. */
export function memoryId(v: unknown): string | undefined {
  const raw = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().toLowerCase() : "";
  const m = /^#?m?(\d{1,9})$/.exec(raw);
  const id = m ? `m${m[1]}` : undefined;
  return id && HUB_MEMORY_ID_RE.test(id) ? id : undefined;
}

/** "3 days ago", from a hub time to the hub's now. */
export function agoText(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  if (h < 48) return "yesterday";
  const d = Math.floor(h / 24);
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.floor(d / 7)} weeks ago`;
  return `${Math.floor(d / 30)} months ago`;
}

/** Where a memory applies, in a few words: `b3-fun/workmesh`, `b3-fun/workmesh: packages/cli/**`, `project-wide`. */
export function scopeLabel(scope: { repo: string; paths?: string[] } | undefined): string {
  if (!scope) return "project-wide";
  const paths = scope.paths ?? [];
  if (paths.length === 0) return scope.repo;
  return `${scope.repo}: ${paths.slice(0, 3).map((p) => cleanLine(p, LEASE_PATH_MAX)).join(", ")}${paths.length > 3 ? ` (+${paths.length - 3})` : ""}`;
}

/** Text an agent or person wrote, redacted (§9): whitespace kept, control characters and secrets out. */
function scrub(v: unknown, home: string, max: number): string | undefined {
  return scrubText(str(v, 16_000), { home, max })?.text;
}

/** A title on one line, at most 120 characters (cut with "…"). */
function oneLine(s: string, max = HUB_MEMORY_TITLE_MAX): { text: string; cut: boolean } {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? { text: flat, cut: false } : { text: `${flat.slice(0, max - 1).trimEnd()}…`, cut: true };
}

/** A memory's title as a sentence in an answer: one line of it (the hub sent it back), with one full stop. */
const sentence = (title: string): string => `${cleanLine(title, HUB_MEMORY_TITLE_MAX).replace(/[.!?…]+$/, "")}.`;
/** What the hub said went wrong, on one line; `fallback` when it said nothing. */
const hubSaid = (error: string | undefined, fallback: string): string => (error ? cleanLine(error, 300) : "") || fallback;

/** Has the last sync, and the hub has memory; else what to answer. */
async function memoryGate(ctx: MemoryOpContext, answer: CoordOpResult): Promise<CoordOpResult | undefined> {
  if (!ctx.coord.view().state) await ctx.coord.refreshed(0);
  if (!ctx.coord.view().state) return fail("Workmesh hasn't heard from the hub yet; try again in a few seconds.");
  return ctx.coord.memoryAvailable() ? undefined : answer;
}

function memoryError(r: Extract<CoordResult<unknown>, { ok: false }>, noMemory: CoordOpResult): CoordOpResult {
  if (r.unavailable && r.error === NO_MEMORY) return noMemory;
  return fail(r.unavailable ? "Workmesh coordination isn't on this team's hub yet; nothing was sent." : `Workmesh: ${cleanLine(r.error, 300)}`);
}

/** The session's repo and its directory in it (repo-relative, "" at the top), from its cwd. */
function cwdPlace(ctx: Pick<MemoryOpContext, "cwd" | "classify">): { repo?: string; dir?: string } {
  if (!ctx.cwd || !path.isAbsolute(ctx.cwd)) return {};
  const t = ctx.classify(ctx.cwd);
  if (!t?.repo) return {};
  const rel = path.relative(t.root, ctx.cwd).split(path.sep).join("/");
  return { repo: t.repo, dir: rel.startsWith("..") ? undefined : rel };
}

/**
 * A memory's scope from `scope` ("repo" | "project" | owner/name; default the session's repo when it is in a shared one,
 * else the project) and `paths` (repo-relative, or absolute and made relative; globs in lease-path syntax).
 */
export function resolveMemoryScope(
  scopeArg: unknown,
  pathsArg: unknown,
  ctx: Pick<MemoryOpContext, "cwd" | "classify" | "home">,
): { scope?: HubMemoryScope } | { error: string } {
  const home = ctx.home ?? os.homedir();
  const want = typeof scopeArg === "string" ? scopeArg.trim() : undefined;
  const here = cwdPlace(ctx);
  let repo: string | undefined;
  let explicit = false;
  if (want === "project" || want === "team") {
    repo = undefined;
    explicit = true;
  } else if (want === "repo") {
    if (!here.repo) {
      return { error: "This session's directory isn't in a repo shared with the team: give `scope` as owner/name, or `project`." };
    }
    repo = here.repo;
    explicit = true;
  } else if (want) {
    if (!HUB_REPO_RE.test(want)) return { error: '`scope` is "repo", "project" or a repo as owner/name.' };
    repo = want;
    explicit = true;
  } else {
    repo = here.repo;
  }
  const raw = strList(pathsArg, 100);
  if (!raw) return { scope: repo ? { repo } : undefined };
  if (explicit && !repo) return { error: "Paths belong to a repo: drop `scope: project`, or the paths." };
  const out: string[] = [];
  let whole = false;
  for (const p0 of raw) {
    let p = p0;
    if (p === "~" || p.startsWith("~/")) p = path.join(home, p.slice(1));
    if (!path.isAbsolute(p)) {
      if (!repo) return { error: `${p0} is repo-relative, and this session isn't in a shared repo: give the repo as \`scope\` (owner/name).` };
      const rel = normalizeLeasePath(p);
      if (!rel) return { error: `${p0} isn't a repo-relative path or glob.` };
      out.push(rel);
      continue;
    }
    const glob = p.search(/[*?]/);
    const probe = glob === -1 ? p : p.slice(0, glob).replace(/[^/]*$/, "") || "/";
    const t = ctx.classify(probe);
    if (!t?.repo) return { error: `${p0} isn't in a repo this machine shares with the team.` };
    if (repo && repo.toLowerCase() !== t.repo.toLowerCase()) return { error: `${p0} is in ${t.repo}, not ${repo}: one repo per memory.` };
    repo = t.repo;
    const relRaw = path.relative(t.root, path.normalize(p)).split(path.sep).join("/");
    if (relRaw === "") {
      whole = true;
      continue;
    }
    const rel = normalizeLeasePath(relRaw);
    if (!rel) return { error: `${p0} isn't inside ${t.repo}.` };
    out.push(rel);
  }
  const paths = [...new Set(out)];
  if (paths.length > HUB_MEMORY_MAX_PATHS) return { error: `At most ${HUB_MEMORY_MAX_PATHS} paths per memory.` };
  if (!repo) return { scope: undefined };
  // The whole repo among them: the memory is the repo's.
  return { scope: paths.length === 0 || whole ? { repo } : { repo, paths } };
}

function issuesOf(v: unknown): { issues: string[] } | { error: string } {
  const raw = strList(v, 50) ?? [];
  const issues = [...new Set(raw.map((i) => i.toUpperCase()))];
  const bad = issues.filter((i) => !HUB_ISSUE_RE.test(i));
  if (bad.length > 0) return { error: `Not an issue id: ${bad.join(", ")} (a Linear id is like B3-123).` };
  if (issues.length > HUB_MEMORY_MAX_LINKS) return { error: `At most ${HUB_MEMORY_MAX_LINKS} issues per memory.` };
  return { issues };
}

function prsOf(v: unknown, repo: string | undefined): { prs: string[] } | { error: string } {
  const out: string[] = [];
  for (const raw of strList(v, 50) ?? []) {
    const n = /^#?(\d{1,7})$/.exec(raw);
    const link = n && repo ? prLink(`${repo}#${n[1]}`) : prLink(raw);
    if (!link) return { error: `Not a PR: ${raw} (a PR is https://github.com/owner/name/pull/N or owner/name#N).` };
    out.push(link);
  }
  const prs = [...new Set(out)];
  if (prs.length > HUB_MEMORY_MAX_LINKS) return { error: `At most ${HUB_MEMORY_MAX_LINKS} PRs per memory.` };
  return { prs };
}

function tagsOf(v: unknown): string[] {
  return [...new Set((strList(v, 50) ?? []).filter((t) => TAG_RE.test(t)))].slice(0, HUB_MEMORY_MAX_TAGS);
}

/** The answer to a remember the hub took (SPEC §36): proposed, and who reviews it; or accepted (an older hub, §35). */
function rememberAnswer(m: HubMemoryAccepted | undefined, supersedes: string | undefined): CoordOpResult {
  if (!m) return { ok: true, text: "Sent to the team's memory.", data: {} };
  const replaces = supersedes ? ` It replaces ${supersedes} once accepted.` : "";
  if (m.status === "proposed") {
    return {
      ok: true,
      text: `Proposed ${m.id} for the team: ${sentence(m.title)} A person reviews it on the board (Needs you) before other agents see it.${replaces}`,
      data: { memory: m },
    };
  }
  if (m.status === "accepted") {
    return {
      ok: true,
      text: `Remembered ${m.id} (accepted, ${scopeLabel(m.scope)}): ${sentence(m.title)} Your team's agents get it where it applies, and through \`recall\`.${supersedes ? ` It replaces ${supersedes}.` : ""}`,
      data: { memory: m },
    };
  }
  return { ok: true, text: `The team's hub took ${m.id} as ${m.status}: ${sentence(m.title)}`, data: { memory: m } };
}

/** `remember { kind, title, body?, scope?, paths?, issues?, prs?, tags?, supersedes? }`. */
export async function rememberOp(a: Args, ctx: MemoryOpContext): Promise<CoordOpResult> {
  const kind = memoryKind(a.kind);
  if (!kind) return fail(`\`remember\` needs \`kind\`: one of ${HUB_MEMORY_KINDS.join(", ")}.`);
  const home = ctx.home ?? os.homedir();
  const full = scrub(a.title, home, HUB_MEMORY_BODY_MAX);
  if (!full) return fail("`remember` needs `title`: the memory in one line.");
  const title = oneLine(full);
  let body = scrub(a.body, home, HUB_MEMORY_BODY_MAX);
  // A title too long for one line goes whole into the body, so nothing is lost.
  if (!body && title.cut) body = full;
  const scoped = resolveMemoryScope(a.scope, a.paths ?? a.path, ctx);
  if ("error" in scoped) return fail(scoped.error);
  const issues = issuesOf(a.issues ?? a.issue);
  if ("error" in issues) return fail(issues.error);
  const prs = prsOf(a.prs ?? a.pr, scoped.scope?.repo ?? cwdPlace(ctx).repo);
  if ("error" in prs) return fail(prs.error);
  const tags = tagsOf(a.tags ?? a.tag);
  let supersedes: string | undefined;
  if (a.supersedes !== undefined && a.supersedes !== null && a.supersedes !== "") {
    supersedes = memoryId(a.supersedes);
    if (!supersedes) return fail("`supersedes` is a memory id, like m12.");
  }
  const gate = await memoryGate(ctx, fail(NO_MEMORY_WRITE));
  if (gate) return gate;
  const links =
    issues.issues.length > 0 || prs.prs.length > 0
      ? { ...(issues.issues.length ? { issues: issues.issues } : {}), ...(prs.prs.length ? { prs: prs.prs } : {}) }
      : undefined;
  const req: HubMemoryRequest = {
    action: "remember",
    ...(ctx.key ? { sessionKey: CoordClient.family(ctx.key) } : {}),
    kind,
    title: title.text,
    ...(body ? { body } : {}),
    ...(scoped.scope ? { scope: scoped.scope } : {}),
    ...(links ? { links } : {}),
    ...(tags.length ? { tags } : {}),
    ...(supersedes ? { supersedes } : {}),
  };
  const r = await ctx.coord.memory(req);
  if (!r.ok) return memoryError(r, fail(NO_MEMORY_WRITE));
  if (!r.body.ok) return fail(`Workmesh: ${hubSaid(r.body.error, "the hub didn't take the memory")}`);
  return rememberAnswer(r.body.memory, supersedes);
}

/**
 * `note` on a hub with memory (SPEC §36): a memory, project-wide as a note always was; kind `rule` or `convention`
 * from a tag (or its plural), else `fact`; the first line is the title, the rest the body; the other tags stay tags.
 * Undefined when the hub turns out to have no memory (the caller sends a v1 note instead).
 */
export async function noteAsMemory(a: Args, ctx: MemoryOpContext): Promise<CoordOpResult | undefined> {
  const home = ctx.home ?? os.homedir();
  const text = scrub(a.text, home, 4000);
  if (!text) return fail("`note` needs `text`.");
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() !== "");
  const first = oneLine(lines[at] ?? text);
  const rest = lines.slice(at + 1).join("\n").trim();
  const body = (first.cut ? text : rest).slice(0, HUB_MEMORY_BODY_MAX);
  const allTags = tagsOf(a.tags ?? a.tag);
  const kind = allTags.map((t) => RULE_TAGS[t.toLowerCase()]).find((k) => k !== undefined) ?? "fact";
  const tags = allTags.filter((t) => RULE_TAGS[t.toLowerCase()] === undefined);
  const r = await ctx.coord.memory({
    action: "remember",
    ...(ctx.key ? { sessionKey: CoordClient.family(ctx.key) } : {}),
    kind,
    title: first.text,
    ...(body ? { body } : {}),
    ...(tags.length ? { tags } : {}),
  });
  if (!r.ok) {
    if (r.unavailable && r.error === NO_MEMORY) return undefined;
    return memoryError(r, fail(NO_MEMORY_WRITE));
  }
  if (!r.body.ok) return fail(`Workmesh: ${hubSaid(r.body.error, "the hub didn't take the note")}`);
  return rememberAnswer(r.body.memory, undefined);
}

/**
 * `forget { id, reason? }`: propose retiring an accepted memory (a person retires it on the board), or withdraw a
 * proposal of one's own. A `retired` answer, from an older hub, is read too (SPEC §36).
 */
export async function forgetOp(a: Args, ctx: MemoryOpContext): Promise<CoordOpResult> {
  const id = memoryId(a.id);
  if (!id) return fail("`forget` needs `id`: the memory's id, like m12 (`recall` and `memories` show them).");
  const reason = scrub(a.reason, ctx.home ?? os.homedir(), HUB_MEMORY_REASON_MAX);
  const noMemory = fail("This team's hub has no memory yet (it predates Workmesh v3); there is nothing to forget.");
  const gate = await memoryGate(ctx, noMemory);
  if (gate) return gate;
  const r = await ctx.coord.memory({
    action: "forget",
    ...(ctx.key ? { sessionKey: CoordClient.family(ctx.key) } : {}),
    id,
    ...(reason ? { reason } : {}),
  });
  if (!r.ok) return memoryError(r, noMemory);
  if (!r.body.ok) {
    if (r.status === 404) return fail(`No memory ${id} on this team's hub (\`memories\` lists them).`, r.body);
    return fail(`Workmesh: ${hubSaid(r.body.error, `the hub didn't retire ${id}`)}`, r.body);
  }
  const m = r.body.memory;
  if (!m) return { ok: true, text: `Asked the team's hub to forget ${id}.`, data: {} };
  const t = sentence(m.title);
  if (m.status === "retired") return { ok: true, text: `Retired ${id}: ${t} Agents no longer get it.`, data: { memory: m } };
  if (m.status === "rejected") return { ok: true, text: `Withdrew ${id}, a proposal: ${t}`, data: { memory: m } };
  if (m.status === "accepted" && m.retire) {
    return {
      ok: true,
      text: `Proposed retiring ${id}: ${t} A person reviews it on the board (Needs you); agents keep getting it until then.`,
      data: { memory: m },
    };
  }
  return { ok: true, text: `${id} is ${m.status}: ${t}`, data: { memory: m } };
}

/**
 * One recall hit: `[m12] gotcha · b3-fun/workmesh · Sean, 3 days ago`, then its title and its body (cut at ~600) as
 * marked lines: both are their writer's text, and neither can add a line that reads as Workmesh's.
 */
export function recallHit(m: HubMemoryAccepted, hubNow: number): string {
  const head = `[${m.id}] ${m.kind} · ${scopeLabel(m.scope)} · ${label(m.by.person) || "someone"}, ${agoText(hubNow - m.updatedAt)}`;
  const title = quoted(cleanLine(m.title, HUB_MEMORY_TITLE_MAX));
  const body = quoted(m.body, RECALL_BODY_MAX);
  const links = [...(m.links?.issues ?? []), ...(m.links?.prs ?? [])];
  return [head, title, ...(body === QUOTE_MARK ? [] : [body]), ...(links.length ? [`Links: ${links.join(", ")}`] : [])].join("\n");
}

/** `recall { query, kinds?, limit?, repo? }`: the session's repo and directory go along so the hub ranks them first. */
export async function recallOp(a: Args, ctx: MemoryOpContext): Promise<CoordOpResult> {
  const query = scrub(a.query ?? a.q, ctx.home ?? os.homedir(), HUB_RECALL_QUERY_MAX);
  if (!query) return fail("`recall` needs `query`: words to search the team's memory for.");
  const kindsRaw = strList(a.kinds ?? a.kind, 10);
  const kinds = kindsRaw ? [...new Set(kindsRaw.map(memoryKind))] : undefined;
  if (kinds?.includes(undefined)) return fail(`\`kinds\` are ${HUB_MEMORY_KINDS.join(", ")}.`);
  const limit = typeof a.limit === "number" && Number.isFinite(a.limit) ? Math.min(HUB_RECALL_MAX, Math.max(1, Math.round(a.limit))) : undefined;
  const repoArg = str(a.repo, 200);
  if (repoArg && !HUB_REPO_RE.test(repoArg)) return fail("`repo` is owner/name, e.g. b3-fun/workmesh.");
  const gate = await memoryGate(ctx, { ok: true, text: NO_MEMORY_READ, data: { memories: [], available: false } });
  if (gate) return gate;
  const here = cwdPlace(ctx);
  const repo = repoArg ?? here.repo;
  const dir = here.repo && repo && here.repo.toLowerCase() === repo.toLowerCase() && here.dir ? normalizeLeasePath(here.dir) : undefined;
  const r = await ctx.coord.recall({
    ...(ctx.key ? { sessionKey: CoordClient.family(ctx.key) } : {}),
    query,
    ...(repo ? { repo } : {}),
    ...(dir ? { paths: [dir] } : {}),
    ...(kinds ? { kinds: kinds as HubMemoryKind[] } : {}),
    ...(limit ? { limit } : {}),
  });
  if (!r.ok) return memoryError(r, { ok: true, text: NO_MEMORY_READ, data: { memories: [], available: false } });
  const hits = r.body.memories;
  if (hits.length === 0) return { ok: true, text: `No team memories match "${query}".`, data: { memories: [] } };
  const hubNow = ctx.coord.hubNow(ctx.now);
  return { ok: true, text: hits.map((m) => recallHit(m, hubNow)).join("\n\n"), data: { memories: hits } };
}

/** One line of the brief: `- [m12] gotcha · b3-fun/workmesh · Sean, 3 days ago: <title> — <first sentence>`. */
export function briefLine(m: MemoryBriefItem, hubNow: number, max = 240): string {
  const head = `- [${m.id}] ${m.kind} · ${scopeLabel(m.scope)} · ${label(m.by.person) || "someone"}, ${agoText(hubNow - m.updatedAt)}${m.tags?.length ? ` [${m.tags.join(", ")}]` : ""}: `;
  // Title and sentence are their writer's text: one line each, on this line.
  const title = cleanLine(m.title, HUB_MEMORY_TITLE_MAX);
  const s = cleanLine(firstSentence(cleanText(m.body)), max);
  let text = s && s.toLowerCase() !== title.toLowerCase() ? `${title} — ${s}` : title;
  const room = max - head.length;
  if (text.length > room) text = `${text.slice(0, Math.max(1, room - 1)).trimEnd()}…`;
  return `${head}${text}`;
}

/** `memories { kind?, tag?, repo? }` (and `notes` on a hub with memory): the brief, newest first. */
export async function memoriesOp(a: Args, ctx: MemoryOpContext): Promise<CoordOpResult> {
  const gate = await memoryGate(ctx, { ok: true, text: NO_MEMORY_READ, data: { memories: [], available: false } });
  if (gate) return gate;
  await ctx.coord.memoryReady();
  const brief = ctx.coord.brief();
  if (!brief) return fail("Workmesh hasn't fetched the team's memories yet; try again in a few seconds.");
  const kindArg = str(a.kind, 20);
  const kind = kindArg ? memoryKind(kindArg) : undefined;
  if (kindArg && !kind) return fail(`\`kind\` is one of ${HUB_MEMORY_KINDS.join(", ")}.`);
  const tag = str(a.tag, 32)?.toLowerCase();
  const tagKind = tag ? (memoryKind(tag) ?? RULE_TAGS[tag]) : undefined;
  const repo = str(a.repo, 200);
  const list = brief.filter(
    (m) =>
      (!kind || m.kind === kind) &&
      (!tag || m.kind === tagKind || (m.tags ?? []).some((t) => t.toLowerCase() === tag)) &&
      (!repo || (repo === "project" ? !m.scope : m.scope?.repo.toLowerCase() === repo.toLowerCase())),
  );
  if (list.length === 0) {
    const what = [kind && `${kind}s`, tag && `tagged ${tag}`, repo && `for ${repo}`].filter(Boolean).join(" ");
    return { ok: true, text: what ? `No team memories ${what}.` : "No accepted team memories yet.", data: { memories: [] } };
  }
  const hubNow = ctx.coord.hubNow(ctx.now);
  const lines = list.slice(0, LIST_MAX).map((m) => briefLine(m, hubNow));
  if (list.length > LIST_MAX) lines.push(`- …and ${list.length - LIST_MAX} more (\`recall\` searches them).`);
  return { ok: true, text: lines.join("\n"), data: { memories: list } };
}

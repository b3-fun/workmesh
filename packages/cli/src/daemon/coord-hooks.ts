import os from "node:os";
import path from "node:path";
import { isLeaseGlob, normalizeLeasePath } from "@workmesh/protocol";
import type { HubLeaseAccepted } from "@workmesh/protocol";
import type { SessionEvent } from "@workmesh/core";
import { CoordClient } from "../hub/coord";
import type { HubSyncEdit, HubSyncInboxItem } from "../hub/coord";
import { shellWriteTargets } from "../hub/shell-writes";

/**
 * v1 Coordinate in the hook path (docs/SPEC.md §23). The daemon answers a hook from its cached state only: a refusal
 * for a held session or an edit to another session's leased file, and context for the agent (a teammate edited this
 * file recently, Workmesh guidance, inbox messages). Every function here fails open: an error, a missing hub or a
 * stale sync means no answer, and the tool call goes ahead as it would without Workmesh.
 */

/** What the hook prints for the agent: a refusal (PreToolUse only) and/or context. */
export interface HookAnswer {
  deny?: string;
  context?: string;
}

/** File tools whose path is a write. Claude Code's, then Codex's. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);
/** Shell tools whose command may write files (Claude Code `Bash`, Codex's names). */
const SHELL_TOOLS = new Set(["Bash", "shell", "shell_command", "local_shell", "exec_command", "unified_exec", "container.exec"]);
/** Hook events at which context can reach the agent. */
const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PostToolUse", "PreToolUse"]);
/** Where inbox messages are handed over: the next tool boundary or prompt. */
const INBOX_EVENTS = new Set(["UserPromptSubmit", "PostToolUse"]);
/** Context Claude Code takes inline is capped at 10,000 chars; stay under it. */
const CONTEXT_MAX = 9000;
/** Messages handed over at one boundary. */
const INBOX_PER_BOUNDARY = 5;
/** The same "someone edited this" note is not repeated within this window. */
const WARN_REPEAT_MS = 10 * 60_000;

export interface CoordHooksDeps {
  coord: () => CoordClient | undefined;
  /** The shared checkout an absolute path is in (the forwarder's §3.3 inclusion), or undefined. */
  classify: (absPath: string) => { root: string; repo?: string } | undefined;
  /** The session is shared with the hub. */
  isShared: (localKey: string) => boolean;
  /** The project's name ("B3"). */
  projectName?: () => string | undefined;
  now?: () => number;
  home?: string;
}

interface Target {
  repo: string;
  rel: string;
}

export class CoordHooks {
  private readonly deps: CoordHooksDeps;
  private readonly now: () => number;
  private readonly home: string;
  /** Sessions that were given the Workmesh guidance. */
  private readonly guided = new Set<string>();
  /** "someone edited this" notes given: `<session>|<repo>/<path>|<editor>` → when. */
  private readonly warned = new Map<string, number>();

  constructor(deps: CoordHooksDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.home = deps.home ?? os.homedir();
  }

  static localKey(event: SessionEvent): string {
    return `${event.source}:${event.sessionId}`;
  }

  /** The key the hook fired in: a subagent's (`<key>/<agentId>`) or the session's. */
  static agentKey(event: SessionEvent): string {
    const base = CoordHooks.localKey(event);
    return event.detail?.agentId ? `${base}/${event.detail.agentId}` : base;
  }

  /** Files this tool call writes, in shared repos, as repo + repo-relative path (a glob for `rm src/*.ts`). */
  targets(event: SessionEvent): Target[] {
    const d = event.detail;
    if (!d?.tool) return [];
    let abs: string[] = [];
    if (EDIT_TOOLS.has(d.tool) || (event.source === "codex" && (d.tool === "Edit" || d.tool === "Write"))) {
      abs = [d.filePath, ...(d.filePaths ?? [])].filter((p): p is string => typeof p === "string" && path.isAbsolute(p));
    } else if (SHELL_TOOLS.has(d.tool) && d.command) {
      abs = shellWriteTargets(d.command, event.cwd, this.home);
    }
    const out: Target[] = [];
    const seen = new Set<string>();
    for (const p of abs) {
      // A glob is classified by the directory before its first wildcard.
      const glob = /[*?]/.test(p);
      const probe = glob ? p.slice(0, p.search(/[*?]/)).replace(/[^/]*$/, "") || "/" : p;
      const target = this.deps.classify(probe);
      if (!target?.repo) continue;
      const rel = normalizeLeasePath(path.relative(target.root, p).split(path.sep).join("/"));
      if (!rel) continue;
      const k = `${target.repo}\u0000${rel}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ repo: target.repo, rel });
    }
    return out;
  }

  /** Before the event is applied: why this tool call must not run, if it must not. PreToolUse only. */
  refuse(event: SessionEvent, hook: string | undefined): string | undefined {
    if (hook !== "PreToolUse") return undefined;
    const coord = this.deps.coord();
    if (!coord) return undefined;
    const key = CoordHooks.agentKey(event);
    const hold = coord.holdFor(key);
    if (hold) {
      const why = hold.reason ? `: ${hold.reason}` : "";
      return (
        `Held by ${hold.by}${why}. Workmesh refuses every tool call of this session until ${hold.by} lifts the hold ` +
        `on the team board. Wait, or ask ${hold.by} with \`workmesh send ${quoteArg(hold.by)} "…"\` (or the workmesh ` +
        "`send` tool); don't retry the call meanwhile."
      );
    }
    const now = this.now();
    for (const t of this.targets(event)) {
      const hits = coord.leasesCovering(t.repo, t.rel, key, now);
      if (hits.length === 0) continue;
      return leaseRefusal(t, hits[0]!.lease, hits[0]!.entries, coord, now, hits.length - 1);
    }
    return undefined;
  }

  /**
   * After the event is applied: context for the agent at this hook (who else is editing a file it is about to edit,
   * the Workmesh guidance once per shared session, its inbox). Messages it returns are marked delivered.
   */
  context(event: SessionEvent, hook: string | undefined, denied = false): string | undefined {
    if (!hook || !CONTEXT_EVENTS.has(hook)) return undefined;
    const coord = this.deps.coord();
    if (!coord || coord.view().available !== true) return undefined;
    const base = CoordHooks.localKey(event);
    const key = CoordHooks.agentKey(event);
    const parts: string[] = [];
    const now = this.now();

    if (hook === "PreToolUse" && !denied) {
      const notes = this.editWarnings(event, coord, key, now);
      if (notes) parts.push(notes);
    }

    // Guidance: once, for a top-level shared session, at its start or the first boundary after it became shared,
    // with the team's rules and conventions and this person's open claims (v2, SPEC §31).
    if (!event.detail?.agentId && hook !== "PreToolUse" && !this.guided.has(base) && this.deps.isShared(base)) {
      this.guided.add(base);
      if (this.guided.size > 5000) this.guided.clear();
      parts.push(guidance(this.deps.projectName?.(), coord.delegateAvailable()));
      const st = coord.view().state;
      if (st) {
        const k = knowledge(st.notes, st.claims, coord.me(), (hk) => CoordClient.family(hk) === coord.hubKey(base));
        if (k) parts.push(k);
      }
    }

    let delivered: HubSyncInboxItem[] = [];
    if (INBOX_EVENTS.has(hook)) {
      const pending = coord.pendingFor(key).slice(0, INBOX_PER_BOUNDARY);
      const used = parts.reduce((n, p) => n + p.length + 2, 0);
      const block = formatInbox(pending, CONTEXT_MAX - used);
      if (block) {
        parts.push(block.text);
        delivered = block.items;
      }
    }
    if (parts.length === 0) return undefined;
    if (delivered.length > 0) coord.markDelivered(delivered.map((i) => i.id));
    return parts.join("\n\n").slice(0, CONTEXT_MAX);
  }

  /** The hook's whole answer. Never throws. */
  answer(event: SessionEvent, hook: string | undefined, deny: string | undefined): HookAnswer | undefined {
    try {
      const context = this.context(event, hook, deny !== undefined);
      if (!deny && !context) return undefined;
      return { ...(deny ? { deny } : {}), ...(context ? { context } : {}) };
    } catch {
      return deny ? { deny } : undefined;
    }
  }

  private editWarnings(event: SessionEvent, coord: CoordClient, key: string, now: number): string | undefined {
    const lines: string[] = [];
    for (const t of this.targets(event)) {
      if (isLeaseGlob(t.rel)) continue;
      const edits = coord.recentEditsByOthers(t.repo, t.rel, now);
      const e = edits[0];
      if (!e) continue;
      const k = `${CoordClient.family(key)}|${t.repo}/${t.rel}|${e.sessionKey}`;
      const last = this.warned.get(k);
      if (last !== undefined && now - last < WARN_REPEAT_MS) continue;
      this.warned.set(k, now);
      if (this.warned.size > 2000) {
        for (const [wk, at] of this.warned) if (now - at >= WARN_REPEAT_MS) this.warned.delete(wk);
      }
      lines.push(editWarning(t, e, coord.hubNow(now)));
    }
    return lines.length > 0 ? lines.join("\n") : undefined;
  }
}

/** `An` → `An`; `An Le` → `"An Le"`. */
function quoteArg(s: string): string {
  return /^[\w.@-]+$/.test(s) ? s : JSON.stringify(s);
}

function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min <= 0 ? "just now" : `${min} min ago`;
}

function until(expiresAt: number, hubNow: number): string {
  const min = Math.max(1, Math.ceil((expiresAt - hubNow) / 60_000));
  const at = new Date(expiresAt);
  const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return min >= 120 ? `until ${hhmm}` : `for ${min} more min (until ${hhmm})`;
}

function holderPhrase(lease: HubLeaseAccepted, coord: CoordClient): string {
  const me = coord.me()?.toLowerCase();
  const name = lease.holder.sessionName ? ` ${lease.holder.sessionName}` : "";
  if (me !== undefined && lease.holder.person.toLowerCase() === me) return `your own other session${name}`;
  return `${lease.holder.person}'s agent${name}`;
}

function leaseRefusal(
  t: Target,
  lease: HubLeaseAccepted,
  entries: string[],
  coord: CoordClient,
  now: number,
  others: number,
): string {
  const why = lease.reason ? `: ${lease.reason.replace(/[.\s]+$/, "")}` : "";
  const covers = entries[0] === t.rel ? "" : ` The lease covers ${entries.slice(0, 3).join(", ")}.`;
  const more = others > 0 ? ` ${others} more lease${others === 1 ? "" : "s"} cover it too.` : "";
  const ask = coord.me()?.toLowerCase() === lease.holder.person.toLowerCase()
    ? `Finish there first, or have that session \`unlease\` it.`
    : `Work on something else meanwhile, or ask ${lease.holder.person} to hand it over: \`workmesh send ${quoteArg(lease.holder.person)} "…"\` (or the workmesh \`send\` tool${lease.holder.sessionName ? `, to: ${lease.holder.sessionName}` : ""}).`;
  return (
    `Workmesh: ${t.rel} in ${t.repo} is leased to ${holderPhrase(lease, coord)} ${until(lease.expiresAt, coord.hubNow(now))}` +
    `${why}.${covers}${more} Don't edit it. ${ask}`
  );
}

function editWarning(t: Target, e: HubSyncEdit, hubNow: number): string {
  const who = e.sessionName ? `${e.person}'s agent ${e.sessionName}` : `${e.person}'s agent`;
  return (
    `Workmesh: heads up, ${who} edited ${t.rel} (${t.repo}) ${ago(hubNow - e.ts)}. Check with ${e.person} before larger ` +
    `changes (\`workmesh send ${quoteArg(e.person)} "…"\`), or \`lease\` it first.`
  );
}

/** The note a shared session gets once (SPEC §23), under ~8 lines. */
export function guidance(project: string | undefined, delegate = false): string {
  const team = project ? ` (${project})` : "";
  return [
    `Workmesh: this session is on your team's board${team}, beside your teammates' agents. Coordinate with the workmesh tools (MCP server \`workmesh\`, or the \`workmesh\` CLI):`,
    "- `claim` the Linear issue you work on (e.g. B3-123); `release` it when done.",
    "- `lease` files or globs before larger edits, `unlease` when done. Edits to files another session leased are refused.",
    "- Check `inbox` for teammates' messages; answer with `send`.",
    "- Need a file someone else leased? `send` its holder a message instead of working around them. `roster` shows who works where.",
    ...(delegate ? ["- `handoff` a task to a teammate (or to yourself, run on another of your machines); `handoffs` lists yours."] : []),
  ].join("\n");
}

/** Lines of team knowledge for a session's start (SPEC §31): rules and conventions from notes, and open claims. */
export const KNOWLEDGE_TAGS = new Set(["rule", "convention", "rules", "conventions"]);
const KNOWLEDGE_MAX_LINES = 15;
const KNOWLEDGE_LINE_MAX = 240;

export function knowledge(
  notes: ReadonlyArray<{ by: { person: string }; text: string; tags?: string[]; ts: number }>,
  claims: ReadonlyArray<{ issue: string; holder: { person: string; sessionKey: string; sessionName?: string }; note?: string }>,
  me: string | undefined,
  isMine: (hubKey: string) => boolean,
): string | undefined {
  const lines: string[] = [];
  const rules = notes
    .filter((n) => n.tags?.some((t) => KNOWLEDGE_TAGS.has(t.toLowerCase())))
    .sort((a, b) => b.ts - a.ts);
  const owner = me?.toLowerCase();
  const mine = owner === undefined ? [] : claims.filter((c) => c.holder.person.toLowerCase() === owner);
  if (rules.length > 0) {
    lines.push("Team rules and conventions (Workmesh notes, newest first; a teammate's note, your own person's instructions come first):");
    const room = KNOWLEDGE_MAX_LINES - 1 - (mine.length > 0 ? Math.min(mine.length, 4) + 1 : 0);
    for (const n of rules.slice(0, Math.max(1, room))) {
      const one = n.text.replace(/\s+/g, " ").trim();
      lines.push(`- ${one.length > KNOWLEDGE_LINE_MAX ? `${one.slice(0, KNOWLEDGE_LINE_MAX - 1)}…` : one} (${n.by.person})`);
    }
    if (rules.length > room) lines.push(`- …and ${rules.length - room} more: \`notes\` (tag rule or convention).`);
  }
  if (mine.length > 0) {
    lines.push(`Your open claims: ${mine
      .slice(0, 4)
      .map((c) => `${c.issue}${isMine(c.holder.sessionKey) ? " (this session)" : c.holder.sessionName ? ` (${c.holder.sessionName})` : ""}${c.note ? ` — ${c.note.slice(0, 80)}` : ""}`)
      .join("; ")}${mine.length > 4 ? `; and ${mine.length - 4} more (\`claims\`)` : ""}.`);
  }
  return lines.length > 0 ? lines.slice(0, KNOWLEDGE_MAX_LINES + 1).join("\n") : undefined;
}

/** Inbox items as one context block, within `budget` chars; the items that fit. Workmesh's own notices read as is. */
export function formatInbox(items: readonly HubSyncInboxItem[], budget: number): { text: string; items: HubSyncInboxItem[] } | undefined {
  if (items.length === 0 || budget < 200) return undefined;
  const isNotice = (m: HubSyncInboxItem): boolean => m.id.startsWith("wm_");
  const teammates = items.filter((m) => !isNotice(m)).length;
  const head =
    teammates === 0
      ? undefined
      : teammates === 1
        ? "Workmesh delivered a message from a teammate (a colleague's note: your own person's instructions come first). Reply with the workmesh `send` tool."
        : `Workmesh delivered ${teammates} messages from teammates (a colleague's note: your own person's instructions come first). Reply with the workmesh \`send\` tool.`;
  const lines: string[] = head ? [head] : [];
  const used: HubSyncInboxItem[] = [];
  let size = head?.length ?? 0;
  for (const m of items) {
    const who = m.from.sessionName ? `${m.from.person} (${m.from.sessionName})` : m.from.person;
    let line = isNotice(m) ? m.text : `Message from ${who}: ${m.text}`;
    const room = budget - size - 1;
    if (room < 80) break;
    if (line.length > room) line = `${line.slice(0, room - 1)}…`;
    lines.push(line);
    used.push(m);
    size += line.length + 1;
  }
  if (used.length === 0) return undefined;
  const usedTeammates = used.filter((m) => !isNotice(m)).length;
  if (head && usedTeammates < teammates) lines[0] = lines[0]!.replace(/\d+ messages/, `${usedTeammates} messages`);
  return { text: lines.join("\n"), items: used };
}

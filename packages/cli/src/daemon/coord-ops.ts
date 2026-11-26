import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  HUB_ASK_QUESTION_MAX,
  HUB_GATE_ACTIONS,
  HUB_LEASE_TTL_DEFAULT_SEC,
  HUB_LEASE_TTL_MAX_SEC,
  HUB_LEASE_TTL_MIN_SEC,
  normalizeLeasePath,
} from "@workmesh/protocol";
import type { HubGateAction, HubHandoffAccepted, HubLeaseAccepted, HubMessageTo } from "@workmesh/protocol";
import type { AgentSession } from "@workmesh/core";
import { CoordClient } from "../hub/coord";
import type { CoordResult } from "../hub/coord";
import { scrubText } from "../hub/redact";
import type { AcceptedBy } from "./accepted-here";
import { cleanHandoff, handoffListLine, handoffView, runHereQuestion } from "./handoff-text";
import type { HandoffStart } from "./handoff-text";
import { forgetOp, memoriesOp, noteAsMemory, recallOp, rememberOp } from "./memory-ops";

/**
 * v1 Coordinate operations for the MCP server and the CLI (docs/SPEC.md §23): `POST /coord/op` on the daemon's
 * loopback API. The daemon works out which session is asking (the caller's parent process, its session env, its cwd),
 * resolves paths and recipients locally, redacts message and note text (§9) and makes the hub call with the device
 * token, which never leaves it. Every answer has a short `text` for an agent or a person, and `data` for `--json`.
 */

export const COORD_OPS = [
  "whoami",
  "roster",
  "send",
  "inbox",
  "claim",
  "release",
  "claims",
  "lease",
  "unlease",
  "leases",
  "note",
  "notes",
  // v2 Delegate (SPEC §31)
  "handoff",
  "handoffs",
  "gates",
  "approvals",
  // Ask (SPEC §29)
  "ask",
  // v3 Memory (SPEC §36)
  "remember",
  "recall",
  "forget",
  "memories",
] as const;
export type CoordOp = (typeof COORD_OPS)[number];

/** Who is asking: the MCP server or CLI process's view of itself. */
export const coordCallerSchema = z
  .object({
    /** The caller's parent process (Claude Code runs MCP servers as its children). */
    ppid: z.number().int().positive().optional(),
    cwd: z.string().max(4096).optional(),
    /** `CLAUDE_CODE_SESSION_ID` in the caller's environment. */
    claudeSessionId: z.string().max(128).optional(),
    /** `CODEX_THREAD_ID` in the caller's environment. */
    codexThreadId: z.string().max(128).optional(),
    /** The MCP client's name (`claude-code`, `codex-mcp-client`), or `cli`. */
    client: z.string().max(80).optional(),
  })
  .default({});
export type CoordCaller = z.infer<typeof coordCallerSchema>;

/**
 * The `client` names that are a person's own surfaces: the CLI and the menu bar app. The MCP server sends its MCP
 * client's name, and never one of these (mcp/server.ts).
 */
export const PERSON_CLIENTS: readonly string[] = ["cli", "menubar"];

export const coordOpRequestSchema = z.object({
  op: z.enum(COORD_OPS),
  args: z.record(z.string(), z.unknown()).default({}),
  caller: coordCallerSchema,
});
export type CoordOpRequest = z.infer<typeof coordOpRequestSchema>;

export interface CoordOpResult {
  ok: boolean;
  /** For the agent or the person. */
  text: string;
  data?: unknown;
}

export interface CoordOpsDeps {
  coord: () => CoordClient | undefined;
  /** The hub pairing (url, project, person). */
  hub: () => { url: string; project: { name: string }; person?: { name: string }; deviceId: string } | undefined;
  getSession: (key: string) => AgentSession | undefined;
  listSessions: () => readonly AgentSession[];
  classify: (absPath: string) => { root: string; repo?: string } | undefined;
  isShared: (key: string) => boolean;
  /** Live Claude Code processes by session id (`~/.claude/sessions`). */
  claudeSessions: () => ReadonlyMap<string, { pid: number; sessionId: string }> | undefined;
  /** v2: the person accepted a handoff on this machine (record it, and start it now rather than at the next sync). */
  onAccepted?: (h: HubHandoffAccepted, by: AcceptedBy) => void;
  /** v2: whether a handoff accepted somewhere else waits for this person's "run it here". */
  waitsToRunHere?: (h: HubHandoffAccepted) => boolean;
  /** v2: the person said "run it here" on this machine (record it, and start it). */
  onRunHere?: (h: HubHandoffAccepted, by: AcceptedBy) => void;
  /** v2: handoff ids running on this machine. */
  runningHandoffs?: () => ReadonlySet<string>;
  /** v2: what the person's Accept of this handoff starts on this machine, in one line opening with `lead`. */
  handoffStart?: (h: HubHandoffAccepted, lead: string) => HandoffStart | undefined;
  /** Ask: this machine's IANA time zone, for "today" and clock times (default: the process's). */
  timeZone?: () => string | undefined;
  now?: () => number;
  home?: string;
}

const str = (v: unknown, max = 4000): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
const strList = (v: unknown, max = 50): string[] | undefined => {
  if (typeof v === "string" && v.trim()) return [v.trim()];
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  return out.length > 0 ? out.slice(0, max) : undefined;
};

const fail = (text: string, data?: unknown): CoordOpResult => ({ ok: false, text, data });

function mins(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "under a minute";
  if (m < 120) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

/** Which session is asking. Undefined = the person themselves (the CLI outside any agent session). */
export function resolveCaller(caller: CoordCaller, deps: CoordOpsDeps): string | undefined {
  const live = (key: string): boolean => deps.getSession(key) !== undefined;
  // Claude Code: the parent process's session file names the session even after /clear.
  if (caller.ppid !== undefined) {
    const claude = deps.claudeSessions();
    if (claude) {
      for (const p of claude.values()) if (p.pid === caller.ppid) return `claude-code:${p.sessionId}`;
    }
  }
  if (caller.claudeSessionId) return `claude-code:${caller.claudeSessionId}`;
  if (caller.codexThreadId) return `codex:${caller.codexThreadId}`;
  // Otherwise: the live session that runs in the caller's directory and moved last.
  if (caller.cwd) {
    const source = caller.client?.startsWith("codex") ? "codex" : caller.client?.startsWith("claude") ? "claude-code" : undefined;
    const candidates = deps
      .listSessions()
      .filter((s) => s.cwd === caller.cwd && (!source || s.source === source))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const best = candidates[0];
    if (best && live(best.key)) return best.key;
  }
  return undefined;
}

/** A hub answer that failed, as one line for the caller. */
function hubError(r: Extract<CoordResult<unknown>, { ok: false }>): CoordOpResult {
  return fail(r.unavailable ? "Workmesh coordination isn't on this team's hub yet; nothing was sent." : `Workmesh: ${r.error}`);
}

function leaseLine(l: HubLeaseAccepted, coord: CoordClient, now: number): string {
  const who = l.holder.sessionName ? `${l.holder.person} (${l.holder.sessionName})` : l.holder.person;
  const mine = coord.localKey(l.holder.sessionKey) !== undefined ? " [this machine]" : "";
  const left = l.expiresAt - coord.hubNow(now);
  const why = l.reason ? ` — ${l.reason}` : "";
  return `- ${l.repo}: ${l.paths.join(", ")} · ${who}${mine} · ${left > 0 ? `${mins(left)} left` : "expired"}${why} [${l.id}]`;
}

/** Lease arguments → one repo and its repo-relative entries. */
export function resolveLeasePaths(
  raw: readonly string[],
  repoArg: string | undefined,
  cwd: string | undefined,
  classify: CoordOpsDeps["classify"],
  home = os.homedir(),
): { repo: string; paths: string[] } | { error: string } {
  let repo = repoArg;
  const out: string[] = [];
  for (const p0 of raw) {
    let p = p0;
    if (p === "~" || p.startsWith("~/")) p = path.join(home, p.slice(1));
    if (repoArg && !path.isAbsolute(p)) {
      const rel = normalizeLeasePath(p);
      if (!rel) return { error: `${p0} isn't a repo-relative path or glob` };
      out.push(rel);
      continue;
    }
    if (!path.isAbsolute(p)) {
      if (!cwd) return { error: `${p0} is relative and this session has no working directory: give an absolute path or a repo` };
      p = path.join(cwd, p);
    }
    const glob = p.search(/[*?]/);
    const probe = glob === -1 ? p : p.slice(0, glob).replace(/[^/]*$/, "") || "/";
    const target = classify(probe);
    if (!target?.repo) return { error: `${p0} isn't in a repo this machine shares with the hub` };
    if (repo && repo !== target.repo) return { error: `one repo per lease: ${p0} is in ${target.repo}, not ${repo}` };
    repo = target.repo;
    const relRaw = path.relative(target.root, path.normalize(p)).split(path.sep).join("/");
    const rel = relRaw === "" ? "**" : normalizeLeasePath(relRaw);
    if (!rel) return { error: `${p0} isn't inside ${target.repo}` };
    out.push(rel);
  }
  if (!repo) return { error: "name at least one path" };
  return { repo, paths: [...new Set(out)] };
}

/** Runs one operation. Never throws. */
export async function runCoordOp(req: CoordOpRequest, deps: CoordOpsDeps): Promise<CoordOpResult> {
  try {
    return await runUnsafe(req, deps);
  } catch (err) {
    return fail(`Workmesh: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function runUnsafe(req: CoordOpRequest, deps: CoordOpsDeps): Promise<CoordOpResult> {
  const hub = deps.hub();
  const coord = deps.coord();
  if (!hub || !coord) {
    return fail("This machine isn't connected to a Workmesh hub (`workmesh hub connect <url>`).");
  }
  const now = (deps.now ?? Date.now)();
  const home = deps.home ?? os.homedir();
  const key = resolveCaller(req.caller, deps);
  const session = key ? deps.getSession(CoordClient.family(key)) : undefined;
  const cwd = session?.cwd ?? req.caller.cwd;
  const view = coord.view();
  const st = view.state;
  const a = req.args;
  const needsSession = (what: string): CoordOpResult | undefined =>
    key ? undefined : fail(`Workmesh can't tell which agent session is asking, and ${what} belongs to one. Run it from inside a Claude Code or Codex session.`);
  const unavailable = view.available === false ? fail("Workmesh coordination isn't on this team's hub yet.") : undefined;
  const ctx = { coord, key, cwd, home, now, classify: deps.classify };

  switch (req.op) {
    case "whoami": {
      const shared = key ? deps.isShared(CoordClient.family(key)) : false;
      const data = {
        person: coord.me() ?? hub.person?.name,
        project: hub.project.name,
        hub: hub.url,
        deviceId: hub.deviceId,
        session: key ? { key, hubKey: coord.hubKey(key), name: session?.name, cwd, shared } : undefined,
        coordination: view.available === true ? "on" : view.available === false ? "not on this hub" : view.halted ? "stopped (pair again)" : "starting",
      };
      const lines = [
        `You are ${data.person ?? "(unknown)"} on ${data.project} (${data.hub}). Coordination: ${data.coordination}.`,
        key
          ? `This session: ${session?.name ?? key} (${data.session!.hubKey})${shared ? ", shared with the team" : ", not shared (its cwd isn't in a shared repo yet)"}.`
          : "No agent session identified: you are the person at the terminal.",
      ];
      return { ok: true, text: lines.join("\n"), data };
    }

    case "roster": {
      if (unavailable) return unavailable;
      if (!st) return fail("Workmesh hasn't heard from the hub yet; try again in a few seconds.");
      const lines: string[] = [];
      for (const p of st.roster) {
        const live = p.sessions.filter((s) => s.state !== "ended");
        lines.push(`${p.person}: ${live.length === 0 ? "no sessions" : `${live.length} session${live.length === 1 ? "" : "s"}`}`);
        for (const s of live.slice(0, 12)) lines.push(`  - ${s.name || s.hubKey} · ${s.state}${s.repo ? ` · ${s.repo}` : ""}`);
      }
      if (st.claims.length > 0) lines.push(`Claims: ${st.claims.map((c) => `${c.issue} (${c.holder.person})`).join(", ")}`);
      if (st.leases.length > 0) lines.push(`Leases: ${st.leases.length} active (\`leases\` lists them)`);
      return { ok: true, text: lines.join("\n") || "Nobody on the roster yet.", data: { roster: st.roster, claims: st.claims } };
    }

    case "send": {
      if (unavailable) return unavailable;
      const toRaw = str(a.to, 300);
      const text = scrubText(str(a.text, 16_000), { home, max: 4000 })?.text;
      if (!toRaw) return fail("`send` needs `to`: a person (name, email or GitHub login), an agent's session name, or a session's hub key.");
      if (!text) return fail("`send` needs `text`.");
      const to = recipient(toRaw, str(a.kind, 20), st);
      if ("error" in to) return fail(to.error);
      const thread = str(a.thread, 64);
      // v2 (SPEC §30): wake an idle recipient. Absent: an agent's reply (in a thread it was sent, or to the session
      // that wrote to it in the last 30 minutes) wakes; otherwise the hub's default (a person's message wakes).
      const wake =
        typeof a.wake === "boolean"
          ? a.wake
          : key && coord.isReply(key, to, thread, now)
            ? true
            : undefined;
      const r = await coord.message({
        ...(key ? { from: CoordClient.family(key) } : {}),
        to,
        text,
        ...(thread ? { thread } : {}),
        ...(wake !== undefined ? { wake } : {}),
      });
      if (!r.ok) return hubError(r);
      if (!r.body.ok) return fail(`Workmesh: ${r.body.error || "the hub didn't take the message"}`);
      const where = "person" in to ? to.person : "agent" in to ? to.agent : to.session;
      return { ok: true, text: `Sent to ${where} (message ${r.body.id}).`, data: { id: r.body.id, to } };
    }

    case "inbox": {
      if (key) {
        const items = coord.pendingFor(key);
        if (items.length > 0) coord.markDelivered(items.map((i) => i.id));
        if (items.length === 0) return { ok: true, text: "No new messages for this session.", data: { messages: [] } };
        const lines = items.map((m) => `Message from ${m.from.sessionName ? `${m.from.person} (${m.from.sessionName})` : m.from.person}: ${m.text}`);
        return { ok: true, text: lines.join("\n"), data: { messages: items } };
      }
      const all = coord.inboxItems();
      if (all.length === 0) return { ok: true, text: "No messages waiting for this machine's agents.", data: { messages: [] } };
      const lines = all.map((m) => {
        const s = m.localKey ? deps.getSession(CoordClient.family(m.localKey)) : undefined;
        return `- to ${s?.name ?? m.localKey ?? m.to}${m.delivered ? " (delivered)" : ""}: from ${m.from.person}${m.from.sessionName ? ` (${m.from.sessionName})` : ""}: ${m.text}`;
      });
      return { ok: true, text: lines.join("\n"), data: { messages: all } };
    }

    case "claim":
    case "release": {
      if (unavailable) return unavailable;
      const missing = needsSession("a claim");
      if (missing) return missing;
      const issue = str(a.issue, 24)?.toUpperCase();
      if (!issue || !/^[A-Z][A-Z0-9]{0,9}-\d{1,6}$/.test(issue)) return fail("Give a Linear issue id, like B3-123.");
      const note = str(a.note, 500);
      const r = await coord.claim({ action: req.op, sessionKey: CoordClient.family(key!), issue, ...(note && req.op === "claim" ? { note } : {}) });
      if (!r.ok) return hubError(r);
      if (!r.body.ok) {
        const h = r.body.holder;
        return fail(
          `${issue} is already claimed by ${h.person}${h.sessionName ? ` (${h.sessionName})` : ""}. Pick another issue, or ask ${h.person} with \`send\`.`,
          r.body,
        );
      }
      return { ok: true, text: req.op === "claim" ? `Claimed ${issue}.` : `Released ${issue}.`, data: r.body };
    }

    case "claims": {
      if (unavailable) return unavailable;
      if (!st) return fail("Workmesh hasn't heard from the hub yet; try again in a few seconds.");
      if (st.claims.length === 0) return { ok: true, text: "No active claims.", data: { claims: [] } };
      const lines = st.claims.map(
        (c) => `- ${c.issue} · ${c.holder.person}${c.holder.sessionName ? ` (${c.holder.sessionName})` : ""}${c.note ? ` — ${c.note}` : ""}`,
      );
      return { ok: true, text: lines.join("\n"), data: { claims: st.claims } };
    }

    case "lease": {
      if (unavailable) return unavailable;
      const missing = needsSession("a lease");
      if (missing) return missing;
      const raw = strList(a.paths ?? a.path);
      if (!raw) return fail("`lease` needs `paths`: files, directories or globs (repo-relative, or absolute).");
      const resolved = resolveLeasePaths(raw, str(a.repo, 200), cwd, deps.classify, home);
      if ("error" in resolved) return fail(resolved.error);
      const minutes = typeof a.minutes === "number" ? a.minutes : typeof a.ttlMin === "number" ? a.ttlMin : undefined;
      const ttlSec =
        minutes === undefined
          ? HUB_LEASE_TTL_DEFAULT_SEC
          : Math.min(HUB_LEASE_TTL_MAX_SEC, Math.max(HUB_LEASE_TTL_MIN_SEC, Math.round(minutes * 60)));
      const reason = str(a.reason, 200);
      const r = await coord.lease({
        action: "acquire",
        sessionKey: CoordClient.family(key!),
        repo: resolved.repo,
        paths: resolved.paths,
        ttlSec,
        ...(reason ? { reason } : {}),
      });
      if (!r.ok) return hubError(r);
      if (!r.body.ok) {
        const lines = r.body.conflicts.map(
          (c) =>
            `- ${c.paths.join(", ")} · ${c.holder.person}${c.holder.sessionName ? ` (${c.holder.sessionName})` : ""} · ${mins(c.expiresAt - coord.hubNow(now))} left${c.reason ? ` — ${c.reason}` : ""}`,
        );
        return fail(`Not leased: these leases overlap (${resolved.repo}):\n${lines.join("\n")}\nAsk the holder with \`send\`, or lease something narrower.`, r.body);
      }
      return {
        ok: true,
        text: `Leased ${resolved.paths.join(", ")} in ${resolved.repo} for ${mins(ttlSec * 1000)}${r.body.lease ? ` [${r.body.lease.id}]` : ""}. \`unlease\` when done.`,
        data: r.body,
      };
    }

    case "unlease": {
      if (unavailable) return unavailable;
      const missing = needsSession("a lease");
      if (missing) return missing;
      const leaseId = str(a.leaseId ?? a.id, 64);
      const raw = strList(a.paths ?? a.path);
      let repo = str(a.repo, 200);
      let paths: string[] = [];
      if (raw) {
        const resolved = resolveLeasePaths(raw, repo, cwd, deps.classify, home);
        if ("error" in resolved) return fail(resolved.error);
        repo = resolved.repo;
        paths = resolved.paths;
      }
      const mineKey = coord.hubKey(CoordClient.family(key!));
      const mine = (st?.leases ?? []).filter((l) => CoordClient.family(l.holder.sessionKey) === mineKey);
      const repos = repo ? [repo] : [...new Set((leaseId ? mine.filter((l) => l.id === leaseId) : mine).map((l) => l.repo))];
      if (repos.length === 0) {
        const cwdRepo = cwd ? deps.classify(cwd)?.repo : undefined;
        if (!cwdRepo) return { ok: true, text: "This session holds no leases.", data: { released: 0 } };
        repos.push(cwdRepo);
      }
      let released = 0;
      for (const r0 of repos) {
        const r = await coord.lease({
          action: "release",
          sessionKey: CoordClient.family(key!),
          repo: r0,
          paths,
          ...(leaseId ? { leaseId } : {}),
        });
        if (!r.ok) return hubError(r);
        if (r.body.ok) released += r.body.released ?? (r.body.lease ? 1 : 0);
      }
      return { ok: true, text: `Released ${released} lease${released === 1 ? "" : "s"}.`, data: { released } };
    }

    case "leases": {
      if (unavailable) return unavailable;
      if (!st) return fail("Workmesh hasn't heard from the hub yet; try again in a few seconds.");
      const repo = str(a.repo, 200);
      const hubNow = coord.hubNow(now);
      const leases = st.leases.filter((l) => l.expiresAt > hubNow && (!repo || l.repo === repo));
      if (leases.length === 0) return { ok: true, text: repo ? `No active leases in ${repo}.` : "No active leases.", data: { leases: [] } };
      return { ok: true, text: leases.map((l) => leaseLine(l, coord, now)).join("\n"), data: { leases } };
    }

    case "note": {
      if (unavailable) return unavailable;
      // v3 (SPEC §36): on a hub with memory a note is a memory (a fact, or a rule or convention by its tag).
      if (coord.memoryAvailable(now)) {
        const r = await noteAsMemory(a, ctx);
        if (r) return r; // else the hub has no memory after all: a v1 note
      }
      const text = scrubText(str(a.text, 16_000), { home, max: 4000 })?.text;
      if (!text) return fail("`note` needs `text`.");
      const tags = strList(a.tags, 10)?.filter((t) => /^[\w.:-]{1,32}$/.test(t));
      const r = await coord.note({
        ...(key ? { sessionKey: CoordClient.family(key) } : {}),
        text,
        ...(tags && tags.length > 0 ? { tags: [...new Set(tags)] } : {}),
      });
      if (!r.ok) return hubError(r);
      if (!r.body.ok) return fail(`Workmesh: ${r.body.error || "the hub didn't take the note"}`);
      return { ok: true, text: `Noted for the team (note ${r.body.id}).`, data: { id: r.body.id } };
    }

    case "notes": {
      if (unavailable) return unavailable;
      if (!st) return fail("Workmesh hasn't heard from the hub yet; try again in a few seconds.");
      // v3 (SPEC §36): on a hub with memory, the notes are the accepted memories (`tag` matches a kind or a tag); until
      // the brief arrives, the sync's notes (which list them too).
      if (coord.memoryAvailable(now)) {
        await coord.memoryReady();
        if (coord.brief()) return memoriesOp(a, ctx);
      }
      const tag = str(a.tag, 32);
      const notes = st.notes.filter((n) => !tag || n.tags?.includes(tag));
      if (notes.length === 0) return { ok: true, text: tag ? `No team notes tagged ${tag}.` : "No team notes yet.", data: { notes: [] } };
      const lines = notes.map(
        (n) =>
          `- ${n.by.person}${n.by.sessionName ? ` (${n.by.sessionName})` : ""}, ${mins(coord.hubNow(now) - n.ts)} ago${n.tags?.length ? ` [${n.tags.join(", ")}]` : ""}: ${n.text}`,
      );
      return { ok: true, text: lines.join("\n"), data: { notes } };
    }

    // --- v2 Delegate (SPEC §31) -------------------------------------------------------

    case "handoff": {
      if (unavailable) return unavailable;
      const toRaw = str(a.to, 200);
      const task = scrubText(str(a.task, 16_000), { home, max: 4000 })?.text;
      if (!toRaw) return fail("`handoff` needs `to`: a person (name, email or GitHub login), or `me` for one of your other machines.");
      if (!task) return fail("`handoff` needs `task`: what to do, in a few sentences.");
      const me = coord.me() ?? hub.person?.name;
      const person = /^(me|myself|self)$/i.test(toRaw) ? me : personOf(toRaw, st);
      if (!person) return fail(`Workmesh doesn't know who ${toRaw} is on this team (\`roster\` lists people).`);
      const repoArg = str(a.repo, 200);
      const repo = repoArg ?? (cwd ? deps.classify(cwd)?.repo : undefined);
      if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail("`repo` is owner/name, e.g. b3-fun/workmesh.");
      const issue = str(a.issue, 24)?.toUpperCase();
      if (issue && !/^[A-Z][A-Z0-9]{0,9}-\d{1,6}$/.test(issue)) return fail("`issue` is a Linear issue id, like B3-123.");
      const context = scrubText(str(a.context, 16_000), { home, max: 4000 })?.text;
      const r = await coord.handoff({
        action: "create",
        ...(key ? { from: CoordClient.family(key) } : {}),
        to: { person },
        task,
        ...(repo ? { repo } : {}),
        ...(issue ? { issue } : {}),
        ...(context ? { context } : {}),
      });
      if (!r.ok) return delegateError(r);
      if (!r.body.ok) return fail(`Workmesh: ${r.body.error || "the hub didn't take the handoff"}`);
      const h = r.body.handoff;
      const self = me !== undefined && person.toLowerCase() === me.toLowerCase();
      return {
        ok: true,
        text: self
          ? `Handed to yourself (handoff ${h.id}${repo ? `, ${repo}` : ""}): one of your machines starts an agent for it if its policy allows, else it waits for your Accept on the board or in the menu bar.`
          : `Handed to ${person} (handoff ${h.id}${repo ? `, ${repo}` : ""}). It waits for ${person}'s Accept on the board or in their menu bar; you'll get a message here when they take it and when it's done.`,
        data: { handoff: h },
      };
    }

    case "handoffs": {
      if (unavailable) return unavailable;
      const action = str(a.action, 20) ?? "list";
      if (action === "accept" || action === "decline" || action === "run") {
        // Accepting starts an agent on this machine with someone else's text as its instructions, so the answer is
        // a person's: the CLI at their terminal or the menu bar, and never a caller the daemon reads as an agent
        // session. Every call through the MCP server is an agent's, also one whose session the daemon can't name.
        // "Run it here" for a handoff accepted somewhere else is the same answer.
        const person = key === undefined && PERSON_CLIENTS.includes(req.caller.client ?? "");
        if (!person) {
          return fail("Handoffs are accepted or declined by a person, on the board, in the menu bar or in their own terminal, not by an agent.");
        }
        const id = str(a.id, 64);
        if (!id) return fail(`\`handoffs\` ${action} needs \`id\` (\`handoffs\` lists them).`);
        const by: AcceptedBy = req.caller.client === "menubar" ? "menubar" : "cli";
        if (action === "run") {
          await coord.refreshed();
          const h = coord.view().state?.handoffs?.find((x) => x.id === id);
          if (!h) return fail(`No handoff ${id} for you or from you in the hub's list (\`handoffs\` lists them).`);
          if (!deps.waitsToRunHere?.(h)) return fail(`Workmesh: ${id} isn't waiting to run on this machine.`);
          const start = deps.handoffStart?.(h, "Running it here starts");
          if (start && !start.agent) return fail(start.text);
          deps.onRunHere?.(h, by);
          return { ok: true, text: `Running ${id} here: this machine starts an agent for it.`, data: { handoff: cleanHandoff(h) } };
        }
        const note = str(a.note, 500);
        const r = await coord.handoff({ action, id, ...(note ? { note } : {}) });
        if (!r.ok) return delegateError(r);
        if (!r.body.ok) return fail(`Workmesh: ${r.body.error || `the hub didn't ${action} it`}`, r.body);
        if (action === "accept") deps.onAccepted?.(r.body.handoff, by);
        return {
          ok: true,
          text: action === "accept" ? `Accepted ${id}: this machine starts an agent for it.` : `Declined ${id}.`,
          data: { handoff: cleanHandoff(r.body.handoff) },
        };
      }
      if (action !== "list" && action !== "show") return fail("`handoffs` takes action list, show, accept, decline or run.");
      await coord.refreshed();
      const st = coord.view().state;
      if (!st) return fail("Workmesh hasn't heard from the hub yet; try again in a few seconds.");
      if (st.handoffs === undefined) return fail("This team's hub has no handoffs yet (it predates Workmesh v2).");
      const me = coord.me()?.toLowerCase();
      const running = deps.runningHandoffs?.() ?? new Set<string>();
      if (action === "show") {
        // The whole handoff, for a person to read before they answer it.
        const id = str(a.id, 64);
        if (!id) return fail("`handoffs` show needs `id` (`handoffs` lists them).");
        const h = st.handoffs.find((x) => x.id === id);
        if (!h) return fail(`No handoff ${id} for you or from you in the hub's list (\`handoffs\` lists them).`);
        const runningHere = running.has(h.id);
        const canAccept = h.status === "offered" && !runningHere && me !== undefined && h.to.person.toLowerCase() === me;
        // Accepted somewhere else: it waits for this person's "run it here" on this machine.
        const canRun = !runningHere && (deps.waitsToRunHere?.(h) ?? false);
        const start = canAccept ? deps.handoffStart?.(h, "Accepting starts") : canRun ? deps.handoffStart?.(h, "Running it here starts") : undefined;
        const ago = h.createdAt > 0 ? mins(coord.hubNow(now) - h.createdAt) : undefined;
        return {
          ok: true,
          text: handoffView(h, { runningHere, ago, start, runHere: canRun ? runHereQuestion(h) : undefined }),
          data: { handoff: cleanHandoff(h), canAccept, canRun, ...(start ? { onAccept: start } : {}) },
        };
      }
      if (st.handoffs.length === 0) return { ok: true, text: "No handoffs.", data: { handoffs: [] } };
      const lines = st.handoffs
        .slice(0, 30)
        .map((h) => handoffListLine(h, { me, runningHere: running.has(h.id), runHere: deps.waitsToRunHere?.(h) ? runHereQuestion(h) : undefined }));
      return { ok: true, text: lines.join("\n"), data: { handoffs: st.handoffs.map(cleanHandoff) } };
    }

    case "gates": {
      if (unavailable) return unavailable;
      const me = coord.me() ?? hub.person?.name;
      const set = a.set;
      if (set !== undefined) {
        if (key) return fail("Approval gates are your person's to set, from their own terminal or the board, not an agent's.");
        const raw = set === "off" || set === "none" ? [] : strList(set, 10) ?? [];
        const actions = [...new Set(raw.flatMap((x) => x.split(",")).map((x) => x.trim().toLowerCase().replace(/-/g, "_")).filter(Boolean))];
        const bad = actions.filter((x) => !(HUB_GATE_ACTIONS as readonly string[]).includes(x));
        if (bad.length > 0) return fail(`Unknown gate${bad.length === 1 ? "" : "s"}: ${bad.join(", ")}. Gates: ${HUB_GATE_ACTIONS.join(", ")}.`);
        const r = await coord.setGates({ actions: actions as HubGateAction[] });
        if (!r.ok) return delegateError(r);
        if (!r.body.ok) return fail(`Workmesh: ${r.body.error || "the hub didn't take the gates"}`);
        return {
          ok: true,
          text:
            actions.length === 0
              ? "Approval gates off: your agents merge, deploy and publish without asking."
              : `Your agents now ask before they ${actions.map((x) => x.replace("_", "-")).join(", ")} (approve on the board, in the menu bar or with workmesh approvals approve <id>).`,
          data: { gates: r.body.gates ?? { owner: me, actions } },
        };
      }
      if (!st) return fail("Workmesh hasn't heard from the hub yet; try again in a few seconds.");
      if (st.gates === undefined) return fail("This team's hub has no approval gates yet (it predates Workmesh v2).");
      const mine = st.gates.find((g) => me !== undefined && g.owner.toLowerCase() === me.toLowerCase());
      const others = st.gates.filter((g) => g !== mine && g.actions.length > 0);
      const lines = [
        mine && mine.actions.length > 0
          ? `Your agents ask before they: ${mine.actions.join(", ")}${mine.approvers?.length ? ` (approved by ${mine.approvers.join(" or ")})` : ""}.`
          : "No approval gates on your agents (`workmesh gates set merge,deploy` turns some on).",
        ...others.map((g) => `${g.owner}: ${g.actions.join(", ")}`),
      ];
      return { ok: true, text: lines.join("\n"), data: { gates: st.gates } };
    }

    case "approvals": {
      if (unavailable) return unavailable;
      const action = str(a.action, 20) ?? "list";
      if (action === "approve" || action === "deny") {
        if (key) return fail("Approvals are decided by a person, on the board, in the menu bar or in their own terminal, not by an agent.");
        const id = str(a.id, 64);
        if (!id) return fail(`\`approvals ${action}\` needs an id (\`workmesh approvals\` lists them).`);
        const note = str(a.note, 500);
        // Where the person decided (SPEC §30, 0.12.1): the menu bar says so; anything else at a terminal is the CLI.
        const via = req.caller.client === "menubar" ? "menubar" : "cli";
        const r = await coord.approval({ action, id, ...(note ? { note } : {}), via });
        if (!r.ok) return delegateError(r);
        if (!r.body.ok) return fail(`Workmesh: ${r.body.error || `the hub didn't ${action} it`}`);
        return { ok: true, text: `${action === "approve" ? "Approved" : "Denied"}: ${r.body.approval.detail}.`, data: { approval: r.body.approval } };
      }
      if (action !== "list") return fail("`approvals` takes action list, approve or deny.");
      await coord.refreshed();
      const st = coord.view().state;
      if (!st) return fail("Workmesh hasn't heard from the hub yet; try again in a few seconds.");
      if (st.approvals === undefined) return fail("This team's hub has no approvals yet (it predates Workmesh v2).");
      if (st.approvals.length === 0) return { ok: true, text: "No approvals.", data: { approvals: [] } };
      const lines = st.approvals.slice(0, 30).map((ap) => {
        const local = coord.localKey(ap.sessionKey);
        const s0 = local ? deps.getSession(CoordClient.family(local)) : undefined;
        const who = local ? `this machine's ${s0?.name ?? local}` : (ap.owner ?? "a teammate");
        const decided = ap.status === "pending" ? "" : ` by ${ap.by ?? "?"}${ap.note ? `: ${ap.note}` : ""}`;
        return `- ${ap.id} · ${ap.status}${decided} · ${ap.gate} · ${ap.detail} · ${who}`;
      });
      return { ok: true, text: lines.join("\n"), data: { approvals: st.approvals } };
    }

    // --- v3 Memory (SPEC §36) ------------------------------------------------------------

    case "remember":
      if (unavailable) return unavailable;
      return rememberOp(a, ctx);
    case "recall":
      if (unavailable) return unavailable;
      return recallOp(a, ctx);
    case "forget":
      if (unavailable) return unavailable;
      return forgetOp(a, ctx);
    case "memories":
      if (unavailable) return unavailable;
      return memoriesOp(a, ctx);

    // --- Ask (SPEC §29) -----------------------------------------------------------------

    case "ask": {
      const question = scrubText(str(a.question, 16_000), { home, max: HUB_ASK_QUESTION_MAX })?.text;
      if (!question) return fail("`ask` needs `question`: what you want to know about the team's agents, in plain words.");
      const zone = (deps.timeZone ?? localTimeZone)();
      const r = await coord.ask({ question, ...(zone ? { zone } : {}) }, key ? CoordClient.family(key) : "person");
      if (!r.ok) return askNoAnswer(r);
      const named = r.body.sessions
        .slice(0, 12)
        .map((x) => `- ${x.name || x.hubKey} (${x.person}${x.state ? `, ${x.state}` : ""}) [${x.hubKey}]`);
      const text = named.length > 0 ? `${r.body.answer}\n\nSessions it names (\`send\` takes the key):\n${named.join("\n")}` : r.body.answer;
      return { ok: true, text, data: r.body };
    }
  }
}

/**
 * Ask's no, softly (SPEC §29): the hub has no Ask, is rate-limiting, or its model failed. Not a tool error: the agent
 * reads why and carries on without the answer.
 */
function askNoAnswer(r: Extract<CoordResult<unknown>, { ok: false }>): CoordOpResult {
  const wait = r.retryAfterMs !== undefined ? Math.max(1, Math.ceil(r.retryAfterMs / 60_000)) : undefined;
  const again = wait === undefined ? "" : wait >= 60 ? " Don't ask again for an hour or so." : ` Don't ask again for ${wait} min.`;
  // 400 (a question the hub won't read) and 401 (pair again) are the caller's to fix; the rest is the hub saying no.
  const soft = r.status !== 400 && r.status !== 401;
  return {
    ok: soft,
    text: soft ? `No answer from the team board: ${r.error}.${again} Carry on without it, or ask your person.` : `Workmesh: ${r.error}`,
    data: { answered: false, status: r.status, error: r.error, ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}) },
  };
}

/** This machine's IANA time zone, if the runtime knows it. */
function localTimeZone(): string | undefined {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return z && /^[A-Za-z][\w+./-]{0,63}$/.test(z) ? z : undefined;
  } catch {
    return undefined;
  }
}

/** A v2 hub answer that failed. */
function delegateError(r: Extract<CoordResult<unknown>, { ok: false }>): CoordOpResult {
  return fail(r.unavailable ? "This team's hub has no delegation yet (it predates Workmesh v2); nothing was sent." : `Workmesh: ${r.error}`);
}

/** A `to` string → the person the roster names (display name, GitHub login), else the string itself. */
export function personOf(
  to: string,
  st: { roster: ReadonlyArray<{ person: string; github?: string }> } | undefined,
): string | undefined {
  const low = to.toLowerCase();
  for (const p of st?.roster ?? []) {
    if (p.person.toLowerCase() === low || p.github?.toLowerCase() === low) return p.person;
  }
  return to.includes("@") || /^[\w .'-]{1,120}$/.test(to) ? to : undefined;
}

/** A `to` string → the wire recipient, using the roster to tell people from agents and sessions. */
export function recipient(
  to: string,
  kind: string | undefined,
  st: { roster: ReadonlyArray<{ person: string; github?: string; sessions: ReadonlyArray<{ hubKey: string; name: string; state?: string }> }> } | undefined,
): HubMessageTo | { error: string } {
  if (kind === "person") return { person: to };
  if (/^dev_[0-9A-Z]{26}:/.test(to)) return { session: to };
  const low = to.toLowerCase();
  if (kind !== "session" && kind !== "agent") {
    for (const p of st?.roster ?? []) {
      if (p.person.toLowerCase() === low || p.github?.toLowerCase() === low) return { person: p.person };
    }
  }
  const sessions = (st?.roster ?? []).flatMap((p) => p.sessions.map((x) => ({ ...x, person: p.person })));
  // A session's short key (`claude-code:<id>`, or the start of its id), as hooks and transcripts name it.
  const short = /^[\w-]+:([\w-]+)$/.exec(to);
  let hits = short
    ? sessions.filter((x) => {
        const k = x.hubKey.slice(x.hubKey.indexOf(":") + 1).toLowerCase();
        return k === low || (short[1]!.length >= 6 && k.startsWith(low));
      })
    : [];
  // A session's name, as the board and a lease refusal show it.
  if (hits.length === 0) hits = sessions.filter((x) => x.name && x.name.toLowerCase() === low);
  const live = hits.filter((x) => x.state !== "ended");
  if (live.length > 0) hits = live;
  if (hits.length === 1) return { session: hits[0]!.hubKey };
  if (hits.length > 1) {
    const list = hits
      .slice(0, 8)
      .map((x) => `${x.name || "(unnamed)"} (${x.person}${x.state ? `, ${x.state}` : ""}) ${x.hubKey}`)
      .join("; ");
    return { error: `"${to}" matches ${hits.length} sessions: ${list}. Send to one of those keys.` };
  }
  if (kind === "session") {
    const names = sessions.filter((x) => x.state !== "ended" && x.name).slice(0, 10).map((x) => `${x.name} (${x.person})`);
    return {
      error: `No session "${to}" on the team's board${names.length ? `; live sessions: ${names.join(", ")}` : ""}. Give a session's name, its key (claude-code:<id>) or its hub key.`,
    };
  }
  if (kind === "agent") return { agent: to };
  return { person: to };
}

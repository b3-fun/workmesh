import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { HUB_LEASE_TTL_DEFAULT_SEC, HUB_LEASE_TTL_MAX_SEC, HUB_LEASE_TTL_MIN_SEC, normalizeLeasePath } from "@workmesh/protocol";
import type { HubLeaseAccepted, HubMessageTo } from "@workmesh/protocol";
import type { AgentSession } from "@workmesh/core";
import { CoordClient } from "../hub/coord";
import type { CoordResult } from "../hub/coord";
import { scrubText } from "../hub/redact";

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
      const r = await coord.message({
        ...(key ? { from: CoordClient.family(key) } : {}),
        to,
        text,
        ...(str(a.thread, 64) ? { thread: str(a.thread, 64) } : {}),
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
      const tag = str(a.tag, 32);
      const notes = st.notes.filter((n) => !tag || n.tags?.includes(tag));
      if (notes.length === 0) return { ok: true, text: tag ? `No team notes tagged ${tag}.` : "No team notes yet.", data: { notes: [] } };
      const lines = notes.map(
        (n) =>
          `- ${n.by.person}${n.by.sessionName ? ` (${n.by.sessionName})` : ""}, ${mins(coord.hubNow(now) - n.ts)} ago${n.tags?.length ? ` [${n.tags.join(", ")}]` : ""}: ${n.text}`,
      );
      return { ok: true, text: lines.join("\n"), data: { notes } };
    }
  }
}

/** A `to` string → the wire recipient, using the roster to tell people from agents. */
export function recipient(
  to: string,
  kind: string | undefined,
  st: { roster: ReadonlyArray<{ person: string; github?: string; sessions: ReadonlyArray<{ hubKey: string; name: string }> }> } | undefined,
): HubMessageTo {
  if (kind === "person") return { person: to };
  if (kind === "agent") return { agent: to };
  if (kind === "session" || /^dev_[0-9A-Z]{26}:/.test(to)) return { session: to };
  const low = to.toLowerCase();
  for (const p of st?.roster ?? []) {
    if (p.person.toLowerCase() === low || p.github?.toLowerCase() === low) return { person: p.person };
  }
  for (const p of st?.roster ?? []) {
    for (const s of p.sessions) if (s.name && s.name.toLowerCase() === low) return { agent: s.name };
  }
  return { person: to };
}

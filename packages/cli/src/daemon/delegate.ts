import { createHash } from "node:crypto";
import type { AgentSession, SessionEvent } from "@workmesh/core";
import type {
  HubApprovalAccepted,
  HubGateAction,
  HubHandoffAccepted,
  HubSyncAccepted,
} from "@workmesh/protocol";
import { CoordClient, isLocalNotice } from "../hub/coord";
import type { HubSyncInboxItem } from "../hub/coord";
import { gateApprovers, gateOwner, samePerson } from "../lib/person";
import { label, oneLine } from "../lib/untrusted";
import { gateVerb, matchGates } from "./gates";
import type { GateMatch } from "./gates";
import { formatInbox } from "./coord-hooks";
import { AcceptedHere } from "./accepted-here";
import type { AcceptedBy } from "./accepted-here";
import { NOTHING_VISIBLE, handoffHash, handoffStart, readable, runHereQuestion } from "./handoff-text";
import type { HandoffPlan, HandoffStart, RunHereWhy } from "./handoff-text";

/**
 * v2 Delegate, the relay side (docs/SPEC.md §31): approval gates in the hook path, handoffs taken by this person's
 * policy and run on this machine, and waking idle sessions for their messages. Everything fails open: a gate is
 * enforced only while the hub answers v2 and the last sync is fresh, a failed approval request lets the action go
 * ahead, and a waiter that can't reach the daemon simply ends.
 *
 * The daemon's own notices are printed as Workmesh's words. So every name, note, task or error the hub passed on goes
 * through `lib/untrusted.ts` before it is put into one: one line each, and a quoted value cannot end its quote.
 */

/** Shell tools whose command a gate reads (Claude Code `Bash`, Codex's names). */
const SHELL_TOOLS = new Set(["Bash", "shell", "shell_command", "local_shell", "exec_command", "unified_exec", "container.exec"]);
/**
 * An approval lets the exact command it was asked for run once, this long after it was decided (SPEC §31). A denial
 * counts for the same session, gate and detail for `DENIAL_VALID_MS`.
 */
export const APPROVAL_VALID_MS = 30 * 60_000;
export const DENIAL_VALID_MS = 60 * 60_000;
/** A held command is quoted back to its session this long (the wake after a decision). */
const HELD_KEEP_MS = 24 * 60 * 60_000;
/** The longest held command a notice quotes; a longer one is named by its start. */
const QUOTE_MAX = 400;
/** When an approval request fails, the action is let through this long (fail-open). */
const FAIL_OPEN_MS = 10 * 60_000;
/** A device that sent a handoff to its own person waits this long for another of their machines to take it. */
export const SELF_HANDOFF_SENDER_DELAY_MS = 20_000;
/** A long-poll waits at most this long per request (the waiter asks again until its own deadline). */
export const WAIT_POLL_MAX_MS = 55_000;

export type HandoffAcceptPolicy = "ask" | "auto-self" | "never";

export interface DelegateSettings {
  /** Wake idle sessions for messages (default true). */
  wake: boolean;
  /** Who may hand this machine work without a click (default `ask`: nobody). */
  accept: HandoffAcceptPolicy;
  /** A handoff accepted somewhere else: wait for the person's "run it here" (`confirm`, the default), or start it. */
  runAccepted: "confirm" | "auto";
  /** The person's own `custom` gate patterns. */
  customGates: readonly string[];
}

/** Runs accepted handoffs on this machine (daemon/handoff-runner.ts). */
export interface HandoffRunnerLike {
  /** Ids running now (or being started). */
  running(): ReadonlySet<string>;
  /** Room for one more. */
  hasRoom(): boolean;
  /** Why this machine can't run it (no checkout of its repo, no agent CLI), or undefined when it can. */
  cannotRun(h: HubHandoffAccepted): string | undefined;
  /** Start it (the hub already said yes to `start`, or is asked by the runner). Never throws. */
  run(h: HubHandoffAccepted): void;
  /** What accepting it would start here, for the person to read first. Starts nothing. */
  plan?(h: HubHandoffAccepted): HandoffPlan;
}

export interface DelegateDeps {
  coord: () => CoordClient | undefined;
  getSession: (key: string) => AgentSession | undefined;
  isShared: (key: string) => boolean;
  /** owner/name of the shared checkout a directory is in. */
  repoOf: (dir: string) => string | undefined;
  settings: () => DelegateSettings;
  runner?: HandoffRunnerLike;
  /** The handoffs accepted on this machine (absent: a record kept in memory only). */
  accepted?: AcceptedHere;
  /** Deliver a message into an idle Codex thread now; false when it couldn't (next-turn delivery stands). */
  codexWake?: (threadId: string, text: string) => Promise<boolean>;
  now?: () => number;
  log?: (message: string) => void;
}

export interface WaitAnswer {
  /** The message to wake the session with (the waiter exits 2 with it). */
  wake?: string;
  /** Stop waiting (the session ended, another waiter took over, or there is nothing to wait for). */
  end?: boolean;
  reason?: string;
}

interface Waiter {
  key: string;
  resolve: (a: WaitAnswer) => void;
  timer: NodeJS.Timeout;
}

/** What the menu bar shows (GET /team `delegate`). */
export interface DelegateSummary {
  available: boolean;
  /**
   * Handoffs offered to this person (Accept / Decline), ones accepted somewhere else that wait for "run it here"
   * (`runHere` is the question), and ones running here. `task` and `context` are the whole text, cleaned for a
   * person to read. `onAccept` says what an Accept or a "run it here" starts on this machine.
   */
  handoffs: Array<{
    id: string;
    from: string;
    fromSession?: string;
    task: string;
    context?: string;
    onAccept?: HandoffStart;
    runHere?: string;
    repo?: string;
    issue?: string;
    status: HubHandoffAccepted["status"];
    createdAt: number;
    runningHere: boolean;
  }>;
  /** Pending approvals: this machine's agents' asks, and ones this person may decide. */
  approvals: Array<{
    id: string;
    session?: string;
    name?: string;
    gate: HubGateAction;
    detail: string;
    status: HubApprovalAccepted["status"];
    ts: number;
    mine: boolean;
    canDecide: boolean;
  }>;
}

/**
 * Whether a handoff is from this device's own person. It is the one place that decides it, so the compare can change
 * without touching the policy that uses it. The `auto-self` policy accepts on it with no click, so it takes the strict
 * check (`CoordClient.surelyMe`, SPEC §49): once the hub sends this person's email, a sender without one is someone
 * else. With an older hub, the name the hub gives decides.
 */
export function fromMe(h: Pick<HubHandoffAccepted, "from">, coord: CoordClient): boolean {
  return coord.surelyMe(h.from);
}

export class Delegate {
  private readonly deps: DelegateDeps;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly waiters = new Map<string, Waiter>();
  /** Approval asks this daemon made: `<family>|<gate>|<detail>` → the hub's answer (until the next sync lists it). */
  private readonly asked = new Map<string, { approval?: HubApprovalAccepted; at: number; inFlight: boolean }>();
  /** Fail-open allowances after a request that didn't reach the hub: key → until. */
  private readonly allowedUntil = new Map<string, number>();
  /** Approval ids whose decision was told to their session. */
  private readonly toldApprovals = new Set<string>();
  /** The exact command last held for each `<session>|<gate>|<detail>` (quoted in the decision's notice). */
  private readonly held = new Map<string, { command: string; hash: string; at: number }>();
  /** Approval id → the commands it was asked for, by hash (an approval runs one of them, once). */
  private readonly boundTo = new Map<string, Map<string, string>>();
  /** When a renewal (`renew: true`) last went out per key: at most one a minute. */
  private readonly renewAskedAt = new Map<string, number>();
  /** Approval ids that let their one command run, and when. */
  private readonly usedApprovals = new Map<string, number>();
  /** Keys whose next ask must not be answered with a decision already made (the last approval was used). */
  private readonly renewNext = new Set<string>();
  /** Handoff statuses as last seen (`<id>` → status), for "your handoff was accepted" notices. */
  private readonly handoffStatus = new Map<string, string>();
  private seededHandoffs = false;
  /** Self-handoffs this device sent: when it first saw them offered (it waits for another machine first). */
  private readonly selfFirstSeen = new Map<string, number>();
  /** Handoff ids with an accept/decline/start call in flight. */
  private readonly handoffCalls = new Set<string>();
  /** When this device last tried to start each accepted handoff (a failed start is retried a minute later). */
  private readonly startTried = new Map<string, number>();
  /** Handoffs this device was told it can't run (logged once). */
  private readonly cantRunLogged = new Set<string>();
  /** Sessions that ended (SessionEnd, a gone process): their waiters stop. */
  private readonly ended = new Set<string>();
  /** Codex messages handed to `codexWake` (by id), so each is tried once. */
  private readonly codexTried = new Set<string>();
  /** The handoffs accepted on this machine: the only ones it starts. */
  private readonly acceptedHere: AcceptedHere;
  /** Handoffs whose text changed after the accept, as `<id>|<hash now>`: the log says so once per change. */
  private readonly changedLogged = new Set<string>();

  constructor(deps: DelegateDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.acceptedHere = deps.accepted ?? new AcceptedHere();
  }

  private me(coord: CoordClient): string | undefined {
    return coord.me();
  }

  // --- approval gates (hook path: cached state only) ---------------------------------

  /** The gates this device's person turned on, if the hub serves v2 and the last sync is fresh; else none. */
  myGates(coord: CoordClient): { actions: Set<HubGateAction>; approvers: string[] } | undefined {
    const st = coord.view().state;
    if (!st?.gates || coord.view().available !== true || !coord.fresh()) return undefined;
    if (!this.me(coord)) return undefined;
    const policy = st.gates.find((g) => coord.isMe(gateOwner(g)));
    if (!policy || policy.actions.length === 0) return undefined;
    return { actions: new Set(policy.actions), approvers: policy.approvers?.length ? policy.approvers : [policy.owner] };
  }

  /** The gated action this tool call takes, if this person gated it. */
  gatedAction(event: SessionEvent, coord: CoordClient): { match: GateMatch; approvers: string[] } | undefined {
    const d = event.detail;
    if (!d?.tool || !SHELL_TOOLS.has(d.tool) || !d.command) return undefined;
    const gates = this.myGates(coord);
    if (!gates) return undefined;
    const matches = matchGates(d.command, event.cwd, { repoOf: this.deps.repoOf, custom: this.deps.settings().customGates });
    const match = matches.find((m) => gates.actions.has(m.gate));
    return match ? { match, approvers: gates.approvers } : undefined;
  }

  /**
   * PreToolUse: why this call must wait for (or was refused) an approval, or undefined to let it run. Shared
   * top-level sessions and their subagents only (the board can show nothing else). Never a network call: an ask
   * goes out in the background.
   */
  gateRefusal(event: SessionEvent, hook: string | undefined): string | undefined {
    if (hook !== "PreToolUse") return undefined;
    const coord = this.deps.coord();
    if (!coord) return undefined;
    const local = `${event.source}:${event.sessionId}`;
    if (!this.deps.isShared(local)) return undefined;
    const gated = this.gatedAction(event, coord);
    if (!gated) return undefined;
    const { match, approvers } = gated;
    const key = `${local}|${match.gate}|${match.detail}`;
    const now = this.now();
    const until = this.allowedUntil.get(key);
    if (until !== undefined && until > now) return undefined;
    const who = approvers.map((p) => label(p)).join(" or ");
    const command = (event.detail?.command ?? "").trim();
    const hash = commandHash(command);
    const approval = this.latestApproval(coord, local, match);
    const decidedAgo = approval ? now - this.decidedLocal(coord, approval) : Number.POSITIVE_INFINITY;
    if (approval?.status === "approved" && decidedAgo <= APPROVAL_VALID_MS) {
      const bound = this.boundTo.get(approval.id);
      // The approval runs the exact command it was asked for, once. One this daemon didn't see asked (it restarted
      // since) runs whatever matches its gate and detail, once.
      if (!this.usedApprovals.has(approval.id) && (!bound || bound.has(hash))) {
        this.usedApprovals.set(approval.id, now);
        this.trimUsed(now);
        this.held.delete(key);
        this.log(`approval ${approval.id} used for ${local.slice(0, 20)}: ${match.gate}`);
        return undefined;
      }
      // Used already, or approved for another command: this one needs its own approval.
      this.held.set(key, { command, hash, at: now });
      this.renewNext.add(key);
      this.ask(coord, local, match, key, hash, command, true);
      const decider = approval.by ? label(approval.by) : who;
      const why = this.usedApprovals.has(approval.id)
        ? `${decider}'s approval covered one run, and it was used`
        : `${decider} approved a different command (${quoteCommand(this.commandFor(approval.id) ?? match.detail)})`;
      return (
        `Waiting for ${who}'s approval to ${gateVerb(match.gate)} (${match.detail}): ${why}, so Workmesh asked ${who} ` +
        "again on the team board. Don't retry or work around it meanwhile: end your turn or carry on with other work; " +
        "this session is woken with the decision."
      );
    }
    if (approval?.status === "denied" && decidedAgo <= DENIAL_VALID_MS) {
      const by = approval.by ? label(approval.by) : who;
      return (
        `Workmesh: ${by} denied this ${gateVerb(match.gate)} (${match.detail}). Don't run it or work around it. ` +
        `If it should go ahead after all, ask ${by} (\`workmesh send ${quote(by)} "…"\` or the workmesh \`send\` tool).`
      );
    }
    this.held.set(key, { command, hash, at: now });
    if (this.held.size > 2000) for (const [k, h] of this.held) if (now - h.at > HELD_KEEP_MS) this.held.delete(k);
    if (approval?.status === "pending") this.bind(approval.id, hash, command);
    else this.ask(coord, local, match, key, hash, command, this.renewNext.has(key));
    return (
      `Waiting for ${who}'s approval to ${gateVerb(match.gate)} (${match.detail}); Workmesh asked ${who} on the team board. ` +
      "The command is held, not refused. Don't retry or work around it meanwhile: end your turn (or carry on with other " +
      `work) and this session is woken with the decision. An approval from ${who} is their go-ahead for this exact ` +
      "command, once: when it arrives, run the command again exactly as written. Workmesh's gate checks the approval " +
      "itself when the command runs."
    );
  }

  /** An approval may run this command. */
  private bind(id: string, hash: string, command: string): void {
    const m = this.boundTo.get(id) ?? new Map<string, string>();
    m.delete(hash);
    m.set(hash, command);
    this.boundTo.set(id, m);
    if (this.boundTo.size > 2000) this.boundTo.delete(this.boundTo.keys().next().value!);
  }

  /** The command an approval was last asked for, if this daemon asked it. */
  private commandFor(id: string): string | undefined {
    const m = this.boundTo.get(id);
    return m ? [...m.values()].at(-1) : undefined;
  }

  private trimUsed(now: number): void {
    if (this.usedApprovals.size < 2000) return;
    for (const [id, at] of this.usedApprovals) if (now - at > DENIAL_VALID_MS) this.usedApprovals.delete(id);
  }

  /**
   * The newest approval for this session, gate and detail: the last sync's, else this daemon's own ask (until a sync
   * made after the ask lists it; an ask the hub then doesn't list is forgotten, so the next attempt asks again).
   */
  private latestApproval(coord: CoordClient, local: string, match: GateMatch): HubApprovalAccepted | undefined {
    const hubKey = coord.hubKey(local);
    const key = `${local}|${match.gate}|${match.detail}`;
    const byId = new Map<string, HubApprovalAccepted>();
    const view = coord.view();
    const entry = this.asked.get(key);
    if (entry?.approval) {
      const listed = (view.state?.approvals ?? []).some((a) => a.id === entry.approval!.id);
      const syncedSince = view.fetchedAt !== undefined && view.fetchedAt > entry.at + 2000;
      if (listed || !syncedSince) byId.set(entry.approval.id, entry.approval);
      else if (!entry.inFlight) this.asked.delete(key);
    }
    for (const a of view.state?.approvals ?? []) {
      if (a.gate !== match.gate || a.detail !== match.detail) continue;
      if (CoordClient.family(a.sessionKey) !== hubKey && a.sessionKey !== local) continue;
      byId.set(a.id, a); // the hub's word wins over this daemon's copy
    }
    let best: HubApprovalAccepted | undefined;
    for (const a of byId.values()) if (!best || a.ts > best.ts) best = a;
    return best;
  }

  /** When an approval was decided, on this machine's clock. */
  private decidedLocal(coord: CoordClient, a: HubApprovalAccepted): number {
    return (a.decidedAt ?? a.ts) - coord.hubNow(0);
  }

  private ask(coord: CoordClient, local: string, match: GateMatch, key: string, hash: string, command: string, renew = false): void {
    const prev = this.asked.get(key);
    if (prev?.inFlight) return;
    if (renew) {
      // A renewal (the last approval was used, or was for another command): at most one a minute.
      const last = this.renewAskedAt.get(key);
      if (last !== undefined && this.now() - last < 60_000) return;
      this.renewAskedAt.set(key, this.now());
      if (this.renewAskedAt.size > 2000) this.renewAskedAt.delete(this.renewAskedAt.keys().next().value!);
    } else if (prev && this.now() - prev.at < 60_000 && prev.approval) {
      // One ask per minute per action: a hub that is slow to list it doesn't get a request per retry.
      return;
    }
    this.asked.set(key, { at: this.now(), inFlight: true, approval: prev?.approval });
    void coord
      .approval({ action: "request", sessionKey: local, gate: match.gate, detail: match.detail, ...(renew ? { renew: true as const } : {}) })
      .then((r) => {
        const entry = this.asked.get(key);
        if (r.ok && r.body.ok) {
          const a = r.body.approval;
          this.asked.set(key, { at: this.now(), inFlight: false, approval: a });
          // An older hub ignores `renew` and may answer with the decision just used: that one stays used.
          if (!this.usedApprovals.has(a.id)) {
            this.bind(a.id, hash, command);
            this.renewNext.delete(key);
          }
          this.log(`approval asked for ${local.slice(0, 20)}: ${match.gate} (${a.status})`);
          if (a.status !== "pending" && !this.usedApprovals.has(a.id)) this.tellDecision(coord, a, local, match.gate);
          return;
        }
        // Fail open: the action goes ahead, and the agent is told so.
        const why = oneLine(r.ok ? (r.body.ok ? "" : r.body.error) : r.error, 300);
        if (entry) entry.inFlight = false;
        this.asked.delete(key);
        this.allowedUntil.set(key, this.now() + FAIL_OPEN_MS);
        this.log(`approval ask failed (${why || "no answer"}); letting ${match.gate} through for ${local.slice(0, 20)}`);
        coord.notify(
          local,
          `Workmesh couldn't ask for approval to ${gateVerb(match.gate)} (${match.detail}): ${why || "the hub didn't answer"}. ` +
            "Approval gates fail open, so it may go ahead: run it again if it is still what you mean to do.",
          { wake: true },
        );
        this.check();
      })
      .catch(() => {
        this.asked.delete(key);
        this.allowedUntil.set(key, this.now() + FAIL_OPEN_MS);
      });
  }

  /** An approval was decided: tell the session that asked (it wakes if idle), quoting the command it held. */
  private tellDecision(coord: CoordClient, a: HubApprovalAccepted, local: string, gate: HubGateAction): void {
    if (this.toldApprovals.has(a.id)) return;
    this.toldApprovals.add(a.id);
    if (this.toldApprovals.size > 2000) this.toldApprovals.clear();
    const command = this.held.get(`${local}|${gate}|${a.detail}`)?.command ?? this.commandFor(a.id);
    coord.notify(local, decisionText(a, gate, command, coord.me(), coord.self().email), { wake: true, from: a.by ? label(a.by) : "Workmesh" });
    this.check();
  }

  // --- sync: approvals decided, handoffs to take -------------------------------------

  /** After each good sync (CoordClient `onSync`). */
  onSync(next: HubSyncAccepted, previous: HubSyncAccepted | undefined): void {
    const coord = this.deps.coord();
    if (!coord) return;
    // Approvals this device's sessions asked for that a person decided.
    const before = new Map((previous?.approvals ?? []).map((a) => [a.id, a.status]));
    for (const a of next.approvals ?? []) {
      if (a.status === "pending") continue;
      const local = coord.localKey(a.sessionKey) ?? (a.sessionKey.includes(":") && !a.sessionKey.startsWith("dev_") ? a.sessionKey : undefined);
      if (!local) continue;
      const askedHere = [...this.asked.values()].some((e) => e.approval?.id === a.id);
      if (before.get(a.id) === "pending" || askedHere) this.tellDecision(coord, a, CoordClient.family(local), a.gate);
    }
    this.onHandoffs(coord, next.handoffs ?? []);
    // An id leaves the record once the hub stops listing its handoff. A hub without v2 sends no list: nothing to go by.
    if (next.handoffs !== undefined) this.acceptedHere.prune(new Set(next.handoffs.map((h) => h.id)));
    this.check();
  }

  private onHandoffs(coord: CoordClient, list: readonly HubHandoffAccepted[]): void {
    const settings = this.deps.settings();
    const seed = !this.seededHandoffs;
    this.seededHandoffs = true;
    for (const h of list) {
      const prev = this.handoffStatus.get(h.id);
      this.handoffStatus.set(h.id, h.status);
      const fromLocal = h.from.sessionKey ? coord.localKey(h.from.sessionKey) : undefined;
      // A handoff a session here sent: tell it how it went (not for what was already so when the daemon started).
      if (fromLocal && !seed && prev !== undefined && prev !== h.status) this.tellSender(coord, h, CoordClient.family(fromLocal));
      if (!coord.isMe(h.to)) continue;
      if (h.status === "offered") this.maybeAutoAccept(coord, h, settings.accept, fromLocal !== undefined);
      else if (h.status === "accepted") this.maybeStart(coord, h, settings.accept);
    }
    if (this.handoffStatus.size > 2000) {
      const keep = new Set(list.map((h) => h.id));
      for (const id of this.handoffStatus.keys()) if (!keep.has(id)) this.handoffStatus.delete(id);
    }
  }

  private tellSender(coord: CoordClient, h: HubHandoffAccepted, local: string): void {
    const who = label(h.to.person);
    // The task sits in quotes, so it is a label (no quote in it ends them); the note is the other side's words.
    const task = label(h.task, 120);
    let text: string | undefined;
    let wake = false;
    switch (h.status) {
      case "accepted":
        text = `Workmesh: ${who} accepted your handoff "${task}".`;
        break;
      case "declined":
        text = `Workmesh: ${who} declined your handoff "${task}".`;
        wake = true;
        break;
      case "started":
        text = `Workmesh: ${who}'s machine started an agent for your handoff "${task}".`;
        break;
      case "done":
        text = `Workmesh: your handoff to ${who} is done ("${task}").`;
        wake = true;
        break;
      case "failed":
        text = `Workmesh: your handoff to ${who} failed ("${task}").`;
        wake = true;
        break;
      default:
        break;
    }
    if (text) coord.notify(local, text, { wake, from: who });
  }

  private maybeAutoAccept(coord: CoordClient, h: HubHandoffAccepted, policy: HandoffAcceptPolicy, sentHere: boolean): void {
    if (policy !== "auto-self" || !this.deps.runner) return;
    if (!fromMe(h, coord)) return;
    if (this.handoffCalls.has(h.id) || this.deps.runner.cannotRun(h)) return;
    if (!this.deps.runner.hasRoom()) return;
    if (sentHere) {
      // Sent from this machine: give the person's other machines a head start ("another of your machines").
      const first = this.selfFirstSeen.get(h.id) ?? this.now();
      this.selfFirstSeen.set(h.id, first);
      if (this.selfFirstSeen.size > 1000) this.selfFirstSeen.clear();
      if (this.now() - first < SELF_HANDOFF_SENDER_DELAY_MS) return;
    }
    this.handoffCalls.add(h.id);
    void coord
      .handoff({ action: "accept", id: h.id })
      .then((r) => {
        if (r.ok && r.body.ok) {
          this.log(`handoff ${h.id}: accepted by policy (auto-self)`);
          // The policy accepted the text this machine was listing: that is what the record covers.
          this.acceptedHere.add(h.id, "policy", this.now(), handoffHash(h));
          if (r.body.handoff.status === "accepted") this.maybeStart(coord, r.body.handoff, policy, true);
        }
      })
      .finally(() => this.handoffCalls.delete(h.id));
  }

  private maybeStart(coord: CoordClient, h: HubHandoffAccepted, policy: HandoffAcceptPolicy, force = false): void {
    const runner = this.deps.runner;
    if (!runner || policy === "never") return;
    if (h.device && h.device !== coord.deviceId) return;
    // The hub's word is not enough: this machine starts only what was accepted on it, unless its person chose `auto`.
    // And it starts the text that was accepted: one the hub lists with other text waits for a new yes.
    if (this.deps.settings().runAccepted !== "auto") {
      const entry = this.acceptedHere.get(h.id);
      if (!entry) return;
      if (entry.hash !== undefined && entry.hash !== handoffHash(h)) {
        this.logChanged(h);
        return;
      }
    }
    if (runner.running().has(h.id) || (!force && this.handoffCalls.has(h.id))) return;
    const why = runner.cannotRun(h);
    if (why) {
      if (!this.cantRunLogged.has(h.id)) {
        this.cantRunLogged.add(h.id);
        this.log(`handoff ${h.id}: not running it here (${why})`);
        // Accepted for this very machine and it can't: say so on the hub rather than leave it hanging.
        if (h.device === coord.deviceId) void coord.handoff({ action: "fail", id: h.id, note: `Couldn't start on this machine: ${why}`.slice(0, 500) });
      }
      return;
    }
    if (!runner.hasRoom()) return;
    const tried = this.startTried.get(h.id);
    if (!force && tried !== undefined && this.now() - tried < 60_000) return;
    this.startTried.set(h.id, this.now());
    if (this.startTried.size > 1000) this.startTried.clear();
    runner.run(h);
  }

  // --- the person's handoff moves (MCP, CLI, menu bar) ------------------------------

  /**
   * The person accepted a handoff on this machine, at its terminal or in its menu bar: the record says so, and it
   * starts here now, rather than at the next sync. `seen` is the handoff as this machine listed it when they
   * accepted, which is the text they read. The record covers that text: if the hub answered the accept with other
   * text (`h`), nothing starts.
   */
  accepted(h: HubHandoffAccepted, by: AcceptedBy = "cli", seen: HubHandoffAccepted = h): void {
    const coord = this.deps.coord();
    if (!coord || h.status !== "accepted") return;
    this.acceptedHere.add(h.id, by, this.now(), handoffHash(seen));
    this.maybeStart(coord, h, this.deps.settings().accept === "never" ? "ask" : this.deps.settings().accept, true);
  }

  /**
   * Why an accepted handoff waits for this person's "run it here", or undefined when it doesn't. It waits when it
   * was accepted somewhere else: on the board, or so the hub says while this machine has no record of it. It waits
   * again when it was accepted here and the hub now lists it with other text. It may run on this machine, and
   * nothing runs it yet.
   */
  runHereWhy(h: HubHandoffAccepted): RunHereWhy | undefined {
    const coord = this.deps.coord();
    const runner = this.deps.runner;
    if (!coord || !runner || h.status !== "accepted") return undefined;
    const settings = this.deps.settings();
    if (settings.accept === "never" || settings.runAccepted === "auto") return undefined;
    if (!coord.isMe(h.to)) return undefined;
    if (h.device && h.device !== coord.deviceId) return undefined;
    if (runner.running().has(h.id)) return undefined;
    const entry = this.acceptedHere.get(h.id);
    if (!entry) return h.device ? "no-record" : "board";
    return entry.hash !== undefined && entry.hash !== handoffHash(h) ? "changed" : undefined;
  }

  waitsToRunHere(h: HubHandoffAccepted): boolean {
    return this.runHereWhy(h) !== undefined;
  }

  /** The question the list shows for a handoff that waits for "run it here", or undefined when it doesn't wait. */
  runHereAsk(h: HubHandoffAccepted): string | undefined {
    const why = this.runHereWhy(h);
    return why ? runHereQuestion(why) : undefined;
  }

  /**
   * The person said "run it here" for a handoff that waits (`runHereWhy`). The record now covers the text this
   * machine lists, which is the text they just read, and it starts.
   */
  runHere(h: HubHandoffAccepted, by: AcceptedBy = "cli"): void {
    const coord = this.deps.coord();
    if (!coord || !this.waitsToRunHere(h)) return;
    this.acceptedHere.add(h.id, by, this.now(), handoffHash(h));
    this.maybeStart(coord, h, this.deps.settings().accept, true);
  }

  /** Says once, per change, that a handoff accepted here is now listed with other text. */
  private logChanged(h: HubHandoffAccepted): void {
    const key = `${h.id}|${handoffHash(h)}`;
    if (this.changedLogged.has(key)) return;
    this.changedLogged.add(key);
    if (this.changedLogged.size > 1000) this.changedLogged.clear();
    this.log(`handoff ${h.id}: its text changed after it was accepted on this machine; not starting it (it waits for "run it here")`);
  }

  /** Handoffs the sync lists for this person: offered to them, sent by them, running here. */
  handoffs(): HubHandoffAccepted[] {
    return this.deps.coord()?.view().state?.handoffs ?? [];
  }

  /**
   * What this person's Accept starts on this machine: the agent, its permission mode and where, in one line they read
   * before they accept. Undefined when this daemon has no runner.
   */
  onAccept(h: HubHandoffAccepted, lead?: string): HandoffStart | undefined {
    const plan = this.deps.runner?.plan?.(h);
    return plan ? handoffStart(plan, h, lead) : undefined;
  }

  // --- wake ------------------------------------------------------------------------

  /** A session event the daemon applied: an `end` stops its waiter; anything may make a message deliverable. */
  observe(event: SessionEvent): void {
    const key = `${event.source}:${event.sessionId}`;
    if (event.kind === "end") {
      this.ended.add(key);
      if (this.ended.size > 5000) this.ended.clear();
    } else {
      this.ended.delete(key);
    }
    if (this.waiters.size > 0 || event.source === "codex") this.check();
  }

  /** A session the daemon dropped because its process is gone. */
  sessionGone(key: string): void {
    this.ended.add(key);
    this.check();
  }

  /**
   * A waiter (the asyncRewake Stop hook, SPEC §31) asks to be woken with this session's next message. Resolves with
   * a message, an `end`, or `{}` after `timeoutMs` (the waiter asks again).
   */
  wait(key: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitAnswer> {
    const coord = this.deps.coord();
    if (!this.deps.settings().wake) return Promise.resolve({ end: true, reason: "wake is off (`workmesh wake on`)" });
    if (!coord || coord.view().available !== true) return Promise.resolve({ end: true, reason: "no coordination on this hub" });
    if (this.ended.has(key)) return Promise.resolve({ end: true, reason: "session ended" });
    if (!this.deps.isShared(key) && coord.pendingFor(key).length === 0) {
      return Promise.resolve({ end: true, reason: "session not shared" });
    }
    const old = this.waiters.get(key);
    if (old) {
      clearTimeout(old.timer);
      this.waiters.delete(key);
      old.resolve({ end: true, reason: "superseded" });
    }
    if (signal?.aborted) return Promise.resolve({ end: true, reason: "gone" });
    return new Promise<WaitAnswer>((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiters.get(key)?.timer === timer) this.waiters.delete(key);
        resolve({});
      }, Math.max(1000, Math.min(WAIT_POLL_MAX_MS, timeoutMs)));
      timer.unref?.();
      const w: Waiter = { key, resolve, timer };
      this.waiters.set(key, w);
      signal?.addEventListener("abort", () => this.release(w, { end: true, reason: "gone" }), { once: true });
      this.check();
    });
  }

  /** Hands waiting messages to idle sessions' waiters (and Codex threads). Cheap: a few maps. */
  check(): void {
    const coord = this.deps.coord();
    if (!coord) return;
    for (const w of [...this.waiters.values()]) {
      if (this.ended.has(w.key)) {
        this.release(w, { end: true, reason: "session ended" });
        continue;
      }
      const s = this.deps.getSession(w.key);
      // Working: messages reach it at its next tool boundary; the next Stop arms a new waiter.
      if (s?.state === "working") continue;
      const items = coord.wakeFor(w.key);
      if (items.length === 0) continue;
      const text = wakeText(items);
      if (!text) continue;
      coord.markDelivered(text.items.map((i) => i.id));
      this.log(`woke ${w.key.slice(0, 24)} for ${text.items.length} message${text.items.length === 1 ? "" : "s"}`);
      this.release(w, { wake: text.text });
    }
    if (this.deps.codexWake && this.deps.settings().wake) this.wakeCodex(coord);
  }

  private release(w: Waiter, answer: WaitAnswer): void {
    clearTimeout(w.timer);
    if (this.waiters.get(w.key) === w) this.waiters.delete(w.key);
    w.resolve(answer);
  }

  /** Idle Codex threads with a waking message: deliver through Codex itself (verified mechanism in codex-wake.ts). */
  private wakeCodex(coord: CoordClient): void {
    const wake = this.deps.codexWake;
    if (!wake) return;
    for (const key of coord.sessionsWithPending()) {
      if (!key.startsWith("codex:") || key.includes("/")) continue;
      const s = this.deps.getSession(key);
      if (!s || s.state === "working" || this.ended.has(key)) continue;
      const items = coord.wakeFor(key).filter((i) => !this.codexTried.has(i.id));
      if (items.length === 0) continue;
      const text = wakeText(items);
      if (!text) continue;
      for (const i of text.items) this.codexTried.add(i.id);
      if (this.codexTried.size > 2000) this.codexTried.clear();
      const threadId = key.slice("codex:".length);
      void wake(threadId, text.text)
        .then((ok) => {
          if (ok) {
            coord.markDelivered(text.items.map((i) => i.id));
            this.log(`woke codex ${threadId.slice(0, 8)} for ${text.items.length} message${text.items.length === 1 ? "" : "s"}`);
          }
        })
        .catch(() => {});
    }
  }

  /** Waiters armed now (for /hub and doctor). */
  waiting(): number {
    return this.waiters.size;
  }

  // --- menu bar --------------------------------------------------------------------

  summary(nameOf: (local: string) => string | undefined): DelegateSummary | undefined {
    const coord = this.deps.coord();
    if (!coord) return undefined;
    const st = coord.view().state;
    const running = this.deps.runner?.running() ?? new Set<string>();
    const handoffs: DelegateSummary["handoffs"] = [];
    for (const h of st?.handoffs ?? []) {
      const offeredToMe = coord.isMe(h.to) && h.status === "offered";
      const here = running.has(h.id);
      const why = here ? undefined : this.runHereWhy(h);
      const waits = why !== undefined;
      if (!offeredToMe && !here && !waits) continue;
      // The whole task and context, so the person can read all of it before Accept. Cleaning never adds a
      // character, so both stay within the protocol's limit.
      const context = readable(h.context);
      const onAccept = (offeredToMe && !here) || waits ? this.onAccept(h) : undefined;
      handoffs.push({
        id: h.id,
        from: oneLine(h.from.person, 120),
        fromSession: h.from.sessionName === undefined ? undefined : oneLine(h.from.sessionName, 120),
        task: readable(h.task) ?? NOTHING_VISIBLE,
        ...(context === undefined ? {} : { context }),
        ...(onAccept ? { onAccept } : {}),
        ...(why ? { runHere: runHereQuestion(why, true) } : {}),
        repo: h.repo,
        issue: h.issue,
        status: h.status,
        createdAt: h.createdAt,
        runningHere: here,
      });
    }
    const approvals: DelegateSummary["approvals"] = [];
    const myGates = st?.gates?.find((g) => coord.isMe(gateOwner(g)));
    for (const a of st?.approvals ?? []) {
      if (a.status !== "pending") continue;
      const local = coord.localKey(a.sessionKey);
      const owner = { person: a.owner, email: a.ownerEmail };
      const policy = a.owner ? st?.gates?.find((g) => samePerson(gateOwner(g), owner)) : myGates;
      const canDecide = policy !== undefined && gateApprovers(policy).some((p) => coord.isMe(p));
      if (local === undefined && !canDecide) continue;
      approvals.push({
        id: a.id,
        session: local,
        name: local ? nameOf(CoordClient.family(local)) : undefined,
        gate: a.gate,
        detail: a.detail,
        status: a.status,
        ts: a.ts,
        mine: local !== undefined,
        canDecide,
      });
    }
    return { available: coord.delegateAvailable(), handoffs, approvals };
  }
}

function quote(s: string): string {
  return /^[\w.@-]+$/.test(s) ? s : JSON.stringify(s);
}

/**
 * The text an idle session wakes with: teammates' messages as marked blocks under §23's heading, plus the daemon's own
 * notices. Its first line says what a wake for a teammate's message allows: a reply, and nothing more.
 */
export function wakeText(items: readonly HubSyncInboxItem[]): { text: string; items: HubSyncInboxItem[] } | undefined {
  const block = formatInbox(items, 9000);
  if (!block) return undefined;
  const teammates = block.items.some((i) => !isLocalNotice(i.id) && i.release !== "own");
  const head = teammates
    ? "Workmesh woke this idle session to read a message. Wait for your person's authorization before taking action."
    : block.items.some((i) => i.release === "own")
      ? "Workmesh delivered a message from your account."
      : "Workmesh woke this idle session with news about its own earlier work:";
  return { text: `${head}\n\n${block.text}`, items: block.items };
}

/** A held command's identity: its words with runs of whitespace made one space. */
export function commandHash(command: string): string {
  return createHash("sha256").update(command.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 32);
}

/** A command as a notice quotes it: inline code, cut at QUOTE_MAX. */
function quoteCommand(command: string): string {
  const one = command.trim();
  const cut = one.length > QUOTE_MAX ? `${one.slice(0, QUOTE_MAX - 1)}…` : one;
  return `\`${cut.replace(/`/g, "'")}\``;
}

/**
 * The notice a decision wakes its session with (SPEC §31): who decided, as whom, and the exact command it covers. An
 * approval from the person (or an approver they named) is their go-ahead for that command, once.
 */
export function decisionText(
  a: HubApprovalAccepted,
  gate: HubGateAction,
  command: string | undefined,
  me: string | undefined,
  myEmail?: string,
): string {
  // Names, the detail and the note come from the hub: one line each, so the notice stays Workmesh's own sentence.
  const by = (a.by ? label(a.by) : "") || "Your teammate";
  const mine = a.by !== undefined && samePerson({ person: me, email: myEmail }, { person: a.by, email: a.byEmail });
  const person = me === undefined ? undefined : label(me);
  const who = mine ? `Your person, ${by},` : person ? `${by}, whom your person ${person} named to answer their approvals,` : by;
  const detail = oneLine(a.detail, 500);
  const what = command ? `this session's held command ${quoteCommand(command)}` : `${gateVerb(gate)} ${detail}`;
  const where = decisionPlace(a.via);
  if (a.status === "approved") {
    return (
      `Workmesh: ${who} approved ${what}${where} (${gateVerb(gate)}: ${detail}). ` +
      `That is ${mine ? "their" : `${person ?? by}'s`} consent for exactly this command, once, in the next ${Math.round(APPROVAL_VALID_MS / 60_000)} ` +
      "minutes: run it now as written, with no need to ask again in the terminal. Workmesh's gate checks the " +
      "approval itself when the command runs and holds it again if it isn't approved."
    );
  }
  return `Workmesh: ${who} denied ${what}${where} (${gateVerb(gate)}: ${detail}). Don't run it; ask ${by} if it should go ahead after all.`;
}

/**
 * Where the person decided (SPEC §30, 0.12.1), as the notice says it: " on the team board", " in their Workmesh menu
 * bar", " in their terminal". Nothing when the hub or the deciding relay predates `via`: a notice never names a place
 * it doesn't know (0.12.0 said "on the team board" for every decision, a CLI one too).
 */
export function decisionPlace(via: HubApprovalAccepted["via"]): string {
  switch (via) {
    case "board":
      return " on the team board";
    case "menubar":
      return " in their Workmesh menu bar";
    case "cli":
      return " in their terminal";
    default:
      return "";
  }
}

import type { AgentSession, SessionEvent } from "@workmesh/core";
import type {
  HubApprovalAccepted,
  HubGateAction,
  HubHandoffAccepted,
  HubSyncAccepted,
} from "@workmesh/protocol";
import { CoordClient } from "../hub/coord";
import type { HubSyncInboxItem } from "../hub/coord";
import { gateVerb, matchGates } from "./gates";
import type { GateMatch } from "./gates";
import { formatInbox } from "./coord-hooks";

/**
 * v2 Delegate, the relay side (docs/SPEC.md §31): approval gates in the hook path, handoffs taken by this person's
 * policy and run on this machine, and waking idle sessions for their messages. Everything fails open: a gate is
 * enforced only while the hub answers v2 and the last sync is fresh, a failed approval request lets the action go
 * ahead, and a waiter that can't reach the daemon simply ends.
 */

/** Shell tools whose command a gate reads (Claude Code `Bash`, Codex's names). */
const SHELL_TOOLS = new Set(["Bash", "shell", "shell_command", "local_shell", "exec_command", "unified_exec", "container.exec"]);
/** An approval (or a denial) counts for the same session, gate and detail this long after it was decided. */
export const APPROVAL_VALID_MS = 60 * 60_000;
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
  /** Who may hand this machine work without a click (default `auto-self`). */
  accept: HandoffAcceptPolicy;
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
}

export interface DelegateDeps {
  coord: () => CoordClient | undefined;
  getSession: (key: string) => AgentSession | undefined;
  isShared: (key: string) => boolean;
  /** owner/name of the shared checkout a directory is in. */
  repoOf: (dir: string) => string | undefined;
  settings: () => DelegateSettings;
  runner?: HandoffRunnerLike;
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
  /** Handoffs offered to this person (Accept / Decline), and ones running here. */
  handoffs: Array<{
    id: string;
    from: string;
    fromSession?: string;
    task: string;
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

const lower = (s: string | undefined): string | undefined => s?.toLowerCase();

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

  constructor(deps: DelegateDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  private me(coord: CoordClient): string | undefined {
    return coord.me();
  }

  // --- approval gates (hook path: cached state only) ---------------------------------

  /** The gates this device's person turned on, if the hub serves v2 and the last sync is fresh; else none. */
  myGates(coord: CoordClient): { actions: Set<HubGateAction>; approvers: string[] } | undefined {
    const st = coord.view().state;
    if (!st?.gates || coord.view().available !== true || !coord.fresh()) return undefined;
    const me = lower(this.me(coord));
    if (!me) return undefined;
    const policy = st.gates.find((g) => g.owner.toLowerCase() === me);
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
    const who = approvers.join(" or ");
    const approval = this.latestApproval(coord, local, match);
    if (approval?.status === "approved" && now - this.decidedLocal(coord, approval) <= APPROVAL_VALID_MS) return undefined;
    if (approval?.status === "denied" && now - this.decidedLocal(coord, approval) <= APPROVAL_VALID_MS) {
      const by = approval.by ?? who;
      const why = approval.note ? `: ${approval.note}` : ".";
      return (
        `Workmesh: ${by} denied this ${gateVerb(match.gate)} (${match.detail})${why} Don't run it or work around it. ` +
        `If it should go ahead after all, ask ${by} (\`workmesh send ${quote(by)} "…"\` or the workmesh \`send\` tool).`
      );
    }
    if (!approval || approval.status !== "pending") this.ask(coord, local, match, key);
    return (
      `Waiting for ${who}'s approval to ${gateVerb(match.gate)} (${match.detail}); you'll get a message when it's decided. ` +
      `Workmesh asked ${who} on the team board. The command is held, not refused: the request to run it stands. Don't ` +
      "retry or work around it meanwhile: carry on with other work, or end your turn and wait. When the approval " +
      "arrives, run the same command again; you don't need to verify the message, because Workmesh checks the approval " +
      "again when you run it and holds the command if it isn't approved."
    );
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

  private ask(coord: CoordClient, local: string, match: GateMatch, key: string): void {
    const prev = this.asked.get(key);
    if (prev?.inFlight) return;
    // One ask per minute per action: a hub that is slow to list it doesn't get a request per retry.
    if (prev && this.now() - prev.at < 60_000 && prev.approval) return;
    this.asked.set(key, { at: this.now(), inFlight: true, approval: prev?.approval });
    void coord
      .approval({ action: "request", sessionKey: local, gate: match.gate, detail: match.detail })
      .then((r) => {
        const entry = this.asked.get(key);
        if (r.ok && r.body.ok) {
          this.asked.set(key, { at: this.now(), inFlight: false, approval: r.body.approval });
          this.log(`approval asked for ${local.slice(0, 20)}: ${match.gate} (${r.body.approval.status})`);
          if (r.body.approval.status !== "pending") this.tellDecision(coord, r.body.approval, local, match.gate);
          return;
        }
        // Fail open: the action goes ahead, and the agent is told so.
        const why = r.ok ? (r.body.ok ? "" : r.body.error) : r.error;
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

  /** An approval was decided: tell the session that asked (it wakes if idle). */
  private tellDecision(coord: CoordClient, a: HubApprovalAccepted, local: string, gate: HubGateAction): void {
    if (this.toldApprovals.has(a.id)) return;
    this.toldApprovals.add(a.id);
    if (this.toldApprovals.size > 2000) this.toldApprovals.clear();
    const by = a.by ?? "Your teammate";
    const mine = coord.me()?.toLowerCase() === a.by?.toLowerCase();
    const who = mine ? `Your person, ${by},` : by;
    const text =
      a.status === "approved"
        ? `Workmesh: ${who} approved this on the team board: ${gateVerb(gate)} ${a.detail}${a.note ? ` (${a.note})` : ""}. ` +
          `That is ${mine ? "their" : `${by}'s`} go-ahead for exactly this, through the approval gate that held it: run the ` +
          "same command again now (the approval holds for an hour). You don't need to verify this message: the gate checks " +
          "the approval itself when you run it, and holds the command again if it isn't approved."
        : `Workmesh: ${who} denied this on the team board: ${gateVerb(gate)} ${a.detail}${a.note ? `: ${a.note}` : ""}. Don't run it; ask ${by} if it should go ahead after all.`;
    coord.notify(local, text, { wake: true, from: by });
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
    this.check();
  }

  private onHandoffs(coord: CoordClient, list: readonly HubHandoffAccepted[]): void {
    const me = lower(this.me(coord));
    const settings = this.deps.settings();
    const seed = !this.seededHandoffs;
    this.seededHandoffs = true;
    for (const h of list) {
      const prev = this.handoffStatus.get(h.id);
      this.handoffStatus.set(h.id, h.status);
      const fromLocal = h.from.sessionKey ? coord.localKey(h.from.sessionKey) : undefined;
      // A handoff a session here sent: tell it how it went (not for what was already so when the daemon started).
      if (fromLocal && !seed && prev !== undefined && prev !== h.status) this.tellSender(coord, h, CoordClient.family(fromLocal));
      if (!me || h.to.person.toLowerCase() !== me) continue;
      if (h.status === "offered") this.maybeAutoAccept(coord, h, settings.accept, fromLocal !== undefined);
      else if (h.status === "accepted") this.maybeStart(coord, h, settings.accept);
    }
    if (this.handoffStatus.size > 2000) {
      const keep = new Set(list.map((h) => h.id));
      for (const id of this.handoffStatus.keys()) if (!keep.has(id)) this.handoffStatus.delete(id);
    }
  }

  private tellSender(coord: CoordClient, h: HubHandoffAccepted, local: string): void {
    const who = h.to.person;
    const task = h.task.length > 120 ? `${h.task.slice(0, 117)}…` : h.task;
    const note = h.note ? `: ${h.note}` : ".";
    let text: string | undefined;
    let wake = false;
    switch (h.status) {
      case "accepted":
        text = `Workmesh: ${who} accepted your handoff "${task}".`;
        break;
      case "declined":
        text = `Workmesh: ${who} declined your handoff "${task}"${note}`;
        wake = true;
        break;
      case "started":
        text = `Workmesh: ${who}'s machine started an agent for your handoff "${task}".`;
        break;
      case "done":
        text = `Workmesh: your handoff to ${who} is done ("${task}")${note}`;
        wake = true;
        break;
      case "failed":
        text = `Workmesh: your handoff to ${who} failed ("${task}")${note}`;
        wake = true;
        break;
      default:
        break;
    }
    if (text) coord.notify(local, text, { wake, from: who });
  }

  private maybeAutoAccept(coord: CoordClient, h: HubHandoffAccepted, policy: HandoffAcceptPolicy, sentHere: boolean): void {
    if (policy !== "auto-self" || !this.deps.runner) return;
    const me = lower(this.me(coord));
    if (!me || h.from.person.toLowerCase() !== me) return;
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
          if (r.body.handoff.status === "accepted") this.maybeStart(coord, r.body.handoff, policy, true);
        }
      })
      .finally(() => this.handoffCalls.delete(h.id));
  }

  private maybeStart(coord: CoordClient, h: HubHandoffAccepted, policy: HandoffAcceptPolicy, force = false): void {
    const runner = this.deps.runner;
    if (!runner || policy === "never") return;
    if (h.device && h.device !== coord.deviceId) return;
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

  /** The person accepted a handoff from this machine: start it here now, rather than at the next sync. */
  accepted(h: HubHandoffAccepted): void {
    const coord = this.deps.coord();
    if (!coord || h.status !== "accepted") return;
    this.maybeStart(coord, h, this.deps.settings().accept === "never" ? "ask" : this.deps.settings().accept, true);
  }

  /** Handoffs the sync lists for this person: offered to them, sent by them, running here. */
  handoffs(): HubHandoffAccepted[] {
    return this.deps.coord()?.view().state?.handoffs ?? [];
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
    const me = lower(this.me(coord));
    const running = this.deps.runner?.running() ?? new Set<string>();
    const handoffs: DelegateSummary["handoffs"] = [];
    for (const h of st?.handoffs ?? []) {
      const offeredToMe = me !== undefined && h.to.person.toLowerCase() === me && h.status === "offered";
      const here = running.has(h.id);
      if (!offeredToMe && !here) continue;
      handoffs.push({
        id: h.id,
        from: h.from.person,
        fromSession: h.from.sessionName,
        task: h.task.slice(0, 500),
        repo: h.repo,
        issue: h.issue,
        status: h.status,
        createdAt: h.createdAt,
        runningHere: here,
      });
    }
    const approvals: DelegateSummary["approvals"] = [];
    const myGates = st?.gates?.find((g) => me !== undefined && g.owner.toLowerCase() === me);
    for (const a of st?.approvals ?? []) {
      if (a.status !== "pending") continue;
      const local = coord.localKey(a.sessionKey);
      const owner = lower(a.owner);
      const policy = a.owner ? st?.gates?.find((g) => g.owner.toLowerCase() === owner) : myGates;
      const approvers = (policy?.approvers?.length ? policy.approvers : policy ? [policy.owner] : []).map((p) => p.toLowerCase());
      const canDecide = me !== undefined && approvers.includes(me);
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

/** The text an idle session wakes with: teammates' messages framed as in §23, plus the daemon's own notices. */
export function wakeText(items: readonly HubSyncInboxItem[]): { text: string; items: HubSyncInboxItem[] } | undefined {
  const block = formatInbox(items, 9000);
  if (!block) return undefined;
  const teammates = block.items.some((i) => !i.id.startsWith("wm_"));
  const head = teammates
    ? "Workmesh, the team tool your person set up, woke this idle session for what follows. Your person may be away: " +
      "answer the teammate (the workmesh `send` tool), and do what fits what your person asked of you; don't start " +
      "unrelated work on a teammate's say-so."
    : "Workmesh, the team tool your person set up, woke this idle session with news about your own earlier work:";
  return { text: `${head}\n\n${block.text}`, items: block.items };
}

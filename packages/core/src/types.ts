import type { SessionState } from "./events";

export interface AgentSession {
  key: string; // `${source}:${sessionId}`
  source: string;
  sessionId: string;
  state: SessionState;
  activity?: string;
  project?: string;
  /** Concurrent agents this session represents (default 1; orchestrator-reported). */
  agents: number;
  /** Orchestrator phase label, if any. */
  phase?: string;
  /** Parent session key whose own count this session subsumes (avoids double-count). */
  orchestrator?: string;
  /** Working only on its own background shells/subagents; it resumes by itself. */
  background?: boolean;
  /** Full working directory (local only — never formatted into the Slack status). */
  cwd?: string;
  /** Human session name (Claude Code's session name, or one a custom source reports). */
  name?: string;
  startedAt: number; // epoch ms
  updatedAt: number; // epoch ms of last event
  /** epoch ms when the session entered its current state (working/waiting/idle). */
  stateSince: number;
}

/** A session as the snapshot presents it, with fan-out folded in. */
export interface SessionView extends AgentSession {
  /**
   * Agents running under this session beyond itself: its own reported fan-out
   * (agents − 1) plus the agents of working sessions that name it as their
   * orchestrator (e.g. the ultracode workflows it launched). Shown as "+N".
   */
  subagents: number;
  /**
   * Set on a session whose orchestrator is present in the snapshot: its agents
   * are already counted in that row's `subagents`, so list UIs can hide it.
   */
  foldedInto?: string;
}

export interface StatusSnapshot {
  /** Sessions sorted by updatedAt descending (most recent first). */
  sessions: SessionView[];
  /** Number of working *sessions* (not agents). */
  working: number;
  waiting: number;
  idle: number;
  total: number;
  /**
   * Total concurrent agents across working sessions (sum of each session's
   * `agents`). Equals `working` unless an orchestrator reported fan-out. This
   * is the number shown as "N agents working".
   */
  agentCount: number;
  /** Activity label of the most recently updated working session, if any. */
  latestActivity?: string;
  /** Phase of the most recently updated working session, if any. */
  latestPhase?: string;
  /**
   * Informational fingerprint of session state, surfaced on the daemon's
   * /state endpoint. The pusher dedups on the formatted status text/emoji, not
   * on this — two different session sets can format to the same Slack status.
   */
  signature: string;
}

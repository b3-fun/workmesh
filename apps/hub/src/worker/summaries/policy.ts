// When the hub asks for a summary (SPEC.md §11). Pure functions, so the triggers, debounce and caps are testable
// without a clock or a model.

export const POLICY = {
  /** Wait this long after a trigger for the rest of the burst (a turn's last message often lands a batch later). */
  coalesceMs: 1_500,
  /** Per session, between any two calls. */
  minGapMs: 10_000,
  /** Now-line refresh while working, when new prompts or messages arrived. */
  workingGapMs: 30_000,
  /** Now-line refresh while working, when only tool calls arrived. */
  quietGapMs: 120_000,
  /** Events older than this when they reach the hub (a resent backlog) trigger nothing. */
  staleEventMs: 15 * 60_000,
  /** Calls per job before giving up on an outage or rate limit. */
  maxAttempts: 2,
  retryMs: 60_000,
  /** Calls per project per UTC day (SUMMARY_DAILY_CAP overrides). */
  dailyCap: 3_000,
  /** Past this share of the cap, only turn summaries, waiting reasons and digests still run. */
  nowOnlyCapShare: 0.9,
  /** A viewer away longer than this gets a digest on return. */
  digestAwayMs: 30 * 60_000,
  /** A built digest is served for this long. */
  digestCacheMs: 10 * 60_000,
  /** Jobs run per alarm; the rest wait for the next one. */
  perAlarm: 6,
} as const;

/** Why a session needs a summary. Several triggers for one session merge into one job. */
export interface Trigger {
  /** A turn ended: write its summary (latest turn event id). */
  turnId?: string;
  turnTs?: number;
  /** The session entered `waiting`: write the waiting reason. */
  waiting?: boolean;
  /** The session's state changed. */
  stateChanged?: boolean;
  /** New prompts, messages or waiting events. */
  text?: boolean;
  /** New tool calls. */
  tools?: boolean;
}

export function mergeTrigger(a: Trigger | undefined, b: Trigger): Trigger {
  if (!a) return { ...b };
  const later = (b.turnTs ?? -1) >= (a.turnTs ?? -1);
  return {
    turnId: (later ? b.turnId : a.turnId) ?? a.turnId ?? b.turnId,
    turnTs: (later ? b.turnTs : a.turnTs) ?? a.turnTs ?? b.turnTs,
    waiting: a.waiting || b.waiting,
    stateChanged: a.stateChanged || b.stateChanged,
    text: a.text || b.text,
    tools: a.tools || b.tools,
  };
}

/** When a job for this trigger may run, given the session's last call. */
export function dueAt(t: Trigger, now: number, lastCallAt: number | null): number {
  const soonest = now + POLICY.coalesceMs;
  const last = lastCallAt ?? Number.NEGATIVE_INFINITY;
  if (t.turnId || t.waiting || t.stateChanged) return Math.max(soonest, last + POLICY.minGapMs);
  if (t.text) return Math.max(soonest, last + POLICY.workingGapMs);
  return Math.max(soonest, last + POLICY.quietGapMs);
}

/** Whether today's count leaves room for this call. Now-line-only refreshes stop first. */
export function capAllows(callsToday: number, cap: number, nowOnly: boolean): boolean {
  if (callsToday >= cap) return false;
  if (nowOnly && callsToday >= Math.floor(cap * POLICY.nowOnlyCapShare)) return false;
  return true;
}

export function dailyCap(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : POLICY.dailyCap;
}

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

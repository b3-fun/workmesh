import { hubTeamAcceptSchema } from "@workmesh/protocol";
import type { HubTeamAccepted } from "@workmesh/protocol";

/**
 * v0.5: the team as the hub sees it, for the menu bar (docs/SPEC.md §16). The
 * daemon polls `GET <hub>/relay/team` with the device token and serves the last
 * good answer on its loopback API (`GET /team`); the menu bar reads only that.
 *
 * Cadence: every 15 s while the menu is open (the app asks with `?open=1`) or
 * something needs the person, every 60 s otherwise. A hub without the endpoint
 * (404, older than v0.5) is asked again after 10 minutes; a 401 stops polling,
 * like ingest. Whether the hub answers also tells the forwarder that it reads
 * v0.6 session structure (subagents as their own sessions).
 */

export interface TeamView {
  /** null: not asked yet; false: this hub has no team view (404). */
  available: boolean | null;
  /** Epoch ms of the last good read. */
  fetchedAt?: number;
  /** The last read's failure, if it failed. */
  error?: string;
  /** The hub rejected the device token. */
  halted: boolean;
  /** The last good read. */
  team?: HubTeamAccepted;
  /** The cadence in effect. */
  pollMs: number;
}

export interface TeamPollerOptions {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
  /** Called when the hub starts or stops answering (200 vs 404). */
  onAvailability?: (available: boolean) => void;
  fastMs?: number;
  slowMs?: number;
  /** After a 404, ask again this much later. */
  absentRetryMs?: number;
  /** A menu `open=1` read keeps the fast cadence this long. */
  openWindowMs?: number;
  timeoutMs?: number;
}

export class TeamPoller {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly onAvailability?: (available: boolean) => void;
  private readonly fastMs: number;
  private readonly slowMs: number;
  private readonly absentRetryMs: number;
  private readonly openWindowMs: number;
  private readonly timeoutMs: number;

  private available: boolean | null = null;
  private team: HubTeamAccepted | undefined;
  private fetchedAt: number | undefined;
  private error: string | undefined;
  private halted = false;
  private openUntil = 0;
  private lastAttemptAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private nextAt = 0;
  private inFlight: Promise<void> | undefined;
  private running = false;

  constructor(opts: TeamPollerOptions) {
    this.url = opts.url.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.onAvailability = opts.onAvailability;
    this.fastMs = opts.fastMs ?? 15_000;
    this.slowMs = opts.slowMs ?? 60_000;
    this.absentRetryMs = opts.absentRetryMs ?? 10 * 60_000;
    this.openWindowMs = opts.openWindowMs ?? 45_000;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The cadence right now: fast while the menu is open or someone needs the person. */
  pollMs(now = this.now()): number {
    if (this.available === false) return this.absentRetryMs;
    const urgent = now < this.openUntil || (this.team?.needsMe.length ?? 0) > 0;
    return urgent ? this.fastMs : this.slowMs;
  }

  /** The menu bar opened: poll fast for a while, and now if the last read is older than the fast cadence. */
  markOpen(now = this.now()): void {
    this.openUntil = now + this.openWindowMs;
    if (!this.running || this.halted || this.available === false) return;
    const due = this.lastAttemptAt + this.fastMs;
    if (due <= now) this.schedule(0);
    else if (due < this.nextAt) this.schedule(due - now);
  }

  view(): TeamView {
    return {
      available: this.available,
      fetchedAt: this.fetchedAt,
      error: this.error,
      halted: this.halted,
      team: this.team,
      pollMs: this.pollMs(),
    };
  }

  private schedule(delayMs: number): void {
    if (!this.running || this.halted) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextAt = this.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll().finally(() => this.schedule(this.pollMs()));
    }, delayMs);
    this.timer.unref?.();
  }

  /** One read of `/relay/team`. Never throws. */
  poll(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.pollUnsafe()
      .catch((err: unknown) => {
        this.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private setAvailable(on: boolean): void {
    if (this.available === on) return;
    this.available = on;
    this.onAvailability?.(on);
  }

  private async pollUnsafe(): Promise<void> {
    if (this.halted) return;
    this.lastAttemptAt = this.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/relay/team`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      this.error = `hub unreachable: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    if (res.status === 404) {
      await res.text().catch(() => "");
      if (this.available !== false) this.log("hub: no team view on this hub yet (404); asking again in 10 min");
      this.error = undefined;
      this.team = undefined;
      this.setAvailable(false);
      return;
    }
    if (res.status === 401) {
      await res.text().catch(() => "");
      this.halted = true;
      this.error = "device token rejected (401)";
      return;
    }
    if (!res.ok) {
      await res.text().catch(() => "");
      this.error = `hub responded ${res.status} to /relay/team`;
      return;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      this.error = "hub sent a team view that isn't JSON";
      return;
    }
    const parsed = hubTeamAcceptSchema.safeParse(body);
    if (!parsed.success) {
      this.error = "hub sent a team view this relay can't read";
      return;
    }
    this.team = parsed.data;
    this.fetchedAt = this.now();
    this.error = undefined;
    this.setAvailable(true);
  }
}

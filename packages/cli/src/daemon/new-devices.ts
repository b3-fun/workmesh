import type { HubNewDeviceAccepted } from "@workmesh/protocol";
import { readStateFile, writeStateFile } from "../hub/persist";
import { oneLine } from "../lib/untrusted";

/**
 * New machines on the person's account (docs/SPEC.md §46, §47). The hub's sync names the machines added to the
 * account in the last 24 hours. This store tells the person about each one once: a line in the daemon's log, and a
 * notice that `GET /team` carries for the menu bar, `workmesh status` and `workmesh doctor`. A notice stays up for a
 * day, or until the person dismisses it.
 *
 * The notice is for the person. Nothing here is put in an agent's context or inbox, and the sync state that hooks and
 * agents' calls read never holds the list (`hub/coord.ts` takes it out).
 */

/** A notice stays up this long after this machine first heard of the new one, unless it is dismissed. */
export const NEW_DEVICE_NOTICE_MS = 24 * 60 * 60_000;
/** Machines remembered, so that none is told twice. More than a hub lists at once (50). */
export const NEW_DEVICE_MAX_REMEMBERED = 200;

const MACHINE_MAX = 80;
const WHERE_MAX = 120;
const UNNAMED = "an unnamed machine";

/** What the person is shown about one new machine. */
export interface NewDeviceNotice {
  id: string;
  /** The machine's name, on one line. */
  machine: string;
  /** Where it joined from, on one line, when the hub said. */
  where?: string;
  /** When it was added (epoch ms, the hub's clock); 0 when the hub didn't say. */
  pairedAt: number;
  /** When this machine first heard of it (epoch ms). */
  toldAt: number;
  /** The whole notice, for a terminal line or a log. */
  text: string;
}

/** One remembered machine, as saved. A saved entry needs only its `id`, so a file with fewer fields still loads. */
interface Told {
  id: string;
  machine: string;
  where?: string;
  pairedAt: number;
  toldAt: number;
  /** Where the person can remove it: the hub this machine was paired with when it heard. */
  board?: string;
  dismissedAt?: number;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago"; "recently" when the hub gave no time. */
export function agoWords(at: number, now: number): string {
  if (!(at > 0)) return "recently";
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** The notice's words. `machine` and `where` must already be on one line (`oneLine`). */
export function newDeviceText(d: { machine: string; where?: string; pairedAt: number }, board: string | undefined, now: number): string {
  const from = d.where ? `, from ${d.where}` : "";
  const remove = board ? `remove it on the board: ${board}` : "remove it on the board.";
  return `A new machine joined your Workmesh account: ${d.machine || UNNAMED}, ${agoWords(d.pairedAt, now)}${from}. If this wasn't you, ${remove}`;
}

/** A place name on one line, without a full stop of its own (the notice adds one). */
function cleanWhere(where: string | undefined): string | undefined {
  if (where === undefined) return undefined;
  return oneLine(where, WHERE_MAX).replace(/[\s.]+$/, "") || undefined;
}

function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Reads the saved list leniently: a missing or unreadable file is an empty list, and an entry keeps what can be read. */
function readTold(raw: unknown): Told[] {
  const list = (raw as { devices?: unknown } | null | undefined)?.devices;
  if (!Array.isArray(list)) return [];
  const out = new Map<string, Told>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id === "" || r.id.length > 64) continue;
    const where = cleanWhere(typeof r.where === "string" ? r.where : undefined);
    const dismissedAt = count(r.dismissedAt);
    out.set(r.id, {
      id: r.id,
      machine: typeof r.machine === "string" ? oneLine(r.machine, MACHINE_MAX) : "",
      ...(where ? { where } : {}),
      pairedAt: count(r.pairedAt) ?? 0,
      // No time saved: told at some earlier point, so it is remembered and no longer shown.
      toldAt: count(r.toldAt) ?? 0,
      ...(typeof r.board === "string" && r.board ? { board: oneLine(r.board, 300) } : {}),
      ...(dismissedAt !== undefined ? { dismissedAt } : {}),
    });
  }
  return [...out.values()].slice(-NEW_DEVICE_MAX_REMEMBERED);
}

export interface NewDeviceNoticesOptions {
  /** Where the list is kept (0600). Absent: memory only. */
  file?: string;
  now?: () => number;
  log?: (message: string) => void;
}

export class NewDeviceNotices {
  private readonly file: string | undefined;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  /** By device id, in the order they were heard of. */
  private readonly told = new Map<string, Told>();

  constructor(opts: NewDeviceNoticesOptions = {}) {
    this.file = opts.file;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    for (const t of readTold(opts.file ? readStateFile(opts.file) : undefined)) this.told.set(t.id, t);
  }

  /**
   * Takes in the list from one sync. A machine not heard of before is remembered, logged once and returned; one
   * already known is left as it is. `board` is where the person can remove a machine, `self` this machine's own
   * device id (never a notice), `hubNow` the hub's clock for "5 minutes ago".
   */
  observe(list: readonly HubNewDeviceAccepted[], at: { board: string; self?: string; hubNow?: number }): NewDeviceNotice[] {
    const now = this.now();
    const fresh: Told[] = [];
    for (const d of list) {
      if (d.id === at.self || this.told.has(d.id)) continue;
      const where = cleanWhere(d.where);
      const t: Told = {
        id: d.id,
        machine: oneLine(d.machine, MACHINE_MAX),
        ...(where ? { where } : {}),
        pairedAt: d.pairedAt,
        toldAt: now,
        board: at.board,
      };
      this.told.set(t.id, t);
      fresh.push(t);
    }
    if (fresh.length === 0) return [];
    // Over the cap, the oldest go first, but never one the hub still lists: forgetting it would tell it again.
    const listed = new Set(list.map((d) => d.id));
    for (const id of [...this.told.keys()]) {
      if (this.told.size <= NEW_DEVICE_MAX_REMEMBERED) break;
      if (!listed.has(id)) this.told.delete(id);
    }
    this.save();
    const notices = fresh.map((t) => toNotice(t, at.hubNow ?? now));
    for (const n of notices) this.log(`hub: ${n.text} (device ${oneLine(n.id, 64)})`);
    return notices;
  }

  /** The notices to show now: heard of in the last 24 hours and not dismissed, newest first. */
  active(hubNow?: number): NewDeviceNotice[] {
    const now = this.now();
    const out: NewDeviceNotice[] = [];
    for (const t of this.told.values()) {
      if (t.dismissedAt !== undefined || t.toldAt <= 0) continue;
      // Either side of now, so a clock that was wrong when the notice was raised can't keep it up for good.
      if (Math.abs(now - t.toldAt) >= NEW_DEVICE_NOTICE_MS) continue;
      out.push(toNotice(t, hubNow ?? now));
    }
    return out.reverse();
  }

  /** The person has seen it: the notice goes, and the machine stays remembered. False when there was none to dismiss. */
  dismiss(id: string): boolean {
    const t = this.told.get(id);
    if (!t || t.dismissedAt !== undefined) return false;
    t.dismissedAt = this.now();
    this.save();
    return true;
  }

  private save(): void {
    if (!this.file) return;
    try {
      writeStateFile(this.file, { v: 1, devices: [...this.told.values()] });
    } catch (err) {
      // Best effort: the worst case is a machine told again after a restart.
      this.log(`new machines: could not save the list: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function toNotice(t: Told, hubNow: number): NewDeviceNotice {
  const machine = t.machine || UNNAMED;
  return {
    id: t.id,
    machine,
    ...(t.where ? { where: t.where } : {}),
    pairedAt: t.pairedAt,
    toldAt: t.toldAt,
    text: newDeviceText({ machine, where: t.where, pairedAt: t.pairedAt }, t.board, hubNow),
  };
}

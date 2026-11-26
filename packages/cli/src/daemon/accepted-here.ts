import fs from "node:fs";
import path from "node:path";

/**
 * The handoffs that were accepted on this machine (docs/SPEC.md §31): by the person at its terminal or in its menu
 * bar, or by the person's own `auto-self` policy. The relay starts an agent only for a handoff in this record. The
 * hub listing a handoff as accepted is not enough, because the hub can be wrong and the board can be used by someone
 * else.
 *
 * The record is a small file in the state dir (0600), so it survives a daemon restart. It holds ids, never a
 * handoff's text. It is capped, and an id goes once the hub stops listing its handoff.
 */

/** Where the accept happened on this machine. */
export type AcceptedBy = "cli" | "menubar" | "policy";

export interface AcceptedEntry {
  id: string;
  /** When, on this machine's clock (epoch ms). */
  at: number;
  by: AcceptedBy;
}

/** The record keeps this many ids; the oldest go first. */
export const ACCEPTED_HERE_MAX = 500;

const BY: readonly string[] = ["cli", "menubar", "policy"];

export class AcceptedHere {
  private readonly file: string | undefined;
  private readonly entries = new Map<string, AcceptedEntry>();

  /** `file` absent: the record lives in memory only. */
  constructor(file?: string) {
    this.file = file;
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      for (const e of Array.isArray(raw) ? raw : []) {
        const x = e as Partial<AcceptedEntry> | null;
        if (!x || typeof x.id !== "string" || x.id === "" || x.id.length > 64) continue;
        if (typeof x.at !== "number" || !Number.isFinite(x.at) || typeof x.by !== "string" || !BY.includes(x.by)) continue;
        this.entries.set(x.id, { id: x.id, at: x.at, by: x.by });
      }
      this.trim();
    } catch {
      // No record yet, or one that can't be read: nothing was accepted here as far as this daemon knows.
    }
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  list(): AcceptedEntry[] {
    return [...this.entries.values()];
  }

  /** A handoff was accepted on this machine. */
  add(id: string, by: AcceptedBy, at: number): void {
    this.entries.delete(id);
    this.entries.set(id, { id, at, by });
    this.trim();
    this.save();
  }

  /** Drops the ids the hub no longer lists. */
  prune(listed: ReadonlySet<string>): void {
    let changed = false;
    for (const id of [...this.entries.keys()]) {
      if (listed.has(id)) continue;
      this.entries.delete(id);
      changed = true;
    }
    if (changed) this.save();
  }

  private trim(): void {
    while (this.entries.size > ACCEPTED_HERE_MAX) this.entries.delete(this.entries.keys().next().value!);
  }

  private save(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.list(), null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
    } catch {
      // Best effort: the record still holds in memory until the daemon stops.
    }
  }
}

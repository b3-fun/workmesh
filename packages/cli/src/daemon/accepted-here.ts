import fs from "node:fs";
import path from "node:path";

/**
 * The handoffs that were accepted on this machine (docs/SPEC.md §31): by the person at its terminal or in its menu
 * bar, by the person's own `auto-self` policy, or by one of their standing rules for requests (§56). The relay starts an agent only for a handoff in this record. The
 * hub listing a handoff as accepted is not enough, because the hub can be wrong and the board can be used by someone
 * else.
 *
 * Each id comes with a hash of what was accepted: the task, the context, the repo and the issue as this machine
 * showed them. A handoff the hub lists with other text is not the one that was accepted, and is not started.
 *
 * The record is a small file in the state dir (0600), so it survives a daemon restart. It holds ids and hashes, never
 * a handoff's text. It is capped, and an id goes once the hub stops listing its handoff.
 */

/** Where the accept happened on this machine. */
export type AcceptedBy = "cli" | "menubar" | "policy" | "rule";

export interface AcceptedEntry {
  id: string;
  /** When, on this machine's clock (epoch ms). */
  at: number;
  by: AcceptedBy;
  /**
   * The hash of the handoff as it was accepted (`handoffHash`). Absent in a record written before hashes were kept:
   * such an entry matches whatever the hub lists under its id.
   */
  hash?: string;
  /** For `rule`: which standing rule (`ruleKey`), so each rule's accepts a day can be counted. */
  rule?: string;
}

/** The record keeps this many ids; the oldest go first. */
export const ACCEPTED_HERE_MAX = 500;

const BY: readonly string[] = ["cli", "menubar", "policy", "rule"];
const HASH_RE = /^[0-9a-f]{64}$/;

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
        // No hash: an entry from before hashes were kept. A hash that isn't one: not an entry to go by.
        if (x.hash !== undefined && (typeof x.hash !== "string" || !HASH_RE.test(x.hash))) continue;
        const rule = typeof x.rule === "string" && x.rule.length <= 400 ? x.rule : undefined;
        this.entries.set(x.id, { id: x.id, at: x.at, by: x.by, ...(x.hash === undefined ? {} : { hash: x.hash }), ...(rule ? { rule } : {}) });
      }
      this.trim();
    } catch {
      // No record yet, or one that can't be read: nothing was accepted here as far as this daemon knows.
    }
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): AcceptedEntry | undefined {
    return this.entries.get(id);
  }

  list(): AcceptedEntry[] {
    return [...this.entries.values()];
  }

  /** A handoff was accepted on this machine; `hash` says which text the accept covers. */
  add(id: string, by: AcceptedBy, at: number, hash?: string, rule?: string): void {
    this.entries.delete(id);
    this.entries.set(id, { id, at, by, ...(hash === undefined ? {} : { hash }), ...(by === "rule" && rule ? { rule } : {}) });
    this.trim();
    this.save();
  }

  /** How many handoffs a standing rule accepted on this machine's day of `now`. */
  countToday(rule: string, now: number): number {
    const day = new Date(now).toDateString();
    let n = 0;
    for (const e of this.entries.values()) if (e.by === "rule" && e.rule === rule && new Date(e.at).toDateString() === day) n++;
    return n;
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

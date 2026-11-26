import { z } from "zod";
import type { HubMessageTo } from "@workmesh/protocol";
import { CoordClient, isLocalNotice } from "../hub/coord";
import type { HubSyncInboxItem, InboxPolicy } from "../hub/coord";
import { readStateFile, writeStateFile } from "../hub/persist";
import type { MessageSettings } from "../lib/config";

/**
 * Who may reach this machine's sessions (docs/SPEC.md §23). Any teammate, or any teammate's agent, can send a message
 * to any session, and the sender chooses whether it asks to wake an idle one. The receiving machine has the last word:
 * this file decides, from this machine's own config and from what its sessions did, which messages may start a turn.
 *
 * It keeps a small record of who each local session wrote to (state dir, 0600). A message from one of them is a
 * reply, and a reply may wake under the default rule. Nothing here calls the hub.
 */

/** A message a local session sent: who it went to, and in which thread. */
export interface SentRecord {
  /** The local session that sent it (the top-level key, `<source>:<sessionId>`). */
  session: string;
  /** The message's id as the hub answered. A reply may name it as its thread. */
  id?: string;
  /** The thread the message was sent in, if it had one. */
  thread?: string;
  /** The person it went to: the one named, or the one whose session or agent was named. */
  person?: string;
  /** The session it went to (a hub key). */
  toSession?: string;
  /** The agent it went to, by its session name. */
  agent?: string;
  at: number;
}

/** A record counts for this long: after that, a message from its recipient is no longer a reply. */
export const SENT_KEEP_MS = 7 * 24 * 60 * 60_000;
/** Records kept, newest last. */
export const SENT_MAX = 500;

const sentSchema = z.object({
  session: z.string().min(1).max(200),
  id: z.string().min(1).max(64).optional(),
  thread: z.string().min(1).max(64).optional(),
  person: z.string().min(1).max(200).optional(),
  toSession: z.string().min(1).max(300).optional(),
  agent: z.string().min(1).max(120).optional(),
  at: z.number().nonnegative(),
});

/** The state file, read leniently: a record this relay can't read is dropped on its own. */
const stateSchema = z.object({
  sent: z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.flatMap((it) => {
        const r = sentSchema.safeParse(it);
        return r.success ? [r.data] : [];
      }),
    ),
});

export interface MessageGateDeps {
  coord: () => CoordClient | undefined;
  /** This machine's rules (config `messages`), read each time: a change applies without a restart. */
  settings: () => MessageSettings;
  /** Where the records are kept. Absent: in memory only. */
  file?: string;
  now?: () => number;
}

export class MessageGate implements InboxPolicy {
  private readonly deps: MessageGateDeps;
  private readonly now: () => number;
  private sentRecords: SentRecord[] = [];
  private dirty = false;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(deps: MessageGateDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.load();
  }

  // --- what this machine's sessions sent ---------------------------------------------

  /** A local session sent a message the hub took: remember who to, so their answer counts as a reply. */
  sent(localKey: string, to: HubMessageTo, info: { id?: string; thread?: string; person?: string } = {}): void {
    const record: SentRecord = {
      session: CoordClient.family(localKey),
      ...(info.id ? { id: info.id } : {}),
      ...(info.thread ? { thread: info.thread } : {}),
      ...("person" in to ? { person: to.person } : info.person ? { person: info.person } : {}),
      ...("session" in to ? { toSession: to.session } : {}),
      ...("agent" in to ? { agent: to.agent } : {}),
      at: this.now(),
    };
    if (!sentSchema.safeParse(record).success) return;
    this.sentRecords.push(record);
    this.prune();
    this.touch();
  }

  /** The records still in force, oldest first (for tests and `doctor`-style checks). */
  records(): readonly SentRecord[] {
    this.prune();
    return this.sentRecords;
  }

  /**
   * Whether a message answers something this session sent: its sender is a person (or one of their sessions or
   * agents) the session wrote to in the last 7 days, or it is in a thread the session wrote in.
   */
  isReply(item: HubSyncInboxItem, localKey: string): boolean {
    const mine = CoordClient.family(localKey);
    const since = this.now() - SENT_KEEP_MS;
    const person = item.from.person.toLowerCase();
    const name = item.from.sessionName?.toLowerCase();
    const session = item.from.sessionKey === undefined ? undefined : CoordClient.family(item.from.sessionKey);
    for (const r of this.sentRecords) {
      if (r.session !== mine || r.at < since) continue;
      if (item.thread !== undefined && (r.id === item.thread || r.thread === item.thread)) return true;
      if (r.person !== undefined && r.person.toLowerCase() === person) return true;
      if (session !== undefined && r.toSession !== undefined && CoordClient.family(r.toSession) === session) return true;
      if (name !== undefined && r.agent !== undefined && r.agent.toLowerCase() === name) return true;
    }
    return false;
  }

  // --- the policy the sync client asks (hub/coord.ts) ---------------------------------

  /**
   * Whether a message may start a turn in its idle session. The daemon's own notices wake as they always did. A
   * teammate's message must first ask to wake (the sender's flag, or the hub's default for a person's message), and
   * then this machine's rule must allow its sender. A person's own messages are always allowed.
   */
  wakes(item: HubSyncInboxItem, localKey: string): boolean {
    if (!CoordClient.wakes(item)) return false;
    if (isLocalNotice(item.id)) return true;
    const coord = this.deps.coord();
    if (coord?.isOwn(item)) return true;
    const rule = this.deps.settings().wake;
    if (rule === "team") return true;
    if (rule === "self") return false;
    if (Array.isArray(rule)) return namesPerson(rule, item.from.person, coord);
    return this.isReply(item, localKey);
  }

  // --- the state file ------------------------------------------------------------------

  /** Drops records past their time or over the cap (oldest first). */
  private prune(): void {
    const since = this.now() - SENT_KEEP_MS;
    if (this.sentRecords.some((r) => r.at < since)) {
      this.sentRecords = this.sentRecords.filter((r) => r.at >= since);
      this.touch();
    }
    if (this.sentRecords.length > SENT_MAX) {
      this.sentRecords.splice(0, this.sentRecords.length - SENT_MAX);
      this.touch();
    }
  }

  private load(): void {
    if (!this.deps.file) return;
    const parsed = stateSchema.safeParse(readStateFile(this.deps.file));
    if (!parsed.success) return;
    this.sentRecords = parsed.data.sent;
    this.prune();
  }

  /** Saves soon: several changes in one tick make one write, and a hook never waits for the disk. */
  private touch(): void {
    this.dirty = true;
    if (!this.deps.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 200);
    this.saveTimer.unref?.();
  }

  /** Writes the records now (the daemon calls it as it stops). Never throws. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.dirty || !this.deps.file) return;
    this.dirty = false;
    try {
      writeStateFile(this.deps.file, { v: 1, sent: this.sentRecords });
    } catch {
      // Best effort: the worst case is a reply that waits for the session's next turn.
    }
  }
}

/**
 * Whether a list of people names this sender: by the name the hub shows, or by a GitHub login the roster gives that
 * person. Case does not matter.
 */
export function namesPerson(list: readonly string[], person: string, coord: CoordClient | undefined): boolean {
  const who = person.toLowerCase();
  const wanted = new Set(list.map((p) => p.trim().toLowerCase()).filter(Boolean));
  if (wanted.has(who)) return true;
  const login = coord?.view().state?.roster.find((p) => p.person.toLowerCase() === who)?.github?.toLowerCase();
  return login !== undefined && wanted.has(login);
}

/**
 * The person a message goes to, as the roster tells it: the one named, the one whose session was named, or the one
 * whose live agent has that session name. Undefined when the roster can't say.
 */
export function recipientPerson(
  to: HubMessageTo,
  roster: ReadonlyArray<{ person: string; sessions: ReadonlyArray<{ hubKey: string; name: string; state?: string }> }> | undefined,
): string | undefined {
  if ("person" in to) return to.person;
  if (!roster) return undefined;
  if ("session" in to) {
    const key = CoordClient.family(to.session);
    return roster.find((p) => p.sessions.some((s) => CoordClient.family(s.hubKey) === key))?.person;
  }
  const name = to.agent.toLowerCase();
  const owners = roster.filter((p) => p.sessions.some((s) => s.state !== "ended" && s.name.toLowerCase() === name));
  return owners.length === 1 ? owners[0]!.person : undefined;
}

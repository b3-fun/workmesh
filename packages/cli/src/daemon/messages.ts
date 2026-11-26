import { z } from "zod";
import type { SessionEvent } from "@workmesh/core";
import type { HubMessageTo } from "@workmesh/protocol";
import { CoordClient, isLocalNotice } from "../hub/coord";
import type { HubSyncInboxItem, InboxPolicy } from "../hub/coord";
import { readStateFile, writeStateFile } from "../hub/persist";
import type { MessageHoldRule, MessageSettings } from "../lib/config";
import { cleanText, label } from "../lib/untrusted";

/**
 * Who may reach this machine's sessions (docs/SPEC.md §23). Any teammate, or any teammate's agent, can send a message
 * to any session, and the sender chooses whether it asks to wake an idle one. The receiving machine has the last word.
 * This file decides, from this machine's own config and from what its sessions did:
 *
 * - whose messages this machine takes at all (`accepts`);
 * - which messages may start a turn in an idle session (`wakes`);
 * - which messages wait for the person instead of going into a session's context (`holds`), because that session
 *   runs with no permission prompts.
 *
 * It keeps two small records in the state dir (0600): who each local session wrote to, so their answer counts as a
 * reply, and the messages held for the person. Nothing here calls the hub.
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

/** A message held for the person, as the menu bar and `workmesh inbox --held` show it. */
export interface HeldMessage {
  id: string;
  /** The session it is for (its local key), and that session's name when the daemon knows one. */
  session: string;
  name?: string;
  /** Who sent it and from which session, each as one line. */
  from: string;
  fromSession?: string;
  /** The text, without what a reader cannot see. */
  text: string;
  ts: number;
  /** When it was held, and when it is dropped if nobody answers (this machine's clock). */
  since: number;
  dropAt: number;
}

/** What the person's answer to a held message came to. */
export type HeldAnswer = { ok: true; message: HeldMessage } | { ok: false; why: "none" | "several" };

/** A record counts for this long: after that, a message from its recipient is no longer a reply. */
export const SENT_KEEP_MS = 7 * 24 * 60 * 60_000;
/** Records kept, newest last. */
export const SENT_MAX = 500;
/** Held messages tracked at once (a hub lists at most 500 for a device). */
const HELD_MAX = 1000;
/** A sender this machine takes no messages from is named in the daemon log at most this often. */
const REFUSED_LOG_EVERY_MS = 60 * 60_000;
/** A dropped message is remembered this long, in case its ack never reached the hub; at most this many are. */
const DROPPED_KEEP_MS = 7 * 24 * 60 * 60_000;
const DROPPED_MAX = 2000;

const sentSchema = z.object({
  session: z.string().min(1).max(200),
  id: z.string().min(1).max(64).optional(),
  thread: z.string().min(1).max(64).optional(),
  person: z.string().min(1).max(200).optional(),
  toSession: z.string().min(1).max(300).optional(),
  agent: z.string().min(1).max(120).optional(),
  at: z.number().nonnegative(),
});
const heldSchema = z.object({ id: z.string().min(1).max(64), session: z.string().min(1).max(300), since: z.number().nonnegative() });
const droppedSchema = z.object({ id: z.string().min(1).max(64), at: z.number().nonnegative() });

/** The items of a list that parse; the rest are dropped one by one. */
const keepValid = <T extends z.ZodType>(item: T) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.flatMap((it) => {
        const r = item.safeParse(it);
        return r.success ? [r.data as z.infer<T>] : [];
      }),
    );

/** The state file, read leniently: a record this relay can't read is dropped on its own. */
const stateSchema = z.object({
  sent: keepValid(sentSchema),
  held: keepValid(heldSchema),
  released: keepValid(z.string().min(1).max(64)),
  dropped: keepValid(droppedSchema),
});

/** What a session's permission mode means for a teammate's message. */
export type ModeLevel = "bypass" | "unattended" | "asks";

/**
 * A permission mode, as a hook or a transcript names it, read for this rule. `bypass`: nobody is asked before a tool
 * runs (Claude Code `bypassPermissions` and `dontAsk`; a Codex thread with no sandbox, `full-access`). `unattended`:
 * an automatic mode decides in the person's place (`auto`). `asks`: any other mode. Undefined: the mode is not known.
 */
export function modeLevel(mode: string | undefined): ModeLevel | undefined {
  switch (mode) {
    case undefined:
    case "":
      return undefined;
    case "bypassPermissions":
    case "dontAsk":
    case "full-access":
      return "bypass";
    case "auto":
      return "unattended";
    default:
      return "asks";
  }
}

/** Whether a teammate's message is held for a session in this mode. An unknown mode holds only under `always`. */
export function holdsFor(rule: MessageHoldRule, mode: string | undefined): boolean {
  if (rule === "never") return false;
  if (rule === "always") return true;
  const level = modeLevel(mode);
  return level === "bypass" || (rule === "unattended" && level === "unattended");
}

export interface MessageGateDeps {
  coord: () => CoordClient | undefined;
  /** This machine's rules (config `messages`), read each time: a change applies without a restart. */
  settings: () => MessageSettings;
  /**
   * A session's permission mode as its transcript last said it (the forwarder's mirror, SPEC §26), for a session
   * whose hooks did not report one.
   */
  mirrorMode?: (localKey: string) => string | undefined;
  /** Where the records are kept. Absent: in memory only. */
  file?: string;
  now?: () => number;
  log?: (message: string) => void;
}

export class MessageGate implements InboxPolicy {
  private readonly deps: MessageGateDeps;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private sentRecords: SentRecord[] = [];
  /** Messages held for the person: id → the session it is for, and since when. */
  private readonly heldIds = new Map<string, { session: string; since: number }>();
  /** Held messages the person delivered: they go to their session whatever its mode. */
  private readonly released = new Set<string>();
  /** Messages dropped (by the person, or because nobody answered): id → when. */
  private readonly dropped = new Map<string, number>();
  /** Each session's permission mode as its last hook reported it. */
  private readonly modes = new Map<string, string>();
  /** Senders whose messages were refused: name → when the daemon log last said so. */
  private readonly refusedAt = new Map<string, number>();
  private dirty = false;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(deps: MessageGateDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
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

  /** The records still in force, oldest first. */
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

  // --- each session's permission mode -------------------------------------------------

  /** A hook's event: its detail names the session's permission mode when the agent tool reports one. */
  observe(event: SessionEvent): void {
    const mode = event.detail?.permissionMode;
    if (!mode) return;
    const key = `${event.source}:${event.sessionId}`;
    if (this.modes.get(key) === mode) return;
    if (this.modes.size > 2000) this.modes.clear();
    this.modes.set(key, mode);
  }

  /**
   * The session's permission mode as best known: what its last hook said, else what its transcript last said. A
   * subagent runs in its session's mode. Undefined when neither is known.
   */
  modeOf(localKey: string): string | undefined {
    const key = CoordClient.family(localKey);
    return this.modes.get(key) ?? this.deps.mirrorMode?.(key);
  }

  // --- the policy the sync client asks (hub/coord.ts) ---------------------------------

  /**
   * Whether this machine takes a message from this sender at all (`messages.from`). The person's own messages are
   * always taken. One that is not taken is dropped by the sync client, and the daemon log names its sender once an
   * hour.
   */
  accepts(item: HubSyncInboxItem): boolean {
    const coord = this.deps.coord();
    if (coord?.isOwn(item)) return true;
    const rule = this.deps.settings().from;
    if (rule === "team") return true;
    if (rule !== "self" && namesPerson(rule, item.from.person, coord)) return true;
    const who = item.from.person.toLowerCase();
    const now = this.now();
    const last = this.refusedAt.get(who);
    if (last === undefined || now - last >= REFUSED_LOG_EVERY_MS) {
      if (this.refusedAt.size > 500) this.refusedAt.clear();
      this.refusedAt.set(who, now);
      const takes = rule === "self" ? "only its person's own" : "only its person's own and those of the people listed";
      this.log(`dropped a message from ${label(item.from.person) || "someone"}: this machine takes ${takes} (messages.from)`);
    }
    return false;
  }

  /**
   * Whether a message may start a turn in its idle session. The daemon's own notices wake as they always did, and so
   * does a held message the person delivered. A teammate's message must first ask to wake (the sender's flag, or the
   * hub's default for a person's message), and then this machine's rule must allow its sender. A person's own
   * messages are always allowed.
   */
  wakes(item: HubSyncInboxItem, localKey: string): boolean {
    if (isLocalNotice(item.id)) return CoordClient.wakes(item);
    if (this.released.has(item.id)) return true;
    if (!CoordClient.wakes(item)) return false;
    const coord = this.deps.coord();
    if (coord?.isOwn(item)) return true;
    const rule = this.deps.settings().wake;
    if (rule === "team") return true;
    if (rule === "self") return false;
    if (Array.isArray(rule)) return namesPerson(rule, item.from.person, coord);
    return this.isReply(item, localKey);
  }

  /**
   * Whether a teammate's message waits for the person instead of going to its session. It does when the session runs
   * in a mode this machine's rule holds for (by default: no permission prompts). Once held, a message stays held
   * until the person delivers or drops it, or its time runs out: a change of mode does not let it through. The
   * person's own messages and the daemon's notices are never held.
   */
  holds(item: HubSyncInboxItem, localKey: string): boolean {
    const id = item.id;
    if (isLocalNotice(id) || this.released.has(id)) return false;
    // Dropped, and waiting for its ack to reach the hub: it never goes to the session.
    if (this.dropped.has(id) || this.heldIds.has(id)) return true;
    if (this.deps.coord()?.isOwn(item)) return false;
    if (!holdsFor(this.deps.settings().hold, this.modeOf(localKey))) return false;
    if (this.heldIds.size >= HELD_MAX) this.heldIds.delete(this.heldIds.keys().next().value!);
    this.heldIds.set(id, { session: localKey, since: this.now() });
    this.touch();
    this.log(`held a message from ${label(item.from.person) || "someone"} for ${localKey}: its person delivers or drops it (menu bar, or workmesh inbox --held)`);
    return true;
  }

  // --- held messages, for the person --------------------------------------------------

  /**
   * After each sync: mark what must be held (also for a session that sits idle, so its person sees it), drop what
   * waited too long, and forget what the hub no longer lists.
   */
  sweep(): void {
    const coord = this.deps.coord();
    if (!coord) return;
    const now = this.now();
    // Reading the inbox asks `holds` for every message not yet handed over.
    const waiting = new Map(coord.inboxItems().filter((m) => !m.delivered).map((m) => [m.id, m]));
    const limit = this.deps.settings().holdMinutes * 60_000;
    for (const [id, h] of [...this.heldIds]) {
      const m = waiting.get(id);
      if (!m) {
        this.heldIds.delete(id);
        this.touch();
      } else if (now - h.since >= limit) {
        this.discard(id);
        this.log(`dropped a held message from ${label(m.from.person) || "someone"} for ${h.session}: nobody delivered it in ${this.deps.settings().holdMinutes} min`);
      }
    }
    for (const id of [...this.released]) {
      if (waiting.has(id)) continue;
      this.released.delete(id);
      this.touch();
    }
    for (const [id, at] of [...this.dropped]) {
      // Still listed: its ack never reached the hub (a restart in between). Ack it again.
      if (waiting.has(id)) coord.discard([id]);
      else if (now - at > DROPPED_KEEP_MS) {
        this.dropped.delete(id);
        this.touch();
      }
    }
  }

  /** The messages held for the person now, oldest first. `nameOf` gives a session's name for display. */
  heldMessages(nameOf?: (localKey: string) => string | undefined): HeldMessage[] {
    const coord = this.deps.coord();
    if (!coord) return [];
    this.sweep();
    const limit = this.deps.settings().holdMinutes * 60_000;
    const out: HeldMessage[] = [];
    for (const m of coord.inboxItems()) {
      const h = this.heldIds.get(m.id);
      if (!h || m.delivered) continue;
      const name = nameOf?.(CoordClient.family(m.localKey));
      const fromSession = m.from.sessionName ? label(m.from.sessionName) : "";
      out.push({
        id: m.id,
        session: m.localKey,
        ...(name ? { name } : {}),
        from: label(m.from.person) || "someone",
        ...(fromSession ? { fromSession } : {}),
        text: cleanText(m.text).trim(),
        ts: m.ts,
        since: h.since,
        dropAt: h.since + limit,
      });
    }
    return out;
  }

  /** The person delivers a held message: it goes to its session at the next prompt or tool call, whatever its mode. */
  deliver(id: string): HeldAnswer {
    const found = this.find(id);
    if (!found.ok) return found;
    this.heldIds.delete(found.message.id);
    this.released.add(found.message.id);
    this.touch();
    this.log(`delivered a held message from ${found.message.from} to ${found.message.session}: its person said so`);
    return found;
  }

  /** The person drops a held message: it never reaches its session. */
  drop(id: string): HeldAnswer {
    const found = this.find(id);
    if (!found.ok) return found;
    this.discard(found.message.id);
    this.log(`dropped a held message from ${found.message.from} for ${found.message.session}: its person said so`);
    return found;
  }

  /** A held message by its id, or by the end of its id when that names exactly one. */
  private find(id: string): HeldAnswer {
    const held = this.heldMessages();
    const exact = held.find((m) => m.id === id);
    if (exact) return { ok: true, message: exact };
    const ending = id.length >= 4 ? held.filter((m) => m.id.endsWith(id)) : [];
    if (ending.length === 1) return { ok: true, message: ending[0]! };
    return { ok: false, why: ending.length > 1 ? "several" : "none" };
  }

  /** A held message leaves for good: never handed over, acked to the hub, remembered until the hub stops listing it. */
  private discard(id: string): void {
    this.heldIds.delete(id);
    this.released.delete(id);
    this.dropped.set(id, this.now());
    while (this.dropped.size > DROPPED_MAX) this.dropped.delete(this.dropped.keys().next().value!);
    this.deps.coord()?.discard([id]);
    this.touch();
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
    for (const h of parsed.data.held) this.heldIds.set(h.id, { session: h.session, since: h.since });
    for (const id of parsed.data.released) this.released.add(id);
    for (const d of parsed.data.dropped) this.dropped.set(d.id, d.at);
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
      writeStateFile(this.deps.file, {
        v: 1,
        sent: this.sentRecords,
        held: [...this.heldIds].map(([id, h]) => ({ id, session: h.session, since: h.since })),
        released: [...this.released],
        dropped: [...this.dropped].map(([id, at]) => ({ id, at })),
      });
    } catch {
      // Best effort: the worst case is a reply that waits for the session's next turn, or a message held again.
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

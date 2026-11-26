import { z } from "zod";
import type { SessionEvent } from "@workmesh/core";
import { hubPersonEmailSchema } from "@workmesh/protocol";
import type { HubMessageTo } from "@workmesh/protocol";
import { CoordClient, isLocalNotice } from "../hub/coord";
import type { HubSyncInboxItem, InboxPolicy } from "../hub/coord";
import { readStateFile, writeStateFile } from "../hub/persist";
import type { MessageHoldRule, MessageSettings } from "../lib/config";
import { emailKey, samePerson, surelyMe } from "../lib/person";
import type { PersonRef } from "../lib/person";
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
  /**
   * That person's email, when the relay knew one (SPEC §49). A reply then counts only from that email. A record
   * without one, such as one written before emails, matches by name.
   */
  email?: string;
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
  /** Where the hub made it from, when no paired machine sent it (a Linear prompt, or a source this relay doesn't know). */
  via?: "linear" | "other";
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
  // This relay writes only emails it checked, so a record with anything else is skipped, never read by name.
  email: hubPersonEmailSchema.optional(),
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
   * A session's permission mode as its transcript last said it (the forwarder's mirror, SPEC §26). It is read beside
   * what the session's last hook said.
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
  /** Names in a list of people that fit several people (`<key> <name>`): the daemon log said so once. */
  private readonly warned = new Set<string>();
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
  sent(localKey: string, to: HubMessageTo, info: { id?: string; thread?: string; person?: string; email?: string } = {}): void {
    // A person named: they and their email come from the message itself. A session or an agent named: the roster's.
    const who = "person" in to ? recipientPerson(to, undefined) : { person: info.person, email: emailKey(info.email) };
    const record: SentRecord = {
      session: CoordClient.family(localKey),
      ...(info.id ? { id: info.id } : {}),
      ...(info.thread ? { thread: info.thread } : {}),
      ...(who?.person ? { person: who.person } : {}),
      ...(who?.email ? { email: who.email } : {}),
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
   *
   * A reply wakes a session without asking its person, so the sender is matched by the strict check (`surelyMe`,
   * SPEC §49). When the record keeps the person's email, the sender must carry the same email, and neither a display
   * name nor an agent's name decides. Only a record with no email matches by those names, as before emails.
   */
  isReply(item: HubSyncInboxItem, localKey: string): boolean {
    const mine = CoordClient.family(localKey);
    const since = this.now() - SENT_KEEP_MS;
    const name = item.from.sessionName?.toLowerCase();
    const session = item.from.sessionKey === undefined ? undefined : CoordClient.family(item.from.sessionKey);
    for (const r of this.sentRecords) {
      if (r.session !== mine || r.at < since) continue;
      if (item.thread !== undefined && (r.id === item.thread || r.thread === item.thread)) return true;
      if ((r.person !== undefined || r.email !== undefined) && surelyMe({ person: r.person, email: r.email }, item.from)) return true;
      if (session !== undefined && r.toSession !== undefined && CoordClient.family(r.toSession) === session) return true;
      if (r.email === undefined && name !== undefined && r.agent !== undefined && r.agent.toLowerCase() === name) return true;
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

  /**
   * Whether this machine's rule holds a teammate's message for this session now. The relay knows the mode from two
   * places, the session's last hook and its transcript. Either one naming a held mode is enough: when they disagree,
   * the message waits for the person.
   */
  private holdsNow(localKey: string): boolean {
    const rule = this.deps.settings().hold;
    const key = CoordClient.family(localKey);
    return holdsFor(rule, this.modes.get(key)) || holdsFor(rule, this.deps.mirrorMode?.(key));
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
    if (rule !== "self" && this.listNames("from", rule, item)) return true;
    const who = item.from.person.toLowerCase();
    const now = this.now();
    const last = this.refusedAt.get(who);
    if (last === undefined || now - last >= REFUSED_LOG_EVERY_MS) {
      if (this.refusedAt.size > 500) this.refusedAt.clear();
      this.refusedAt.set(who, now);
      const takes = rule === "self" ? "only its person's own" : "only its person's own and those of the people listed";
      this.log(`dropped a message from ${sender(item.from.person, item.via)}: this machine takes ${takes} (messages.from)`);
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
    if (Array.isArray(rule)) return this.listNames("wake", rule, item);
    return this.isReply(item, localKey);
  }

  /**
   * Whether a list of people in this machine's config (`messages.<key>`) names a message's sender. A name in it that
   * fits several people lets none of them through, and the daemon log says so once, with their emails.
   */
  private listNames(key: "wake" | "from", list: readonly string[], item: HubSyncInboxItem): boolean {
    const coord = this.deps.coord();
    return namesPerson(list, item.from, coord?.view().state, coord?.self(), (name, emails) => {
      const once = `${key} ${name.toLowerCase()}`;
      if (this.warned.has(once)) return;
      this.warned.add(once);
      this.log(
        `messages.${key}: "${label(name)}" matches ${emails.length} people on this team (${emails.slice(0, 8).join("; ")}), so it lets none of them through. Write one of those emails instead of the name.`,
      );
    });
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
    if (!this.holdsNow(localKey)) return false;
    if (this.heldIds.size >= HELD_MAX) this.heldIds.delete(this.heldIds.keys().next().value!);
    this.heldIds.set(id, { session: localKey, since: this.now() });
    this.touch();
    this.log(`held a message from ${sender(item.from.person, item.via)} for ${localKey}: its person delivers or drops it (menu bar, or workmesh inbox --held)`);
    return true;
  }

  // --- held messages, for the person --------------------------------------------------

  /**
   * After each sync: mark what must be held (also for a session that sits idle, so its person sees it), drop what
   * waited too long, and forget what the hub no longer lists.
   */
  sweep(): void {
    const coord = this.deps.coord();
    // Before the first good sync the inbox is not known: what was held before a restart must not be forgotten.
    if (!coord || coord.view().fetchedAt === undefined) return;
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
        this.log(`dropped a held message from ${sender(m.from.person, m.via)} for ${h.session}: nobody delivered it in ${this.deps.settings().holdMinutes} min`);
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
        ...(m.via ? { via: m.via } : {}),
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
    this.log(`delivered a held message from ${found.message.from}${viaNote(found.message.via)} to ${found.message.session}: its person said so`);
    return found;
  }

  /** The person drops a held message: it never reaches its session. */
  drop(id: string): HeldAnswer {
    const found = this.find(id);
    if (!found.ok) return found;
    this.discard(found.message.id);
    this.log(`dropped a held message from ${found.message.from}${viaNote(found.message.via)} for ${found.message.session}: its person said so`);
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

/** " (via Linear)" after a sender's name in the daemon log, when the hub made the message from another source. */
function viaNote(via: "linear" | "other" | undefined): string {
  return via === undefined ? "" : via === "linear" ? " (via Linear)" : " (via another source)";
}

/** A sender as the daemon log names them: on one line, with where the hub made the message from. */
function sender(person: string, via: "linear" | "other" | undefined): string {
  return `${label(person) || "someone"}${viaNote(via)}`;
}

/**
 * Whether a list of people in this machine's config names a message's sender (`messages.wake`, `messages.from`; SPEC
 * §23). Case does not matter.
 *
 * - An entry with an `@` is an email. It matches the sender's email only, so a display name that looks like an email
 *   never passes for it, and a sender the hub sent with no email never matches one.
 * - Any other entry is a display name. It stands for the one person the last sync's roster lists under that name,
 *   this machine's own person included. The sender is matched with that person by the strict check (`surelyMe`):
 *   when the roster has their email, the sender must carry the same one, so a message the hub made from a Linear
 *   prompt never passes on a name alone. When the roster has no email for them, the names decide.
 * - A name the roster does not list stands for nobody. A name two people share stands for nobody either, and
 *   `ambiguous` hears of it with their emails, so the person can write the email instead.
 *
 * GitHub logins are not read: a machine reports its own person's login, so anyone can claim one.
 */
export function namesPerson(
  list: readonly string[],
  sender: PersonRef,
  st: { roster: ReadonlyArray<{ person: string; email?: string }> } | undefined,
  me: PersonRef | undefined,
  ambiguous: (name: string, emails: string[]) => void = () => {},
): boolean {
  const from = emailKey(sender.email);
  for (const raw of list) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.includes("@")) {
      if (from !== undefined && emailKey(entry) === from) return true;
      continue;
    }
    const one = onePerson(entry, st?.roster, me, ambiguous);
    if (one && surelyMe(one, sender)) return true;
  }
  return false;
}

/**
 * The one person a display name stands for, from the roster's people and this machine's own person, told apart by
 * email. Entries with no email are not told apart from each other, as with a hub that sends none: the name decides
 * then, as it always did. Undefined when nobody has the name, or when two people do.
 */
function onePerson(
  name: string,
  roster: ReadonlyArray<{ person: string; email?: string }> | undefined,
  me: PersonRef | undefined,
  ambiguous: (name: string, emails: string[]) => void,
): PersonRef | undefined {
  const low = name.toLowerCase();
  const people: PersonRef[] = [...(roster ?? [])];
  // This machine's own person counts even when the roster leaves them out: their name must not stand for a namesake.
  if (me?.person && !people.some((p) => samePerson(p, me))) people.push(me);
  const byEmail = new Map<string | undefined, PersonRef>();
  for (const p of people) if (p.person?.toLowerCase() === low && !byEmail.has(emailKey(p.email))) byEmail.set(emailKey(p.email), p);
  if (byEmail.size > 1) {
    ambiguous(name, [...byEmail.keys()].map((e) => e ?? "one with no email"));
    return undefined;
  }
  return byEmail.values().next().value;
}

/**
 * The person a message goes to, with their email when the relay knows one: the one named (the email the relay
 * resolved, or the name itself when it is an email), the one whose session was named, or the one whose live agent
 * has that session name (their email from the roster). Undefined when the roster can't say.
 */
export function recipientPerson(
  to: HubMessageTo,
  roster: ReadonlyArray<{ person: string; email?: string; sessions: ReadonlyArray<{ hubKey: string; name: string; state?: string }> }> | undefined,
): PersonRef | undefined {
  if ("person" in to) return withEmail(to.person, emailKey(to.email) ?? emailKey(to.person));
  if (!roster) return undefined;
  if ("session" in to) {
    const key = CoordClient.family(to.session);
    const owner = roster.find((p) => p.sessions.some((s) => CoordClient.family(s.hubKey) === key));
    return owner && withEmail(owner.person, emailKey(owner.email));
  }
  const name = to.agent.toLowerCase();
  const owners = roster.filter((p) => p.sessions.some((s) => s.state !== "ended" && s.name.toLowerCase() === name));
  return owners.length === 1 ? withEmail(owners[0]!.person, emailKey(owners[0]!.email)) : undefined;
}

/** A person, with their email only when there is one. */
function withEmail(person: string, email: string | undefined): PersonRef {
  return email ? { person, email } : { person };
}

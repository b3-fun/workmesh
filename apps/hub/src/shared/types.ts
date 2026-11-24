// Types and constants shared by the Worker, the board and the fake relay.

export const PUBLIC_URL = "https://bullpen.b3os.org";

/** A device with no ingest for this long shows its sessions as offline. */
export const OFFLINE_AFTER_MS = 2 * 60_000;
/** Ended (and long-silent) sessions drop off the board after this long. */
export const BOARD_WINDOW_MS = 12 * 3600_000;
/** Events are kept this long. */
export const EVENT_RETENTION_MS = 7 * 24 * 3600_000;
export const PAIRING_TTL_SEC = 600;
export const MAX_RELAY_BODY_BYTES = 256 * 1024;

/** What a device shares beyond metadata (SPEC.md §8). */
export type ShareLevel = "metadata" | "conversation";

export interface ProjectInfo {
  id: string;
  name: string;
  include: { remotes: string[]; dirs: string[] };
  issueKeys: string[];
  /** The level a relay suggests at `agentblip hub connect` (SPEC.md §8). */
  defaultShare: ShareLevel;
}

export const PROJECT: ProjectInfo = {
  id: "b3",
  name: "B3",
  include: { remotes: ["github.com/b3-fun/"], dirs: [] },
  issueKeys: ["B3"],
  defaultShare: "conversation",
};

/** Caps on conversation text (SPEC.md §10). */
export const MAX_TEXT_CHARS = 4000;
export const MAX_DESC_CHARS = 200;

export type SessionState = "working" | "waiting" | "idle" | "ended";
export type EventKind = "start" | "prompt" | "tool" | "waiting" | "idle" | "end" | "message" | "turn";

export interface Person {
  email: string;
  name: string;
}

export interface Device {
  id: string;
  email: string;
  machine: string;
  client: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  /** Level from the device's last ingest; null until it sends one (treated as metadata). */
  share: ShareLevel | null;
}

export interface Session {
  hubKey: string;
  deviceId: string;
  email: string;
  source: string;
  key: string;
  name: string | null;
  state: SessionState;
  activity: string | null;
  background: boolean;
  agents: number | null;
  phase: string | null;
  orchestrator: string | null;
  repo: string | null;
  branch: string | null;
  issues: string[];
  startedAt: number;
  updatedAt: number;
  stateSince: number;
  endedAt: number | null;
  lastEventAt: number | null;
  /** Hub clock: last ingest that carried this session. */
  seenAt: number;
  /** Summary of what the session is doing right now (SPEC.md §11), and when it was written. */
  nowLine: string | null;
  nowAt: number | null;
  /** What a waiting session needs from its person; null until written for the current wait. */
  waitingReason: string | null;
}

export interface HubEvent {
  deviceId: string;
  id: string;
  hubKey: string;
  email: string;
  ts: number;
  kind: EventKind;
  tool: string | null;
  label: string | null;
  path: string | null;
  cmd: string | null;
  repo: string | null;
  branch: string | null;
  issues: string[];
  pr: string | null;
  ok: boolean | null;
  /** Prompt or agent message text (conversation-level devices only). */
  text: string | null;
  truncated: boolean;
  /** One-line description of a tool call (conversation-level devices only). */
  desc: string | null;
  /** On `turn` events: how long the turn ran. */
  durationMs: number | null;
  /** On `turn` events: the hub's summary of the turn, once written. */
  summary: string | null;
}

/** "Since you looked" for one viewer (SPEC.md §11). */
export interface Digest {
  /** Start of the window: the viewer's previous visit. */
  since: number;
  builtAt: number;
  lines: string[];
}

export interface BoardState {
  project: { id: string; name: string };
  me: Person;
  people: Person[];
  devices: Device[];
  sessions: Session[];
  /** Newest first. */
  events: HubEvent[];
  serverNow: number;
  /** Who writes summaries, for the footer: "Claude Haiku 5.5", "Gemma 4 26B on Workers AI", or null when off. */
  summarizer: string | null;
  digest: Digest | null;
}

export type StreamMessage =
  | { type: "hello"; serverNow: number }
  | { type: "session"; session: Session }
  | { type: "events"; events: HubEvent[] }
  | { type: "device"; device: Device }
  | { type: "turnSummary"; deviceId: string; id: string; hubKey: string; summary: string }
  | { type: "digest"; digest: Digest | null }
  /** A device went back to metadata: drop its text from the board. */
  | { type: "purge"; deviceId: string };

export type PairStatus = "pending" | "approved" | "expired";

export interface PairInfo {
  code: string;
  machine: string;
  client: string;
  /** The level the relay said it will share, when it said (SPEC.md §8). */
  share: ShareLevel | null;
  status: PairStatus;
  expiresAt: number;
  approvedBy: string | null;
}

/** "an@npclabs.org" -> "An". */
export function displayName(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

export function isOffline(device: Pick<Device, "lastSeenAt"> | undefined, now: number): boolean {
  if (!device || device.lastSeenAt == null) return true;
  return now - device.lastSeenAt > OFFLINE_AFTER_MS;
}

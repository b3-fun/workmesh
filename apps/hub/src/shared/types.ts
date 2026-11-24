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

export interface ProjectInfo {
  id: string;
  name: string;
  include: { remotes: string[]; dirs: string[] };
  issueKeys: string[];
}

export const PROJECT: ProjectInfo = {
  id: "b3",
  name: "B3",
  include: { remotes: ["github.com/b3-fun/"], dirs: [] },
  issueKeys: ["B3"],
};

export type SessionState = "working" | "waiting" | "idle" | "ended";
export type EventKind = "start" | "prompt" | "tool" | "waiting" | "idle" | "end";

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
}

export type StreamMessage =
  | { type: "hello"; serverNow: number }
  | { type: "session"; session: Session }
  | { type: "events"; events: HubEvent[] }
  | { type: "device"; device: Device };

export type PairStatus = "pending" | "approved" | "expired";

export interface PairInfo {
  code: string;
  machine: string;
  client: string;
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

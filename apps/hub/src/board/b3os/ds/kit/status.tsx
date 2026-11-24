// Status badges (LIBRARY.md "status"). The console says a state one way (ds/layout/status-dot: a 7 px dot and the word
// in secondary ink, the pixel grid playing in the dot's place while something runs) and the kit keeps it; this adds the
// pill the original puts on a card's corner (WorkflowCardView's status badge: a raised chip with the dot and the word),
// an HTTP status in mono with its class's dot, a method tag, and a count. Colour stays in the dot: every word is ink, so
// the brand blue stays the loudest thing on the page.
import type { ReactNode } from "react";
import { StatusDot, type StatusDotTone } from "../layout/status-dot";
import { cn } from "../lib/utils";
import "./css/lite.css";
import "./kit.css";

export type StatusTone = StatusDotTone;

/** A state as the kit draws it: its tone, its word, and whether it is under way (the pixel grid plays). */
export interface StatusLook {
  tone: StatusTone;
  word: string;
  running?: boolean;
}

/**
 * The console's words for its states, and each one's tone and whether it is under way. A service's, a deploy's, and a
 * run's or a step's (a routine's run: queued, in_progress, retrying, waiting, canceled, skipped, not_run; `runStatus`
 * maps a run's own words to these keys) and a routine's (active, paused).
 */
export const STATUS: Record<string, StatusLook> = {
  running: { tone: "ok", word: "Running" },
  serving: { tone: "ok", word: "Serving" },
  succeeded: { tone: "ok", word: "Succeeded" },
  ready: { tone: "ok", word: "Ready" },
  deploying: { tone: "live", running: true, word: "Deploying" },
  starting: { tone: "live", running: true, word: "Starting" },
  creating: { tone: "live", running: true, word: "Creating" },
  queued: { tone: "off", word: "Queued" },
  paused: { tone: "warn", word: "Paused" },
  degraded: { tone: "warn", word: "Degraded" },
  failed: { tone: "failed", word: "Failed" },
  crashed: { tone: "failed", word: "Crashed" },
  down: { tone: "failed", word: "Down" },
  stopped: { tone: "off", word: "Stopped" },
  // A share link or a render past its time (Render's tiles).
  expired: { tone: "off", word: "Expired" },
  unknown: { tone: "unknown", word: "Unknown" },
  // A run's and a step's states. A service that is running is settled (the green dot); a run that is running is under
  // way (the pixel grid), so its key is in_progress and its word Running.
  pending: { tone: "off", word: "Pending" },
  in_progress: { tone: "live", running: true, word: "Running" },
  retrying: { tone: "live", running: true, word: "Retrying" },
  waiting: { tone: "warn", word: "Waiting" },
  canceled: { tone: "off", word: "Canceled" },
  skipped: { tone: "off", word: "Skipped" },
  not_run: { tone: "off", word: "Not run" },
  // A routine's (paused is above).
  active: { tone: "ok", word: "Active" },
};

/** A run's states, in the order a run moves through them (the kit page lists them so). */
export const RUN_STATES = [
  "queued",
  "pending",
  "in_progress",
  "retrying",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
  "skipped",
  "not_run",
] as const;

/**
 * The STATUS key of a run's or a step's state as the API says it ("running" is in_progress, "not run" is not_run), or
 * null for a word the kit does not know (draw it with a tone and the word).
 */
export function runStatus(state: string): string | null {
  const k = state
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (k === "running") return "in_progress";
  return (RUN_STATES as readonly string[]).includes(k) ? k : null;
}

/** A STATUS key or a look of its own, as a look: an unknown key keeps its word on the unknown tone. */
export function statusLook(status: string | StatusLook): StatusLook {
  if (typeof status !== "string") return status;
  return STATUS[status] ?? { tone: "unknown", word: status };
}

export interface StatusProps {
  /** A key of STATUS, or a look of its own ({ tone, word, running }); or set `tone` and pass the word as children. */
  status?: keyof typeof STATUS | StatusLook;
  tone?: StatusTone;
  running?: boolean;
  children?: ReactNode;
  /** `dot`: inline, the console's default; `pill`: the original's raised chip, for a card's corner or a header. */
  look?: "dot" | "pill";
  className?: string;
}

export function Status({ status, tone, running, children, look = "dot", className }: StatusProps) {
  const s = status === undefined ? undefined : typeof status === "string" ? STATUS[status] : status;
  const t = tone ?? s?.tone ?? "unknown";
  const r = running ?? s?.running ?? false;
  const word = children ?? s?.word;
  const dot = (
    <StatusDot tone={t} running={r} runningLabel={typeof word === "string" ? word : "In progress"}>
      {word}
    </StatusDot>
  );
  // Set as a box of its own, centred on the line: a pixel grid (running) and a dot (settled) then sit on one baseline,
  // where inline the grid's synthesized baseline dropped "Deploying" 3 px below "Running".
  if (look === "dot") return <span className={cn("kit-status", className)}>{dot}</span>;
  return (
    <span className={cn("kit-status-pill", className)} data-tone={t}>
      {dot}
    </span>
  );
}

/** An HTTP status: the code in mono, after its class's dot (2xx green, 3xx grey, 4xx amber, 5xx red). */
export function HttpCode({ code, className }: { code: number; className?: string }) {
  const tone: StatusTone = code >= 500 ? "failed" : code >= 400 ? "warn" : code >= 300 ? "off" : "ok";
  return (
    <span className={cn("kit-http", className)} data-tone={tone}>
      <span className="kit-http__dot" aria-hidden="true" />
      <span className="font-mono tabular-nums">{code}</span>
    </span>
  );
}

/** An HTTP method, mono, fixed width so paths line up in a list. */
export function Method({ method, className }: { method: string; className?: string }) {
  return <span className={cn("kit-method", className)}>{method.toUpperCase()}</span>;
}

/** A small count beside a label (the original's count chip: a bordered pill, 12 px medium, tabular). */
export function Count({ n, className }: { n: number; className?: string }) {
  return <span className={cn("kit-count", className)}>{n.toLocaleString("en-US")}</span>;
}

import { createHash } from "node:crypto";
import { HUB_DELEGATE_NOTE_MAX } from "@workmesh/protocol";
import type { HubHandoffAccepted } from "@workmesh/protocol";
import { QUOTE_MARK, cleanText, oneLine } from "../lib/untrusted";

/**
 * A handoff as a person reads it before they answer (docs/SPEC.md §31): the list's line, the full view, and the line
 * that says what Accept starts. The task and context are another person's or their agent's words, and accepting makes
 * them an agent's instructions on this machine. So the person gets all of it, without anything they could not see
 * (lib/untrusted.ts), each line of it marked as someone else's, and what starts is said in Workmesh's own words.
 */

/** How much of a task the list shows on its one line. */
export const LIST_TASK_MAX = 160;

/** Shown in place of a task or context that has nothing a person can see. */
export const NOTHING_VISIBLE = "(no visible text)";

/** What accepting a handoff would start on this machine, as the runner would do it (daemon/handoff-runner.ts). */
export interface HandoffPlan {
  /** The agent CLI that would run it; absent when none is installed here. */
  agent?: "claude" | "codex";
  /** Claude Code's `--permission-mode` for the run. Codex has none. */
  permissionMode?: string;
  /** A new git worktree of the repo, this machine's checkout itself, or a scratch directory (a handoff with no repo). */
  where: "worktree" | "checkout" | "scratch";
  /** Why this machine can't run it. */
  cannot?: string;
}

/** What Accept starts, as the person is told: the CLI prints `text`, the menu bar shows it. */
export interface HandoffStart {
  /** The agent that starts; absent when this machine can't run the handoff. */
  agent?: "claude" | "codex";
  /** Its Claude Code permission mode. */
  permissionMode?: string;
  /** One line, ready to show. */
  text: string;
}

const AGENT_NAMES = { claude: "Claude Code", codex: "Codex" } as const;

/**
 * The line that says what Accept starts: which agent, in which permission mode, where. `lead` opens the sentence
 * ("Starts" under a button, "Accepting starts" in a terminal).
 */
export function handoffStart(
  plan: HandoffPlan,
  h: { repo?: string | undefined },
  lead = "Starts",
  platform: NodeJS.Platform = process.platform,
): HandoffStart {
  const here = platform === "darwin" ? "this Mac" : "this machine";
  if (!plan.agent || plan.cannot) {
    return { text: `${here[0]!.toUpperCase()}${here.slice(1)} can't run it: ${plan.cannot ?? "no agent CLI found here"}.` };
  }
  const mode = plan.permissionMode ? ` in ${plan.permissionMode} mode` : "";
  const where =
    plan.where === "worktree" && h.repo
      ? `in a new worktree of ${h.repo}`
      : plan.where === "checkout" && h.repo
        ? `in your checkout of ${h.repo}`
        : "in an empty scratch folder";
  return {
    agent: plan.agent,
    ...(plan.permissionMode ? { permissionMode: plan.permissionMode } : {}),
    text: `${lead} a ${AGENT_NAMES[plan.agent]} agent on ${here}${mode}, ${where}.`,
  };
}

/**
 * What a person's accept covers: the task and context they read, and the repo and issue it is for. The hash is of the
 * text as the hub sent it, before any cleaning, so a change nobody could see counts too.
 */
export function handoffHash(h: Pick<HubHandoffAccepted, "task" | "context" | "repo" | "issue">): string {
  return createHash("sha256")
    .update(JSON.stringify([h.task, h.context ?? null, h.repo ?? null, h.issue ?? null]))
    .digest("hex");
}

/**
 * Why an accepted handoff waits for this person's "run it here" on this machine. `board`: it was accepted on the
 * board. `no-record`: the hub says it was accepted on this machine, and this machine has no record of that.
 * `changed`: it was accepted here, and the hub now lists it with other text.
 */
export type RunHereWhy = "board" | "no-record" | "changed";

const RUN_HERE: Record<RunHereWhy, string> = {
  board: "accepted on the board: run it here?",
  "no-record": "accepted, but this machine has no record of your accept: run it here?",
  changed: "accepted, but its text changed after your accept: run it here?",
};

/** What the list and the menu bar say about a handoff that waits for "run it here". */
export function runHereQuestion(why: RunHereWhy, capital = false): string {
  const text = RUN_HERE[why];
  return capital ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

/** A task or context for a person to read: cleaned, or undefined when nothing visible is left. */
export function readable(text: string | undefined): string | undefined {
  const clean = text === undefined ? "" : cleanText(text).trim();
  return clean === "" ? undefined : clean;
}

/** Whether the list's one line leaves part of the handoff unread: a longer task, or a context. */
export function hasMoreText(h: Pick<HubHandoffAccepted, "task" | "context">): boolean {
  return oneLine(h.task, Number.POSITIVE_INFINITY).length > LIST_TASK_MAX || readable(h.context) !== undefined;
}

/** A handoff with its free text cleaned, for `--json` output. Ids, repo, issue and status are checked on arrival. */
export function cleanHandoff(h: HubHandoffAccepted): HubHandoffAccepted {
  return {
    ...h,
    from: {
      ...h.from,
      person: oneLine(h.from.person, 120),
      sessionName: h.from.sessionName === undefined ? undefined : oneLine(h.from.sessionName, 120),
    },
    to: { person: oneLine(h.to.person, 120) },
    task: readable(h.task) ?? NOTHING_VISIBLE,
    context: readable(h.context),
    note: h.note === undefined ? undefined : oneLine(h.note, HUB_DELEGATE_NOTE_MAX),
  };
}

/**
 * One handoff as one line of the list. `toMe` says it went to this machine's person: the caller decides that
 * (`CoordClient.isMe`, SPEC §49), and the line then names its sender. `runHere` is set for one that waits for this
 * person's "run it here": the line says so where the status would be, and names the command.
 */
export function handoffListLine(
  h: HubHandoffAccepted,
  o: { toMe: boolean; runningHere: boolean; runHere?: string | undefined },
): string {
  const who = o.toMe ? `from ${oneLine(h.from.person, 120)}` : `to ${oneLine(h.to.person, 120)}`;
  const where = [h.repo, h.issue].filter(Boolean).join(", ");
  const here = o.runningHere ? " [running here]" : "";
  const task = oneLine(h.task, LIST_TASK_MAX) || NOTHING_VISIBLE;
  const note = h.note ? ` (${oneLine(h.note, 120)})` : "";
  const more = hasMoreText(h) ? ` [more: workmesh handoffs show ${h.id}]` : "";
  const run = o.runHere ? ` [workmesh handoffs run ${h.id}]` : "";
  const request = h.request ? ` · request${h.request.size ? `, ${h.request.size}` : ""}` : "";
  const rule = h.acceptedBy === "rule" ? " · accepted by a standing rule" : "";
  return `- ${h.id} · ${o.runHere ?? h.status} · ${who}${where ? ` · ${where}` : ""}${request}${rule}${here}: ${task}${note}${more}${run}`;
}

/** Someone else's text in full: cleaned, every line behind the quote mark, long runs of blank lines made one. */
function marked(text: string | undefined): string {
  return (readable(text) ?? NOTHING_VISIBLE)
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => (line ? `${QUOTE_MARK} ${line}` : QUOTE_MARK))
    .join("\n");
}

/**
 * One handoff in full: who it is from, repo, issue and status, then the whole task and the whole context. `start` is
 * the last line, for a handoff this person can accept or run here. `runHere` stands where the status would be, for
 * one that waits for this person's "run it here".
 */
export function handoffView(
  h: HubHandoffAccepted,
  o: { runningHere: boolean; ago?: string | undefined; start?: HandoffStart | undefined; runHere?: string | undefined },
): string {
  const from = oneLine(h.from.person, 120);
  const agent = h.from.sessionName ? oneLine(h.from.sessionName, 120) : "";
  const head = [`Handoff ${h.id}`, o.runHere ?? `${h.status}${o.runningHere ? ", running here" : ""}`, ...(o.ago ? [`sent ${o.ago} ago`] : [])];
  const lines = [
    head.join(" · "),
    `From:  ${from}${h.from.sessionKey ? ` (${agent ? `their agent ${agent}` : "one of their agents"})` : ""}`,
    `To:    ${oneLine(h.to.person, 120)}`,
    ...(h.repo ? [`Repo:  ${h.repo}`] : []),
    ...(h.issue ? [`Issue: ${h.issue}`] : []),
    ...(h.note ? [`Note:  ${oneLine(h.note, HUB_DELEGATE_NOTE_MAX)}`] : []),
    // A request (SPEC §55): someone without a relay asked; the size is the hub's estimate.
    ...(h.request ? [`Kind:  a request${h.request.size ? ` (looks ${h.request.size})` : ""}`] : []),
    ...(h.acceptedBy === "rule" && h.rule ? [`Rule:  accepted by a standing rule (${oneLine(h.rule, 200)})`] : []),
    "",
    `Task from ${from}:`,
    marked(h.task),
  ];
  if (readable(h.context) !== undefined) lines.push("", `Context from ${from}:`, marked(h.context));
  if (o.start) lines.push("", o.start.text);
  return lines.join("\n");
}

import { HUB_MODE_RE, HUB_PLAN_MAX_STEPS, type HubNoticeKind, type HubPlanStatus, type HubTasks } from "@workmesh/protocol";

/**
 * The session mirror (docs/SPEC.md §26): the lines a person's terminal shows around the conversation, read from the
 * same transcripts the tailer reads (transcript.ts) and from the Stop hooks' `background_tasks`. Everything here is
 * parsing and counting on the machine; what may leave it is decided in the forwarder (titles, notice titles and
 * plans at the conversation level only, counts and states at either).
 *
 * Shapes, read from real files on Claude Code 2.1.332 and Codex 0.164 (keys, enum values and Claude Code's own
 * notice templates only, never content):
 * - Claude Code: `{type:"ai-title", aiTitle}`, `{type:"custom-title", customTitle}`, `{type:"permission-mode",
 *   permissionMode}`; `system` lines `compact_boundary` (`compactMetadata.durationMs`, `trigger`); `user` lines whose
 *   `origin.kind` is `task-notification`, their content `<task-notification>` with `<task-id>`, `<status>`
 *   (completed | failed | stopped; absent on monitor events), `<summary>` (one of the templates below, XML-escaped)
 *   and `<duration_ms>`; `user` tool results whose `toolUseResult` starts a background task:
 *   `backgroundTaskId` (Bash), `{taskId, persistent, timeoutMs}` (Monitor), `{taskId, workflowName}` (a workflow),
 *   `{agentId, status:"async_launched"}` (a background agent).
 * - Stop / SubagentStop `background_tasks`: `{id, type, status, description, …}`; `type` is Claude Code's label:
 *   `shell`, `monitor`, `subagent`, `workflow`, `teammate`, `cloud session`, `MCP task`, … (status running | pending).
 * - Codex rollouts: `turn_context` (`model`, `approval_policy`, `sandbox_policy`), `compacted`, `event_msg`
 *   `item_completed` with `item.type` `ContextCompaction`, `response_item` `function_call` `update_plan`
 *   (`arguments` = JSON `{plan: [{step, status}], explanation?}`).
 */

export type TaskKind = keyof Required<HubTasks>;

export interface PlanStep {
  step: string;
  status: HubPlanStatus;
}

export type MirrorItem =
  | { kind: "title"; ts?: number; custom: boolean; text: string }
  | { kind: "mode"; ts?: number; mode: string }
  | { kind: "model"; ts?: number; model: string }
  | {
      kind: "notice";
      id: string;
      ts?: number;
      noticeKind: HubNoticeKind;
      /** The title the notice names (raw: redacted in the forwarder, conversation level only). */
      title?: string;
      durationMs?: number;
      ok?: boolean;
      /** The task it is about (a background agent's id, a shell's id). */
      taskId?: string;
      /** The notice ends that task (a completion, failure or stop). */
      ends?: boolean;
    }
  | { kind: "taskStart"; ts?: number; taskId: string; taskKind: TaskKind }
  | { kind: "plan"; id: string; ts?: number; steps: PlanStep[] };

const MODEL_RE = /^[\w.:@/-]{1,80}$/;
const TASK_ID_RE = /^[\w.-]{1,64}$/;
const MAX_TITLE = 2000;

/** Claude Code's task notice templates (its own wording), in the order they are tried. */
const NOTICE_TEMPLATES: ReadonlyArray<{ re: RegExp; kind: HubNoticeKind; ends?: boolean; ok?: boolean }> = [
  { re: /^Agent "([\s\S]*)" is waiting on its own background work/, kind: "agent_waiting" },
  { re: /^Agent "([\s\S]*)" (?:finished|completed)\b/, kind: "agent_done", ends: true, ok: true },
  { re: /^Agent "([\s\S]*?)" failed\b/, kind: "agent_failed", ends: true, ok: false },
  { re: /^Agent "([\s\S]*)" was (?:stopped|killed)/, kind: "agent_stopped", ends: true },
  { re: /^Background agent "([\s\S]*)" didn't finish/, kind: "agent_stopped", ends: true },
  { re: /^Background command "([\s\S]*)" completed\b/, kind: "shell_done", ends: true, ok: true },
  { re: /^Background command "([\s\S]*)" failed\b/, kind: "shell_failed", ends: true, ok: false },
  { re: /^Background command "([\s\S]*)" was (?:stopped|killed)/, kind: "shell_stopped", ends: true },
  { re: /^Background command "([\s\S]*)" is still running\b/, kind: "shell_running" },
  { re: /^\d* ?[Bb]ackground shell command(?: task)?s? didn't finish/, kind: "shell_stopped" },
  { re: /^Monitor event\b/, kind: "monitor_event" }, // its output is never read into anything
  { re: /^Monitor "([\s\S]*)" (?:stream ended|ended|timed out|was stopped|stopped|failed)/, kind: "monitor_ended", ends: true },
  { re: /^Dynamic workflow "([\s\S]*)" completed\b/, kind: "workflow_done", ends: true, ok: true },
  { re: /^Dynamic workflow "([\s\S]*)" failed\b/, kind: "workflow_failed", ends: true, ok: false },
];

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d{1,6});/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function tag(content: string, name: string, max = 4000): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]{0,${max}}?)</${name}>`).exec(content);
  return m ? m[1] : undefined;
}

/**
 * One `<task-notification>` → a notice. The summary's template decides the kind and where the title is; a summary
 * that matches none is a plain `task` notice without a title (its wording could be anything). A monitor event's
 * `<event>` is never read.
 */
export function parseTaskNotification(content: string, id: string, ts: number | undefined): MirrorItem | undefined {
  if (!content.includes("<task-notification>")) return undefined;
  const head = content.length > 64_000 ? content.slice(0, 64_000) : content;
  const summary = tag(head, "summary");
  const status = tag(head, "status", 40)?.trim();
  const rawId = tag(head, "task-id", 80)?.trim();
  const taskId = rawId && TASK_ID_RE.test(rawId) ? rawId : undefined;
  const ms = Number(tag(head, "duration_ms", 20));
  const durationMs = Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : undefined;
  const text = summary ? xmlUnescape(summary.trim()) : "";
  const failed = status === "failed";
  for (const t of NOTICE_TEMPLATES) {
    const m = t.re.exec(text);
    if (!m) continue;
    const title = m[1]?.trim().slice(0, MAX_TITLE) || undefined;
    return {
      kind: "notice",
      id,
      ts,
      noticeKind: t.kind,
      title,
      durationMs,
      ok: t.ok ?? (status === "completed" ? true : failed ? false : undefined),
      taskId,
      ends: t.ends || status === "completed" || status === "failed" || status === "stopped" ? true : undefined,
    };
  }
  return {
    kind: "notice",
    id,
    ts,
    noticeKind: "task",
    durationMs,
    ok: status === "completed" ? true : failed ? false : undefined,
    taskId,
    ends: status === "completed" || failed || status === "stopped" ? true : undefined,
  };
}

/** A background task started by a tool call in this transcript (from its structured `toolUseResult`). */
function taskStartOf(r: unknown, ts: number | undefined): MirrorItem | undefined {
  if (!r || typeof r !== "object" || Array.isArray(r)) return undefined;
  const o = r as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === "string" && TASK_ID_RE.test(v) ? v : undefined);
  const shell = id(o.backgroundTaskId);
  if (shell) return { kind: "taskStart", ts, taskId: shell, taskKind: "shells" };
  const agent = id(o.agentId);
  if (agent && (o.status === "async_launched" || o.isAsync === true)) return { kind: "taskStart", ts, taskId: agent, taskKind: "agents" };
  const task = id(o.taskId);
  if (task && typeof o.workflowName === "string") return { kind: "taskStart", ts, taskId: task, taskKind: "workflows" };
  if (task && ("persistent" in o || "timeoutMs" in o)) return { kind: "taskStart", ts, taskId: task, taskKind: "monitors" };
  return undefined;
}

/** Cheap prefilter for Claude Code lines that may carry a mirror record (the tailer's own prefilter covers the rest). */
export function claudeMirrorLine(line: string): boolean {
  return (
    line.includes('"ai-title"') ||
    line.includes('"custom-title"') ||
    line.includes('"permission-mode"') ||
    line.includes("task-notification") ||
    line.includes('"compact_boundary"') ||
    (line.includes('"toolUseResult"') && (line.includes('"backgroundTaskId"') || line.includes('"taskId"') || line.includes('"async_launched"')))
  );
}

/** What one parsed Claude Code line adds to the mirror (main thread; the caller drops sidechain lines). */
export function claudeMirrorItems(e: Record<string, unknown>, ts: number | undefined): MirrorItem[] {
  switch (e.type) {
    case "ai-title":
    case "custom-title": {
      const raw = e.type === "ai-title" ? e.aiTitle : e.customTitle;
      const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : "";
      return text ? [{ kind: "title", ts, custom: e.type === "custom-title", text }] : [];
    }
    case "permission-mode": {
      const mode = e.permissionMode;
      return typeof mode === "string" && HUB_MODE_RE.test(mode) ? [{ kind: "mode", ts, mode }] : [];
    }
    case "system": {
      if (e.subtype !== "compact_boundary") return [];
      const meta = e.compactMetadata as { durationMs?: unknown } | undefined;
      const ms = typeof meta?.durationMs === "number" && Number.isFinite(meta.durationMs) && meta.durationMs >= 0 ? Math.round(meta.durationMs) : undefined;
      const id = typeof e.uuid === "string" ? e.uuid : `${ts ?? ""}`;
      return [{ kind: "notice", id: `compact:${id}`, ts, noticeKind: "compact", durationMs: ms }];
    }
    case "user": {
      const origin = e.origin as { kind?: unknown } | undefined;
      const content = (e.message as { content?: unknown } | undefined)?.content;
      if (typeof content === "string" && (origin?.kind === "task-notification" || content.trimStart().startsWith("<task-notification>"))) {
        const id = typeof e.uuid === "string" ? e.uuid : `${ts ?? ""}`;
        const n = parseTaskNotification(content, `notice:${id}`, ts);
        return n ? [n] : [];
      }
      const start = taskStartOf(e.toolUseResult, ts);
      return start ? [start] : [];
    }
    default:
      return [];
  }
}

/** The model of an assistant line, when it names a real one. */
export function claudeModelItem(message: { model?: unknown } | undefined, ts: number | undefined): MirrorItem[] {
  const m = message?.model;
  return typeof m === "string" && m !== "<synthetic>" && MODEL_RE.test(m) ? [{ kind: "model", ts, model: m }] : [];
}

/** Codex's approval policy and sandbox as one word (SPEC §26). */
export function codexMode(approval: unknown, sandbox: unknown): string | undefined {
  const a = typeof approval === "string" ? approval : undefined;
  const sb =
    typeof sandbox === "string"
      ? sandbox
      : sandbox && typeof sandbox === "object" && typeof (sandbox as { type?: unknown }).type === "string"
        ? (sandbox as { type: string }).type
        : undefined;
  if (a === "untrusted") return "untrusted";
  if (sb === "read-only") return "read-only";
  if (sb === "danger-full-access") return "full-access";
  if (sb === "workspace-write") return "auto";
  return undefined;
}

const PLAN_STATUS: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/** Codex `update_plan` arguments → steps (≤ HUB_PLAN_MAX_STEPS, raw text: redacted in the forwarder). */
export function codexPlanSteps(args: string): PlanStep[] | undefined {
  if (args.length > 256 * 1024) return undefined;
  let a: { plan?: unknown };
  try {
    a = JSON.parse(args) as typeof a;
  } catch {
    return undefined;
  }
  if (!a || !Array.isArray(a.plan)) return undefined;
  const steps: PlanStep[] = [];
  for (const s of a.plan as unknown[]) {
    if (!s || typeof s !== "object") continue;
    const r = s as { step?: unknown; status?: unknown };
    const step = typeof r.step === "string" ? r.step.replace(/\s+/g, " ").trim() : "";
    if (!step) continue;
    const status = typeof r.status === "string" && PLAN_STATUS.has(r.status) ? (r.status as HubPlanStatus) : "pending";
    steps.push({ step: step.slice(0, MAX_TITLE), status });
    if (steps.length >= HUB_PLAN_MAX_STEPS) break;
  }
  return steps.length ? steps : undefined;
}

/** Cheap prefilter for Codex lines that may carry a mirror record. */
export function codexMirrorLine(line: string): boolean {
  return (
    line.includes('"turn_context"') ||
    line.includes('"compacted"') ||
    line.includes('"ContextCompaction"') ||
    line.includes('"update_plan"')
  );
}

/** What one parsed Codex rollout line adds to the mirror. */
export function codexMirrorItems(e: Record<string, unknown>, ts: number | undefined): MirrorItem[] {
  const p = e.payload as Record<string, unknown> | undefined;
  if (e.type === "turn_context" && p && typeof p === "object") {
    const out: MirrorItem[] = [];
    if (typeof p.model === "string" && MODEL_RE.test(p.model)) out.push({ kind: "model", ts, model: p.model });
    const mode = codexMode(p.approval_policy, p.sandbox_policy);
    if (mode) out.push({ kind: "mode", ts, mode });
    return out;
  }
  if (e.type === "compacted") return [{ kind: "notice", id: `compact:${ts ?? ""}`, ts, noticeKind: "compact" }];
  if (!p || typeof p !== "object") return [];
  if (e.type === "event_msg" && p.type === "item_completed") {
    const item = p.item as { type?: unknown; id?: unknown } | undefined;
    if (item?.type !== "ContextCompaction") return [];
    const a = p.started_at_ms;
    const b = p.completed_at_ms;
    const ms = typeof a === "number" && typeof b === "number" && b >= a ? Math.round(b - a) : undefined;
    const id = typeof item.id === "string" ? item.id : `${ts ?? ""}`;
    return [{ kind: "notice", id: `compact:${id}`, ts, noticeKind: "compact", durationMs: ms }];
  }
  if (e.type === "response_item" && p.type === "function_call" && p.name === "update_plan" && typeof p.arguments === "string") {
    const steps = codexPlanSteps(p.arguments);
    const id = typeof p.call_id === "string" ? p.call_id : `${ts ?? ""}`;
    return steps ? [{ kind: "plan", id: `plan:${id}`, ts, steps }] : [];
  }
  return [];
}

// ------------------------------------------------------------------ background tasks

/** Claude Code's `background_tasks` type label → the wire's kind. */
export function taskKindOf(type: unknown): TaskKind {
  switch (type) {
    case "shell":
    case "local_bash":
      return "shells";
    case "monitor":
    case "monitor_mcp":
    case "monitor_ws":
      return "monitors";
    case "subagent":
    case "agent":
    case "local_agent":
    case "teammate":
    case "cloud session":
    case "remote_agent":
      return "agents";
    case "workflow":
    case "local_workflow":
      return "workflows";
    default:
      return "other";
  }
}

/** A Stop's `background_tasks` → the running ones by id and kind (ids only; descriptions and commands stay home). */
export function runningTasks(tasks: readonly unknown[] | undefined, max = 100): Array<{ id: string; kind: TaskKind }> {
  const out: Array<{ id: string; kind: TaskKind }> = [];
  for (const t of tasks ?? []) {
    if (!t || typeof t !== "object") continue;
    const r = t as { id?: unknown; type?: unknown; status?: unknown };
    if (r.status !== undefined && r.status !== "running" && r.status !== "pending") continue;
    const id = typeof r.id === "string" && TASK_ID_RE.test(r.id) ? r.id : `anon-${out.length}`;
    out.push({ id, kind: taskKindOf(r.type) });
    if (out.length >= max) break;
  }
  return out;
}

/** The background tasks one session (or one subagent) has running, by id. Bounded. */
export class TaskSet {
  private readonly byId = new Map<string, TaskKind>();
  constructor(private readonly max = 200) {}

  get size(): number {
    return this.byId.size;
  }

  /** The hook's list is the whole truth at that moment. */
  replace(tasks: ReadonlyArray<{ id: string; kind: TaskKind }>): void {
    this.byId.clear();
    for (const t of tasks) this.add(t.id, t.kind);
  }

  add(id: string, kind: TaskKind): void {
    this.byId.delete(id);
    this.byId.set(id, kind);
    while (this.byId.size > this.max) this.byId.delete(this.byId.keys().next().value as string);
  }

  /** Removes the task; returns its kind when it was running. */
  remove(id: string | undefined): TaskKind | undefined {
    if (!id) return undefined;
    const kind = this.byId.get(id);
    this.byId.delete(id);
    return kind;
  }

  /** Ends one task of `kind` whose id the notice didn't give (the oldest). */
  removeOne(kind: TaskKind): void {
    for (const [id, k] of this.byId) {
      if (k === kind) {
        this.byId.delete(id);
        return;
      }
    }
  }

  counts(): HubTasks | undefined {
    if (this.byId.size === 0) return undefined;
    const c: Record<TaskKind, number> = { shells: 0, monitors: 0, agents: 0, workflows: 0, other: 0 };
    for (const k of this.byId.values()) c[k]++;
    const out: HubTasks = {};
    for (const k of Object.keys(c) as TaskKind[]) if (c[k] > 0) out[k] = Math.min(999, c[k]);
    return out;
  }
}

/** The kind of task a notice is about. */
export function noticeTaskKind(kind: HubNoticeKind): TaskKind | undefined {
  if (kind.startsWith("agent_")) return "agents";
  if (kind.startsWith("shell_")) return "shells";
  if (kind.startsWith("monitor_")) return "monitors";
  if (kind.startsWith("workflow_")) return "workflows";
  return undefined;
}

/** Feeds a mirror item into a task set (launches add, ending notices remove). */
export function applyToTasks(tasks: TaskSet, item: MirrorItem): void {
  if (item.kind === "taskStart") tasks.add(item.taskId, item.taskKind);
  else if (item.kind === "notice" && item.ends) {
    const kind = noticeTaskKind(item.noticeKind);
    if (tasks.remove(item.taskId) === undefined && kind && !item.taskId) tasks.removeOne(kind);
  }
}

/** "waiting on 1 shell, 1 monitor" from counts, in Claude Code's order; undefined when nothing runs. */
export function tasksStatusLine(t: HubTasks | undefined): string | undefined {
  if (!t) return undefined;
  const parts: string[] = [];
  const add = (n: number | undefined, one: string) => {
    if (n && n > 0) parts.push(`${n} ${one}${n === 1 ? "" : "s"}`);
  };
  add(t.shells, "shell");
  add(t.monitors, "monitor");
  add(t.agents, "agent");
  add(t.workflows, "workflow");
  add(t.other, "task");
  return parts.length ? `waiting on ${parts.join(", ")}` : undefined;
}

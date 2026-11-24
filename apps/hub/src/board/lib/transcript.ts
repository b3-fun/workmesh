// Turns a session's events into the conversation view's items (SPEC.md §12), modeled on Claude Code's transcript:
// prompts, the agent's messages, consecutive tool calls folded into one line, waits, and turn ends.

import type { HubEvent } from "../../shared/types";

export type Item =
  | { k: "prompt"; key: string; e: HubEvent }
  | { k: "message"; key: string; e: HubEvent }
  | { k: "tools"; key: string; events: HubEvent[]; label: string; failed: number }
  | { k: "waiting"; key: string; e: HubEvent }
  | { k: "turn"; key: string; e: HubEvent }
  | { k: "mark"; key: string; e: HubEvent; text: string };

const evKey = (e: HubEvent) => `${e.deviceId}:${e.id}`;

const SHELL = new Set(["Bash", "BashOutput", "shell", "shell_command", "local_shell", "exec_command", "unified_exec", "container.exec", "write_stdin"]);
const EDIT = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch", "str_replace_based_edit_tool"]);
const READ = new Set(["Read", "NotebookRead", "view_image"]);
const SEARCH = new Set(["Grep", "Glob", "LS", "ToolSearch"]);
const AGENT = new Set(["Task", "Agent"]);
const PLAN = new Set(["TodoWrite", "update_plan", "ExitPlanMode"]);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Bucket {
  order: number;
  render: (n: number, distinct: number) => string;
  calls: number;
  paths: Set<string>;
}

/** "Ran 3 shell commands · Edited 2 files · Called claude-in-chrome 2 times", in order of first appearance. */
export function foldLabel(events: HubEvent[]): string {
  const buckets = new Map<string, Bucket>();
  const add = (key: string, render: Bucket["render"], e: HubEvent) => {
    let b = buckets.get(key);
    if (!b) {
      b = { order: buckets.size, render, calls: 0, paths: new Set() };
      buckets.set(key, b);
    }
    b.calls++;
    if (e.path) b.paths.add(e.path);
  };
  for (const e of events) {
    const tool = e.tool ?? "";
    if (SHELL.has(tool)) add("shell", (n) => `Ran ${plural(n, "shell command")}`, e);
    else if (EDIT.has(tool)) add("edit", (n, d) => `Edited ${plural(d || n, "file")}`, e);
    else if (READ.has(tool)) add("read", (n, d) => `Read ${plural(d || n, "file")}`, e);
    else if (SEARCH.has(tool)) add("search", (n) => `Searched for ${plural(n, "pattern")}`, e);
    else if (tool === "WebSearch" || tool === "web_search") add("websearch", (n) => `Searched the web ${n === 1 ? "once" : `${n} times`}`, e);
    else if (tool === "WebFetch") add("webfetch", (n) => `Fetched ${plural(n, "page")}`, e);
    else if (AGENT.has(tool)) add("agent", (n) => `Started ${plural(n, "agent")}`, e);
    else if (PLAN.has(tool)) add("plan", () => "Updated the plan", e);
    else if (tool === "Skill") add("skill", (n) => `Used ${plural(n, "skill")}`, e);
    else if (tool.startsWith("mcp__")) {
      const server = tool.split("__")[1] || "a tool";
      add(`mcp:${server}`, (n) => `Called ${server} ${n === 1 ? "once" : `${n} times`}`, e);
    } else {
      const name = tool || "a tool";
      add(`tool:${name}`, (n) => `Called ${name} ${n === 1 ? "once" : `${n} times`}`, e);
    }
  }
  return [...buckets.values()]
    .sort((a, b) => a.order - b.order)
    .map((b) => b.render(b.calls, b.paths.size))
    .join(" · ");
}

/** Items from events in time order (oldest first). */
export function buildTranscript(events: HubEvent[]): Item[] {
  const items: Item[] = [];
  let run: HubEvent[] = [];
  const close = () => {
    if (!run.length) return;
    items.push({
      k: "tools",
      key: `tools:${evKey(run[0]!)}`,
      events: run,
      label: foldLabel(run),
      failed: run.filter((e) => e.ok === false).length,
    });
    run = [];
  };
  for (const e of events) {
    if (e.kind === "tool") {
      run.push(e);
      continue;
    }
    if (e.kind === "idle") continue;
    close();
    const key = evKey(e);
    if (e.kind === "prompt") items.push({ k: "prompt", key, e });
    else if (e.kind === "message") items.push({ k: "message", key, e });
    else if (e.kind === "waiting") items.push({ k: "waiting", key, e });
    else if (e.kind === "turn") items.push({ k: "turn", key, e });
    else if (e.kind === "start") items.push({ k: "mark", key, e, text: "Session started" });
    else if (e.kind === "end") items.push({ k: "mark", key, e, text: "Session ended" });
  }
  close();
  return items;
}

/** 1m 34s, 45s, 1h 02m. */
export function turnDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Unique PR links in order of first appearance. */
export function prLinks(events: HubEvent[]): string[] {
  const seen = new Set<string>();
  for (const e of events) if (e.pr) seen.add(e.pr);
  return [...seen];
}

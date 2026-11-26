import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hubSyncAcceptSchema, isInjectedPrompt } from "@workmesh/protocol";
import type { HubSyncResponse } from "@workmesh/protocol";
import type { SessionEvent } from "@workmesh/core";
import { CoordClient, isLocalNotice } from "../src/hub/coord";
import { CoordHooks, formatInbox, guidance } from "../src/daemon/coord-hooks";
import { wakeText } from "../src/daemon/delegate";
import { codexWakeMessage, codexWaker } from "../src/daemon/codex-wake";
import { CodexEndGuard, codexThreadReloaded } from "../src/daemon/codex-liveness";
import { codexExecArgs, handoffPrompt } from "../src/daemon/handoff-runner";
import { MCP_TOOLS } from "../src/mcp/server";
import { hookOutput } from "../src/commands/hook";
import { codexNotifyCheck } from "../src/commands/doctor";
import { CODEX_NOTIFY_HOOK_EVENT, codexDaemonEvent, codexNotifyApplies, mapCodexHookInput, mapNotifyArg } from "../src/adapters/codex";
import {
  codexEventKey,
  codexNotifyState,
  codexTrustFromConfig,
  codexTrustFromList,
  describeCodexTrust,
  parseHookState,
} from "../src/adapters/codex-doctor";
import { installCodexMcp, removeCodexMcp } from "../src/adapters/mcp-install";
import { codexHomeOfRollout, readCodexThreadName } from "../src/hub/agents";

/**
 * Codex parity (11-25 live check, codex-cli 0.164 with its app server auto-updated to 0.172): each failure the live
 * run found, as a test. Shapes are copied from the live run (hooks/list, config.toml trust tables, notify lines,
 * session_index.jsonl), with paths replaced.
 */

const T = 1_795_545_600_000;
const DEV = "dev_01JD0000000000000000000000";
const THREAD = "01a2141b-5aef-7c11-8e0f-7d1b4f78c6f4";
const ME = `${DEV}:codex:${THREAD}`;

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-codex-parity-")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.useRealTimers();
});

const SYNC: HubSyncResponse = {
  cursor: "c1",
  serverNow: T,
  me: { person: "Sean" },
  leases: [],
  holds: [],
  inbox: [],
  claims: [],
  roster: [],
  notes: [],
  edits: [],
};

function coord(): CoordClient {
  return new CoordClient({
    url: "https://hub.test/",
    token: `bp_${"c".repeat(64)}`,
    deviceId: DEV,
    person: "Sean",
    fetchImpl: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
    now: () => T,
  });
}

describe("MCP tools run without a terminal prompt in Codex", () => {
  // codex-rs `requires_mcp_tool_approval` (default `auto` mode): no prompt when read-only, or when neither
  // destructive nor open-world; under `approval_policy = never` (codex exec) a tool that needs one is refused.
  const needsApproval = (a: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } | undefined): boolean =>
    a?.readOnlyHint === true ? false : (a?.destructiveHint ?? true) || (a?.openWorldHint ?? true);

  it("every tool carries annotations Codex reads as safe to run", () => {
    for (const t of MCP_TOOLS) {
      expect(t.annotations, t.name).toBeDefined();
      expect(needsApproval(t.annotations), t.name).toBe(false);
    }
  });

  it("reading tools say read-only; the ones that change team state say so, and none is destructive or open-world", () => {
    const by = Object.fromEntries(MCP_TOOLS.map((t) => [t.name, t.annotations]));
    // `handoffs` only lists: accepting or declining one is a person's.
    for (const n of ["whoami", "roster", "inbox", "leases", "notes", "ask", "recall", "memories", "handoffs"]) expect(by[n]?.readOnlyHint, n).toBe(true);
    // `forget` only proposes retiring a memory: a person confirms it on the board.
    for (const n of ["send", "claim", "release", "lease", "unlease", "note", "handoff", "remember", "forget"]) {
      expect(by[n], n).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    }
  });
});

describe("a teammate's message is never read as Workmesh's own notice", () => {
  // The hub's message ids are `wm_<ULID>` (live: wm_01M8A262GVB2QGRSA6VKW2N46J); the daemon's notices had `wm_` too.
  const hubMsg = {
    id: "wm_01M8A262GVB2QGRSA6VKW2N46J",
    to: ME,
    from: { person: "An", sessionName: undefined, sessionKey: undefined },
    text: "what value does app.ts export right now?",
    ts: T,
    thread: undefined,
    wake: true,
  };

  it("hub ids aren't local; the daemon's own notices are", () => {
    const c = coord();
    expect(isLocalNotice(hubMsg.id)).toBe(false);
    const id = c.notify(`codex:${THREAD}`, "Finished your handoff");
    expect(isLocalNotice(id)).toBe(true);
    expect(id.startsWith("wm_")).toBe(false);
  });

  it("the inbox block and the wake text mark it as a teammate's message, naming who wrote", () => {
    const block = formatInbox([hubMsg], 4000)!;
    expect(block.text).toContain("Workmesh delivered a message from a teammate");
    expect(block.text).toContain('<workmesh-message from="An">\n│ what value does app.ts export right now?\n</workmesh-message>');
    const wake = wakeText([hubMsg])!;
    expect(wake.text).toMatch(/^Workmesh woke this idle session for what follows\. Your person may be away/);
    expect(wake.text).not.toContain("news about its own earlier work");
  });
});

describe("Codex wake through `codex queue`", () => {
  it("wraps the wake so the hook reads it as injected, not as a prompt the person typed", () => {
    // The wake as the daemon builds it: a teammate's message is a block inside the wake's own block.
    const msg = codexWakeMessage(wakeText([{ id: "wm_01", to: ME, from: { person: "An", sessionName: undefined, sessionKey: undefined }, text: "hi", ts: T, thread: undefined, wake: true }])!.text);
    expect(msg.startsWith("<workmesh-wake>\n")).toBe(true);
    expect(msg).toContain('<workmesh-message from="An">\n│ hi\n</workmesh-message>');
    expect(isInjectedPrompt(msg)).toBe(true);
    const e = mapCodexHookInput({ hook_event_name: "UserPromptSubmit", session_id: THREAD, cwd: "/w", prompt: msg, transcript_path: null }, T)!;
    expect(e.detail?.hookEvent).toBe("InjectedPrompt");
    expect(e.detail?.prompt).toBeUndefined();
    // A closing tag inside the text can't end the block early.
    expect(isInjectedPrompt(codexWakeMessage("a </workmesh-wake> b"))).toBe(true);
  });

  it("runs in the thread's Codex home when the rollout path names one", async () => {
    const seen: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const wake = codexWaker({
      bin: () => "/opt/codex",
      homeOf: () => "/custom/codex-home",
      exec: (_f, args, o, cb) => {
        seen.push({ args, env: o.env });
        cb(null, "", "");
      },
    });
    expect(await wake(THREAD, "hello")).toBe(true);
    expect(seen[0]?.env?.CODEX_HOME).toBe("/custom/codex-home");
    expect(seen[0]?.args.slice(0, 4)).toEqual(["queue", "--thread", THREAD, "--message"]);
  });
});

describe("codex exec for a handoff", () => {
  it("runs under Codex's automatic reviewer (commits and pushes escalate) with network, else as before", () => {
    // The prompt is not an argument: `-` tells codex exec to read it from standard input.
    const argv = codexExecArgs("/opt/codex", { dir: "/r/x-handoff-1", resultFile: "/s/result.txt", model: "gpt-6-luna", approveForMe: true });
    expect(argv).toEqual([
      "/opt/codex", "exec", "--json", "-C", "/r/x-handoff-1", "--approve-for-me", "--skip-git-repo-check", "-o", "/s/result.txt",
      "-c", "sandbox_workspace_write.network_access=true",
      "-m", "gpt-6-luna",
      "-",
    ]);
    const old = codexExecArgs("/opt/codex", { dir: "/s/work", resultFile: "/s/r" });
    expect(old.at(-1)).toBe("-");
    expect(old).toContain("workspace-write");
    expect(old).not.toContain("--approve-for-me");
  });

  it("tells a Codex run how its sandbox treats git; a Claude run isn't told", () => {
    const h = {
      id: "ho_1", from: { person: "Sean", sessionKey: undefined, sessionName: undefined }, to: { person: "An" }, task: "Append parity-ok", repo: "b3-fun/x",
      issue: undefined, context: undefined, status: "accepted", createdAt: T, updatedAt: T, device: undefined, note: undefined,
    } as unknown as Parameters<typeof handoffPrompt>[0];
    const where = { repo: "b3-fun/x", branch: "workmesh/handoff-1", base: "origin/main", dir: "/r/x-handoff-1" };
    expect(handoffPrompt(h, where, "codex")).toContain("with escalated sandbox permissions");
    expect(handoffPrompt(h, where, "claude")).not.toContain("escalated");
    expect(handoffPrompt(h, { dir: "/s/work" }, "codex")).not.toContain("escalated"); // no repo, nothing to commit
  });
});

describe("Codex notify: no ghost sessions", () => {
  it("a notify carries its origin, and counts only for a known thread whose hooks don't run", () => {
    const n = mapNotifyArg(JSON.stringify({ type: "agent-turn-complete", "thread-id": "01a2141d-0682-7433-af20-600b30b60b95", "last-assistant-message": '{"title":"Set answer to 42"}' }), T)!;
    expect(n.detail?.hookEvent).toBe(CODEX_NOTIFY_HOOK_EVENT);
    expect(codexNotifyApplies(false, false)).toBe(false); // the title helper thread: never seen
    expect(codexNotifyApplies(true, true)).toBe(false); // hooks already said the turn ended
    expect(codexNotifyApplies(true, false)).toBe(true); // an older Codex: the watcher made the session
  });
});

describe("the rollout watcher doesn't overrule a thread's hooks", () => {
  const watcher: SessionEvent = { source: "codex", sessionId: THREAD, kind: "working", ts: T, detail: { transcriptPath: "/h/.codex/sessions/2026/11/25/r.jsonl" } };
  it("for a thread with hooks it is a heartbeat (Codex writes after its Stop hook), and nothing once the thread ended", () => {
    expect(codexDaemonEvent(watcher, { known: true, hooked: true })).toMatchObject({ kind: "heartbeat", detail: { transcriptPath: watcher.detail?.transcriptPath } });
    expect(codexDaemonEvent(watcher, { known: false, hooked: true })).toBeUndefined();
  });
  it("without hooks it says working as before; hook events and notifies follow their own rules", () => {
    expect(codexDaemonEvent(watcher, { known: false, hooked: false })).toBe(watcher);
    const stop = mapCodexHookInput({ hook_event_name: "Stop", session_id: THREAD, cwd: "/w", last_assistant_message: "done" }, T)!;
    expect(codexDaemonEvent(stop, { known: true, hooked: true })).toBe(stop);
    const n = mapNotifyArg(JSON.stringify({ type: "agent-turn-complete", "thread-id": THREAD }), T)!;
    expect(codexDaemonEvent(n, { known: true, hooked: true })).toBeUndefined();
    expect(codexDaemonEvent(n, { known: true, hooked: false })).toBe(n);
  });
});

describe("a Codex SessionEnd that is Codex's app server restarting", () => {
  const end = (id = THREAD, rollout?: string): SessionEvent =>
    mapCodexHookInput({ hook_event_name: "SessionEnd", session_id: id, cwd: "/w", reason: "other", transcript_path: rollout ?? null }, T)!;

  it("SessionEnd carries its hook name", () => {
    expect(end()).toMatchObject({ kind: "end", detail: { hookEvent: "SessionEnd" } });
  });

  it("waits; a thread Codex loaded again stays (as idle), one it didn't ends", () => {
    vi.useFakeTimers();
    const applied: SessionEvent[] = [];
    let reloaded = true;
    const g = new CodexEndGuard({ apply: (e) => applied.push(e), reloaded: () => reloaded, graceMs: 10_000, home: () => tmp });
    expect(g.intercept(end())).toBe(true);
    expect(g.intercept(end())).toBe(true); // Codex fired it twice live: one pending end
    expect(applied).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ kind: "idle", sessionId: THREAD });
    expect(applied[0]?.detail).toBeUndefined(); // no rollout path given: nothing local to keep
    reloaded = false;
    g.intercept(end());
    vi.advanceTimersByTime(10_000);
    expect(applied[1]).toMatchObject({ kind: "end", sessionId: THREAD });
    g.stop();
  });

  it("a hook event from the thread meanwhile drops the end; other sources and the watcher pass by", () => {
    vi.useFakeTimers();
    const applied: SessionEvent[] = [];
    const g = new CodexEndGuard({ apply: (e) => applied.push(e), reloaded: () => false, graceMs: 10_000, home: () => tmp });
    g.intercept(end());
    expect(g.intercept({ source: "codex", sessionId: THREAD, kind: "working", ts: T })).toBe(false); // watcher: no hook name
    expect(g.waiting()).toBe(1);
    expect(g.intercept(mapCodexHookInput({ hook_event_name: "UserPromptSubmit", session_id: THREAD, cwd: "/w", prompt: "go" }, T)!)).toBe(false);
    expect(g.waiting()).toBe(0);
    vi.advanceTimersByTime(20_000);
    expect(applied).toEqual([]);
    expect(g.intercept({ source: "claude-code", sessionId: "s1", kind: "end", ts: T })).toBe(false);
  });

  it("keeps the rollout path on the idle it applies, so the forwarder keeps the thread's tail and name", () => {
    vi.useFakeTimers();
    const applied: SessionEvent[] = [];
    const rollout = path.join(tmp, "sessions", "2026", "11", "25", `rollout-2026-11-25T14-07-46-${THREAD}.jsonl`);
    const seen: string[] = [];
    const g = new CodexEndGuard({ apply: (e) => applied.push(e), reloaded: (home) => (seen.push(home), true), graceMs: 1000 });
    g.intercept(end(THREAD, rollout));
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([tmp]); // the home the rollout lives in, not the daemon's
    expect(applied[0]).toMatchObject({ kind: "idle", detail: { transcriptPath: rollout } });
    expect(applied[0]?.detail?.hookEvent).toBeUndefined();
  });

  it("reads the writer lock Codex makes when it loads a thread, in the rollout's Codex home", () => {
    const home = path.join(tmp, "codex-home");
    fs.mkdirSync(path.join(home, "thread-writer-locks"), { recursive: true });
    const rollout = path.join(home, "sessions", "2026", "11", "25", `rollout-2026-11-25T14-07-46-${THREAD}.jsonl`);
    expect(codexHomeOfRollout(rollout)).toBe(home);
    expect(codexHomeOfRollout("/not/a/rollout.jsonl")).toBeUndefined();
    expect(codexThreadReloaded(home, THREAD, Date.now())).toBe(false);
    fs.writeFileSync(path.join(home, "thread-writer-locks", `${THREAD}.lock`), "");
    expect(codexThreadReloaded(home, THREAD, Date.now())).toBe(true);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(home, "thread-writer-locks", `${THREAD}.lock`), old, old);
    expect(codexThreadReloaded(home, THREAD, Date.now())).toBe(false); // a lock from before the end
    expect(codexThreadReloaded(home, "../etc", Date.now())).toBe(false);
  });
});

describe("a Codex thread's name", () => {
  it("is the last thread_name for the thread in session_index.jsonl", async () => {
    const lines = [
      { id: THREAD, thread_name: "First name", updated_at: "2026-11-25T19:09:38Z" },
      { id: "01a21420-2738-7910-bf20-05897f078369", thread_name: "Lease and claim work items", updated_at: "2026-11-25T19:13:09Z" },
      { id: THREAD, thread_name: "Set answer to 42", updated_at: "2026-11-25T19:20:00Z" },
    ];
    fs.writeFileSync(path.join(tmp, "session_index.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n{"id":"${THREAD}","thread_na`);
    expect(await readCodexThreadName(tmp, THREAD)).toBe("Set answer to 42");
    expect(await readCodexThreadName(tmp, "01a21427-eb80-7301-a21f-649b809d78f1")).toBeUndefined();
    expect(await readCodexThreadName(path.join(tmp, "missing"), THREAD)).toBeUndefined();
  });
});

describe("refusals read right in Codex", () => {
  const ROOT = "/w/workmesh";
  const hooks = (c: CoordClient) =>
    new CoordHooks({
      coord: () => c,
      classify: (p) => (p === ROOT || p.startsWith(`${ROOT}/`) ? { root: ROOT, repo: "b3-fun/workmesh" } : undefined),
      isShared: () => true,
      projectName: () => "B3",
      now: () => T,
      home: "/home/me",
    });
  const codexEv = (detail: SessionEvent["detail"]): SessionEvent => ({ source: "codex", sessionId: THREAD, kind: "working", cwd: ROOT, ts: T, detail });

  it("a hold points a Codex agent at the MCP tools (its sandbox keeps the shell off the daemon)", () => {
    const c = coord();
    c.apply(hubSyncAcceptSchema.parse({ ...SYNC, holds: [{ sessionKey: ME, by: "An", reason: "pausing", since: T }] }), T);
    const deny = hooks(c).refuse(codexEv({ hookEvent: "PreToolUse", tool: "Bash", command: "ls -la" }), "PreToolUse")!;
    expect(deny).toMatch(/^Held by An: pausing\. /);
    expect(deny).toContain("the workmesh `send` tool");
    expect(deny).not.toContain("in the shell");
  });

  it("a lease refusal asks through the send tool; Codex's own period isn't doubled", () => {
    const c = coord();
    c.apply(
      hubSyncAcceptSchema.parse({
        ...SYNC,
        leases: [{ id: "ls_1", repo: "b3-fun/workmesh", paths: ["app.ts"], holder: { person: "An", sessionKey: "dev_X:codex:t9", sessionName: undefined }, since: T, expiresAt: T + 30 * 60_000, reason: "refactoring answer" }],
      }),
      T,
    );
    const deny = hooks(c).refuse(codexEv({ hookEvent: "PreToolUse", tool: "apply_patch", filePath: `${ROOT}/app.ts` }), "PreToolUse")!;
    expect(deny).toContain("ask An to hand it over with the workmesh `send` tool (to: An)");
    expect(deny).not.toContain("`workmesh send An");
    const out = JSON.parse(hookOutput("PreToolUse", { deny }, "codex")!) as { hookSpecificOutput: { permissionDecisionReason: string } };
    expect(out.hookSpecificOutput.permissionDecisionReason.endsWith(".")).toBe(false);
    const claude = JSON.parse(hookOutput("PreToolUse", { deny })!) as { hookSpecificOutput: { permissionDecisionReason: string } };
    expect(claude.hookSpecificOutput.permissionDecisionReason).toBe(deny);
  });

  it("the session-start note names the MCP tools only for Codex", () => {
    expect(guidance("B3", false, false, true)).toContain("the workmesh tools (MCP server `workmesh`):");
    expect(guidance("B3")).toContain("or the `workmesh` CLI");
  });
});

describe("doctor: what Codex really runs", () => {
  const CMD = '"/usr/local/bin/node" "/opt/workmesh/packages/cli/dist/index.js" hook codex-hooks';
  const HOOKS = JSON.stringify({
    hooks: Object.fromEntries(
      ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop", "SessionEnd"].map((e) => [
        e,
        [{ hooks: [{ type: "command", command: "'/x/harness/notify.mjs'", timeout: 5 }] }, { hooks: [{ type: "command", command: CMD, timeout: 5 }] }],
      ]),
    ),
  });

  it("names events as Codex's state keys do", () => {
    expect(codexEventKey("PreToolUse")).toBe("pre_tool_use");
    expect(codexEventKey("UserPromptSubmit")).toBe("user_prompt_submit");
    expect(codexEventKey("Stop")).toBe("stop");
  });

  it("reads trust from config.toml's hook state (our hooks at group 1 here), and says what to do", () => {
    const hooksPath = path.join(tmp, "hooks.json");
    fs.writeFileSync(hooksPath, HOOKS);
    const state = (event: string, extra = "") =>
      `[hooks.state."${hooksPath}:${codexEventKey(event)}:1:0"]\ntrusted_hash = "sha256:546d997f0d6cee7d4b9b7c32a724bb08c81502888d823559cf49b1f23bb009eb"\n${extra}\n`;
    const all = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop", "SessionEnd"];
    const none = codexTrustFromConfig(hooksPath, HOOKS, 'model = "gpt-6-luna"\n');
    expect(none.hooks).toHaveLength(7);
    expect(describeCodexTrust(none)).toMatchObject({ ok: false });
    expect(describeCodexTrust(none).text).toContain("7 not trusted yet (of 7)");
    expect(describeCodexTrust(none).text).toContain("run /hooks");
    const trusted = codexTrustFromConfig(hooksPath, HOOKS, all.map((e) => state(e)).join("\n"));
    expect(describeCodexTrust(trusted)).toEqual({ ok: true, text: "config.toml says all 7 trusted" });
    const off = codexTrustFromConfig(hooksPath, HOOKS, all.map((e) => state(e, e === "Stop" ? "enabled = false" : "")).join("\n"));
    expect(describeCodexTrust(off).text).toContain("1 turned off");
    // Another tool's hook at group 0 is not ours to report.
    expect(parseHookState(state("Stop")).get(`${hooksPath}:stop:1:0`)).toEqual({ trusted: true });
  });

  it("prefers Codex's own hooks/list answer: trusted, new and changed hooks", () => {
    const entry = (eventName: string, trustStatus: string, command = CMD) => ({ key: `/h:${eventName}:1:0`, eventName, handlerType: "command", command, enabled: true, trustStatus });
    const list = [
      entry("preToolUse", "trusted"),
      entry("stop", "modified"),
      entry("sessionStart", "untrusted"),
      entry("stop", "trusted", "'/x/harness/notify.mjs'"),
    ];
    const t = codexTrustFromList(list)!;
    expect(t).toEqual({
      source: "codex",
      hooks: [
        { event: "PreToolUse", status: "trusted" },
        { event: "Stop", status: "modified" },
        { event: "SessionStart", status: "untrusted" },
      ],
    });
    expect(describeCodexTrust(t).text).toBe(
      "Codex says 1 not trusted yet, 1 changed since you trusted them (of 3): Codex skips them until then — open Codex and run /hooks to trust them",
    );
  });

  it("follows notify through another tool's chain, and says when it leads to a missing or other install", () => {
    const self = path.join(tmp, "workmesh", "packages", "cli", "dist", "index.js");
    fs.mkdirSync(path.dirname(self), { recursive: true });
    fs.writeFileSync(self, "");
    const direct = `notify = ["/usr/local/bin/node", ${JSON.stringify(self)}, "hook", "codex"]\n`;
    expect(codexNotifyState(direct)).toEqual({ kind: "direct", target: self, node: "/usr/local/bin/node" });
    expect(codexNotifyCheck(direct, self)).toMatchObject({ status: "ok", detail: expect.stringContaining("direct, to this install") });
    // Codex Computer Use's line (shape from a live config): the previous notify rides along as a JSON array.
    const old = "/home/me/Documents/agentblip/packages/cli/dist/index.js";
    const prev = JSON.stringify(["/usr/local/bin/node", old, "hook", "codex"]).replace(/\//g, "\\/");
    const chained = `notify = ["/Apps/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient", "turn-ended", "--previous-notify", ${JSON.stringify(prev)}]\n`;
    expect(codexNotifyState(chained)).toEqual({ kind: "chained", via: "SkyComputerUseClient", target: old });
    expect(codexNotifyCheck(chained, self)).toMatchObject({ status: "warn", detail: expect.stringContaining("which no longer exists") });
    const other = path.join(tmp, "other", "dist", "index.js");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, "");
    const toOther = `notify = ["/usr/local/bin/node", ${JSON.stringify(other)}, "hook", "codex"]\n`;
    expect(codexNotifyCheck(toOther, self)).toMatchObject({ status: "warn", detail: expect.stringContaining("another Workmesh install") });
    expect(codexNotifyState('notify = ["/bin/say", "done"]\n')).toEqual({ kind: "other", via: "say" });
    expect(codexNotifyState('model = "x"\n')).toEqual({ kind: "none" });
  });
});

describe("uninstall leaves Codex a config it can load", () => {
  it("takes Codex's own [mcp_servers.workmesh.tools.*] tables out with ours", () => {
    const file = path.join(tmp, "config.toml");
    fs.writeFileSync(file, 'model = "gpt-6-luna"\n\n[projects."/w"]\ntrust_level = "trusted"\n');
    installCodexMcp(file);
    // What "Always allow" wrote, live:
    fs.appendFileSync(file, '\n[mcp_servers.workmesh.tools.whoami]\napproval_mode = "approve"\n\n[mcp_servers.workmesh.tools.roster]\napproval_mode = "approve"\n\n[tui]\nscreen_reader_detection_done = true\n');
    expect(removeCodexMcp(file).removed).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toContain("mcp_servers.workmesh");
    expect(text).toContain('[projects."/w"]');
    expect(text).toContain("[tui]\nscreen_reader_detection_done = true");
  });
});

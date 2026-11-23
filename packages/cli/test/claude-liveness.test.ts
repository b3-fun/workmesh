import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "@agentblip/core";
import type { AgentSession } from "@agentblip/core";
import {
  ClaudeLiveness,
  DEAD_SESSION_GRACE_MS,
  readLiveClaudeSessions,
} from "../src/daemon/claude-liveness";
import type { ClaudeProcess } from "../src/daemon/claude-liveness";

const T = 1_700_000_000_000;

function sessions(
  ...specs: Array<{ id: string; state?: "working" | "waiting" | "idle"; source?: string; name?: string }>
): AgentSession[] {
  const store = new SessionStore();
  for (const s of specs) {
    store.apply({ source: s.source ?? "claude-code", sessionId: s.id, kind: s.state ?? "working", name: s.name }, T);
  }
  return [...store.list()];
}

const live = (...procs: Array<Partial<ClaudeProcess> & { sessionId: string }>) =>
  new Map(procs.map((p) => [p.sessionId, { pid: 1, ...p }]));

describe("ClaudeLiveness", () => {
  it("reaps a session whose process vanished past the grace period", () => {
    const l = new ClaudeLiveness();
    const s = sessions({ id: "a" }, { id: "b" });
    expect(l.step(s, live({ sessionId: "a" }, { sessionId: "b" }), T).reap).toEqual([]);
    // b's process is gone: kept within the grace…
    expect(l.step(s, live({ sessionId: "a" }), T + 60_000).reap).toEqual([]);
    // …ended after it
    expect(l.step(s, live({ sessionId: "a" }), T + DEAD_SESSION_GRACE_MS + 1).reap).toEqual([
      "claude-code:b",
    ]);
  });

  it("measures the grace from the last time the process was seen alive", () => {
    const l = new ClaudeLiveness(1000);
    const s = sessions({ id: "a" });
    l.step(s, live({ sessionId: "a" }), T);
    l.step(s, live({ sessionId: "a" }), T + 5000); // still alive at +5s
    expect(l.step(s, live(), T + 5500).reap).toEqual([]);
    expect(l.step(s, live(), T + 6001).reap).toEqual(["claude-code:a"]);
  });

  it("never reaps a session it never saw alive (old Claude Code, other config dir)", () => {
    const l = new ClaudeLiveness(1000);
    const s = sessions({ id: "ghost" });
    expect(l.step(s, live(), T).reap).toEqual([]);
    expect(l.step(s, live(), T + 60_000).reap).toEqual([]);
  });

  it("reaps nothing when the sessions dir can't be read", () => {
    const l = new ClaudeLiveness(1000);
    const s = sessions({ id: "a" });
    l.step(s, live({ sessionId: "a" }), T);
    expect(l.step(s, undefined, T + 60_000).reap).toEqual([]);
  });

  it("ignores other sources", () => {
    const l = new ClaudeLiveness(1000);
    const s = sessions({ id: "wf", source: "workflow" }, { id: "cx", source: "codex" });
    const out = l.step(s, live(), T + 60_000);
    expect(out).toEqual({ reap: [], touch: [], names: [] });
  });

  it("touches working sessions Claude reports busy or running shells, not idle ones", () => {
    const l = new ClaudeLiveness();
    const s = sessions({ id: "busy" }, { id: "shell" }, { id: "idle" }, { id: "waits", state: "waiting" });
    const out = l.step(
      s,
      live(
        { sessionId: "busy", status: "busy" },
        { sessionId: "shell", status: "shell" },
        { sessionId: "idle", status: "idle" },
        { sessionId: "waits", status: "busy" },
      ),
      T,
    );
    expect(out.touch.sort()).toEqual(["claude-code:busy", "claude-code:shell"]);
  });

  it("reports new or changed session names only", () => {
    const l = new ClaudeLiveness();
    const s = sessions({ id: "a", name: "documents-07" }, { id: "b" });
    const out = l.step(s, live({ sessionId: "a", name: "documents-07" }, { sessionId: "b", name: "agentblip-2" }), T);
    expect(out.names).toEqual([["claude-code:b", "agentblip-2"]]);
  });
});

describe("readLiveClaudeSessions", () => {
  it("reads live session files and skips dead pids and junk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-live-"));
    fs.mkdirSync(path.join(dir, "sessions"));
    const write = (name: string, body: string) => fs.writeFileSync(path.join(dir, "sessions", name), body);
    write("11.json", JSON.stringify({ pid: 11, sessionId: "a", name: "documents-07", status: "idle" }));
    write("12.json", JSON.stringify({ pid: 12, sessionId: "b", status: "busy" }));
    write("13.json", "{half-writ");
    write("14.key", "secret");
    write("15.json", JSON.stringify({ pid: "x", sessionId: "c" }));
    const map = readLiveClaudeSessions(dir, (pid) => pid === 11);
    expect([...(map?.keys() ?? [])]).toEqual(["a"]);
    expect(map?.get("a")).toEqual({ pid: 11, sessionId: "a", name: "documents-07", status: "idle" });
  });

  it("is undefined when the dir is missing", () => {
    expect(readLiveClaudeSessions(path.join(os.tmpdir(), "ab-nope-xyz"))).toBeUndefined();
  });
});

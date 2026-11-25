import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/aggregate";
import type { SessionEvent } from "../src/events";

const ev = (over: Partial<SessionEvent> = {}): SessionEvent => ({
  source: "claude-code",
  sessionId: "s1",
  kind: "working",
  ...over,
});

describe("SessionStore", () => {
  it("tracks a session through its lifecycle", () => {
    const store = new SessionStore();
    store.apply(ev({ kind: "start" }), 1000);
    expect(store.snapshot().sessions[0]?.state).toBe("idle");

    store.apply(ev({ kind: "working", activity: "editing app.ts" }), 2000);
    const snap = store.snapshot();
    expect(snap.working).toBe(1);
    expect(snap.latestActivity).toBe("editing app.ts");

    store.apply(ev({ kind: "end" }), 3000);
    expect(store.snapshot().total).toBe(0);
  });

  it("counts sessions across sources independently", () => {
    const store = new SessionStore();
    store.apply(ev(), 1000);
    store.apply(ev({ source: "codex", sessionId: "s2" }), 1001);
    store.apply(ev({ sessionId: "s3", kind: "waiting" }), 1002);
    const snap = store.snapshot();
    expect(snap.total).toBe(3);
    expect(snap.working).toBe(2);
    expect(snap.waiting).toBe(1);
  });

  it("keeps previous activity for label-less working events", () => {
    const store = new SessionStore();
    store.apply(ev({ activity: "running tests" }), 1000);
    store.apply(ev(), 2000);
    expect(store.snapshot().latestActivity).toBe("running tests");
  });

  it("heartbeat refreshes liveness without changing state", () => {
    const store = new SessionStore({ workingStaleMs: 5000 });
    store.apply(ev({ kind: "waiting" }), 1000);
    store.apply(ev({ kind: "heartbeat" }), 4000);
    store.sweep(8000); // 4000ms since heartbeat < 5000ms stale threshold
    expect(store.snapshot().waiting).toBe(1);
  });

  it("drops out-of-order events", () => {
    const T = 1_700_000_000_000;
    const store = new SessionStore();
    store.apply(ev({ kind: "idle" }), T + 5000);
    store.apply(ev({ kind: "working", ts: T + 1000 }), T + 6000);
    expect(store.snapshot().working).toBe(0);
  });

  it("clamps implausible client timestamps to receipt time", () => {
    const store = new SessionStore({ workingStaleMs: 1000 });
    const now = 1_700_000_000_000;
    // Far-future ts must not wedge the session past every sweep threshold…
    store.apply(ev({ ts: now + 86_400_000 }), now);
    store.sweep(now + 2000);
    expect(store.snapshot().working).toBe(0);
    // …and pre-2001 ts (broken clock) must not be dropped as out-of-order.
    const store2 = new SessionStore();
    store2.apply(ev({ kind: "idle" }), now);
    store2.apply(ev({ kind: "working", ts: 999 }), now + 1000);
    expect(store2.snapshot().working).toBe(1);
  });

  it("gives waiting sessions a longer staleness leash than working ones", () => {
    const store = new SessionStore({
      workingStaleMs: 1000,
      waitingStaleMs: 10_000,
    });
    store.apply(ev({ kind: "waiting" }), 1000);
    store.apply(ev({ sessionId: "s2", kind: "working" }), 1000);

    store.sweep(3000); // working stale, waiting not
    expect(store.snapshot().working).toBe(0);
    expect(store.snapshot().waiting).toBe(1);

    store.sweep(12_500); // now the waiting session is stale too
    expect(store.snapshot().waiting).toBe(0);
  });

  it("sweep demotes stale working sessions then evicts idle ones", () => {
    const store = new SessionStore({ workingStaleMs: 1000, idleEvictMs: 2000 });
    store.apply(ev({ activity: "thinking" }), 1000);

    store.sweep(2500); // silent 1500ms > workingStaleMs
    let snap = store.snapshot();
    expect(snap.working).toBe(0);
    expect(snap.idle).toBe(1);
    expect(snap.latestActivity).toBeUndefined();

    store.sweep(10_000); // long past idleEvictMs
    expect(store.snapshot().total).toBe(0);
  });

  it("signature changes with state and is order-independent", () => {
    const store = new SessionStore();
    store.apply(ev(), 1000);
    const a = store.snapshot().signature;
    store.apply(ev({ sessionId: "s2", kind: "waiting" }), 2000);
    const b = store.snapshot().signature;
    expect(a).not.toBe(b);

    const store2 = new SessionStore();
    store2.apply(ev({ sessionId: "s2", kind: "waiting" }), 500);
    store2.apply(ev(), 600);
    expect(store2.snapshot().signature).toBe(b);
  });

  it("stateSince marks when the current state began, not the last event", () => {
    const store = new SessionStore();
    store.apply(ev({ kind: "working", activity: "thinking" }), 1000);
    store.apply(ev({ kind: "working", activity: "editing a.ts" }), 5000);
    expect(store.snapshot().sessions[0]?.stateSince).toBe(1000);
    store.apply(ev({ kind: "waiting" }), 9000);
    expect(store.snapshot().sessions[0]?.stateSince).toBe(9000);
    store.apply(ev({ kind: "heartbeat" }), 12_000);
    expect(store.snapshot().sessions[0]?.stateSince).toBe(9000);
  });

  it("sweep demotion resets stateSince and clears background", () => {
    const store = new SessionStore({ workingStaleMs: 1000 });
    store.apply(ev({ background: true }), 1000);
    store.sweep(5000);
    const s = store.snapshot().sessions[0];
    expect(s?.state).toBe("idle");
    expect(s?.stateSince).toBe(5000);
    expect(s?.background).toBeUndefined();
  });

  it("background is set only by the event that reports it; heartbeats keep it", () => {
    const store = new SessionStore();
    store.apply(ev({ activity: "running in background", background: true }), 1000);
    expect(store.snapshot().sessions[0]?.background).toBe(true);
    store.apply(ev({ kind: "heartbeat" }), 2000);
    expect(store.snapshot().sessions[0]?.background).toBe(true);
    store.apply(ev({ activity: "running commands" }), 3000);
    expect(store.snapshot().sessions[0]?.background).toBeUndefined();
    // never on a non-working session
    store.apply(ev({ kind: "idle", background: true }), 4000);
    expect(store.snapshot().sessions[0]?.background).toBeUndefined();
  });

  it("keeps cwd and name sticky across events", () => {
    const store = new SessionStore();
    store.apply(ev({ cwd: "/x/workmesh", name: "workmesh-1" }), 1000);
    store.apply(ev({ activity: "thinking" }), 2000);
    const s = store.snapshot().sessions[0];
    expect(s?.cwd).toBe("/x/workmesh");
    expect(s?.name).toBe("workmesh-1");
  });

  it("remove drops a session; annotate sets a name without counting as activity", () => {
    const store = new SessionStore();
    store.apply(ev(), 1000);
    store.apply(ev({ sessionId: "s2" }), 1000);
    store.annotate("claude-code:s1", { name: "documents-07" });
    const s1 = store.snapshot().sessions.find((s) => s.sessionId === "s1");
    expect(s1?.name).toBe("documents-07");
    expect(s1?.updatedAt).toBe(1000);
    store.annotate("claude-code:missing", { name: "x" }); // no-op, no throw
    expect(store.remove("claude-code:s1")).toBe(true);
    expect(store.remove("claude-code:s1")).toBe(false);
    expect(store.snapshot().sessions.map((s) => s.sessionId)).toEqual(["s2"]);
  });

  it("folds orchestrated sessions into their orchestrator's row", () => {
    const store = new SessionStore();
    store.apply(ev({ sessionId: "parent", activity: "orchestrating a workflow" }), 1000);
    store.apply(
      ev({ source: "workflow", sessionId: "wf1", agents: 5, orchestrator: "claude-code:parent" }),
      1001,
    );
    store.apply(ev({ source: "workflow", sessionId: "wf2", agents: 3 }), 1002); // no parent
    store.apply(ev({ source: "workflow", sessionId: "wf3", agents: 2, orchestrator: "claude-code:gone" }), 1003);
    const snap = store.snapshot();
    const by = (id: string) => snap.sessions.find((s) => s.sessionId === id);
    expect(by("parent")?.subagents).toBe(5);
    expect(by("parent")?.foldedInto).toBeUndefined();
    expect(by("wf1")?.foldedInto).toBe("claude-code:parent");
    expect(by("wf2")?.subagents).toBe(2); // its own fan-out beyond itself
    expect(by("wf2")?.foldedInto).toBeUndefined();
    expect(by("wf3")?.foldedInto).toBeUndefined(); // orchestrator not present
    expect(snap.agentCount).toBe(10); // unchanged: 5 + 3 + 2, parent subsumed
  });

  it("touch keeps a busy session from going stale without bumping updatedAt", () => {
    const store = new SessionStore({ workingStaleMs: 1000 });
    store.apply(ev({ activity: "running commands" }), 1000);
    store.touch("claude-code:s1", 1800);
    store.sweep(2500); // 1500 since the event, 700 since the touch
    const s = store.snapshot().sessions[0];
    expect(s?.state).toBe("working");
    expect(s?.updatedAt).toBe(1000);
    // a hook event stamped before the touch still applies (not out-of-order)
    store.apply(ev({ kind: "idle", ts: 1700 }), 2600);
    expect(store.snapshot().sessions[0]?.state).toBe("idle");
    store.touch("claude-code:nope", 3000); // unknown key: no-op
    expect(store.snapshot().total).toBe(1);
  });

  it("restore puts saved sessions back without overriding newer ones, and sweep ages them", () => {
    const store = new SessionStore();
    const t = 1_795_545_600_000;
    store.apply({ source: "claude-code", sessionId: "live", kind: "working", activity: "editing a.ts", ts: t }, t);
    const saved = [
      { key: "claude-code:live", source: "claude-code", sessionId: "live", state: "idle" as const, agents: 1, startedAt: t - 9, updatedAt: t - 9, stateSince: t - 9 },
      { key: "claude-code:old", source: "claude-code", sessionId: "old", state: "working" as const, activity: "thinking", agents: 1, startedAt: t - 60_000, updatedAt: t - 60_000, stateSince: t - 60_000 },
      { key: "bad-key", source: "claude-code", sessionId: "x", state: "idle" as const, agents: 1, startedAt: t, updatedAt: t, stateSince: t },
      { key: "codex:future", source: "codex", sessionId: "future", state: "idle" as const, agents: 1, startedAt: t, updatedAt: t + 3600_000, stateSince: t },
    ];
    expect(store.restore(saved, t)).toBe(1);
    expect(store.get("claude-code:live")?.state).toBe("working");
    expect(store.get("claude-code:old")).toMatchObject({ state: "working", updatedAt: t - 60_000 });
    store.sweep(t + 4 * 60_000);
    expect(store.get("claude-code:old")?.state).toBe("idle");
  });
});

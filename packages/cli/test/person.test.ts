import { describe, expect, it } from "vitest";
import { hubSyncAcceptSchema } from "@workmesh/protocol";
import type { HubHandoffAccepted, HubSyncResponse } from "@workmesh/protocol";
import type { AgentSession, SessionEvent } from "@workmesh/core";
import { CoordClient } from "../src/hub/coord";
import { Delegate, decisionText } from "../src/daemon/delegate";
import type { HandoffRunnerLike } from "../src/daemon/delegate";
import { CoordHooks, claimsLine, gateNote, knowledge } from "../src/daemon/coord-hooks";
import { recipient, runCoordOp } from "../src/daemon/coord-ops";
import type { CoordOpsDeps } from "../src/daemon/coord-ops";
import { emailKey, gateApprovers, samePerson } from "../src/lib/person";

/**
 * People by email (docs/SPEC.md §48, §49). Two people can share a display name. The relay matches a person the hub
 * names by email when both sides have one, and by display name with a hub that sends no emails.
 */

const TOKEN = `bp_${"e".repeat(64)}`;
const DEV = "dev_01JD0000000000000000000000";
const OTHER_DEV = "dev_01JDOTHEROTHEROTHEROTHER00";
const T = 1_795_545_600_000;
const LOCAL = "claude-code:s1";
const MINE = `${DEV}:${LOCAL}`;
const THEIRS = `${OTHER_DEV}:claude-code:o1`;
const ROOT = "/w/demo";

/** This machine's person, and a teammate with the same display name. */
const SAM = "sam@example.com";
const OTHER_SAM = "sam.lee@example.org";
const me = { person: "Sam Lee", email: SAM };
const namesake = { person: "Sam Lee", email: OTHER_SAM };

describe("samePerson (SPEC §49)", () => {
  it("with an email on both sides, the email decides", () => {
    // Equal names with different emails are two people.
    expect(samePerson(me, namesake)).toBe(false);
    // One email under two display names is one person: the email wins over the name.
    expect(samePerson(me, { person: "Samuel L.", email: SAM })).toBe(true);
    expect(samePerson(me, { person: "Sam Lee", email: SAM })).toBe(true);
    expect(samePerson({ person: "An", email: "an@example.com" }, { person: "An", email: "an@example.org" })).toBe(false);
  });

  it("emails are compared without case; anything that is not an email counts as none", () => {
    expect(samePerson(me, { person: "S", email: "Sam@Example.COM" })).toBe(true);
    expect(emailKey(" Sam@Example.com ")).toBe(SAM);
    for (const none of [undefined, null, "", "Sam Lee", "sam@", "sam lee@example.com", `${"a".repeat(250)}@example.com`]) {
      expect(emailKey(none), JSON.stringify(none)).toBeUndefined();
    }
    // A malformed email on one side falls back to the names.
    expect(samePerson(me, { person: "Sam Lee", email: "not an email" })).toBe(true);
    expect(samePerson(me, { person: "An", email: "not an email" })).toBe(false);
  });

  it("with no email on either side, the display names decide, as before", () => {
    expect(samePerson({ person: "Sam Lee" }, { person: "sam lee" })).toBe(true);
    expect(samePerson(me, { person: "SAM LEE" })).toBe(true);
    expect(samePerson({ person: "Sam Lee" }, namesake)).toBe(true);
    expect(samePerson({ person: "Sam Lee" }, { person: "An" })).toBe(false);
    expect(samePerson(me, { person: "An" })).toBe(false);
  });

  it("a missing or empty name matches nobody", () => {
    expect(samePerson(undefined, me)).toBe(false);
    expect(samePerson(me, undefined)).toBe(false);
    expect(samePerson({}, {})).toBe(false);
    expect(samePerson({ person: "" }, { person: "" })).toBe(false);
    expect(samePerson({ person: undefined, email: SAM }, { person: "Sam Lee" })).toBe(false);
  });

  it("a gate's approvers pair up with their emails; with no approvers, the owner answers", () => {
    expect(gateApprovers({ owner: "Sam Lee", ownerEmail: SAM, approvers: ["Sam Lee", "An"], approverEmails: [OTHER_SAM, "an@example.com"] })).toEqual([
      { person: "Sam Lee", email: OTHER_SAM },
      { person: "An", email: "an@example.com" },
    ]);
    expect(gateApprovers({ owner: "Sam Lee", ownerEmail: SAM, approvers: ["An"] })).toEqual([{ person: "An", email: undefined }]);
    expect(gateApprovers({ owner: "Sam Lee", ownerEmail: SAM })).toEqual([{ person: "Sam Lee", email: SAM }]);
    expect(gateApprovers({ owner: "Sam Lee", approvers: [] })).toEqual([{ person: "Sam Lee", email: undefined }]);
  });
});

// ------------------------------------------------------------------ a relay paired as Sam Lee <sam@example.com>

const BASE: HubSyncResponse = {
  cursor: "c1",
  serverNow: T,
  me,
  leases: [],
  holds: [],
  inbox: [],
  claims: [],
  roster: [],
  notes: [],
  edits: [],
  handoffs: [],
  gates: [],
  approvals: [],
};

class FakeRunner implements HandoffRunnerLike {
  ran: string[] = [];
  private readonly ids = new Set<string>();
  running(): ReadonlySet<string> {
    return this.ids;
  }
  hasRoom(): boolean {
    return true;
  }
  cannotRun(): string | undefined {
    return undefined;
  }
  run(h: HubHandoffAccepted): void {
    this.ran.push(h.id);
    this.ids.add(h.id);
  }
}

/** A relay as the daemon builds it. `paired`: what pairing answered (absent: a config with no person). */
function relay(opts: { paired?: { name?: string; email?: string }; replies?: Array<{ status: number; body?: unknown }> } = {}) {
  const paired = opts.paired ?? { name: "Sam Lee", email: SAM };
  const calls: Array<{ url: string; body?: unknown }> = [];
  const replies = [...(opts.replies ?? [])];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined });
    const r = replies.shift() ?? { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
  const session: AgentSession = { key: LOCAL, source: "claude-code", sessionId: "s1", state: "working", agents: 1, startedAt: T, updatedAt: T, stateSince: T, cwd: ROOT };
  const runner = new FakeRunner();
  let d: Delegate | undefined;
  const coord = new CoordClient({
    url: "https://hub.test",
    token: TOKEN,
    deviceId: DEV,
    person: paired.name,
    personEmail: paired.email,
    fetchImpl,
    now: () => T,
    onSync: (n, p) => d?.onSync(n, p),
  });
  d = new Delegate({
    coord: () => coord,
    getSession: (k) => (k === LOCAL ? session : undefined),
    isShared: () => true,
    repoOf: (dir) => (dir.startsWith(ROOT) ? "b3-fun/demo" : undefined),
    settings: () => ({ wake: true, accept: "auto-self", customGates: [] }),
    runner,
    now: () => T,
  });
  const hooks = new CoordHooks({
    coord: () => coord,
    classify: (p) => (p === ROOT || p.startsWith(`${ROOT}/`) ? { root: ROOT, repo: "b3-fun/demo" } : undefined),
    isShared: () => true,
    projectName: () => "B3",
    now: () => T,
    home: "/home/me",
  });
  const ops: CoordOpsDeps = {
    coord: () => coord,
    hub: () => ({ url: "https://hub.test", project: { name: "B3" }, person: paired.name ? { name: paired.name } : undefined, deviceId: DEV }),
    getSession: (k) => (k === LOCAL ? session : undefined),
    listSessions: () => [session],
    classify: () => undefined,
    isShared: () => true,
    claudeSessions: () => undefined,
    now: () => T,
    home: "/home/me",
  };
  const sync = (over: Partial<HubSyncResponse> = {}) => coord.apply(hubSyncAcceptSchema.parse({ ...BASE, ...over }), T);
  return { coord, d: d!, hooks, ops, runner, calls, sync };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const handoff = (over: Record<string, unknown> = {}) =>
  ({
    id: "h_1",
    from: { ...me, sessionKey: THEIRS, sessionName: "laptop" },
    to: me,
    task: "Port the key rotation",
    repo: "b3-fun/demo",
    status: "offered",
    createdAt: T,
    ...over,
  }) as NonNullable<HubSyncResponse["handoffs"]>[number];

const event = (detail: NonNullable<SessionEvent["detail"]>): SessionEvent => ({ source: "claude-code", sessionId: "s1", kind: "working", ts: T, cwd: ROOT, detail });
const bash = (command: string) => event({ hookEvent: "PreToolUse", tool: "Bash", command });
const edit = (filePath: string) => event({ hookEvent: "PreToolUse", tool: "Edit", filePath });

describe("the relay's own person (SPEC §49)", () => {
  it("has the email pairing answered; a sync's own `me.email` wins", () => {
    const x = relay({ paired: { name: "Sam Lee", email: "Sam@Example.com" } });
    expect(x.coord.self()).toEqual(me);
    x.sync({ me: { person: "Sam Lee" } });
    expect(x.coord.self()).toEqual(me);
    x.sync({ me: { person: "Sam L.", email: "sam@example.net" } });
    expect(x.coord.self()).toEqual({ person: "Sam L.", email: "sam@example.net" });
    expect(x.coord.isMe(me)).toBe(false);
    expect(x.coord.isMe({ person: "Somebody", email: "SAM@example.net" })).toBe(true);
  });

  it("with no email from the hub, people are matched by display name", () => {
    const x = relay({ paired: { name: "Sam Lee" } });
    x.sync({ me: { person: "Sam Lee" } });
    expect(x.coord.self()).toEqual({ person: "Sam Lee", email: undefined });
    expect(x.coord.isMe(namesake)).toBe(true);
    expect(x.coord.isMe({ person: "An", email: SAM })).toBe(false);
    const unpaired = relay({ paired: {} });
    expect(unpaired.coord.isMe(me)).toBe(false);
  });
});

describe("handoffs: only this person's own are taken without a click (SPEC §49)", () => {
  it("a handoff whose sender has my display name but another email is not treated as mine", async () => {
    const x = relay();
    x.sync({ handoffs: [handoff({ from: { ...namesake, sessionKey: THEIRS, sessionName: "laptop" } })] });
    await flush();
    // Offered to me by a namesake: it waits for my Accept; the auto-self policy does not take it.
    expect(x.calls).toEqual([]);
    expect(x.runner.ran).toEqual([]);
    expect(x.d.summary(() => undefined)?.handoffs.map((h) => [h.id, h.status])).toEqual([["h_1", "offered"]]);
  });

  it("one I sent from another machine is accepted here and started, whatever name the hub shows for me", async () => {
    const accepted = { status: 200, body: { ok: true, handoff: handoff({ status: "accepted", device: DEV }) } };
    const x = relay({ replies: [accepted] });
    x.sync({ handoffs: [handoff({ from: { person: "Samuel L.", email: "SAM@example.com", sessionKey: THEIRS } })] });
    await flush();
    expect(x.calls).toEqual([{ url: "https://hub.test/relay/handoffs", body: { action: "accept", id: "h_1" } }]);
    expect(x.runner.ran).toEqual(["h_1"]);
  });

  it("one I sent to a namesake is theirs: not offered to me, never accepted or started here", async () => {
    const x = relay();
    const mineToThem = handoff({ from: { ...me, sessionKey: MINE }, to: namesake });
    x.sync({ handoffs: [mineToThem] });
    x.sync({ handoffs: [{ ...mineToThem, status: "accepted" }] });
    await flush();
    expect(x.calls).toEqual([]);
    expect(x.runner.ran).toEqual([]);
    expect(x.d.summary(() => undefined)?.handoffs).toEqual([]);
    const list = await runCoordOp({ op: "handoffs", args: {}, caller: {} }, x.ops);
    expect(list.text).toBe("- h_1 · accepted · to Sam Lee · b3-fun/demo: Port the key rotation");
  });

  it("a hub that sends no emails: the display name decides, as before", async () => {
    const accepted = { status: 200, body: { ok: true, handoff: handoff({ status: "accepted", device: DEV, from: { person: "Sam Lee" }, to: { person: "Sam Lee" } }) } };
    const x = relay({ replies: [accepted] });
    x.sync({ me: { person: "Sam Lee" }, handoffs: [handoff({ from: { person: "sam lee", sessionKey: THEIRS }, to: { person: "Sam Lee" } })] });
    await flush();
    expect(x.calls.map((c) => c.body)).toEqual([{ action: "accept", id: "h_1" }]);
    expect(x.runner.ran).toEqual(["h_1"]);
  });
});

describe("gates and approvals: a namesake's are not mine (SPEC §49)", () => {
  const theirs = { owner: "Sam Lee", ownerEmail: OTHER_SAM, actions: ["merge" as const] };
  const mine = { owner: "Sam Lee", ownerEmail: SAM, actions: ["deploy" as const] };

  it("the relay enforces its own person's policy, whichever comes first in the list", () => {
    for (const gates of [[theirs, mine], [mine, theirs]]) {
      const x = relay();
      x.sync({ gates });
      expect(x.d.gateRefusal(bash("gh pr merge 212 --merge"), "PreToolUse")).toBeUndefined();
      expect(x.d.gateRefusal(bash("npx wrangler deploy"), "PreToolUse")).toMatch(/^Waiting for Sam Lee's approval to deploy/);
    }
  });

  it("the session-start note and `gates` read my policy", async () => {
    const x = relay();
    x.sync({ gates: [theirs, mine] });
    const start: SessionEvent = { source: "claude-code", sessionId: "s1", kind: "start", ts: T, detail: { hookEvent: "SessionStart" } };
    const ctx = x.hooks.context(start, "SessionStart")!;
    expect(ctx).toContain("when this session tries to deploy, Workmesh holds the command");
    expect(ctx).not.toContain("merge a PR");
    const list = await runCoordOp({ op: "gates", args: {}, caller: {} }, x.ops);
    expect(list.text).toBe("Your agents ask before they: deploy.\nSam Lee: merge");
  });

  it("`gates set` updates my policy and leaves the namesake's alone", async () => {
    const x = relay({ replies: [{ status: 200, body: { ok: true } }] });
    x.sync({ gates: [theirs, { ...mine, approvers: ["An"], approverEmails: ["an@example.com"] }] });
    await runCoordOp({ op: "gates", args: { set: "publish" }, caller: {} }, x.ops);
    expect(x.coord.view().state?.gates).toEqual([theirs, { owner: "Sam Lee", ownerEmail: SAM, actions: ["publish"], approvers: ["An"], approverEmails: ["an@example.com"] }]);
  });

  it("a namesake who is an approver is someone else: in the note, in the decision, in who may decide", () => {
    const x = relay();
    const policy = { ...mine, approvers: ["Sam Lee", "Sam Lee"], approverEmails: [SAM, OTHER_SAM] };
    const theirAsk = { id: "ap_2", sessionKey: THEIRS, owner: "Sam Lee", ownerEmail: OTHER_SAM, gate: "merge" as const, detail: "gh pr merge 9 in b3-fun/demo", status: "pending" as const, ts: T };
    const anAsk = { ...theirAsk, id: "ap_3", owner: "An", ownerEmail: "an@example.com" };
    x.sync({
      gates: [policy, { ...theirs, approvers: ["Sam Lee"], approverEmails: [OTHER_SAM] }, { owner: "An", ownerEmail: "an@example.com", actions: ["merge"], approvers: ["Sam Lee"], approverEmails: [SAM] }],
      approvals: [theirAsk, anAsk],
    });
    const start: SessionEvent = { source: "claude-code", sessionId: "s1", kind: "start", ts: T, detail: { hookEvent: "SessionStart" } };
    expect(x.hooks.context(start, "SessionStart")).toContain("asks Sam Lee (or Sam Lee, whom Sam Lee named) on the team board");
    // The namesake's own approval is theirs to decide; An named me, so An's is mine to decide.
    expect(x.d.summary(() => undefined)?.approvals.map((a) => [a.id, a.canDecide])).toEqual([["ap_3", true]]);
    const decided = { id: "ap_1", sessionKey: MINE, owner: "Sam Lee", ownerEmail: SAM, gate: "deploy" as const, detail: "wrangler deploy in b3-fun/demo", status: "approved" as const, ts: T, decidedAt: T, by: "Sam Lee", via: undefined, note: undefined };
    expect(decisionText({ ...decided, byEmail: OTHER_SAM }, "deploy", "npx wrangler deploy", "Sam Lee", SAM)).toMatch(
      /^Workmesh: Sam Lee, whom your person Sam Lee named to answer their approvals, approved /,
    );
    expect(decisionText({ ...decided, byEmail: SAM }, "deploy", "npx wrangler deploy", "Sam Lee", SAM)).toMatch(/^Workmesh: Your person, Sam Lee, approved /);
    // No email on the decision (an older hub): the name decides, as before.
    expect(decisionText(decided, "deploy", "npx wrangler deploy", "Sam Lee", SAM)).toMatch(/^Workmesh: Your person, Sam Lee, approved /);
    expect(gateNote("Sam Lee", ["deploy"], ["Sam Lee", "An"])).toContain("asks Sam Lee (or An, whom Sam Lee named)");
  });
});

describe("leases, edits and claims of a namesake are another person's (SPEC §49)", () => {
  const theirLease = { id: "ls_1", repo: "b3-fun/demo", paths: ["src/**"], holder: { ...namesake, sessionKey: THEIRS, sessionName: "docs-1" }, expiresAt: T + 20 * 60_000 };

  it("a lease refusal names the namesake as a teammate, and my own other session as mine", () => {
    const x = relay();
    x.sync({ leases: [theirLease] });
    const deny = x.hooks.refuse(edit(`${ROOT}/src/api.ts`), "PreToolUse")!;
    expect(deny).toContain("src/api.ts in b3-fun/demo is leased to Sam Lee's agent docs-1");
    expect(deny).toContain('ask Sam Lee to hand it over: `workmesh send "Sam Lee" "…"`');
    expect(deny).not.toContain("your own other session");
    x.sync({ leases: [{ ...theirLease, holder: { person: "Samuel L.", email: SAM, sessionKey: `${DEV}:codex:t7`, sessionName: "codex-2" } }] });
    const own = x.hooks.refuse(edit(`${ROOT}/src/api.ts`), "PreToolUse")!;
    expect(own).toContain("leased to your own other session codex-2");
    expect(own).toContain("have that session `unlease` it");
  });

  it("a namesake's recent edit gets the heads-up; my own on another machine does not", () => {
    const x = relay();
    const row = { repo: "b3-fun/demo", path: "src/api.ts", sessionKey: THEIRS, sessionName: "docs-1", ts: T - 60_000 };
    x.sync({ edits: [{ ...row, ...namesake }] });
    expect(x.hooks.context(edit(`${ROOT}/src/api.ts`), "PreToolUse")).toContain("heads up, Sam Lee's agent docs-1 edited src/api.ts (b3-fun/demo) 1 min ago");
    const y = relay();
    y.sync({ edits: [{ ...row, person: "Samuel L.", email: SAM }] });
    expect(y.coord.recentEditsByOthers("b3-fun/demo", "src/api.ts")).toEqual([]);
  });

  it("the open-claims line lists my claims only", () => {
    const claims = [
      { issue: "B3-1", holder: { ...namesake, sessionKey: THEIRS }, since: T },
      { issue: "B3-2", holder: { ...me, sessionKey: MINE }, since: T },
    ];
    expect(claimsLine(claims, "Sam Lee", (hk) => hk === MINE, SAM)).toBe("Your open claims: B3-2 (this session).");
    expect(knowledge([], claims, "Sam Lee", (hk) => hk === MINE, SAM)).toBe("Your open claims: B3-2 (this session).");
    // Without my email (a hub that sends none), both are read as mine by name, as before.
    expect(claimsLine(claims, "Sam Lee", (hk) => hk === MINE)).toBe("Your open claims: B3-1; B3-2 (this session).");
    const x = relay();
    x.sync({ claims });
    const start: SessionEvent = { source: "claude-code", sessionId: "s1", kind: "start", ts: T, detail: { hookEvent: "SessionStart" } };
    expect(x.hooks.context(start, "SessionStart")).toContain("Your open claims: B3-2 (this session).");
  });

  it("a claim this relay just made is mine at once, by email", async () => {
    const x = relay({ replies: [{ status: 200, body: { ok: true } }] });
    x.sync();
    await x.coord.claim({ action: "claim", sessionKey: LOCAL, issue: "B3-3" });
    expect(x.coord.view().state?.claims[0]?.holder).toMatchObject(me);
  });
});

describe("replies: a message from one namesake is no reason to wake the other (SPEC §49)", () => {
  it("a reply is to the person who wrote, by email", () => {
    const x = relay();
    const alexA = { person: "Alex Kim", email: "alex@example.com" };
    const alexB = { person: "Alex Kim", email: "alex.kim@example.org" };
    x.sync({ inbox: [{ id: "m_1", to: MINE, from: { ...alexA, sessionKey: THEIRS, sessionName: "docs-1" }, text: "can you look at src/api.ts?", ts: T }] });
    x.coord.markDelivered(["m_1"]);
    expect(x.coord.isReply(LOCAL, alexA)).toBe(true);
    expect(x.coord.isReply(LOCAL, alexB)).toBe(false);
    // A name alone (a hub that sends no roster emails) is matched by name, as before.
    expect(x.coord.isReply(LOCAL, { person: "alex kim" })).toBe(true);
  });
});

describe("a name a person or an agent typed (SPEC §49)", () => {
  const an = { person: "An", email: "an@example.com", github: "an-b3" };
  const roster = (...people: Array<{ person: string; email?: string; github?: string }>) =>
    hubSyncAcceptSchema.parse({ ...BASE, roster: people.map((p) => ({ ...p, sessions: [] })) });
  const two = roster(me, namesake, an);
  const refusal = { error: '"Sam Lee" matches 2 people on this team: Sam Lee <sam@example.com>; Sam Lee <sam.lee@example.org>. Use one of those emails instead of the name.' };

  it("one person: the request carries their email beside the name", () => {
    expect(recipient("an", undefined, two)).toEqual({ person: "An", email: "an@example.com" });
    expect(recipient("an-b3", undefined, two)).toEqual({ person: "An", email: "an@example.com" });
    expect(recipient("AN@example.com", "person", two)).toEqual({ person: "An", email: "an@example.com" });
    // An email picks one of two people with the same name.
    expect(recipient(OTHER_SAM, undefined, two)).toEqual(namesake);
    expect(recipient("Sam@Example.com", undefined, two)).toEqual(me);
    // The roster lists a person twice: still one person.
    expect(recipient("sam lee", undefined, roster(namesake, namesake))).toEqual(namesake);
  });

  it("a name that fits two people is refused with the choices, never guessed", () => {
    expect(recipient("Sam Lee", undefined, two)).toEqual(refusal);
    expect(recipient("sam lee", "person", two)).toEqual({ ...refusal, error: refusal.error.replace('"Sam Lee"', '"sam lee"') });
    // My own name is a choice even when the roster leaves me out: it never goes to a namesake unasked.
    expect(recipient("Sam Lee", undefined, roster(namesake, an), me)).toEqual({
      error: '"Sam Lee" matches 2 people on this team: Sam Lee <sam.lee@example.org>; Sam Lee <sam@example.com>. Use one of those emails instead of the name.',
    });
    expect(recipient("Sam Lee", undefined, roster(me, an), me)).toEqual(me);
  });

  it("with no emails to tell people apart, the name goes to the hub as before", () => {
    const plain = roster({ person: "Sam Lee" }, { person: "Sam Lee" }, { person: "An", github: "an-b3" });
    expect(recipient("sam lee", undefined, plain)).toEqual({ person: "Sam Lee" });
    expect(recipient("an-b3", undefined, plain, { person: "Sam Lee", email: SAM })).toEqual({ person: "An" });
    expect(recipient("sam lee", undefined, plain, { person: "Sam Lee", email: SAM })).toEqual({ person: "Sam Lee" });
    // One of the two has no email: nothing tells them apart, so the hub resolves the name.
    expect(recipient("Sam Lee", undefined, roster(namesake, { person: "Sam Lee" }))).toEqual({ person: "Sam Lee" });
    // Nobody on the roster by that name: the string goes to the hub unchanged.
    expect(recipient("Riley Park", undefined, two)).toEqual({ person: "Riley Park" });
    expect(recipient("riley@example.com", undefined, two)).toEqual({ person: "riley@example.com" });
  });

  it("send: refuses the shared name and sends nothing; by email it reaches the one person", async () => {
    const x = relay({ replies: [{ status: 200, body: { ok: true, id: "m_7" } }] });
    x.sync({ roster: [{ ...me, sessions: [] }, { ...namesake, sessions: [] }] });
    const no = await runCoordOp({ op: "send", args: { to: "Sam Lee", text: "can I take src/api.ts?" }, caller: {} }, x.ops);
    expect(no).toMatchObject({ ok: false, text: refusal.error });
    expect(x.calls).toEqual([]);
    const ok = await runCoordOp({ op: "send", args: { to: OTHER_SAM, text: "can I take src/api.ts?" }, caller: {} }, x.ops);
    expect(ok).toMatchObject({ ok: true, text: "Sent to Sam Lee (message m_7)." });
    expect(x.calls).toEqual([{ url: "https://hub.test/relay/messages", body: { to: namesake, text: "can I take src/api.ts?" } }]);
  });

  it("handoff: refuses the shared name; a namesake by email is a teammate, `me` is this person by email", async () => {
    const offered = (to: { person: string; email?: string }) => ({ status: 200, body: { ok: true, handoff: handoff({ from: me, to }) } });
    const x = relay({ replies: [offered(namesake), offered(me)] });
    x.sync({ roster: [{ ...namesake, sessions: [] }] });
    const no = await runCoordOp({ op: "handoff", args: { to: "Sam Lee", task: "finish the port" }, caller: {} }, x.ops);
    expect(no.ok).toBe(false);
    expect(no.text).toBe('"Sam Lee" matches 2 people on this team: Sam Lee <sam.lee@example.org>; Sam Lee <sam@example.com>. Use one of those emails instead of the name.');
    expect(x.calls).toEqual([]);
    const theirs = await runCoordOp({ op: "handoff", args: { to: OTHER_SAM, task: "finish the port" }, caller: {} }, x.ops);
    expect(theirs.text).toMatch(/^Handed to Sam Lee \(handoff h_1\)\. It waits for Sam Lee's Accept/);
    const mine = await runCoordOp({ op: "handoff", args: { to: "me", task: "finish the port" }, caller: {} }, x.ops);
    expect(mine.text).toMatch(/^Handed to yourself \(handoff h_1\)/);
    expect(x.calls.map((c) => c.body)).toEqual([
      { action: "create", to: namesake, task: "finish the port" },
      { action: "create", to: me, task: "finish the port" },
    ]);
  });

  it("a hub that sends no emails gets the bodies it always got", async () => {
    const x = relay({ paired: { name: "Sam Lee" }, replies: [{ status: 200, body: { ok: true, id: "m_8" } }, { status: 200, body: { ok: true, handoff: handoff({ from: { person: "Sam Lee" }, to: { person: "Sam Lee" } }) } }] });
    x.sync({ me: { person: "Sam Lee" }, roster: [{ person: "An", github: "an-b3", sessions: [] }] });
    await runCoordOp({ op: "send", args: { to: "an-b3", text: "hi" }, caller: {} }, x.ops);
    const mine = await runCoordOp({ op: "handoff", args: { to: "me", task: "finish the port" }, caller: {} }, x.ops);
    expect(mine.text).toMatch(/^Handed to yourself/);
    expect(x.calls.map((c) => c.body)).toEqual([
      { to: { person: "An" }, text: "hi" },
      { action: "create", to: { person: "Sam Lee" }, task: "finish the port" },
    ]);
  });
});

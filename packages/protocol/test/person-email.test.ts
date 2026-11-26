import { describe, expect, it } from "vitest";
import {
  HUB_PERSON_EMAIL_MAX,
  hubApprovalResponseAcceptSchema,
  hubAskResponseAcceptSchema,
  hubAskResponseSchema,
  hubApprovalResponseSchema,
  hubClaimResponseAcceptSchema,
  hubClaimResponseSchema,
  hubGatesResponseAcceptSchema,
  hubGatesResponseSchema,
  hubHandoffRequestAcceptSchema,
  hubHandoffRequestSchema,
  hubHandoffResponseAcceptSchema,
  hubHandoffResponseSchema,
  hubLeaseResponseAcceptSchema,
  hubLeaseResponseSchema,
  hubMemoryBriefResponseAcceptSchema,
  hubMemoryBriefResponseSchema,
  hubMemoryResponseAcceptSchema,
  hubMemoryResponseSchema,
  hubMessageRequestAcceptSchema,
  hubMessageRequestSchema,
  hubPersonEmailAcceptSchema,
  hubPersonEmailSchema,
  hubSyncAcceptSchema,
  hubSyncResponseSchema,
  hubTeamAcceptSchema,
  hubTeamResponseSchema,
} from "../src";

/**
 * A person's email beside their display name (docs/SPEC.md §48). Two people can share a display name, so every place
 * that names a person may carry their email. Each field is optional: a body without any reads as it always did.
 */

const T = 1_795_545_600_000;
const SAM = "sam@example.com";
const OTHER_SAM = "sam.lee@example.org";
const AN = "an@example.com";

const holder = { person: "Sam Lee", email: SAM, sessionKey: "dev_S:claude-code:s1", sessionName: "docs-1" };
const lease = { id: "ls_1", repo: "b3-fun/workmesh", paths: ["README.md"], holder, since: T, expiresAt: T + 60_000 };
const handoff = {
  id: "h_1",
  from: { person: "Sam Lee", email: OTHER_SAM, sessionKey: "dev_O:claude-code:o1", sessionName: "laptop" },
  to: { person: "Sam Lee", email: SAM },
  task: "Port the key rotation",
  status: "offered",
  createdAt: T,
} as const;
const approval = {
  id: "ap_1",
  sessionKey: "dev_S:claude-code:s1",
  owner: "Sam Lee",
  ownerEmail: SAM,
  gate: "merge",
  detail: "gh pr merge 212 --merge in b3-fun/demo",
  status: "approved",
  ts: T,
  decidedAt: T + 1000,
  by: "An",
  byEmail: AN,
} as const;
const memory = {
  id: "m1",
  kind: "rule",
  title: "Deploys freeze at 5pm",
  body: "",
  by: { person: "Sam Lee", email: SAM, sessionKey: "dev_S:claude-code:s1" },
  status: "accepted",
  retire: { by: { person: "An", email: AN }, reason: "out of date", ts: T },
  createdAt: T,
  updatedAt: T,
} as const;

/** One sync with an email in every place that names a person. */
const sync = {
  cursor: "c_1",
  serverNow: T,
  me: { person: "Sam Lee", email: SAM },
  leases: [lease],
  holds: [{ sessionKey: "dev_S:claude-code:s1", by: "An", byEmail: AN, reason: "wait for the review", since: T }],
  inbox: [{ id: "m_1", to: "dev_S:claude-code:s1", from: { person: "An", email: AN, sessionName: "b3iq" }, text: "ping", ts: T }],
  claims: [{ issue: "B3-7239", holder, since: T }],
  roster: [
    { person: "Sam Lee", email: SAM, sessions: [{ hubKey: "dev_S:claude-code:s1", name: "docs-1", state: "working" }] },
    { person: "Sam Lee", email: OTHER_SAM, github: "sam-lee", sessions: [] },
  ],
  notes: [{ id: "n_1", by: { person: "An", email: AN }, text: "deploys freeze at 5pm", ts: T }],
  edits: [{ repo: "b3-fun/workmesh", path: "README.md", person: "An", email: AN, sessionKey: "dev_A:claude-code:a1", ts: T }],
  handoffs: [handoff],
  gates: [{ owner: "Sam Lee", ownerEmail: SAM, actions: ["merge"], approvers: ["Sam Lee", "An"], approverEmails: [SAM, AN] }],
  approvals: [approval],
} as const;

/** The same sync as a hub that sends no emails builds it. */
const withoutEmails = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(withoutEmails);
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k]) => !/^(email|\w+Emails?)$/.test(k))
      .map(([k, x]) => [k, withoutEmails(x)]),
  );
};

describe("the email field (SPEC §48)", () => {
  it("is plain ASCII local@domain, at most 254 characters", () => {
    const long = `${"a".repeat(HUB_PERSON_EMAIL_MAX - "@example.com".length)}@example.com`;
    for (const ok of [AN, "Sam.Lee+work@mail.example.org", "o'neil@example.com", "sam@localhost", long]) {
      expect(hubPersonEmailSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["", "sam", "@example.com", "sam@", "sam lee@example.com", " sam@example.com", "sam@example.com\n", "sam@@example.com", "s\u00e4m@example.com", "Sam Lee <sam@example.com>", `a${long}`, 7, null]) {
      expect(hubPersonEmailSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("a reader takes a missing, null or malformed email as absent", () => {
    expect(hubPersonEmailAcceptSchema.parse(AN)).toBe(AN);
    for (const absent of [undefined, null, "", "not an email", 7, {}]) {
      expect(hubPersonEmailAcceptSchema.parse(absent), JSON.stringify(absent)).toBeUndefined();
    }
  });
});

describe("sync with emails (SPEC §48)", () => {
  it("what the hub builds with emails, the relay reads unchanged", () => {
    const built = hubSyncResponseSchema.parse(sync);
    expect(built).toEqual(sync);
    const read = hubSyncAcceptSchema.parse(built);
    expect(read.me).toEqual(sync.me);
    expect(read.leases).toEqual(sync.leases);
    expect(read.holds).toEqual(sync.holds);
    expect(read.inbox).toEqual(sync.inbox);
    expect(read.claims).toEqual(sync.claims);
    expect(read.roster).toEqual(sync.roster);
    expect(read.notes).toEqual(sync.notes);
    expect(read.edits).toEqual(sync.edits);
    expect(read.handoffs).toEqual(sync.handoffs);
    expect(read.gates).toEqual(sync.gates);
    expect(read.approvals).toEqual(sync.approvals);
  });

  it("bodies with and without emails both read; without, no email appears anywhere", () => {
    // The fixture names a person in 15 places (`email` 10 times, `byEmail` and `ownerEmail` twice each, `approverEmails`).
    expect(JSON.stringify(hubSyncAcceptSchema.parse(sync)).match(/mail/gi)).toHaveLength(15);
    const plain = withoutEmails(sync);
    expect(JSON.stringify(plain)).not.toContain("@");
    const read = hubSyncAcceptSchema.parse(hubSyncResponseSchema.parse(plain));
    expect(JSON.stringify(read)).not.toContain("mail");
    expect(read.me).toEqual({ person: "Sam Lee" });
    expect(read.leases[0]?.holder.person).toBe("Sam Lee");
    expect(read.roster).toHaveLength(2);
    expect(read.handoffs?.[0]?.from.person).toBe("Sam Lee");
    expect(read.gates?.[0]?.approvers).toEqual(["Sam Lee", "An"]);
  });

  it("a malformed email reads as absent and its item is kept", () => {
    const read = hubSyncAcceptSchema.parse({
      ...sync,
      me: { person: "Sam Lee", email: "sam" },
      leases: [{ ...lease, holder: { ...holder, email: null } }],
      holds: [{ ...sync.holds[0], byEmail: 7 }],
      inbox: [{ ...sync.inbox[0], from: { person: "An", email: "an at example.com" } }],
      claims: [{ ...sync.claims[0], holder: { ...holder, email: "" } }],
      roster: [{ person: "Sam Lee", email: ["sam@example.com"], sessions: [] }],
      notes: [{ ...sync.notes[0], by: { person: "An", email: {} } }],
      edits: [{ ...sync.edits[0], email: "x".repeat(300) }],
      handoffs: [{ ...handoff, from: { person: "Sam Lee", email: "nope" }, to: { person: "Sam Lee", email: null } }],
      approvals: [{ ...approval, ownerEmail: "nope", byEmail: false }],
    });
    expect(read.me).toEqual({ person: "Sam Lee" });
    expect(read.leases[0]?.holder).toEqual({ person: "Sam Lee", sessionKey: holder.sessionKey, sessionName: "docs-1" });
    expect(read.holds[0]).toMatchObject({ by: "An" });
    expect(read.holds[0]?.byEmail).toBeUndefined();
    expect(read.inbox[0]?.from).toEqual({ person: "An" });
    expect(read.claims[0]?.holder.email).toBeUndefined();
    expect(read.roster).toEqual([{ person: "Sam Lee", sessions: [] }]);
    expect(read.notes[0]?.by).toEqual({ person: "An" });
    expect(read.edits[0]?.person).toBe("An");
    expect(read.edits[0]?.email).toBeUndefined();
    expect(read.handoffs?.[0]?.from).toEqual({ person: "Sam Lee" });
    expect(read.handoffs?.[0]?.to).toEqual({ person: "Sam Lee" });
    expect(read.approvals?.[0]).toMatchObject({ id: "ap_1", owner: "Sam Lee", by: "An" });
    expect(read.approvals?.[0]?.ownerEmail).toBeUndefined();
    expect(read.approvals?.[0]?.byEmail).toBeUndefined();
    // The emails that are well formed in the same body are still read.
    expect(read.gates?.[0]).toEqual(sync.gates[0]);
  });

  it("the hub's own schemas refuse a malformed email, so it never sends one", () => {
    const bad = [
      { ...sync, me: { person: "Sam Lee", email: "sam" } },
      { ...sync, leases: [{ ...lease, holder: { ...holder, email: "sam lee@example.com" } }] },
      { ...sync, holds: [{ ...sync.holds[0], byEmail: "" }] },
      { ...sync, roster: [{ person: "Sam Lee", email: "@example.com", sessions: [] }] },
      { ...sync, handoffs: [{ ...handoff, to: { person: "Sam Lee", email: "sam@" } }] },
      { ...sync, gates: [{ owner: "Sam Lee", ownerEmail: "x", actions: [] }] },
      { ...sync, gates: [{ owner: "Sam Lee", actions: [], approvers: ["An"], approverEmails: ["An"] }] },
      { ...sync, approvals: [{ ...approval, byEmail: "An" }] },
    ];
    for (const b of bad) expect(hubSyncResponseSchema.safeParse(b).success, JSON.stringify(b).slice(0, 80)).toBe(false);
  });
});

describe("gate approvers' emails (SPEC §48)", () => {
  const gates = (g: unknown) => hubSyncAcceptSchema.parse({ ...sync, gates: [g] }).gates?.[0];

  it("are kept when there is one email per approver, in the same order", () => {
    expect(gates(sync.gates[0])).toEqual(sync.gates[0]);
    expect(gates({ owner: "Sam Lee", ownerEmail: SAM, actions: ["merge"] })).toEqual({ owner: "Sam Lee", ownerEmail: SAM, actions: ["merge"] });
  });

  it("read as absent when they don't line up with the names, and the policy is kept", () => {
    const base = { owner: "Sam Lee", ownerEmail: SAM, actions: ["merge"], approvers: ["Sam Lee", "An"] };
    for (const approverEmails of [[SAM], [SAM, AN, AN], [SAM, "An"], [SAM, null], "sam@example.com", []]) {
      const read = gates({ ...base, approverEmails });
      expect(read, JSON.stringify(approverEmails)).toMatchObject(base);
      expect(read?.approverEmails, JSON.stringify(approverEmails)).toBeUndefined();
    }
    // A name the relay drops leaves one email too many: the emails are dropped, never shifted onto another approver.
    const shifted = gates({ ...base, approvers: ["", "An"], approverEmails: [SAM, AN] });
    expect(shifted?.approvers).toEqual(["An"]);
    expect(shifted?.approverEmails).toBeUndefined();
    // Emails without any approver names say nothing.
    expect(gates({ owner: "Sam Lee", actions: [], approverEmails: [SAM] })?.approverEmails).toBeUndefined();
  });

  it("ride on the answer to setting gates too", () => {
    const body = hubGatesResponseSchema.parse({ ok: true, gates: sync.gates[0] });
    expect(body).toEqual({ ok: true, gates: sync.gates[0] });
    expect(hubGatesResponseAcceptSchema.parse(body)).toEqual(body);
  });
});

describe("answers that name a person (SPEC §48)", () => {
  it("leases, claims, handoffs and approvals carry the email through", () => {
    const conflict = { ok: false, conflicts: [{ leaseId: "ls_1", holder, paths: ["README.md"], expiresAt: T + 60_000 }] };
    for (const r of [{ ok: true, lease }, conflict]) {
      const built = hubLeaseResponseSchema.parse(r);
      expect(built).toEqual(r);
      expect(hubLeaseResponseAcceptSchema.parse(built)).toEqual(r);
    }
    const held = { ok: false, holder, since: T };
    expect(hubClaimResponseAcceptSchema.parse(hubClaimResponseSchema.parse(held))).toEqual(held);
    const handed = { ok: true, handoff };
    expect(hubHandoffResponseAcceptSchema.parse(hubHandoffResponseSchema.parse(handed))).toEqual(handed);
    const decided = { ok: true, approval };
    expect(hubApprovalResponseAcceptSchema.parse(hubApprovalResponseSchema.parse(decided))).toEqual(decided);
  });

  it("memories name their author, and who proposed retiring them", () => {
    const one = { ok: true, memory };
    expect(hubMemoryResponseAcceptSchema.parse(hubMemoryResponseSchema.parse(one))).toMatchObject({
      ok: true,
      memory: { by: { person: "Sam Lee", email: SAM }, retire: { by: { person: "An", email: AN } } },
    });
    const brief = { ok: true, rev: "r1", memories: [{ id: "m1", kind: "rule", title: "Deploys freeze at 5pm", body: "", by: { person: "Sam Lee", email: SAM }, updatedAt: T }] };
    expect(hubMemoryBriefResponseAcceptSchema.parse(hubMemoryBriefResponseSchema.parse(brief))).toEqual(brief);
    const loose = hubMemoryBriefResponseAcceptSchema.parse({ ...brief, memories: [{ ...brief.memories[0], by: { person: "Sam Lee", email: "sam" } }] });
    expect(loose.memories[0]?.by).toEqual({ person: "Sam Lee" });
    const older = { ok: true, memory: { ...memory, by: { person: "Sam Lee" }, retire: undefined } };
    const read = hubMemoryResponseAcceptSchema.parse(hubMemoryResponseSchema.parse(older));
    expect(read.ok && read.memory?.by.person).toBe("Sam Lee");
    expect(read.ok && read.memory?.by.email).toBeUndefined();
  });

  it("the sessions an Ask answer names say whose they are by email too", () => {
    const answer = {
      ok: true,
      answer: "Two agents are on the docs.",
      sessions: [
        { hubKey: "dev_S:claude-code:s1", name: "docs-1", person: "Sam Lee", email: SAM, state: "working" },
        { hubKey: "dev_O:claude-code:o1", name: "docs-1", person: "Sam Lee", email: OTHER_SAM, state: "idle" },
      ],
    };
    const built = hubAskResponseSchema.parse(answer);
    expect(built).toEqual(answer);
    expect(hubAskResponseAcceptSchema.parse(built)).toEqual(answer);
    const loose = hubAskResponseAcceptSchema.parse({ ...answer, sessions: [{ ...answer.sessions[0], email: "Sam Lee" }, { hubKey: "k", name: "x", person: "An", state: "idle" }] });
    expect(loose.sessions).toEqual([
      { hubKey: "dev_S:claude-code:s1", name: "docs-1", person: "Sam Lee", state: "working" },
      { hubKey: "k", name: "x", person: "An", state: "idle" },
    ]);
    expect(hubAskResponseSchema.safeParse({ ...answer, sessions: [{ ...answer.sessions[0], email: "Sam Lee" }] }).success).toBe(false);
  });

  it("the team view names each session's owner by email too", () => {
    const team = {
      me: { name: "Sam Lee", email: SAM },
      people: [
        { name: "Sam Lee", email: SAM, online: true, counts: { working: 1, waiting: 1, idle: 0 } },
        { name: "Sam Lee", email: OTHER_SAM, online: true, counts: { working: 1, waiting: 0, idle: 0 } },
      ],
      needsMe: [{ session: "dev_S:claude-code:s1", reason: "Approve the deploy", since: T, owner: "Sam Lee", ownerEmail: SAM }],
      sessions: [
        { key: "dev_S:claude-code:s1", owner: "Sam Lee", ownerEmail: SAM, name: "docs-1", source: "claude-code", state: "waiting", subagents: 0 },
        { key: "dev_O:claude-code:o1", owner: "Sam Lee", ownerEmail: OTHER_SAM, name: "docs-1", source: "claude-code", state: "working", subagents: 0 },
      ],
    } as const;
    const built = hubTeamResponseSchema.parse(team);
    expect(built).toEqual(team);
    const read = hubTeamAcceptSchema.parse(built);
    expect(read.needsMe[0]?.ownerEmail).toBe(SAM);
    expect(read.sessions.map((s) => s.ownerEmail)).toEqual([SAM, OTHER_SAM]);
    const loose = hubTeamAcceptSchema.parse({ ...team, sessions: [{ ...team.sessions[0], ownerEmail: "Sam Lee" }], needsMe: [{ ...team.needsMe[0], ownerEmail: null }] });
    expect(loose.sessions).toHaveLength(1);
    expect(loose.sessions[0]?.ownerEmail).toBeUndefined();
    expect(loose.needsMe[0]?.ownerEmail).toBeUndefined();
    const plain = hubTeamAcceptSchema.parse(hubTeamResponseSchema.parse(withoutEmails(team)));
    expect(plain.sessions.map((s) => s.owner)).toEqual(["Sam Lee", "Sam Lee"]);
    expect(plain.sessions[0]?.ownerEmail).toBeUndefined();
  });
});

describe("requests that name a person (SPEC §48)", () => {
  it("a message to a person may carry their email; the hub reads it beside the name", () => {
    const withEmail = { from: "claude-code:s1", to: { person: "Sam Lee", email: OTHER_SAM }, text: "can I take README.md?" };
    const sent = hubMessageRequestSchema.parse(withEmail);
    expect(sent).toEqual(withEmail);
    expect(hubMessageRequestAcceptSchema.parse(sent).to).toMatchObject({ person: "Sam Lee", email: OTHER_SAM });
    // Without one, the body is what a relay has always sent.
    const plain = { to: { person: "An" }, text: "hi" };
    expect(hubMessageRequestSchema.parse(plain)).toEqual(plain);
    expect(hubMessageRequestAcceptSchema.parse(plain).to.email).toBeUndefined();
  });

  it("the relay sends an email only as an email, and only beside a person", () => {
    expect(hubMessageRequestSchema.safeParse({ to: { person: "Sam Lee", email: SAM }, text: "x" }).success).toBe(true);
    for (const to of [
      { person: "Sam Lee", email: "Sam Lee" },
      { person: "Sam Lee", email: "" },
      { person: "Sam Lee", email: null },
      { session: "dev_S:claude-code:s1", email: SAM },
      { agent: "docs-1", email: SAM },
      { email: SAM },
    ]) {
      expect(hubMessageRequestSchema.safeParse({ to, text: "x" }).success, JSON.stringify(to)).toBe(false);
    }
  });

  it("the hub's reading: a malformed email is absent, and an email alone is no recipient", () => {
    expect(hubMessageRequestAcceptSchema.parse({ to: { person: "Sam Lee", email: SAM, extra: 1 }, text: "x" }).to).toMatchObject({ person: "Sam Lee", email: SAM });
    const read = hubMessageRequestAcceptSchema.parse({ to: { person: "Sam Lee", email: "nope" }, text: "x" });
    expect(read.to.person).toBe("Sam Lee");
    expect(read.to.email).toBeUndefined();
    expect(hubMessageRequestAcceptSchema.safeParse({ to: { email: SAM }, text: "x" }).success).toBe(false);
    expect(hubMessageRequestAcceptSchema.parse({ to: { session: "dev_S:claude-code:s1", email: SAM }, text: "x" }).to.session).toBe("dev_S:claude-code:s1");
  });

  it("a handoff to a person may carry their email", () => {
    const create = { action: "create", from: "claude-code:s1", to: { person: "Sam Lee", email: OTHER_SAM }, task: "do x" } as const;
    const sent = hubHandoffRequestSchema.parse(create);
    expect(sent).toEqual(create);
    expect(hubHandoffRequestAcceptSchema.parse(sent)).toEqual(create);
    const plain = { action: "create", to: { person: "An" }, task: "do x" } as const;
    expect(hubHandoffRequestAcceptSchema.parse(hubHandoffRequestSchema.parse(plain))).toEqual(plain);
    expect(hubHandoffRequestSchema.safeParse({ ...create, to: { person: "Sam Lee", email: "Sam Lee" } }).success).toBe(false);
    const read = hubHandoffRequestAcceptSchema.parse({ ...create, to: { person: "Sam Lee", email: "nope" } });
    expect(read).toMatchObject({ action: "create", to: { person: "Sam Lee" } });
    expect(read.action === "create" && read.to.email).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  HUB_DEVICE_WHERE_MAX,
  HUB_LEASE_MAX_PATHS,
  HUB_LEASE_TTL_MAX_SEC,
  HUB_LEASE_TTL_MIN_SEC,
  HUB_MACHINE_NAME_MAX,
  HUB_SYNC_MAX_NEW_DEVICES,
  hubClaimRequestAcceptSchema,
  hubClaimRequestSchema,
  hubClaimResponseAcceptSchema,
  hubClaimResponseSchema,
  hubIdResponseAcceptSchema,
  hubIdResponseSchema,
  hubInboxAckRequestAcceptSchema,
  hubInboxAckRequestSchema,
  hubLeaseRequestAcceptSchema,
  hubLeaseRequestSchema,
  hubLeaseResponseAcceptSchema,
  hubLeaseResponseSchema,
  hubMessageRequestAcceptSchema,
  hubMessageRequestSchema,
  hubNoteRequestAcceptSchema,
  hubNoteRequestSchema,
  hubSyncAcceptSchema,
  hubSyncResponseSchema,
  isLeasePath,
  leaseEntriesCovering,
  leasePathCovers,
  leasePathsOverlap,
  normalizeLeasePath,
} from "../src";

const T = 1_795_545_600_000;
const anHolder = { person: "An", sessionKey: "dev_A:claude-code:s9", sessionName: "b3iq-strategy" };
const lease = {
  id: "ls_1",
  repo: "b3-fun/workmesh",
  paths: ["packages/cli/src/hub/**", "README.md"],
  holder: anHolder,
  since: T,
  expiresAt: T + 1_800_000,
  reason: "reworking the forwarder",
};
const claim = { issue: "B3-7167", holder: anHolder, since: T, note: "relay side" };

const sync = {
  cursor: "c_42",
  serverNow: T + 5000,
  me: { person: "Sean" },
  leases: [lease],
  holds: [{ sessionKey: "dev_S:claude-code:s1", by: "An", reason: "reworking the cell layout", since: T }],
  inbox: [
    {
      id: "m_1",
      to: "dev_S:claude-code:s1",
      from: { person: "An", sessionName: "b3iq-strategy", sessionKey: "dev_A:claude-code:s9" },
      text: "I have the forwarder leased; take the CLI instead?",
      ts: T,
      thread: "t_1",
    },
  ],
  claims: [claim],
  roster: [
    { person: "An", github: "an-b3", sessions: [{ hubKey: "dev_A:claude-code:s9", name: "b3iq-strategy", state: "working", repo: "b3-fun/workmesh" }] },
  ],
  notes: [{ id: "n_1", by: { person: "An", sessionName: "b3iq-strategy" }, text: "deploys freeze at 5pm", tags: ["deploy"], ts: T }],
  edits: [{ repo: "b3-fun/workmesh", path: "packages/cli/src/index.ts", person: "An", sessionKey: "dev_A:claude-code:s9", ts: T }],
} as const;

describe("lease paths (SPEC §21)", () => {
  it("are repo-relative paths or globs, normalized before sending", () => {
    for (const ok of ["README.md", "packages/cli/src/**", "**", "src/*.ts", "app/[id]/page.tsx", "a?c/x", "**/*.test.ts"]) {
      expect(isLeasePath(ok), ok).toBe(true);
    }
    for (const bad of ["", "/abs", "~/x", "C:/x", "a/../b", "a//b", "a/", "./a", "a/**b", "a\\b", "a\u0000b", "x".repeat(401)]) {
      expect(isLeasePath(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(normalizeLeasePath("./src//hub/")).toBe("src/hub");
    expect(normalizeLeasePath("src\\hub\\x.ts")).toBe("src/hub/x.ts");
    expect(normalizeLeasePath("../x")).toBeUndefined();
    expect(normalizeLeasePath("/etc/passwd")).toBeUndefined();
    expect(normalizeLeasePath(" . ")).toBeUndefined();
  });

  it("an entry covers what it matches and everything under it", () => {
    expect(leasePathCovers("packages/cli", "packages/cli/src/index.ts")).toBe(true);
    expect(leasePathCovers("packages/cli", "packages/cli")).toBe(true);
    expect(leasePathCovers("packages/cli", "packages/client/x.ts")).toBe(false);
    expect(leasePathCovers("packages/*", "packages/core/src/a.ts")).toBe(true);
    expect(leasePathCovers("src/*.ts", "src/a.ts")).toBe(true);
    expect(leasePathCovers("src/*.ts", "src/a.md")).toBe(false);
    expect(leasePathCovers("src/*.ts", "src/sub/a.ts")).toBe(false);
    expect(leasePathCovers("src/**/*.ts", "src/a.ts")).toBe(true);
    expect(leasePathCovers("src/**/*.ts", "src/x/y/a.ts")).toBe(true);
    expect(leasePathCovers("**", "anything/at/all.md")).toBe(true);
    expect(leasePathCovers("**/README.md", "README.md")).toBe(true);
    expect(leasePathCovers("a?c", "abc/d")).toBe(true);
    expect(leasePathCovers("a?c", "ac")).toBe(false);
    expect(leasePathCovers("app/[id]/page.tsx", "app/[id]/page.tsx")).toBe(true);
    expect(leasePathCovers("app/[id]/page.tsx", "app/i/page.tsx")).toBe(false);
    expect(leasePathCovers("./src/", "src/x")).toBe(true);
    expect(leasePathCovers("src", "../src/x")).toBe(false);
    expect(leaseEntriesCovering(lease.paths, "packages/cli/src/hub/forwarder.ts")).toEqual(["packages/cli/src/hub/**"]);
  });

  it("two entries overlap when some file is covered by both", () => {
    const yes: [string, string][] = [
      ["src", "src/a.ts"],
      ["src/a.ts", "src/a.ts"],
      ["src/**", "src/x/y.ts"],
      ["src/*.ts", "src/a.ts"],
      ["src/*.ts", "src/*"],
      ["src/*/x.ts", "src/foo"],
      ["**/*.test.ts", "packages/cli/test/a.test.ts"],
      ["**", "README.md"],
      ["a*", "*b"],
      ["packages/*/src", "packages/cli"],
    ];
    const no: [string, string][] = [
      ["src/a.ts", "src/b.ts"],
      ["src", "srcx/a.ts"],
      ["src/*.ts", "src/a.md"],
      ["src/*.ts", "lib/*.ts"],
      ["a*.ts", "b*.ts"],
      ["docs/**", "src/**"],
    ];
    for (const [a, b] of yes) {
      expect(leasePathsOverlap(a, b), `${a} ~ ${b}`).toBe(true);
      expect(leasePathsOverlap(b, a), `${b} ~ ${a}`).toBe(true);
    }
    for (const [a, b] of no) {
      expect(leasePathsOverlap(a, b), `${a} !~ ${b}`).toBe(false);
      expect(leasePathsOverlap(b, a), `${b} !~ ${a}`).toBe(false);
    }
  });
});

describe("leases (SPEC §21)", () => {
  const acquire = {
    action: "acquire",
    sessionKey: "claude-code:s1",
    repo: "b3-fun/workmesh",
    paths: ["packages/cli/src/hub/**"],
    ttlSec: 1800,
    reason: "reworking the forwarder",
  } as const;

  it("what a relay sends, the hub reads unchanged", () => {
    for (const body of [acquire, { action: "release", sessionKey: "claude-code:s1", repo: "b3-fun/workmesh", paths: [] }, { action: "renew", sessionKey: "claude-code:s1", repo: "b3-fun/workmesh", paths: [], leaseId: "ls_1", ttlSec: 600 }]) {
      const sent = hubLeaseRequestSchema.parse(body);
      expect(hubLeaseRequestAcceptSchema.parse(sent)).toEqual(sent);
    }
  });

  it("strict: paths, ttl, reason and shape", () => {
    const bad = [
      { ...acquire, paths: [] },
      { ...acquire, paths: ["/abs/x"] },
      { ...acquire, paths: ["a", "a"] },
      { ...acquire, paths: Array.from({ length: HUB_LEASE_MAX_PATHS + 1 }, (_, i) => `f${i}`) },
      { ...acquire, ttlSec: HUB_LEASE_TTL_MIN_SEC - 1 },
      { ...acquire, ttlSec: HUB_LEASE_TTL_MAX_SEC + 1 },
      { ...acquire, ttlSec: 90.5 },
      { ...acquire, reason: "r".repeat(201) },
      { ...acquire, repo: "workmesh" },
      { ...acquire, action: "steal" },
      { ...acquire, person: "An" }, // the hub takes the person from the token
    ];
    for (const b of bad) expect(hubLeaseRequestSchema.safeParse(b).success, JSON.stringify(b).slice(0, 120)).toBe(false);
  });

  it("accept: drops unknown keys and nulls, repeats once, clamps the ttl, still refuses bad paths", () => {
    const got = hubLeaseRequestAcceptSchema.parse({ ...acquire, paths: ["a", "a", "b"], ttlSec: 5, reason: null, person: "An" });
    expect(got).toEqual({ action: "acquire", sessionKey: "claude-code:s1", repo: "b3-fun/workmesh", paths: ["a", "b"], ttlSec: 60, reason: undefined, leaseId: undefined });
    expect(hubLeaseRequestAcceptSchema.parse({ ...acquire, ttlSec: 1e9 }).ttlSec).toBe(HUB_LEASE_TTL_MAX_SEC);
    expect(hubLeaseRequestAcceptSchema.safeParse({ ...acquire, paths: ["../x"] }).success).toBe(false);
    expect(hubLeaseRequestAcceptSchema.safeParse({ ...acquire, paths: null }).success).toBe(false); // acquire needs one
    expect(hubLeaseRequestAcceptSchema.parse({ action: "release", sessionKey: "k", repo: "o/r" }).paths).toEqual([]);
  });

  it("responses: granted, released, conflicts; the relay reads what it can", () => {
    for (const r of [{ ok: true, lease }, { ok: true, released: 2 }, { ok: false, conflicts: [{ leaseId: "ls_1", holder: anHolder, paths: lease.paths, expiresAt: lease.expiresAt, reason: lease.reason }] }]) {
      const built = hubLeaseResponseSchema.parse(r);
      expect(hubLeaseResponseAcceptSchema.parse(built)).toEqual(built);
    }
    const loose = hubLeaseResponseAcceptSchema.parse({
      ok: false,
      conflicts: [{ leaseId: "ls_2", holder: { ...anHolder, sessionName: null }, paths: ["ok/path", "/bad"], expiresAt: T + 0.4, extra: 1 }, { nope: true }],
    });
    expect(loose).toEqual({ ok: false, conflicts: [{ leaseId: "ls_2", holder: { person: "An", sessionKey: anHolder.sessionKey, sessionName: undefined }, paths: ["ok/path"], expiresAt: T, reason: undefined }] });
    const okLease = hubLeaseResponseAcceptSchema.parse({ ok: true, lease: { ...lease, paths: ["/only/bad"] } });
    expect(okLease).toEqual({ ok: true, lease: undefined, released: undefined }); // a lease with no readable path reads as absent
  });
});

describe("claims (SPEC §21)", () => {
  it("one claimant per issue: claim, release, held by someone else", () => {
    const req = { action: "claim", sessionKey: "claude-code:s1", issue: "B3-7167", note: "relay side" } as const;
    expect(hubClaimRequestAcceptSchema.parse(hubClaimRequestSchema.parse(req))).toEqual(req);
    expect(hubClaimRequestAcceptSchema.parse({ ...req, issue: "b3-7167", note: null }).issue).toBe("B3-7167");
    for (const bad of [{ ...req, issue: "7167" }, { ...req, note: "n".repeat(501) }, { ...req, action: "take" }]) {
      expect(hubClaimRequestSchema.safeParse(bad).success).toBe(false);
    }
    const read = (r: unknown) => hubClaimResponseAcceptSchema.parse(hubClaimResponseSchema.parse(r));
    expect(read({ ok: true, claim })).toEqual({ ok: true, claim });
    expect(read({ ok: true })).toEqual({ ok: true, claim: undefined });
    expect(read({ ok: false, holder: anHolder, since: T })).toEqual({ ok: false, holder: anHolder, since: T });
  });
});

describe("messages and notes (SPEC §21)", () => {
  it("exactly one recipient; text 1..4000; from optional (the person themselves)", () => {
    const bodies = [
      { from: "claude-code:s1", to: { person: "An" }, text: "Can I take packages/cli?" },
      { from: "claude-code:s1", to: { session: "dev_A:claude-code:s9" }, text: "done with the forwarder", thread: "t_1" },
      { to: { agent: "b3iq-strategy" }, text: "from Sean at the terminal" },
    ];
    for (const b of bodies) {
      const sent = hubMessageRequestSchema.parse(b);
      const read = hubMessageRequestAcceptSchema.parse(sent);
      expect(read.text).toBe(sent.text);
      expect(Object.values(read.to).filter(Boolean)).toHaveLength(1);
    }
    for (const bad of [
      { to: {}, text: "x" },
      { to: { person: "An", agent: "x" }, text: "x" },
      { to: { person: "An" }, text: "" },
      { to: { person: "An" }, text: "x".repeat(4001) },
      { to: { team: "B3" }, text: "x" },
    ]) {
      expect(hubMessageRequestSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
    expect(hubMessageRequestAcceptSchema.safeParse({ to: { person: "An", agent: "x" }, text: "x" }).success).toBe(false);
    expect(hubMessageRequestAcceptSchema.parse({ to: { person: "An" }, text: "y".repeat(5000) }).text).toHaveLength(4000);
    const ok = hubIdResponseSchema.parse({ ok: true, id: "m_9" });
    expect(hubIdResponseAcceptSchema.parse(ok)).toEqual(ok);
    expect(hubIdResponseAcceptSchema.parse({ ok: false, error: 7 })).toEqual({ ok: false, error: "" });
  });

  it("notes carry word tags", () => {
    const n = { sessionKey: "claude-code:s1", text: "deploys freeze at 5pm", tags: ["deploy", "B3-7167"] };
    expect(hubNoteRequestAcceptSchema.parse(hubNoteRequestSchema.parse(n))).toEqual(n);
    expect(hubNoteRequestSchema.safeParse({ text: "x", tags: ["two words"] }).success).toBe(false);
    expect(hubNoteRequestSchema.safeParse({ text: "x", tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }).success).toBe(false);
    expect(hubNoteRequestAcceptSchema.parse({ text: "x", tags: ["ok", "not ok", "ok"] }).tags).toEqual(["ok"]);
  });

  it("acks name 1..200 ids", () => {
    expect(hubInboxAckRequestAcceptSchema.parse(hubInboxAckRequestSchema.parse({ ids: ["m_1"] }))).toEqual({ ids: ["m_1"] });
    expect(hubInboxAckRequestSchema.safeParse({ ids: [] }).success).toBe(false);
  });
});

describe("sync (SPEC §21)", () => {
  it("what the hub builds, the relay reads unchanged", () => {
    const built = hubSyncResponseSchema.parse(sync);
    const read = hubSyncAcceptSchema.parse(built);
    expect(read.leases).toEqual(built.leases);
    expect(read.holds).toEqual(built.holds);
    expect(read.inbox).toEqual(built.inbox);
    expect(read.claims).toEqual(built.claims);
    expect(read.notes).toEqual(built.notes);
    expect(read.edits).toEqual([{ ...built.edits![0], sessionName: undefined }]);
    expect(read.roster).toEqual(built.roster);
    expect(read.cursor).toBe("c_42");
  });

  it("the relay keeps what it can read from a hub newer or older than it", () => {
    const read = hubSyncAcceptSchema.parse({
      cursor: 7,
      leases: [{ ...lease, paths: ["/bad", "ok"] }, { id: "x" }],
      holds: [{ sessionKey: "dev_S:claude-code:s1", by: null, since: "now" }, { by: "An" }],
      inbox: [{ id: "m_2", to: "dev_S:claude-code:s1", from: {}, text: "hi", ts: T }, { id: "m_3", to: "k", from: { person: "An" }, text: "" }],
      claims: [{ ...claim, issue: "nope" }, claim],
      roster: [{ person: "An", sessions: [{ hubKey: "k", state: "thinking" }, {}] }],
      notes: "none",
    });
    expect(read.cursor).toBeUndefined();
    expect(read.leases).toHaveLength(1);
    expect(read.leases[0]?.paths).toEqual(["ok"]);
    expect(read.holds).toEqual([{ sessionKey: "dev_S:claude-code:s1", by: "someone", reason: undefined, since: 0 }]);
    expect(read.inbox).toHaveLength(1);
    expect(read.inbox[0]?.from.person).toBe("someone");
    expect(read.claims).toHaveLength(1);
    expect(read.roster[0]?.sessions).toEqual([{ hubKey: "k", name: "", state: "idle", repo: undefined }]);
    expect(read.notes).toEqual([]);
    expect(read.edits).toEqual([]);
    expect(hubSyncAcceptSchema.parse({})).toMatchObject({ leases: [], holds: [], inbox: [], claims: [], roster: [], notes: [], edits: [] });
  });
});

describe("where the hub made an inbox item from (SPEC §23)", () => {
  const linear = { ...sync.inbox[0], id: "m_9", via: "linear" };
  const withVia = (via: unknown) => ({ ...sync, inbox: [{ ...linear, via }] });

  it("what the hub builds, the relay reads unchanged", () => {
    const built = hubSyncResponseSchema.parse({ ...sync, inbox: [linear] });
    expect(built.inbox[0]?.via).toBe("linear");
    expect(hubSyncAcceptSchema.parse(built).inbox[0]?.via).toBe("linear");
  });

  it("is optional: a message a person or an agent sent carries none", () => {
    expect(hubSyncResponseSchema.parse(sync).inbox[0]?.via).toBeUndefined();
    expect(hubSyncAcceptSchema.parse(sync).inbox[0]?.via).toBeUndefined();
    expect(hubSyncAcceptSchema.parse(withVia(null)).inbox[0]?.via).toBeUndefined();
  });

  it("strict: exactly `linear`", () => {
    for (const via of ["Linear", "slack", "", 1, null, ["linear"]]) {
      expect(hubSyncResponseSchema.safeParse(withVia(via)).success, JSON.stringify(via)).toBe(false);
    }
  });

  it("accept: a value this relay doesn't know keeps the message and reads as `other`, never as absent", () => {
    for (const via of ["Linear", "slack", "", 1, false, ["linear"], { from: "linear" }]) {
      const read = hubSyncAcceptSchema.parse(withVia(via));
      expect(read.inbox, JSON.stringify(via)).toHaveLength(1);
      expect(read.inbox[0]?.via, JSON.stringify(via)).toBe("other");
    }
  });
});

describe("new machines on sync (SPEC §46)", () => {
  const laptop = { id: "dev_01JD0000000000000000000002", machine: "sams-laptop", pairedAt: T, where: "Lisbon, Portugal (Example Telecom)" };
  const box = { id: "dev_01JD0000000000000000000003", machine: "sams-box", pairedAt: T + 1000 };

  it("what the hub builds, the relay reads unchanged", () => {
    const built = hubSyncResponseSchema.parse({ ...sync, newDevices: [laptop, box] });
    expect(built.newDevices).toEqual([laptop, box]);
    const read = hubSyncAcceptSchema.parse(built);
    expect(read.newDevices).toEqual(built.newDevices);
  });

  it("is optional: an older hub sends no list, and the relay reads none", () => {
    expect(hubSyncResponseSchema.parse(sync).newDevices).toBeUndefined();
    expect(hubSyncAcceptSchema.parse(sync).newDevices).toBeUndefined();
    expect(hubSyncAcceptSchema.parse({ ...sync, newDevices: null }).newDevices).toBeUndefined();
    expect(hubSyncAcceptSchema.parse({ ...sync, newDevices: [] }).newDevices).toEqual([]);
  });

  it("strict: an id, a name of 1..120, a time, a place of at most 200, at most 50 machines", () => {
    const bad = (d: unknown) => hubSyncResponseSchema.safeParse({ ...sync, newDevices: [d] }).success;
    expect(bad({ ...laptop, id: "" })).toBe(false);
    expect(bad({ ...laptop, machine: "" })).toBe(false);
    expect(bad({ ...laptop, machine: "m".repeat(HUB_MACHINE_NAME_MAX + 1) })).toBe(false);
    expect(bad({ ...laptop, pairedAt: "today" })).toBe(false);
    expect(bad({ ...laptop, where: "w".repeat(HUB_DEVICE_WHERE_MAX + 1) })).toBe(false);
    const many = Array.from({ length: HUB_SYNC_MAX_NEW_DEVICES + 1 }, (_, i) => ({ ...box, id: `d${i}` }));
    expect(hubSyncResponseSchema.safeParse({ ...sync, newDevices: many }).success).toBe(false);
  });

  it("accept: a machine with an id is kept even when its other fields can't be read; the rest are dropped or cut", () => {
    const read = hubSyncAcceptSchema.parse({
      ...sync,
      newDevices: [
        { id: "d1", machine: 7, pairedAt: "today", where: { city: "Lisbon" } },
        { machine: "no-id", pairedAt: T },
        "nope",
        { id: "d2", machine: "m".repeat(300), pairedAt: T + 0.4, where: "w".repeat(300), extra: true },
      ],
    });
    expect(read.newDevices).toEqual([
      { id: "d1", machine: "", pairedAt: 0, where: undefined },
      { id: "d2", machine: "m".repeat(HUB_MACHINE_NAME_MAX), pairedAt: T, where: "w".repeat(HUB_DEVICE_WHERE_MAX) },
    ]);
    expect(hubSyncAcceptSchema.parse({ ...sync, newDevices: "none" }).newDevices).toEqual([]);
    const many = Array.from({ length: HUB_SYNC_MAX_NEW_DEVICES + 20 }, (_, i) => ({ ...box, id: `d${i}` }));
    expect(hubSyncAcceptSchema.parse({ ...sync, newDevices: many }).newDevices).toHaveLength(HUB_SYNC_MAX_NEW_DEVICES);
  });
});

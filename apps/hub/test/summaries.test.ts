import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardState, StreamMessage } from "../src/shared/types";
import type { Project } from "../src/worker/project";
import { POLICY, utcDay } from "../src/worker/summaries/policy";
import type { CompletionRequest, CompletionResult, SummaryProvider } from "../src/worker/summaries/provider";
import { batch, call, event, ingest, pairDevice, projectStub, session } from "./helpers";

// Summaries with the model mocked (SPEC.md §11). Jobs run only when a test calls runSummaries with a chosen clock.

type Respond = (req: CompletionRequest) => CompletionResult | Promise<CompletionResult>;

const ok = (value: unknown): CompletionResult => ({ ok: true, value, inputTokens: 900, outputTokens: 40, provider: "fake" });

function fake(respond: Respond = defaultRespond) {
  const calls: CompletionRequest[] = [];
  const provider: SummaryProvider = {
    id: "fake-model",
    label: "Fake model",
    async complete(req) {
      calls.push(req);
      return respond(req);
    },
  };
  return { calls, provider };
}

function defaultRespond(req: CompletionRequest): CompletionResult {
  const props = Object.keys((req.schema as { properties: Record<string, unknown> }).properties);
  if (props.includes("lines")) return ok({ lines: ["Sean shipped the summaries", "An is blocked on a boot test"] });
  const out: Record<string, string> = { now: "Publishing agentblip 0.6.0; waiting on Sean's security key" };
  if (props.includes("turn")) out.turn = "Sean asked to publish 0.6.0. Built and tested it; waiting on the security key.";
  if (props.includes("waiting")) out.waiting = "Tap the security key for npm publish";
  return ok(out);
}

const stub = () => projectStub();
const withDo = <T,>(fn: (p: Project, st: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(stub(), (i: Project, st) => fn(i, st));
const run = (at: number) => withDo((p) => p.runSummaries(at));
const sql = <T extends Record<string, SqlStorageValue>>(q: string, ...args: SqlStorageValue[]) =>
  withDo((_p, st) => st.storage.sql.exec<T>(q, ...args).toArray());

let mock = fake();
const use = (m: ReturnType<typeof fake>) => {
  mock = m;
  return withDo((p) => p.setSummaryProvider(m.provider, { manual: true }));
};

beforeEach(async () => {
  await use(fake());
  await withDo((_p, st) => {
    st.storage.sql.exec("DELETE FROM summary_jobs");
    st.storage.sql.exec("DELETE FROM summary_usage");
  });
});

afterEach(async () => {
  await withDo((p) => p.setSummaryProvider(undefined));
});

const conv = (over: Record<string, unknown> = {}) => batch({ share: "conversation", ...over });
let n = 0;
const key = () => `claude-code:sum${++n}`;

async function job(hubKey: string) {
  return (await sql<{ due_at: number; turn_id: string | null; waiting: number; attempts: number }>(
    "SELECT due_at, turn_id, waiting, attempts FROM summary_jobs WHERE hub_key = ?",
    hubKey,
  ))[0];
}

async function sessionRow(hubKey: string) {
  return (await sql<{ now_line: string | null; waiting_reason: string | null; sum_at: number | null }>(
    "SELECT now_line, waiting_reason, sum_at FROM sessions WHERE hub_key = ?",
    hubKey,
  ))[0]!;
}

describe("turn summaries and now lines", () => {
  it("a turn end queues a job (nothing runs on ingest), then writes the summary and the now line", async () => {
    const { token, deviceId } = await pairDevice();
    const k = key();
    const hubKey = `${deviceId}:${k}`;
    const t = Date.now();
    const res = await ingest(
      token,
      conv({
        sessions: [session({ key: k, state: "idle" })],
        events: [
          event({ id: `${k}-p`, key: k, kind: "prompt", ts: t - 9000, text: "Publish agentblip 0.6.0 to npm", path: undefined }),
          event({ id: `${k}-m`, key: k, kind: "message", ts: t - 8000, text: "Built it. `npm publish` needs your key.", path: undefined }),
          event({ id: `${k}-b`, key: k, tool: "Bash", ts: t - 7000, cmd: "npm publish", desc: "Publish to npm", path: undefined }),
          event({ id: `${k}-t`, key: k, kind: "turn", ts: t - 1000, durationMs: 94_000, tool: undefined, path: undefined }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(0);
    const j = await job(hubKey);
    expect(j?.turn_id).toBe(`${k}-t`);
    expect(j!.due_at).toBeGreaterThanOrEqual(t + POLICY.coalesceMs - 50);

    expect(await run(Date.now() + 60_000)).toBeGreaterThanOrEqual(1);
    expect(mock.calls).toHaveLength(1);
    const req = mock.calls[0]!;
    expect(req.user).toContain("Publish agentblip 0.6.0 to npm");
    expect(req.user).toContain("Bash · \"Publish to npm\" · npm publish");
    expect(req.user).toContain("Turn ended after 1m 34s");
    expect((req.schema as { required: string[] }).required.sort()).toEqual(["now", "turn"]);

    const state = (await (await call("/api/state")).json()) as BoardState;
    const s = state.sessions.find((x) => x.hubKey === hubKey)!;
    expect(s.nowLine).toBe("Publishing agentblip 0.6.0; waiting on Sean's security key");
    expect(state.events.find((e) => e.id === `${k}-t`)?.summary).toContain("Sean asked to publish 0.6.0");
    expect(state.summarizer).toBe("Fake model");
  });

  it("pushes the now line and the turn summary to connected boards", async () => {
    const { token, deviceId } = await pairDevice();
    const k = key();
    await ingest(token, conv({ sessions: [session({ key: k, state: "idle" })], events: [event({ key: k, kind: "turn", durationMs: 5000, path: undefined, tool: undefined })] }));
    const res = await call("/api/stream", { headers: { upgrade: "websocket" } });
    const ws = res.webSocket!;
    const got: StreamMessage[] = [];
    ws.addEventListener("message", (m) => {
      got.push(JSON.parse(m.data as string));
    });
    ws.accept();
    await run(Date.now() + 60_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(got.some((m) => m.type === "session" && m.session.hubKey === `${deviceId}:${k}` && !!m.session.nowLine)).toBe(true);
    expect(got.some((m) => m.type === "turnSummary" && m.hubKey === `${deviceId}:${k}`)).toBe(true);
    ws.close();
  });
});

describe("waiting reasons", () => {
  it("entering waiting writes a reason; a new wait clears the old one until the next is written", async () => {
    const { token, deviceId } = await pairDevice();
    const k = key();
    const hubKey = `${deviceId}:${k}`;
    await ingest(token, conv({ sessions: [session({ key: k })], events: [event({ key: k })] }));
    await run(Date.now() + 60_000);
    await ingest(
      token,
      conv({ sessions: [session({ key: k, state: "waiting", activity: "needs my input" })], events: [event({ key: k, kind: "waiting", label: "needs my input", path: undefined, tool: undefined })] }),
    );
    expect((await job(hubKey))?.waiting).toBe(1);
    await run(Date.now() + 60_000);
    expect(mock.calls.at(-1)!.user).toContain("Waiting on Sean: needs my input");
    expect((await sessionRow(hubKey)).waiting_reason).toBe("Tap the security key for npm publish");

    await ingest(token, conv({ sessions: [session({ key: k, state: "working" })], events: [] }));
    await ingest(token, conv({ sessions: [session({ key: k, state: "waiting" })], events: [] }));
    expect((await sessionRow(hubKey)).waiting_reason).toBeNull();
  });

  it("drops a reason for a wait that ended while the model ran", async () => {
    const { token, deviceId } = await pairDevice();
    const k = key();
    const hubKey = `${deviceId}:${k}`;
    await ingest(token, conv({ sessions: [session({ key: k, state: "waiting" })], events: [event({ key: k })] }));
    await use(
      fake(async (req) => {
        // The person answers mid-call.
        await ingest(token, conv({ sessions: [session({ key: k, state: "working" })], events: [] }));
        return defaultRespond(req);
      }),
    );
    await run(Date.now() + 60_000);
    expect((await sessionRow(hubKey)).waiting_reason).toBeNull();
  });
});

describe("debounce and skips", () => {
  it("merges a burst into one job and spaces working refreshes 30 s (text) or 2 min (tools only)", async () => {
    const { token, deviceId } = await pairDevice();
    const k = key();
    const hubKey = `${deviceId}:${k}`;
    for (let i = 0; i < 5; i++) await ingest(token, conv({ sessions: [session({ key: k })], events: [event({ key: k })] }));
    expect(await sql("SELECT * FROM summary_jobs WHERE hub_key = ?", hubKey)).toHaveLength(1);
    await run(Date.now() + 5_000);
    expect(mock.calls).toHaveLength(1);
    const lastCall = (await sessionRow(hubKey)).sum_at!;

    await ingest(token, conv({ sessions: [session({ key: k })], events: [event({ key: k, kind: "message", text: "Tests pass.", path: undefined, tool: undefined })] }));
    expect((await job(hubKey))!.due_at).toBeGreaterThanOrEqual(lastCall + POLICY.workingGapMs);
    expect(await run(lastCall + POLICY.workingGapMs - 1_000)).toBe(0);
    expect(mock.calls).toHaveLength(1);
    await run(lastCall + POLICY.workingGapMs + 1_000);
    expect(mock.calls).toHaveLength(2);

    const second = (await sessionRow(hubKey)).sum_at!;
    await ingest(token, conv({ sessions: [session({ key: k })], events: [event({ key: k })] }));
    expect((await job(hubKey))!.due_at).toBeGreaterThanOrEqual(second + POLICY.quietGapMs);
  });

  it("skips a job when nothing is new since the last now line", async () => {
    const { token, deviceId } = await pairDevice();
    const k = key();
    const hubKey = `${deviceId}:${k}`;
    await ingest(token, conv({ sessions: [session({ key: k })], events: [event({ key: k })] }));
    await run(Date.now() + 60_000);
    expect(mock.calls).toHaveLength(1);
    await withDo((_p, st) =>
      st.storage.sql.exec("INSERT INTO summary_jobs (hub_key, due_at, created_at) VALUES (?, ?, ?)", hubKey, 0, 0),
    );
    await run(Date.now() + 60_000);
    expect(mock.calls).toHaveLength(1);
  });

  it("a resent backlog (events older than 15 min) triggers nothing", async () => {
    const { token, deviceId } = await pairDevice();
    const k = key();
    await ingest(token, conv({ sessions: [session({ key: k })], events: [] }));
    const old = Date.now() - POLICY.staleEventMs - 60_000;
    await ingest(token, conv({ sessions: [session({ key: k })], events: [event({ key: k, kind: "turn", ts: old, path: undefined, tool: undefined })] }));
    expect(await job(`${deviceId}:${k}`)).toBeUndefined();
  });
});

describe("caps and failures", () => {
  it("stops at the daily cap; past 90 % only turn summaries and waiting reasons run", async () => {
    const { token, deviceId } = await pairDevice();
    const a = key();
    const b = key();
    await ingest(token, conv({ sessions: [session({ key: a }), session({ key: b, state: "idle" })], events: [event({ key: a }), event({ key: b, kind: "turn", path: undefined, tool: undefined })] }));
    const day = utcDay(Date.now());
    await withDo((_p, st) => st.storage.sql.exec("INSERT INTO summary_usage (day, calls) VALUES (?, ?)", day, Math.floor(POLICY.dailyCap * 0.95)));
    await run(Date.now() + 60_000);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.user).toContain("Turn ended");
    const usage = (await sql<{ calls: number; skipped: number }>("SELECT calls, skipped FROM summary_usage WHERE day = ?", day))[0]!;
    expect(usage.skipped).toBe(1);

    await withDo((_p, st) => st.storage.sql.exec("UPDATE summary_usage SET calls = ? WHERE day = ?", POLICY.dailyCap, day));
    await ingest(token, conv({ sessions: [session({ key: a, state: "idle" })], events: [event({ key: a, kind: "turn", path: undefined, tool: undefined })] }));
    await run(Date.now() + 60_000);
    expect(mock.calls).toHaveLength(1);
    expect((await sessionRow(`${deviceId}:${b}`)).now_line).not.toBeNull();
  });

  it.each([
    ["refusal", { ok: false, reason: "refusal", provider: "fake" }],
    ["max_tokens", { ok: false, reason: "max_tokens", provider: "fake" }],
    ["bad_output", { ok: false, reason: "bad_output", provider: "fake" }],
  ] as const)("a %s stores nothing and is not retried", async (_name, result) => {
    const { token, deviceId } = await pairDevice();
    const k = key();
    const hubKey = `${deviceId}:${k}`;
    await use(fake(() => result as CompletionResult));
    await ingest(token, conv({ sessions: [session({ key: k, state: "idle" })], events: [event({ id: `${k}-t`, key: k, kind: "turn", path: undefined, tool: undefined })] }));
    await run(Date.now() + 60_000);
    expect(mock.calls).toHaveLength(1);
    expect((await sessionRow(hubKey)).now_line).toBeNull();
    expect((await sql<{ summary: string | null }>("SELECT summary FROM events WHERE id = ?", `${k}-t`))[0]!.summary).toBeNull();
    expect(await job(hubKey)).toBeUndefined();
    const state = await call("/api/state");
    expect(state.status).toBe(200);
  });

  it("an outage or rate limit retries once, a minute later, then gives up", async () => {
    const { token, deviceId } = await pairDevice();
    const k = key();
    const hubKey = `${deviceId}:${k}`;
    await use(fake(() => ({ ok: false, reason: "rate_limited", provider: "fake", status: 429 })));
    await ingest(token, conv({ sessions: [session({ key: k, state: "idle" })], events: [event({ key: k, kind: "turn", path: undefined, tool: undefined })] }));
    const t = Date.now() + 60_000;
    await run(t);
    const retry = await job(hubKey);
    expect(retry?.attempts).toBe(1);
    expect(retry!.due_at).toBe(t + POLICY.retryMs);
    await run(t + POLICY.retryMs);
    expect(mock.calls).toHaveLength(2);
    expect(await job(hubKey)).toBeUndefined();
  });

  it("with summaries off, ingest queues nothing", async () => {
    const { token, deviceId } = await pairDevice();
    await withDo((p) => p.setSummaryProvider(null, { manual: true }));
    const k = key();
    await ingest(token, conv({ sessions: [session({ key: k, state: "idle" })], events: [event({ key: k, kind: "turn", path: undefined, tool: undefined })] }));
    expect(await job(`${deviceId}:${k}`)).toBeUndefined();
    const state = (await (await call("/api/state")).json()) as BoardState;
    expect(state.summarizer).toBeNull();
  });
});

describe("metadata-only sessions", () => {
  it("are summarized from tools, paths and commands, never from text", async () => {
    const { token, deviceId } = await pairDevice("an@npclabs.org", "an-meta");
    const k = key();
    await ingest(
      token,
      batch({
        share: "metadata",
        sessions: [session({ key: k, state: "idle" })],
        events: [
          event({ key: k, kind: "prompt", text: "SECRET PROMPT TEXT", path: undefined, tool: undefined }),
          event({ key: k, tool: "Edit", path: "crates/b3os-sandboxes/src/vm.rs", desc: "SECRET DESC" }),
          event({ key: k, kind: "turn", path: undefined, tool: undefined }),
        ],
      }),
    );
    await run(Date.now() + 60_000);
    const req = mock.calls.find((c) => c.user.includes("crates/b3os-sandboxes/src/vm.rs"))!;
    expect(req.user).toContain("Shares activity only");
    expect(req.user).toContain("An sent a prompt (text not shared)");
    expect(req.user).not.toContain("SECRET");
    expect((await sessionRow(`${deviceId}:${k}`)).now_line).not.toBeNull();
  });
});

describe("digest", () => {
  it("a viewer back after 30 min gets a digest built off the request path, then served from cache", async () => {
    const viewer = `viewer${++n}@npclabs.org`;
    const as = { "x-dev-user-email": viewer };
    const { token } = await pairDevice();
    const k = key();
    await ingest(token, conv({ sessions: [session({ key: k, state: "idle" })], events: [event({ key: k, kind: "turn", path: undefined, tool: undefined })] }));
    await run(Date.now() + 60_000);
    const first = (await (await call("/api/state", { headers: as })).json()) as BoardState;
    expect(first.digest).toBeNull();
    expect(await job(`digest:${viewer}`)).toBeUndefined();

    // Away for two hours.
    await withDo((_p, st) => st.storage.sql.exec("UPDATE viewers SET last_seen_at = ? WHERE email = ?", Date.now() - 2 * 3600_000, viewer));
    const back = (await (await call("/api/state", { headers: as })).json()) as BoardState;
    expect(back.digest).toBeNull();
    expect(await job(`digest:${viewer}`)).toBeDefined();
    const before = mock.calls.length;
    await run(Date.now() + 1_000);
    expect(mock.calls.length).toBe(before + 1);
    expect(mock.calls.at(-1)!.user).toContain("<turns>");

    const again = (await (await call("/api/state", { headers: as })).json()) as BoardState;
    expect(again.digest?.lines).toEqual(["Sean shipped the summaries", "An is blocked on a boot test"]);
    expect(again.digest!.since).toBeLessThan(Date.now() - 3600_000);
    expect(mock.calls.length).toBe(before + 1);
  });
});

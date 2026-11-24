import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BoardState, StreamMessage } from "../src/shared/types";
import { scrubSecrets } from "../src/worker/ingest";
import { batch, call, event, ingest, pairDevice, post, projectStub, session, startPairing } from "./helpers";

// Conversation capture on the hub (SPEC.md §8, §10).

const rows = (q: string, ...args: SqlStorageValue[]) =>
  runInDurableObject(projectStub(), (_i, st) => st.storage.sql.exec(q, ...args).toArray());

const prompt = (over: Record<string, unknown> = {}) =>
  event({ kind: "prompt", tool: undefined, path: undefined, text: "Ship the hub forwarder", ...over });
const message = (over: Record<string, unknown> = {}) =>
  event({ kind: "message", tool: undefined, path: undefined, text: "Done. **307** tests pass.", ...over });

describe("conversation devices", () => {
  it("store prompt and message text, tool descriptions and turn durations, and record the level", async () => {
    const { token, deviceId } = await pairDevice();
    const res = await ingest(
      token,
      batch({
        share: "conversation",
        events: [
          prompt({ id: "c-p" }),
          message({ id: "c-m", truncated: true }),
          event({ id: "c-t", tool: "Bash", path: undefined, cmd: "pnpm test", desc: "Run the  test\nsuite" }),
          event({ id: "c-turn", kind: "turn", tool: undefined, path: undefined, durationMs: 94_000.4 }),
        ],
      }),
    );
    expect(await res.json()).toEqual({ ok: true, accepted: 4 });
    const state = (await (await call("/api/state")).json()) as BoardState;
    const byId = Object.fromEntries(state.events.filter((e) => e.deviceId === deviceId).map((e) => [e.id, e]));
    expect(byId["c-p"]!.text).toBe("Ship the hub forwarder");
    expect(byId["c-m"]).toMatchObject({ text: "Done. **307** tests pass.", truncated: true });
    expect(byId["c-t"]!.desc).toBe("Run the test suite");
    expect(byId["c-turn"]!.durationMs).toBe(94_000);
    expect(state.devices.find((d) => d.id === deviceId)!.share).toBe("conversation");
  });

  it("cut text over the cap and mark it truncated; far over it is a schema error", async () => {
    const { token, deviceId } = await pairDevice();
    const res = await ingest(
      token,
      batch({ share: "conversation", events: [prompt({ id: "long", text: "a".repeat(4_500) }), event({ id: "d", desc: "d".repeat(300) })] }),
    );
    expect(res.status).toBe(200);
    const [r] = await rows("SELECT length(text) AS n, truncated FROM events WHERE device_id = ? AND id = 'long'", deviceId);
    expect(r).toEqual({ n: 4_000, truncated: 1 });
    const [d] = await rows("SELECT length(descr) AS n FROM events WHERE device_id = ? AND id = 'd'", deviceId);
    expect(d).toEqual({ n: 200 });
    expect((await ingest(token, batch({ share: "conversation", events: [prompt({ text: "a".repeat(16_001) })] }))).status).toBe(400);
    expect((await ingest(token, batch({ share: "nope" }))).status).toBe(400);
  });

  it("keep text on prompts and messages only, and drop a message without text", async () => {
    const { token, deviceId } = await pairDevice();
    await ingest(token, batch({ share: "conversation", events: [event({ id: "tool-text", text: "STRAY" }), message({ id: "empty", text: "" })] }));
    const got = await rows("SELECT id, text FROM events WHERE device_id = ?", deviceId);
    expect(got).toEqual([{ id: "tool-text", text: null }]);
  });

  it("redact obvious credentials as a second guard behind the relay", async () => {
    const { token, deviceId } = await pairDevice();
    const secrets = [
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      `bp_${"ab".repeat(32)}`,
      "AKIAABCDEFGHIJKLMNOP",
      "xoxb-1234567890-abcdefghij",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ];
    await ingest(
      token,
      batch({
        share: "conversation",
        events: [
          prompt({ id: "s1", text: `use ${secrets.join(" and ")} please` }),
          message({ id: "s2", text: "clone https://sean:hunter2pass@github.com/b3-fun/bullpen and\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----" }),
          event({ id: "s3", desc: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwx'" }),
        ],
      }),
    );
    const all = JSON.stringify(await rows("SELECT text, descr FROM events WHERE device_id = ?", deviceId));
    for (const s of [...secrets, "hunter2pass", "AAAA", "abcdefghijklmnopqrstuvwx"]) expect(all).not.toContain(s);
    expect(all).toContain("https://[redacted]@github.com/b3-fun/bullpen");
    expect(scrubSecrets("task-runner and risk-assessment-report-for-the-team stay")).toBe(
      "task-runner and risk-assessment-report-for-the-team stay",
    );
  });
});

describe("metadata devices", () => {
  it("keep no text: prompts lose it, messages are dropped, descriptions are cleared", async () => {
    const { token, deviceId } = await pairDevice("an@npclabs.org", "an-meta");
    const res = await ingest(
      token,
      batch({
        share: "metadata",
        events: [prompt({ id: "m-p", text: "SECRET PROMPT" }), message({ id: "m-m", text: "SECRET MESSAGE" }), event({ id: "m-t", desc: "SECRET DESC" })],
      }),
    );
    expect(await res.json()).toEqual({ ok: true, accepted: 2 });
    const dump = JSON.stringify(await rows("SELECT * FROM events WHERE device_id = ?", deviceId));
    expect(dump).not.toContain("SECRET");
    expect((await rows("SELECT share FROM devices WHERE id = ?", deviceId))[0]).toEqual({ share: "metadata" });
  });

  it("old relays (no share, v0 kinds only) keep working and count as metadata", async () => {
    const { token, deviceId } = await pairDevice();
    const res = await ingest(token, { v: 1, sentAt: Date.now(), full: false, sessions: [session()], events: [event({ id: "v0", text: "SECRET" })] });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await rows("SELECT * FROM events WHERE device_id = ?", deviceId))).not.toContain("SECRET");
    expect((await rows("SELECT share FROM devices WHERE id = ?", deviceId))[0]).toEqual({ share: "metadata" });
  });

  it("going back to metadata purges what the device shared and tells boards", async () => {
    const { token, deviceId } = await pairDevice();
    await ingest(token, batch({ share: "conversation", events: [prompt({ id: "x-p" }), event({ id: "x-t", desc: "Run tests" })] }));
    await runInDurableObject(projectStub(), (_i, st) => {
      st.storage.sql.exec("UPDATE sessions SET now_line = 'Running tests', waiting_reason = 'Approve' WHERE device_id = ?", deviceId);
      st.storage.sql.exec("UPDATE events SET summary = 'Did a thing' WHERE device_id = ?", deviceId);
    });
    const ws = (await call("/api/stream", { headers: { upgrade: "websocket" } })).webSocket!;
    const got: StreamMessage[] = [];
    ws.addEventListener("message", (m) => {
      got.push(JSON.parse(m.data as string));
    });
    ws.accept();
    await ingest(token, batch({ share: "metadata", events: [] }));
    await new Promise((r) => setTimeout(r, 50));
    const ev = await rows("SELECT text, descr, summary FROM events WHERE device_id = ?", deviceId);
    expect(ev.every((r) => r.text == null && r.descr == null && r.summary == null)).toBe(true);
    const [s] = await rows("SELECT now_line, waiting_reason FROM sessions WHERE device_id = ?", deviceId);
    expect(s).toEqual({ now_line: null, waiting_reason: null });
    expect(got.some((m) => m.type === "purge" && m.deviceId === deviceId)).toBe(true);
    expect(got.some((m) => m.type === "device" && m.device.id === deviceId && m.device.share === "metadata")).toBe(true);
    ws.close();
  });
});

describe("pairing with a level", () => {
  it("the approve page learns the level the relay will share", async () => {
    const res = await post("/relay/pair/start", { machine: "share-mac", client: "agentblip/0.7.0", share: "conversation" }, { "cf-connecting-ip": "10.9.9.9" });
    const { code } = (await res.json()) as { code: string };
    const info = (await (await call(`/api/pair/${code}`)).json()) as { share: string | null };
    expect(info.share).toBe("conversation");
    const old = await startPairing("old-relay");
    expect(((await (await call(`/api/pair/${old.code}`)).json()) as { share: string | null }).share).toBeNull();
  });
});

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BoardState, StreamMessage } from "../src/shared/types";
import { batch, call, event, ingest, pairDevice, post, projectStub, session } from "./helpers";

async function state(): Promise<BoardState> {
  return (await call("/api/state")).json();
}

describe("ingest auth", () => {
  it("401 without a token", async () => {
    expect((await ingest(null, batch())).status).toBe(401);
  });

  it("401 for a malformed token", async () => {
    expect((await ingest("bp_nothex", batch())).status).toBe(401);
  });

  it("401 for a well-formed but unknown token", async () => {
    expect((await ingest(`bp_${"a".repeat(64)}`, batch())).status).toBe(401);
  });

  it("401 once the device is revoked; only its owner can revoke", async () => {
    const { token, deviceId } = await pairDevice("an@npclabs.org", "an-laptop");
    expect((await ingest(token, batch())).status).toBe(200);

    const notMine = await post(`/api/devices/${deviceId}/revoke`, {}, { "x-dev-user-email": "sean@npclabs.org" });
    expect(notMine.status).toBe(404);
    expect((await ingest(token, batch())).status).toBe(200);

    const mine = await post(`/api/devices/${deviceId}/revoke`, {}, { "x-dev-user-email": "an@npclabs.org" });
    expect(mine.status).toBe(200);
    expect((await ingest(token, batch())).status).toBe(401);

    const s = await state();
    expect(s.devices.find((d) => d.id === deviceId)).toBeUndefined();
    expect(s.sessions.find((x) => x.deviceId === deviceId)).toBeUndefined();
  });
});

describe("ingest validation", () => {
  it("accepts a valid batch", async () => {
    const { token } = await pairDevice();
    const res = await ingest(token, batch());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: 1 });
  });

  it("accepts `gh pr create` with a PR link, and rounds fractional timestamps", async () => {
    const { token, deviceId } = await pairDevice();
    const ts = Date.now() + 0.6;
    const res = await ingest(
      token,
      batch({ events: [event({ id: "pr-1", ts, tool: "Bash", path: undefined, cmd: "gh pr create", pr: "https://github.com/b3-fun/bullpen/pull/7" })] }),
    );
    expect(res.status).toBe(200);
    await runInDurableObject(projectStub(), (_i, st) => {
      const row = st.storage.sql.exec("SELECT ts, cmd, pr FROM events WHERE device_id = ? AND id = 'pr-1'", deviceId).one();
      expect(row).toEqual({ ts: Math.round(ts), cmd: "gh pr create", pr: "https://github.com/b3-fun/bullpen/pull/7" });
    });
  });

  it.each([
    ["wrong version", { v: 2 }],
    ["unknown state", { sessions: [session({ state: "thinking" })] }],
    ["unknown event kind", { events: [event({ kind: "chat" })] }],
    ["absolute path", { events: [event({ path: "/Users/sean/secret.txt" })] }],
    ["path escaping the repo", { events: [event({ path: "src/../../.ssh/id_rsa" })] }],
    ["full command line", { events: [event({ cmd: "git commit -m 'secret message'" })] }],
    ["non-PR link", { events: [event({ pr: "https://example.com/x" })] }],
    ["too many events", { events: Array.from({ length: 501 }, () => event()) }],
    ["agents out of range", { sessions: [session({ agents: 0 })] }],
    ["over-long activity", { sessions: [session({ activity: "x".repeat(201) })] }],
  ])("400 for %s, and nothing is stored", async (_name, over) => {
    const { token, deviceId } = await pairDevice();
    const res = await ingest(token, batch(over));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: string[] };
    expect(body.issues.length).toBeGreaterThan(0);
    await runInDurableObject(projectStub(), (_i, st) => {
      expect(st.storage.sql.exec("SELECT * FROM events WHERE device_id = ?", deviceId).toArray()).toHaveLength(0);
      expect(st.storage.sql.exec("SELECT * FROM sessions WHERE device_id = ?", deviceId).toArray()).toHaveLength(0);
    });
  });

  it("400 for a body that is not JSON", async () => {
    const { token } = await pairDevice();
    expect((await ingest(token, "{nope")).status).toBe(400);
  });

  it("413 over 256 KB, with or without a content-length", async () => {
    const { token } = await pairDevice();
    const big = JSON.stringify(batch({ pad: "x".repeat(256 * 1024) }));
    expect((await ingest(token, big)).status).toBe(413);

    const bytes = new TextEncoder().encode(big);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 16 * 1024) c.enqueue(bytes.slice(i, i + 16 * 1024));
        c.close();
      },
    });
    const res = await call("/relay/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: stream,
      // @ts-expect-error duplex is required for streamed bodies
      duplex: "half",
    });
    expect(res.status).toBe(413);
  });
});

describe("ingest storage", () => {
  it("dedupes events on (deviceId, id)", async () => {
    const a = await pairDevice("sean@npclabs.org", "mac-a");
    const b = await pairDevice("an@npclabs.org", "mac-b");
    const ev = event({ id: "same-id" });
    expect(await (await ingest(a.token, batch({ events: [ev, ev] }))).json()).toEqual({ ok: true, accepted: 1 });
    expect(await (await ingest(a.token, batch({ events: [ev] }))).json()).toEqual({ ok: true, accepted: 0 });
    expect(await (await ingest(b.token, batch({ events: [ev] }))).json()).toEqual({ ok: true, accepted: 1 });
    await runInDurableObject(projectStub(), (_i, st) => {
      const rows = st.storage.sql.exec("SELECT device_id FROM events WHERE id = 'same-id'").toArray();
      expect(rows.map((r) => r.device_id).sort()).toEqual([a.deviceId, b.deviceId].sort());
    });
  });

  it("takes the owner from the token; payload fields cannot spoof it or smuggle content", async () => {
    const { token, deviceId } = await pairDevice("gio@npclabs.org", "gio-mac");
    const res = await ingest(
      token,
      batch({
        email: "sean@npclabs.org",
        owner: "sean@npclabs.org",
        deviceId: "dev_00000000000000000000000000",
        sessions: [session({ email: "sean@npclabs.org", owner: "sean", deviceId: "other", prompt: "SECRET PROMPT" })],
        events: [
          event({
            email: "sean@npclabs.org",
            hubKey: "dev_X:claude-code:s1",
            deviceId: "other",
            prompt: "SECRET PROMPT",
            output: "SECRET OUTPUT",
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);

    const s = await state();
    const mine = s.sessions.filter((x) => x.deviceId === deviceId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.email).toBe("gio@npclabs.org");
    expect(mine[0]!.hubKey).toBe(`${deviceId}:claude-code:s1`);
    const ev = s.events.find((e) => e.deviceId === deviceId)!;
    expect(ev.email).toBe("gio@npclabs.org");
    expect(ev.hubKey).toBe(`${deviceId}:claude-code:s1`);

    await runInDurableObject(projectStub(), (_i, st) => {
      const all = JSON.stringify([
        st.storage.sql.exec("SELECT * FROM sessions").toArray(),
        st.storage.sql.exec("SELECT * FROM events").toArray(),
      ]);
      expect(all).not.toContain("SECRET");
      const owners = st.storage.sql
        .exec("SELECT DISTINCT email FROM sessions WHERE device_id = ?", deviceId)
        .toArray()
        .map((r) => r.email);
      expect(owners).toEqual(["gio@npclabs.org"]);
    });
  });

  it("a full heartbeat ends sessions missing from the set", async () => {
    const { token, deviceId } = await pairDevice();
    await ingest(token, batch({ sessions: [session({ key: "claude-code:a" }), session({ key: "codex:b" })], events: [] }));
    await ingest(token, batch({ full: true, sessions: [session({ key: "claude-code:a" })], events: [] }));
    const s = await state();
    const byKey = Object.fromEntries(s.sessions.filter((x) => x.deviceId === deviceId).map((x) => [x.key, x.state]));
    expect(byKey).toEqual({ "claude-code:a": "working", "codex:b": "ended" });
  });

  it("updates last-seen and the session's last event time", async () => {
    const { token, deviceId } = await pairDevice();
    const ts = Date.now() - 5_000;
    await ingest(token, batch({ events: [event({ ts })] }));
    const s = await state();
    expect(s.devices.find((d) => d.id === deviceId)!.lastSeenAt).toBeGreaterThan(ts);
    expect(s.sessions.find((x) => x.deviceId === deviceId)!.lastEventAt).toBe(ts);
  });

  it("streams sessions and events to connected boards", async () => {
    const { token } = await pairDevice();
    const res = await call("/api/stream", { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const got: StreamMessage[] = [];
    ws.addEventListener("message", (m) => {
      got.push(JSON.parse(m.data as string));
    });
    ws.accept();
    await ingest(token, batch({ events: [event({ id: "ws-1" })] }));
    await new Promise((r) => setTimeout(r, 50));
    const types = got.map((m) => m.type);
    expect(types).toContain("session");
    expect(types).toContain("events");
    const evs = got.find((m) => m.type === "events");
    expect(evs && evs.type === "events" && evs.events[0]!.id).toBe("ws-1");
    ws.close();
  });
});

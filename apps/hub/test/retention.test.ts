import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BoardState } from "../src/shared/types";
import { batch, call, event, ingest, pairDevice, projectStub, session, startPairing } from "./helpers";

const DAY = 24 * 3600_000;

describe("retention", () => {
  it("the hourly alarm prunes events older than 7 days, stale sessions and old pairings", async () => {
    const { token, deviceId } = await pairDevice();
    const now = Date.now();
    await ingest(
      token,
      batch({
        sessions: [session({ key: "claude-code:old" }), session({ key: "claude-code:new" })],
        events: [
          event({ id: "old", key: "claude-code:old", ts: now - 8 * DAY }),
          event({ id: "edge", key: "claude-code:new", ts: now - 6 * DAY }),
          event({ id: "new", key: "claude-code:new", ts: now - 1000 }),
        ],
      }),
    );
    const pending = await startPairing("abandoned");

    await runInDurableObject(projectStub(), (_i, st) => {
      st.storage.sql.exec("UPDATE sessions SET seen_at = ? WHERE hub_key = ?", now - 8 * DAY, `${deviceId}:claude-code:old`);
      st.storage.sql.exec("UPDATE pairings SET created_at = ? WHERE code = ?", now - 2 * DAY, pending.code);
    });

    expect(await runDurableObjectAlarm(projectStub())).toBe(true);

    await runInDurableObject(projectStub(), async (_i, st) => {
      const ids = st.storage.sql
        .exec("SELECT id FROM events WHERE device_id = ? ORDER BY id", deviceId)
        .toArray()
        .map((r) => r.id);
      expect(ids).toEqual(["edge", "new"]);
      const keys = st.storage.sql
        .exec("SELECT key FROM sessions WHERE device_id = ?", deviceId)
        .toArray()
        .map((r) => r.key);
      expect(keys).toEqual(["claude-code:new"]);
      expect(st.storage.sql.exec("SELECT * FROM pairings WHERE code = ?", pending.code).toArray()).toHaveLength(0);
      // The alarm re-arms itself for the next hour.
      expect(await st.storage.getAlarm()).toBeGreaterThan(Date.now());
    });
  });

  it("the board drops sessions that ended more than 12 h ago and keeps offline ones dimmable", async () => {
    const { token, deviceId } = await pairDevice();
    await ingest(
      token,
      batch({
        sessions: [
          session({ key: "claude-code:live" }),
          session({ key: "claude-code:recent-end", state: "ended" }),
          session({ key: "claude-code:old-end", state: "ended" }),
        ],
        events: [],
      }),
    );
    await runInDurableObject(projectStub(), (_i, st) => {
      st.storage.sql.exec("UPDATE sessions SET ended_at = ? WHERE hub_key = ?", Date.now() - 13 * 3600_000, `${deviceId}:claude-code:old-end`);
      // Device went quiet 5 minutes ago: offline, but its sessions stay on the board.
      st.storage.sql.exec("UPDATE devices SET last_seen_at = ? WHERE id = ?", Date.now() - 5 * 60_000, deviceId);
    });
    const s = (await (await call("/api/state")).json()) as BoardState;
    const keys = s.sessions.filter((x) => x.deviceId === deviceId).map((x) => x.key).sort();
    expect(keys).toEqual(["claude-code:live", "claude-code:recent-end"]);
    expect(Date.now() - s.devices.find((d) => d.id === deviceId)!.lastSeenAt!).toBeGreaterThan(2 * 60_000);
  });
});

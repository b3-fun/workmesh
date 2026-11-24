import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/worker/crypto";
import { approve, call, poll, post, projectStub, startPairing } from "./helpers";

describe("pairing", () => {
  it("starts with a code, device id, poll secret and verify URL", async () => {
    const p = await startPairing("seans-mac-studio");
    expect(p.code).toMatch(/^[A-Z]{4}-\d{4}$/);
    expect(p.deviceId).toMatch(/^dev_[0-9A-Z]{26}$/);
    expect(p.pollSecret).toMatch(/^[0-9a-f]{32}$/);
    expect(p.verifyUrl).toBe(`https://bullpen.b3os.org/pair?code=${p.code}`);
    expect(p.expiresInSec).toBe(600);
  });

  it("is pending until a signed-in person approves, then delivers the token exactly once", async () => {
    const p = await startPairing("seans-mac-studio");
    expect(await (await poll(p)).json()).toEqual({ status: "pending" });

    const info = await call(`/api/pair/${p.code}`);
    expect(await info.json()).toMatchObject({ code: p.code, machine: "seans-mac-studio", status: "pending" });

    const a = await approve(p.code, "sean@npclabs.org");
    expect(a.status).toBe(200);

    const first = (await (await poll(p)).json()) as Record<string, unknown>;
    expect(first.status).toBe("complete");
    expect(first.deviceToken).toMatch(/^bp_[0-9a-f]{64}$/);
    expect(first.person).toEqual({ email: "sean@npclabs.org", name: "Sean" });
    expect(first.project).toEqual({
      id: "b3",
      name: "B3",
      include: { remotes: ["github.com/b3-fun/"], dirs: [] },
      issueKeys: ["B3"],
    });

    const second = (await (await poll(p)).json()) as Record<string, unknown>;
    expect(second.status).toBe("complete");
    expect(second).not.toHaveProperty("deviceToken");

    // Only the SHA-256 of the token is stored.
    const token = first.deviceToken as string;
    const hash = await sha256Hex(token);
    await runInDurableObject(projectStub(), (_instance, state) => {
      const rows = state.storage.sql.exec("SELECT * FROM devices WHERE id = ?", p.deviceId).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_hash).toBe(hash);
      expect(JSON.stringify(rows)).not.toContain(token);
      const pairings = state.storage.sql.exec("SELECT * FROM pairings").toArray();
      expect(JSON.stringify(pairings)).not.toContain(p.pollSecret);
    });
  });

  it("rejects a wrong poll secret", async () => {
    const p = await startPairing();
    const res = await poll({ deviceId: p.deviceId, pollSecret: "0".repeat(32) });
    expect(res.status).toBe(401);
  });

  it("expires after ten minutes: poll says expired, approve says gone", async () => {
    const p = await startPairing();
    await runInDurableObject(projectStub(), (_i, state) => {
      state.storage.sql.exec(
        "UPDATE pairings SET created_at = created_at - 601000, expires_at = expires_at - 601000 WHERE code = ?",
        p.code,
      );
    });
    expect(await (await poll(p)).json()).toEqual({ status: "expired" });
    expect((await approve(p.code)).status).toBe(410);
    expect(((await (await call(`/api/pair/${p.code}`)).json()) as { status: string }).status).toBe("expired");
  });

  it("refuses unknown codes and a second approver", async () => {
    expect((await approve("ZZZZ-0000")).status).toBe(404);
    const p = await startPairing();
    expect((await approve(p.code, "an@npclabs.org")).status).toBe(200);
    expect((await approve(p.code, "an@npclabs.org")).status).toBe(200);
    expect((await approve(p.code, "gio@npclabs.org")).status).toBe(409);
    const done = (await (await poll(p)).json()) as { person: { email: string } };
    expect(done.person.email).toBe("an@npclabs.org");
  });

  it("validates the start body", async () => {
    const res = await post("/relay/pair/start", { machine: "" }, { "cf-connecting-ip": "10.9.9.9" });
    expect(res.status).toBe(400);
  });

  it("limits pair starts to 10 per IP per hour", async () => {
    const start = (ip: string) =>
      post("/relay/pair/start", { machine: "m", client: "c" }, { "cf-connecting-ip": ip });
    for (let i = 0; i < 10; i++) expect((await start("203.0.113.7")).status).toBe(200);
    const limited = await start("203.0.113.7");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await start("203.0.113.8")).status).toBe(200);
  });
});

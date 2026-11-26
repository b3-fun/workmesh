import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { DeviceCredentials, deviceFetch } from "../src/hub/device-auth";

const pair = { url: "https://hub.test", deviceId: "dev_test", deviceToken: "bp_" + "1".repeat(64) };
const access = "bp_" + "2".repeat(64);
const dirs: string[] = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-auth-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it("recovers from a lost refresh response after daemon restart and coalesces concurrent callers", async () => {
  const dir = temp();
  const store = new DeviceCredentials(pair, dir, false);
  const requests: Array<{ proof: string | null; next: string }> = [];
  let lost = true;
  const transport: typeof fetch = async (url, options) => {
    const proof = new Headers(options?.headers).get("authorization");
    expect(options?.redirect).toBe("error");
    if (String(url).endsWith("/refresh")) {
      requests.push({ proof, next: JSON.parse(String(options?.body)).next });
      if (lost) { lost = false; throw new Error("interrupted"); }
      return Response.json({ deviceToken: access, expiresInSec: 900 });
    }
    expect(proof).toBe("Bearer " + access);
    return Response.json({ ok: true });
  };
  await expect(deviceFetch(pair, store, transport)(pair.url + "/relay/team")).rejects.toThrow("interrupted");
  const cached = store.read()!;
  expect(cached.next).toBe(requests[0]!.next);
  const files = fs.readdirSync(path.join(dir, "devices"));
  expect(fs.statSync(path.join(dir, "devices", files[0]!)).mode & 0o777).toBe(0o600);
  let now = 0;
  const restarted = deviceFetch(pair, new DeviceCredentials(pair, dir, false), transport, () => now);
  await Promise.all(["team", "sync", "ingest"].map((route) => restarted(pair.url + "/relay/" + route)));
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(store.read()).toEqual({ current: cached.next });
  now = 900_000;
  await restarted(pair.url + "/relay/sync");
  expect(requests[2]!.proof).toBe("Bearer " + cached.next);
  expect(requests[2]!.next).not.toBe(cached.next);
  await expect(restarted("https://other.test/relay/sync")).rejects.toThrow();
  store.remove();
  expect(store.read()).toBeUndefined();
});

it("never downgrades a migrated pairing to legacy access on an unavailable hub", async () => {
  const store = new DeviceCredentials(pair, temp(), false);
  store.write({ current: "wr_" + "3".repeat(64) });
  const requests: string[] = [];
  const send = deviceFetch(pair, store, async url => {
    requests.push(String(url));
    return new Response(null, { status: 404 });
  });
  await expect(send(pair.url + "/relay/team")).rejects.toThrow("404");
  expect(requests).toEqual([pair.url + "/relay/device/refresh"]);
});

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { HUB_DEVICE_TOKEN_RE, HUB_REFRESH_TOKEN_RE, hubDeviceRefreshResponseSchema } from "@workmesh/protocol";
import { configDir } from "../lib/paths";
import { writeStateFile } from "./persist";

type Pairing = { deviceId: string; deviceToken: string; url: string };
const refresh = z.string().regex(HUB_REFRESH_TOKEN_RE);
const credentials = z.object({ current: z.union([refresh, z.string().regex(HUB_DEVICE_TOKEN_RE)]), next: refresh.optional() });
type Credentials = z.infer<typeof credentials>;
const service = "org.b3os.workmesh.device-refresh";

/** Only the daemon writes. A successor is durable before the hub consumes its predecessor. */
export class DeviceCredentials {
  private readonly account: string;
  private readonly file: string;

  constructor(pair: Pairing, dir = configDir(), private readonly useKeychain = process.platform === "darwin") {
    this.account = createHash("sha256").update(pair.deviceId + ":" + pair.deviceToken).digest("hex");
    this.file = path.join(dir, "devices", this.account + ".json");
  }

  private keychain(args: string[], input?: string) {
    return spawnSync("/usr/bin/security", args, { input, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"] });
  }

  private keychainValue(): string | undefined {
    const result = this.keychain(["find-generic-password", "-s", service, "-a", this.account, "-w"]);
    return result.status === 0 ? result.stdout.trim() : undefined;
  }

  private stored(): unknown {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Could not read the saved Workmesh device credentials");
    }
  }

  read(): Credentials | undefined {
    const stored = this.stored();
    if (stored === undefined) return undefined;
    if (stored !== "keychain") return credentials.parse(stored);
    const encoded = this.keychainValue();
    if (!encoded) throw new Error("Unlock the login Keychain to refresh this Workmesh device");
    return credentials.parse(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
  }

  write(value: Credentials): void {
    const stored = this.stored();
    if (stored === "keychain" || (stored === undefined && this.useKeychain)) {
      // Only fixed strings, hex and base64 enter security's stdin. The credential is never in process arguments.
      const encoded = Buffer.from(JSON.stringify(value)).toString("base64");
      this.keychain(["-i"], `add-generic-password -U -s ${service} -a ${this.account} -w ${encoded}\n`);
      if (this.keychainValue() === encoded) {
        if (stored !== "keychain") writeStateFile(this.file, JSON.stringify("keychain"));
        return;
      }
      if (stored === "keychain") throw new Error("Could not update the Workmesh device credential in Keychain");
    }
    writeStateFile(this.file, value);
  }

  remove(): void {
    if (this.stored() === "keychain") {
      const result = this.keychain(["delete-generic-password", "-s", service, "-a", this.account]);
      if (result.status !== 0 && result.status !== 44) throw new Error("Could not remove the Workmesh device credential from Keychain");
    }
    fs.rmSync(this.file, { force: true });
  }
}

/** Shared by sync, ingest, team and every coordination operation, including concurrent polls. */
export function deviceFetch(pair: Pairing, store = new DeviceCredentials(pair), transport = fetch, now = Date.now): typeof fetch {
  let access: { token: string; until: number } | undefined;
  let refreshing: Promise<string | Response> | undefined;

  async function renew(): Promise<string | Response> {
    const saved = store.read();
    const current = saved?.current ?? pair.deviceToken;
    const next = saved?.next ?? `wr_${randomBytes(32).toString("hex")}`;
    if (!saved?.next) store.write({ current, next });
    const start = now();
    const res = await transport(pair.url + "/relay/device/refresh", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { authorization: `Bearer ${current}`, "content-type": "application/json" },
      body: JSON.stringify({ deviceId: pair.deviceId, next }),
    });
    if (res.status === 404 && current === pair.deviceToken) {
      // Rollout ordering: old hubs keep working and are probed again after one minute.
      access = { token: current, until: start + 60_000 };
      return current;
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) return res;
      throw new Error(`Could not renew Workmesh device access (HTTP ${res.status})`);
    }
    const fresh = hubDeviceRefreshResponseSchema.parse(await res.json());
    if (store.read()?.next !== next) throw new Error("The Workmesh pairing changed during refresh");
    store.write({ current: next });
    access = { token: fresh.deviceToken, until: start + fresh.expiresInSec * 1000 - 30_000 };
    return fresh.deviceToken;
  }

  return async (url, init) => {
    if (!String(url).startsWith(pair.url + "/relay/")) throw new Error("Device credentials belong to the paired hub");
    const token = access && access.until > now() ? access.token : await (refreshing ??= renew().finally(() => { refreshing = undefined; }));
    if (typeof token !== "string") return token.clone();
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return transport(url, { ...init, headers, redirect: "error" });
  };
}

/** Probe without rotating the daemon's credential. A pending successor may already have committed on the hub. */
export async function deviceStatus(pair: Pairing, transport: typeof fetch): Promise<number | undefined> {
  const saved = new DeviceCredentials(pair).read();
  for (const proof of [saved?.current ?? pair.deviceToken, saved?.next]) {
    if (!proof) continue;
    const res = await transport(pair.url + "/relay/device/status", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { authorization: `Bearer ${proof}`, "content-type": "application/json" },
      body: JSON.stringify({ deviceId: pair.deviceId }),
    });
    if (res.status === 404 && (!saved || saved.current === pair.deviceToken)) return undefined;
    if (res.status !== 401) return res.status;
  }
  return 401;
}

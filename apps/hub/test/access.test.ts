import { env } from "cloudflare:test";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { accessCertsUrl, resetJwksCache } from "../src/worker/access";
import { call, post, prodEnv } from "./helpers";

const TEAM = "npclabs.cloudflareaccess.com";
const ISS = `https://${TEAM}`;
const AUD = env.ACCESS_AUD;

let key: CryptoKey;
let otherKey: CryptoKey;
let jwk: JWK;
let certsFetches = 0;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  key = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };
  otherKey = (await generateKeyPair("RS256")).privateKey;
  resetJwksCache();
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === accessCertsUrl(TEAM)) {
      certsFetches++;
      return Response.json({ keys: [jwk], public_cert: { kid: "test-kid" } });
    }
    return realFetch(input, init);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  resetJwksCache();
});

async function token(
  opts: { aud?: string; iss?: string; exp?: number | string; email?: string | null; signWith?: CryptoKey } = {},
) {
  const claims: Record<string, unknown> = { type: "app", identity_nonce: "n" };
  if (opts.email !== null) claims.email = opts.email ?? "an@example.com";
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer(opts.iss ?? ISS)
    .setAudience(opts.aud ?? AUD)
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(opts.signWith ?? key);
}

const me = (jwt?: string, extra: Record<string, string> = {}) =>
  call("/api/me", { headers: { ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}), ...extra } }, prodEnv);

describe("Access JWT on /api/*", () => {
  it("accepts a valid token and takes the email from it", async () => {
    const res = await me(await token({ email: "An@Example.com" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "an@example.com", name: "An" });
    expect(certsFetches).toBeGreaterThan(0);
  });

  it("401 when the header is missing", async () => {
    expect((await me()).status).toBe(401);
  });

  it("401 when only the unsigned email header is present", async () => {
    expect((await me(undefined, { "cf-access-authenticated-user-email": "sean@example.com" })).status).toBe(401);
  });

  it("401 for the wrong audience", async () => {
    expect((await me(await token({ aud: "someone-elses-app" }))).status).toBe(401);
  });

  it("401 for the wrong issuer", async () => {
    expect((await me(await token({ iss: "https://evil.cloudflareaccess.com" }))).status).toBe(401);
  });

  it("401 for an expired token", async () => {
    expect((await me(await token({ exp: Math.floor(Date.now() / 1000) - 3600 }))).status).toBe(401);
  });

  it("401 for a token signed by another key", async () => {
    expect((await me(await token({ signWith: otherKey }))).status).toBe(401);
  });

  it("401 for a token without an email (service token)", async () => {
    expect((await me(await token({ email: null }))).status).toBe(401);
  });

  it("401 for garbage", async () => {
    expect((await me("not.a.jwt")).status).toBe(401);
  });

  it("guards every /api route, including writes and the stream", async () => {
    expect((await call("/api/state", {}, prodEnv)).status).toBe(401);
    expect((await call("/api/devices", {}, prodEnv)).status).toBe(401);
    expect((await call("/api/stream", { headers: { upgrade: "websocket" } }, prodEnv)).status).toBe(401);
    expect((await post("/api/pair/approve", { code: "ABCD-1234" }, {}, prodEnv)).status).toBe(401);
  });

  it("leaves /relay/* to device tokens (Access is bypassed there)", async () => {
    const res = await post("/relay/pair/start", { machine: "m", client: "c" }, { "cf-connecting-ip": "10.77.0.1" }, prodEnv);
    expect(res.status).toBe(200);
  });
});

describe("DEV_USER_EMAIL", () => {
  it("refuses every /api call when set in production", async () => {
    const bad = { ...prodEnv, DEV_USER_EMAIL: "sean@example.com" } as Env;
    const jwt = await token();
    for (const path of ["/api/me", "/api/state", "/api/devices"]) {
      const res = await call(path, { headers: { "cf-access-jwt-assertion": jwt } }, bad);
      expect(res.status).toBe(500);
    }
  });

  it("skips Access outside production", async () => {
    const dev = { ...prodEnv, ENVIRONMENT: "development", DEV_USER_EMAIL: "sean@example.com" } as Env;
    const res = await call("/api/me", {}, dev);
    expect(await res.json()).toEqual({ email: "sean@example.com", name: "Sean" });
  });
});

describe("cross-origin writes", () => {
  it("403 when a write comes from another origin", async () => {
    const res = await post("/api/pair/approve", { code: "ABCD-1234" }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });
});

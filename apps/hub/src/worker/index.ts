import { Hono, type Context, type MiddlewareHandler } from "hono";
import { MAX_RELAY_BODY_BYTES, PROJECT } from "../shared/types";
import { AccessError, verifyAccessJwt } from "./access";
import { DEVICE_TOKEN_RE, sha256Hex } from "./crypto";
import type { Project, Result } from "./project";
import {
  IngestSchema,
  PairApproveSchema,
  PairCodeSchema,
  PairPollSchema,
  PairStartSchema,
  describeIssues,
} from "./schema";

export { Project } from "./project";

type AppEnv = { Bindings: Env; Variables: { email: string } };

const app = new Hono<AppEnv>();

const project = (env: Env): DurableObjectStub<Project> => env.PROJECT.get(env.PROJECT.idFromName(PROJECT.id));

function send(c: Context, r: Result): Response {
  return c.json(r.body as object, r.status as 200, r.headers);
}

const jsonError = (c: Context, status: number, error: string, extra?: object) =>
  c.json({ error, ...extra }, status as 400);

class TooLarge extends Error {}

/** Reads at most `max` bytes; throws TooLarge past that, without buffering the rest. */
async function readCapped(req: Request, max: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > max) throw new TooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const ch of chunks) {
    all.set(ch, off);
    off += ch.byteLength;
  }
  return new TextDecoder().decode(all);
}

type Parsed = { ok: true; data: unknown } | { ok: false; res: Response };

async function readJson(c: Context): Promise<Parsed> {
  let text: string;
  try {
    text = await readCapped(c.req.raw, MAX_RELAY_BODY_BYTES);
  } catch (err) {
    if (err instanceof TooLarge) return { ok: false, res: jsonError(c, 413, "request body over 256 KB") };
    throw err;
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, res: jsonError(c, 400, "body is not JSON") };
  }
}

// ------------------------------------------------------------------ relay (device tokens; Access bypassed)

app.post("/relay/pair/start", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return body.res;
  const parsed = PairStartSchema.safeParse(body.data);
  if (!parsed.success) return jsonError(c, 400, "invalid request", { issues: describeIssues(parsed.error) });
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const r = await project(c.env).pairStart({
    ipHash: await sha256Hex(`pair:${ip}`),
    machine: parsed.data.machine,
    client: parsed.data.client,
    share: parsed.data.share ?? null,
    origin: new URL(c.req.url).origin,
  });
  return send(c, r);
});

app.post("/relay/pair/poll", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return body.res;
  const parsed = PairPollSchema.safeParse(body.data);
  if (!parsed.success) return jsonError(c, 400, "invalid request", { issues: describeIssues(parsed.error) });
  const r = await project(c.env).pairPoll(parsed.data.deviceId, await sha256Hex(parsed.data.pollSecret));
  return send(c, r);
});

app.post("/relay/ingest", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const body = await readJson(c);
  if (!body.ok && body.res.status === 413) return body.res;
  if (!DEVICE_TOKEN_RE.test(token)) return jsonError(c, 401, "missing or malformed device token");
  if (!body.ok) return body.res;
  const parsed = IngestSchema.safeParse(body.data);
  if (!parsed.success) {
    const issues = describeIssues(parsed.error);
    console.warn("ingest rejected", JSON.stringify(issues));
    return jsonError(c, 400, "schema error", { issues });
  }
  const r = await project(c.env).ingest(await sha256Hex(token), parsed.data);
  return send(c, r);
});

app.all("/relay/*", (c) => jsonError(c, 404, "not found"));

// ------------------------------------------------------------------ board API (Cloudflare Access)

const requireAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  const env = c.env;
  if (env.DEV_USER_EMAIL) {
    if (env.ENVIRONMENT === "production") {
      console.error("DEV_USER_EMAIL is set in production; refusing every /api request");
      return jsonError(c, 500, "server misconfigured");
    }
    // Local dev only: the fake relay may act as another teammate.
    c.set("email", (c.req.header("x-dev-user-email") ?? env.DEV_USER_EMAIL).trim().toLowerCase());
    return next();
  }
  const token = c.req.header("cf-access-jwt-assertion");
  if (!token) return jsonError(c, 401, "not signed in");
  try {
    const { email } = await verifyAccessJwt(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
    c.set("email", email);
  } catch (err) {
    if (err instanceof AccessError) return jsonError(c, 401, "invalid access token");
    throw err;
  }
  return next();
};

/** Writes must come from the board itself (cheap CSRF guard on top of Access). */
const sameOriginWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) return jsonError(c, 403, "cross-origin request");
  }
  return next();
};

app.use("/api/*", requireAccess, sameOriginWrites);

app.get("/api/me", async (c) => c.json(await project(c.env).me(c.var.email)));

app.get("/api/state", async (c) => c.json(await project(c.env).boardState(c.var.email)));

app.get("/api/sessions/:hubKey/events", async (c) => {
  const hubKey = c.req.param("hubKey");
  const before = Number(c.req.query("before") ?? Date.now() + 60_000);
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 200) || 200));
  if (!Number.isFinite(before)) return jsonError(c, 400, "bad before");
  return c.json({ events: await project(c.env).sessionEvents(hubKey, before, limit) });
});

app.get("/api/stream", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return jsonError(c, 426, "expected a websocket");
  return project(c.env).fetch(
    new Request(new URL("/api/stream", c.req.url), { headers: { Upgrade: "websocket", "X-Bullpen-Viewer": c.var.email } }),
  );
});

app.get("/api/summaries", async (c) => c.json(await project(c.env).summaryUsage()));

app.get("/api/pair/:code", async (c) => {
  const code = PairCodeSchema.safeParse(c.req.param("code"));
  if (!code.success) return jsonError(c, 404, "unknown code");
  return send(c, await project(c.env).pairInfo(code.data));
});

app.post("/api/pair/approve", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return body.res;
  const parsed = PairApproveSchema.safeParse(body.data);
  if (!parsed.success) return jsonError(c, 400, "invalid code");
  return send(c, await project(c.env).pairApprove(parsed.data.code, c.var.email));
});

app.get("/api/devices", async (c) => c.json({ devices: await project(c.env).myDevices(c.var.email) }));

app.post("/api/devices/:id/revoke", async (c) =>
  send(c, await project(c.env).revokeDevice(c.req.param("id"), c.var.email)),
);

app.all("/api/*", (c) => jsonError(c, 404, "not found"));

// ------------------------------------------------------------------ board assets (SPA)

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
  console.error("unhandled", err instanceof Error ? err.message : String(err));
  return jsonError(c, 500, "internal error");
});

export default app;

// A stand-in hub for the smoke test where the hosted hub isn't available (CI in this public repo). It speaks just
// enough of the relay protocol (docs/SPEC.md §3) to pair, take ingests and report presence, plus the two board
// calls the smoke test reads (`/api/pair/approve`, `/api/state`, viewer from x-dev-user-email). No leases, no team
// view: those answer 404, as an older hub would. Usage: node fake-hub.mjs <port>
import crypto from "node:crypto";
import http from "node:http";

const port = Number(process.argv[2] ?? 8797);
const PROJECT = { id: "b3", name: "B3", include: { remotes: ["github.com/b3-fun/"], dirs: [] }, issueKeys: ["B3"], defaultShare: "conversation" };
const pairings = new Map(); // code -> { deviceId, pollSecret, machine, client, approvedBy, delivered }
const devices = new Map(); // id -> { id, email, machine, client, tokenHash, createdAt, lastSeenAt, revokedAt }
const sessions = new Map(); // hubKey -> session
let latestClient; // FAKE_HUB_TEAM: the newest relay version the hub "read from npm"
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const presence = (d) => (d.lastSeenAt == null ? "offline" : Date.now() - d.lastSeenAt <= 90_000 ? "online" : Date.now() - d.lastSeenAt <= 300_000 ? "reconnecting" : "offline");

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function read(req) {
  let s = "";
  for await (const c of req) s += c;
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}
function deviceOf(req) {
  const m = /^Bearer (bp_[0-9a-f]{64})$/.exec(req.headers.authorization ?? "");
  if (!m) return undefined;
  const h = hash(m[1]);
  return [...devices.values()].find((d) => d.tokenHash === h);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (req.method === "POST" && p === "/relay/pair/start") {
      const b = await read(req);
      const code = `${crypto.randomBytes(2).toString("hex").toUpperCase().replace(/[0-9]/g, "X").slice(0, 4).padEnd(4, "Q")}-${String(crypto.randomInt(10000)).padStart(4, "0")}`;
      const pair = { deviceId: `dev_${crypto.randomBytes(13).toString("hex").toUpperCase().slice(0, 26)}`, pollSecret: crypto.randomBytes(16).toString("hex"), machine: b.machine ?? "machine", client: b.client ?? "unknown", approvedBy: null, delivered: false };
      pairings.set(code, pair);
      return send(res, 200, { code, deviceId: pair.deviceId, pollSecret: pair.pollSecret, verifyUrl: `http://127.0.0.1:${port}/pair?code=${code}`, expiresInSec: 900 });
    }
    if (req.method === "POST" && p === "/relay/pair/poll") {
      const b = await read(req);
      const pair = [...pairings.values()].find((x) => x.deviceId === b.deviceId && x.pollSecret === b.pollSecret);
      if (!pair) return send(res, 401, { error: "unknown pairing" });
      if (!pair.approvedBy) return send(res, 200, { status: "pending" });
      const person = { email: pair.approvedBy, name: pair.approvedBy.split("@")[0] };
      if (pair.delivered) return send(res, 200, { status: "complete", person, project: PROJECT });
      const token = `bp_${crypto.randomBytes(32).toString("hex")}`;
      pair.delivered = true;
      devices.set(pair.deviceId, { id: pair.deviceId, email: pair.approvedBy, machine: pair.machine, client: pair.client, tokenHash: hash(token), createdAt: Date.now(), lastSeenAt: null, revokedAt: null });
      return send(res, 200, { status: "complete", deviceToken: token, person, project: PROJECT });
    }
    if (req.method === "POST" && p === "/api/pair/approve") {
      const b = await read(req);
      const pair = pairings.get(String(b.code ?? "").toUpperCase());
      if (!pair) return send(res, 404, { error: "unknown code" });
      pair.approvedBy = String(req.headers["x-dev-user-email"] ?? "dev@example.com");
      return send(res, 200, { ok: true, machine: pair.machine });
    }
    if (req.method === "POST" && p === "/relay/ingest") {
      const d = deviceOf(req);
      const b = await read(req);
      if (!d || d.revokedAt) return send(res, 401, { error: "unknown or revoked device token; pair again" });
      if (b.v !== 1 || !Array.isArray(b.sessions) || !Array.isArray(b.events)) return send(res, 400, { error: "schema error" });
      d.lastSeenAt = Date.now();
      if (b.client) d.client = b.client;
      for (const s of b.sessions) sessions.set(`${d.id}:${s.key}`, { ...s, hubKey: `${d.id}:${s.key}`, deviceId: d.id, email: d.email });
      return send(res, 200, { ok: true, accepted: b.events.length });
    }
    if (req.method === "GET" && p === "/api/state") {
      return send(res, 200, {
        devices: [...devices.values()].map(({ tokenHash: _t, ...d }) => ({ ...d, presence: presence(d) })),
        sessions: [...sessions.values()],
      });
    }
    // FAKE_HUB_TEAM=1 (the update smoke test): a minimal team view carrying `latestClient` (SPEC §40), which
    // `POST /api/latest {version}` sets the way the real hub's npm read would. Off by default: an older hub's 404.
    if (process.env.FAKE_HUB_TEAM === "1" && req.method === "POST" && p === "/api/latest") {
      const b = await read(req);
      latestClient = typeof b.version === "string" ? b.version : undefined;
      return send(res, 200, { ok: true, latestClient: latestClient ?? null });
    }
    if (process.env.FAKE_HUB_TEAM === "1" && req.method === "GET" && p === "/relay/team") {
      const d = deviceOf(req);
      if (!d || d.revokedAt) return send(res, 401, { error: "unknown or revoked device token; pair again" });
      const me = { name: d.email.split("@")[0], email: d.email };
      return send(res, 200, {
        me,
        people: [{ ...me, online: true, counts: { working: 0, waiting: 0, idle: 0 } }],
        needsMe: [],
        sessions: [],
        serverNow: Date.now(),
        ...(latestClient ? { latestClient } : {}),
      });
    }
    if (p.startsWith("/relay/") && !deviceOf(req)) return send(res, 401, { error: "unknown or revoked device token; pair again" });
    return send(res, 404, { error: "not found" });
  })
  .listen(port, "127.0.0.1", () => console.log(`fake hub on http://127.0.0.1:${port}`));

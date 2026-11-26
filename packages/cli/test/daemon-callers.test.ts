import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@workmesh/core";
import type { SafeConfig } from "../src/lib/config";
import { createDaemonServer, isLoopbackHost } from "../src/daemon/server";
import { getHealth, getState, pauseDaemon, postEvent, resumeDaemon } from "../src/lib/daemon-client";

const SECRET = "a".repeat(64);
const AUTH = { authorization: `Bearer ${SECRET}` };

const WRONG_HOST = { ok: false, error: "host not allowed: use 127.0.0.1 or localhost with the daemon's port" };
const HAS_ORIGIN = { ok: false, error: "requests with an Origin header are not allowed" };

const CONFIG: SafeConfig = {
  mode: "relay",
  relayUrl: "https://agentblip.com",
  port: 4519,
  granularity: "count",
  statusPolicy: "respect",
  showProject: false,
  repoPrefix: true,
  statusTtlSec: 300,
  debounceMs: 10000,
};

const event: SessionEvent = { source: "claude-code", sessionId: "s1", kind: "working" };

interface Harness {
  server: http.Server;
  port: number;
  applied: SessionEvent[];
  /** How many times a request reached the daemon's own work: 0 after a refused request. */
  reached(): number;
}

async function startServer(): Promise<Harness> {
  const applied: SessionEvent[] = [];
  let reached = 0;
  const server = createDaemonServer({
    secret: SECRET,
    applyEvent: (e) => {
      reached++;
      applied.push(e);
    },
    getState: () => {
      reached++;
      return {
        snapshot: { sessions: [], working: 0, waiting: 0, idle: 0, total: 0, agentCount: 0, signature: "" },
        formatted: null,
        paused: false,
      };
    },
    getLastError: () => {
      reached++;
      return undefined;
    },
    getOwnership: () => {
      reached++;
      return { backedOff: false, savedPrior: false, policy: "respect" };
    },
    pause: async () => {
      reached++;
    },
    resume: () => {
      reached++;
    },
    dismiss: () => {
      reached++;
      return false;
    },
    getConfig: () => {
      reached++;
      return CONFIG;
    },
    setConfig: () => {
      reached++;
      return CONFIG;
    },
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: (server.address() as AddressInfo).port, applied, reached: () => reached };
}

interface Sent {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

/** One request that carries exactly the headers given. Node's fetch writes the Host header itself. */
function send(port: number, sent: Sent = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: sent.method ?? "GET",
        path: sent.path ?? "/health",
        headers: sent.headers,
        setHost: false,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          try {
            body = JSON.parse(text) as unknown;
          } catch {
            // Node's own 400 is not JSON
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on("error", reject);
    req.end(sent.body);
  });
}

/** The status line the server answers a hand-written request with. */
function statusLine(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
    let answer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      answer += chunk;
    });
    socket.on("end", () => resolve(answer.split("\r\n")[0] ?? ""));
    socket.on("error", reject);
  });
}

/** A few requests that cover the open endpoint, a read, a write with a body, a write without one and no endpoint. */
const REQUESTS: Sent[] = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/state" },
  { method: "POST", path: "/event", body: JSON.stringify(event) },
  { method: "POST", path: "/pause" },
  { method: "GET", path: "/nowhere" },
];

describe("isLoopbackHost", () => {
  it.each([
    ["127.0.0.1:4519", 4519],
    ["localhost:4519", 4519],
    ["[::1]:4519", 4519],
    ["LOCALHOST:4519", 4519],
    ["127.0.0.1:80", 80],
    // A client leaves plain HTTP's default port, 80, out of the header.
    ["127.0.0.1", 80],
    ["localhost", 80],
    ["[::1]", 80],
  ])("accepts %s for a daemon on port %i", (host, port) => {
    expect(isLoopbackHost(host, port)).toBe(true);
  });

  it.each([
    // another name with the right port
    ["example.com:4519", 4519],
    ["example.com", 80],
    ["192.168.1.20:4519", 4519],
    ["0.0.0.0:4519", 4519],
    ["127.0.0.2:4519", 4519],
    // the right name with another port, or with none (none means 80)
    ["127.0.0.1:4520", 4519],
    ["127.0.0.1:80", 4519],
    ["127.0.0.1", 4519],
    ["localhost", 4519],
    ["[::1]", 4519],
    // a name that only starts or ends like an allowed one
    ["localhost.example.com:4519", 4519],
    ["127.0.0.1.example.com:4519", 4519],
    ["127.0.0.1:4519.example.com", 4519],
    ["notlocalhost:4519", 4519],
    ["localhost.:4519", 4519],
    // other spellings of the same address or port
    ["::1:4519", 4519],
    ["[::1]4519", 4519],
    ["[0:0:0:0:0:0:0:1]:4519", 4519],
    ["127.0.0.1:04519", 4519],
    ["127.1:4519", 4519],
    ["", 4519],
    [undefined, 4519],
    // no port to compare with (the connection is already gone)
    ["127.0.0.1:4519", undefined],
  ])("refuses %s for a daemon on port %s", (host, port) => {
    expect(isLoopbackHost(host, port)).toBe(false);
  });
});

describe("daemon server: who is calling", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startServer();
  });

  afterEach(() => {
    h.server.close();
  });

  const ownHost = (): string => `127.0.0.1:${h.port}`;

  it("answers a request that names this machine and the daemon's port", async () => {
    for (const name of ["127.0.0.1", "localhost", "[::1]", "LOCALHOST"]) {
      const res = await send(h.port, { headers: { host: `${name}:${h.port}` } });
      expect(res.status, name).toBe(200);
    }
    const state = await send(h.port, { path: "/state", headers: { host: `localhost:${h.port}`, ...AUTH } });
    expect(state.status).toBe(200);
  });

  it("refuses any other Host header with 421: every endpoint, with the secret too, and nothing runs", async () => {
    const hosts = [
      `example.com:${h.port}`,
      `127.0.0.1:${h.port + 1}`,
      "127.0.0.1",
      "localhost",
      `localhost.example.com:${h.port}`,
      "",
    ];
    for (const host of hosts) {
      for (const sent of REQUESTS) {
        const res = await send(h.port, { ...sent, headers: { host, ...AUTH, "content-type": "application/json" } });
        expect(res.status, `${sent.method} ${sent.path} as "${host}"`).toBe(421);
        expect(res.body).toEqual(WRONG_HOST);
      }
    }
    expect(h.reached()).toBe(0);
  });

  it("refuses a request that has no Host header", async () => {
    // HTTP/1.1 requires the header, so Node answers 400 before the daemon sees the request.
    expect([400, 421]).toContain((await send(h.port)).status);
    // HTTP/1.0 does not require it, so this one reaches the daemon's own check.
    expect(await statusLine(h.port, "GET /health HTTP/1.0\r\n\r\n")).toBe("HTTP/1.1 421 Misdirected Request");
    expect(h.reached()).toBe(0);
  });

  it("refuses a request that carries an Origin header with 403: every endpoint, with the secret too, and nothing runs", async () => {
    const origins = ["https://example.com", `http://127.0.0.1:${h.port}`, `http://localhost:${h.port}`, "null", ""];
    for (const origin of origins) {
      for (const sent of REQUESTS) {
        const res = await send(h.port, {
          ...sent,
          headers: { host: ownHost(), origin, ...AUTH, "content-type": "application/json" },
        });
        expect(res.status, `${sent.method} ${sent.path} from "${origin}"`).toBe(403);
        expect(res.body).toEqual(HAS_ORIGIN);
      }
    }
    expect(h.reached()).toBe(0);
  });

  it("checks the Host header before the Origin header", async () => {
    const res = await send(h.port, { headers: { host: `example.com:${h.port}`, origin: "https://example.com" } });
    expect(res.status).toBe(421);
  });

  it("never sends a CORS header, so a browser's permission request fails", async () => {
    const preflight: Sent = {
      method: "OPTIONS",
      path: "/event",
      headers: {
        host: ownHost(),
        origin: "https://example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    };
    const answers = [
      await send(h.port, { headers: { host: ownHost() } }),
      await send(h.port, { path: "/state", headers: { host: ownHost() } }),
      await send(h.port, { path: "/state", headers: { host: ownHost(), ...AUTH } }),
      await send(h.port, preflight),
      await send(h.port, { headers: { host: `example.com:${h.port}` } }),
    ];
    expect(answers.map((a) => a.status)).toEqual([200, 401, 200, 403, 421]);
    for (const answer of answers) {
      const cors = Object.keys(answer.headers).filter((name) => name.startsWith("access-control-"));
      expect(cors, `status ${answer.status}`).toEqual([]);
    }
  });
});

describe("daemon server: the CLI's own client", () => {
  let h: Harness;
  let stateDirTmp: string;
  let savedStateHome: string | undefined;

  beforeEach(async () => {
    stateDirTmp = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-state-"));
    savedStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDirTmp;
    // The client reads the secret from the state dir on every request.
    fs.mkdirSync(path.join(stateDirTmp, "workmesh"), { recursive: true });
    fs.writeFileSync(path.join(stateDirTmp, "workmesh", "daemon.secret"), `${SECRET}\n`, { mode: 0o600 });
    h = await startServer();
  });

  afterEach(() => {
    h.server.close();
    if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedStateHome;
    fs.rmSync(stateDirTmp, { recursive: true, force: true });
  });

  it("is answered: it calls 127.0.0.1 with the daemon's port and sends no Origin header", async () => {
    const seen: Array<{ host?: string; origin?: string }> = [];
    h.server.on("request", (req: http.IncomingMessage) => {
      seen.push({ host: req.headers.host, origin: req.headers.origin });
    });

    // The calls the commands, the hooks and the MCP server make: reads, a hook's event, writes with no body.
    await expect(getHealth(h.port)).resolves.toMatchObject({ ok: true });
    await expect(getState(h.port)).resolves.toMatchObject({ paused: false });
    await expect(postEvent(h.port, event, "PreToolUse")).resolves.toEqual({ ok: true });
    await expect(pauseDaemon(h.port)).resolves.toEqual({ ok: true, paused: true });
    await expect(resumeDaemon(h.port)).resolves.toEqual({ ok: true, paused: false });

    expect(seen).toEqual(Array.from({ length: 5 }, () => ({ host: `127.0.0.1:${h.port}`, origin: undefined })));
    expect(h.applied).toEqual([event]);
  });
});

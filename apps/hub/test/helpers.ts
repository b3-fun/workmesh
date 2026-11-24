import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker/index";

export const HOST = "https://workmesh.b3os.org";

/** Local-dev env: Access skipped, the dev user (or X-Dev-User-Email) is the viewer. */
export const devEnv = { ...env, ENVIRONMENT: "development", DEV_USER_EMAIL: "sean@npclabs.org" } as Env;

/** Production-shaped env: Access JWT required. */
export const prodEnv = { ...env, ENVIRONMENT: "production", DEV_USER_EMAIL: undefined } as Env;

export async function call(path: string, init: RequestInit = {}, e: Env = devEnv): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${HOST}${path}`, init), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export function post(path: string, body: unknown, headers: Record<string, string> = {}, e: Env = devEnv) {
  return call(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    e,
  );
}

let ipCounter = 0;
/** A fresh client IP per call so tests never trip the pair-start limit by accident. */
export const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

export interface PairStart {
  code: string;
  deviceId: string;
  pollSecret: string;
  verifyUrl: string;
  expiresInSec: number;
}

export async function startPairing(machine = "test-mac"): Promise<PairStart> {
  const res = await post("/relay/pair/start", { machine, client: "agentblip/0.6.0" }, { "cf-connecting-ip": freshIp() });
  if (res.status !== 200) throw new Error(`pair start ${res.status}`);
  return res.json();
}

export const poll = (p: Pick<PairStart, "deviceId" | "pollSecret">) =>
  post("/relay/pair/poll", { deviceId: p.deviceId, pollSecret: p.pollSecret });

export const approve = (code: string, email = "sean@npclabs.org") =>
  post("/api/pair/approve", { code }, { "x-dev-user-email": email });

/** Pairs a device for `email` and returns its token and id. */
export async function pairDevice(email = "sean@npclabs.org", machine = "test-mac") {
  const p = await startPairing(machine);
  const a = await approve(p.code, email);
  if (a.status !== 200) throw new Error(`approve ${a.status}`);
  const res = (await (await poll(p)).json()) as { status: string; deviceToken: string };
  return { token: res.deviceToken, deviceId: p.deviceId };
}

export function ingest(token: string | null, body: unknown) {
  return post("/relay/ingest", body, token ? { authorization: `Bearer ${token}` } : {});
}

export function session(over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    key: "claude-code:s1",
    source: "claude-code",
    name: "documents-07",
    state: "working",
    activity: "editing vm.rs",
    repo: "b3-fun/b3os-beta",
    branch: "main",
    issues: ["B3-7166"],
    startedAt: now - 60_000,
    updatedAt: now,
    stateSince: now - 10_000,
    ...over,
  };
}

let evCounter = 0;
export function event(over: Record<string, unknown> = {}) {
  return {
    id: `ev${++evCounter}`,
    key: "claude-code:s1",
    ts: Date.now(),
    kind: "tool",
    tool: "Edit",
    path: "crates/b3os-sandboxes/src/vm.rs",
    repo: "b3-fun/b3os-beta",
    ...over,
  };
}

export function batch(over: Record<string, unknown> = {}) {
  return { v: 1, sentAt: Date.now(), full: false, sessions: [session()], events: [event()], ...over };
}

export function projectStub() {
  return env.PROJECT.get(env.PROJECT.idFromName("b3"));
}

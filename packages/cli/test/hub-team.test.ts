import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { hubTeamAcceptSchema } from "@workmesh/protocol";
import type { HubTeamResponse } from "@workmesh/protocol";
import { createDaemonServer } from "../src/daemon/server";
import type { TeamState } from "../src/daemon/server";
import { TeamPoller } from "../src/hub/team";
import { readGithubLogin } from "../src/lib/github";

/** v0.5: the menu bar's team view (docs/SPEC.md §16) and v0.6 avatars (§15). */

const TOKEN = `bp_${"b".repeat(64)}`;
const NOW = 1_795_545_600_000;

const TEAM: HubTeamResponse = {
  me: { name: "Sean", email: "sean@npclabs.org", github: "seangeng" },
  people: [
    { name: "Sean", github: "seangeng", online: true, counts: { working: 1, waiting: 1, idle: 0 } },
    { name: "An", online: true, counts: { working: 2, waiting: 0, idle: 0 } },
  ],
  needsMe: [{ session: "dev_X:claude-code:s1", reason: "Approve the deploy", since: NOW - 60_000, name: "documents-07" }],
  sessions: [{ key: "dev_Y:codex:t1", owner: "An", name: "codex-3", source: "codex", state: "working", now: "Fixing ingest", subagents: 1 }],
  serverNow: NOW,
};

function fakeHub(replies: Array<{ status: number; body?: unknown } | Error>) {
  const calls: Array<{ url: string; auth?: string }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.authorization });
    const r = replies.shift() ?? { status: 200, body: TEAM };
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("TeamPoller", () => {
  let poller: TeamPoller | undefined;
  afterEach(() => poller?.stop());

  it("reads /relay/team with the device token and keeps the last good answer", async () => {
    const hub = fakeHub([{ status: 200, body: TEAM }, new Error("ECONNRESET")]);
    const seen: boolean[] = [];
    let now = NOW;
    poller = new TeamPoller({ url: "https://hub.test/", token: TOKEN, fetchImpl: hub.fetchImpl, now: () => now, onAvailability: (a) => seen.push(a) });
    expect(poller.view()).toMatchObject({ available: null, halted: false });
    await poller.poll();
    expect(hub.calls[0]).toEqual({ url: "https://hub.test/relay/team", auth: `Bearer ${TOKEN}` });
    expect(poller.view()).toMatchObject({ available: true, fetchedAt: NOW, team: { me: { name: "Sean" }, needsMe: [{ reason: "Approve the deploy" }] } });
    expect(seen).toEqual([true]);
    now += 1000;
    await poller.poll();
    expect(poller.view()).toMatchObject({ available: true, fetchedAt: NOW, error: expect.stringContaining("hub unreachable") });
    expect(poller.view().team?.people).toHaveLength(2); // still the last good answer
  });

  it("polls fast while the menu is open or something needs the person, slow otherwise", async () => {
    let now = NOW;
    const quiet = { ...TEAM, needsMe: [] };
    const hub = fakeHub([{ status: 200, body: quiet }]);
    poller = new TeamPoller({ url: "https://hub.test", token: TOKEN, fetchImpl: hub.fetchImpl, now: () => now });
    await poller.poll();
    expect(poller.pollMs()).toBe(60_000);
    poller.markOpen();
    expect(poller.pollMs()).toBe(15_000);
    now += 46_000;
    expect(poller.pollMs()).toBe(60_000);
    await poller.poll(); // default reply: TEAM, with a needsMe item
    expect(poller.pollMs()).toBe(15_000);
  });

  it("an older hub (404) has no team view: asked again in 10 min, structure off", async () => {
    const seen: boolean[] = [];
    const hub = fakeHub([{ status: 200, body: TEAM }, { status: 404, body: "not found" }]);
    poller = new TeamPoller({ url: "https://hub.test", token: TOKEN, fetchImpl: hub.fetchImpl, onAvailability: (a) => seen.push(a) });
    await poller.poll();
    await poller.poll();
    expect(poller.view()).toMatchObject({ available: false, team: undefined, pollMs: 600_000 });
    expect(seen).toEqual([true, false]);
  });

  it("stops on 401, reports a hub error, and drops what it can't read", async () => {
    const hub = fakeHub([{ status: 500 }, { status: 200, body: "<html>" }, { status: 200, body: { people: "x" } }, { status: 401 }, { status: 200, body: TEAM }]);
    poller = new TeamPoller({ url: "https://hub.test", token: TOKEN, fetchImpl: hub.fetchImpl });
    await poller.poll();
    expect(poller.view().error).toBe("hub responded 500 to /relay/team");
    await poller.poll();
    expect(poller.view().error).toMatch(/isn't JSON/);
    await poller.poll(); // tolerant reading: a malformed list reads as empty
    expect(poller.view()).toMatchObject({ available: true, team: { people: [], needsMe: [], sessions: [] } });
    await poller.poll();
    expect(poller.view()).toMatchObject({ halted: true, error: "device token rejected (401)" });
    await poller.poll();
    expect(hub.calls).toHaveLength(4); // halted: no more requests
  });
});

describe("daemon GET /team", () => {
  it("serves the team view behind the secret and passes ?open=1 on", async () => {
    const opens: boolean[] = [];
    const state: TeamState = {
      enabled: true,
      hubUrl: "https://workmesh.b3os.org",
      boardUrl: "https://workmesh.b3os.org",
      hubName: "B3",
      deviceId: "dev_X",
      share: "conversation",
      connected: true,
      halted: false,
      available: true,
      pollMs: 15_000,
      team: hubTeamAcceptSchema.parse(TEAM),
    };
    const server = createDaemonServer({
      secret: "s".repeat(64),
      applyEvent: () => {},
      getState: () => ({ snapshot: { sessions: [], working: 0, waiting: 0, idle: 0, total: 0, agentCount: 0, signature: "" }, formatted: null, paused: false }),
      getLastError: () => undefined,
      getOwnership: () => ({ backedOff: false, savedPrior: false, policy: "respect" }),
      pause: async () => {},
      resume: () => {},
      dismiss: () => false,
      getConfig: () => ({}) as never,
      setConfig: () => ({}) as never,
      getTeam: (open) => {
        opens.push(open);
        return state;
      },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const get = (path: string, auth = true) =>
        fetch(`http://127.0.0.1:${port}${path}`, { headers: auth ? { authorization: `Bearer ${"s".repeat(64)}` } : {} });
      expect((await get("/team", false)).status).toBe(401);
      const res = await get("/team");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ enabled: true, share: "conversation", team: { needsMe: [{ reason: "Approve the deploy" }] } });
      await get("/team?open=1");
      expect(opens).toEqual([false, true]);
    } finally {
      server.close();
    }
  });

  it("answers enabled:false when the daemon has no team view", async () => {
    const server = createDaemonServer({
      secret: "s".repeat(64),
      applyEvent: () => {},
      getState: () => ({ snapshot: { sessions: [], working: 0, waiting: 0, idle: 0, total: 0, agentCount: 0, signature: "" }, formatted: null, paused: false }),
      getLastError: () => undefined,
      getOwnership: () => ({ backedOff: false, savedPrior: false, policy: "respect" }),
      pause: async () => {},
      resume: () => {},
      dismiss: () => false,
      getConfig: () => ({}) as never,
      setConfig: () => ({}) as never,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/team`, { headers: { authorization: `Bearer ${"s".repeat(64)}` } });
      expect(await res.json()).toEqual({ enabled: false });
    } finally {
      server.close();
    }
  });
});

describe("readGithubLogin (gh api user)", () => {
  it("asks gh for the login only, and checks its shape", async () => {
    const calls: Array<[string, string[]]> = [];
    const login = await readGithubLogin({
      candidates: ["gh"],
      exec: async (file, args) => {
        calls.push([file, args]);
        return "seangeng\n";
      },
    });
    expect(login).toBe("seangeng");
    expect(calls).toEqual([["gh", ["api", "user", "--jq", ".login"]]]);
    expect(await readGithubLogin({ candidates: ["gh"], exec: async () => "<html>rate limited</html>" })).toBeUndefined();
  });

  it("tries the next place when gh isn't on PATH; stops when gh fails", async () => {
    const enoent = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    const tried: string[] = [];
    expect(
      await readGithubLogin({
        candidates: ["gh", "gh2"],
        exec: async (file) => {
          tried.push(file);
          if (file === "gh") throw enoent;
          return "an-b3";
        },
      }),
    ).toBe("an-b3");
    expect(tried).toEqual(["gh", "gh2"]);
    const failed: string[] = [];
    expect(
      await readGithubLogin({
        candidates: ["gh", "gh2"],
        exec: async (file) => {
          failed.push(file);
          throw Object.assign(new Error("not logged in"), { code: 4 });
        },
      }),
    ).toBeUndefined();
    expect(failed).toEqual(["gh"]);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HUB_DEVICE_TOKEN_RE,
  hubPairPollResponseSchema,
  hubPairStartResponseSchema,
  hubShareLevelSchema,
} from "@agentblip/core";
import type { HubPairStartResponse, HubProjectRule, HubShareLevel } from "@agentblip/core";
import pkg from "../../package.json";
import { hubShareLevel, loadConfig, saveConfig } from "../lib/config";
import type { Config, HubConfig } from "../lib/config";
import { getHubState, isDaemonUp, reloadHub } from "../lib/daemon-client";
import { configPath } from "../lib/paths";
import { bold, cyan, dim, formatDuration, green, red, select, sleep, spinner, yellow } from "../lib/ui";
import { openBrowser } from "./setup";
import type { HubState } from "../daemon/server";

/** The team hub's address; `hub connect` takes any URL. */
export const EXAMPLE_HUB_URL = "https://bullpen.b3os.org";

const POLL_INTERVAL_MS = 2000;
const HTTP_TIMEOUT_MS = 10_000;

/** What each sharing level sends, in the words the CLI prints (SPEC §8: "state plainly"). */
export const SHARE_LEVEL_SUMMARY: Record<HubShareLevel, string> = {
  metadata:
    "metadata only: tool names, repo-relative paths, program + subcommand, issue ids, PR links. No prompt or agent text.",
  conversation:
    "metadata plus your prompts, the agent's text replies, a one-line description of each tool call and how long each " +
    "turn took, from sessions running inside a shared repo. Secrets are redacted on this machine first; tool " +
    "inputs, tool output and file contents never leave.",
};

/** Parses a `--share` / `hub share` argument. */
export function parseShareLevel(input: string): HubShareLevel {
  const parsed = hubShareLevelSchema.safeParse(input.trim().toLowerCase());
  if (!parsed.success) throw new Error(`unknown sharing level "${input}" — use conversation or metadata`);
  return parsed.data;
}

/**
 * The level `hub connect` suggests when no `--share` was given: the one this
 * machine already chose for this hub, else the project's `defaultShare`, else
 * `metadata`.
 */
export function suggestedShare(project: HubProjectRule, previous?: HubShareLevel): HubShareLevel {
  return previous ?? project.defaultShare ?? "metadata";
}

/** https, or http only for a hub on this machine (local dev). */
export function resolveHubUrl(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`invalid hub URL: ${trimmed || "(empty)"} — e.g. ${EXAMPLE_HUB_URL}`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error(`hub URL must be https (got ${url.protocol}//${url.host})`);
  }
  if (url.username || url.password) throw new Error("hub URL must not contain credentials");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** This machine's name as the board shows it: "seans-mac-studio". */
export function machineName(hostname = os.hostname()): string {
  const name = hostname
    .replace(/\.local$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return name || "machine";
}

export interface PairResult {
  deviceId: string;
  deviceToken: string;
  person?: { email: string; name: string };
  project: HubProjectRule;
}

export interface PairOptions {
  machine: string;
  client?: string;
  fetchImpl?: typeof fetch;
  /** Called once the hub hands out a code: show it, open the browser. */
  onCode?: (pair: HubPairStartResponse) => void;
  pollIntervalMs?: number;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}

/** Device-code pairing (SPEC §3.1): start, show the code, poll until approved. */
export async function pairWithHub(hubUrl: string, opts: PairOptions): Promise<PairResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const wait = opts.wait ?? sleep;
  const now = opts.now ?? Date.now;
  const startRes = await postJson(fetchImpl, `${hubUrl}/relay/pair/start`, {
    machine: opts.machine,
    client: opts.client ?? `agentblip/${pkg.version}`,
  });
  if (startRes.status === 429) {
    const after = startRes.headers.get("retry-after");
    throw new Error(`the hub is rate limiting pairing${after ? ` — try again in ${after}s` : ""}`);
  }
  if (!startRes.ok) throw new Error(`hub ${hubUrl} responded ${startRes.status} to pair/start — is it reachable?`);
  const pair = hubPairStartResponseSchema.parse(await startRes.json());
  opts.onCode?.(pair);

  const deadline = now() + pair.expiresInSec * 1000;
  while (now() < deadline) {
    await wait(opts.pollIntervalMs ?? POLL_INTERVAL_MS);
    let res: Response;
    try {
      res = await postJson(fetchImpl, `${hubUrl}/relay/pair/poll`, {
        deviceId: pair.deviceId,
        pollSecret: pair.pollSecret,
      });
    } catch {
      continue; // transient network error: keep polling
    }
    if (res.status === 401) throw new Error("the hub no longer knows this pairing — run `agentblip hub connect` again");
    if (!res.ok) continue;
    const poll = hubPairPollResponseSchema.parse(await res.json());
    if (poll.status === "expired") break;
    if (poll.status !== "complete") continue;
    if (!poll.deviceToken || !HUB_DEVICE_TOKEN_RE.test(poll.deviceToken)) {
      throw new Error("the hub approved the pairing but sent no valid device token — pair again");
    }
    if (!poll.project) throw new Error("the hub sent no project sharing rule — pair again");
    return { deviceId: pair.deviceId, deviceToken: poll.deviceToken, person: poll.person, project: poll.project };
  }
  throw new Error("pairing code expired — run `agentblip hub connect` again");
}

/** Absolute, normalized form of a dir argument (`~` expanded). */
export function resolveDir(input: string, home = os.homedir()): string {
  const expanded = input === "~" || input.startsWith("~/") ? path.join(home, input.slice(1)) : input;
  return path.resolve(expanded);
}

/** Adds `dir` to one list and removes it from the other. */
export function withDir(hub: HubConfig, dir: string, kind: "include" | "exclude"): HubConfig {
  const add = kind === "include" ? "includeDirs" : "excludeDirs";
  const remove = kind === "include" ? "excludeDirs" : "includeDirs";
  return {
    ...hub,
    [add]: hub[add].includes(dir) ? hub[add] : [...hub[add], dir],
    [remove]: hub[remove].filter((d) => d !== dir),
  };
}

/** Tells a running daemon to pick up the new hub section; false when no daemon answered. */
async function reloadDaemon(config: Config): Promise<HubState | undefined> {
  if (!(await isDaemonUp(config.port))) return undefined;
  try {
    return await reloadHub(config.port);
  } catch (err) {
    // A daemon older than 0.6 has no /hub/reload: it needs a restart.
    console.log(yellow(`  the running daemon did not reload (${err instanceof Error ? err.message : String(err)})`));
    console.log(yellow(`  restart it: ${bold("agentblip stop && agentblip start --detach")}`));
    return undefined;
  }
}

function requireHub(config: Config): HubConfig {
  if (!config.hub) throw new Error(`not connected to a hub — run \`agentblip hub connect ${EXAMPLE_HUB_URL}\``);
  return config.hub;
}

export interface HubConnectOptions {
  open?: boolean;
  machine?: string;
  /** `--share conversation|metadata`; absent: ask in a TTY, else keep or use metadata. */
  share?: string;
  /** Injected for tests: answer the sharing question. */
  askShare?: (suggested: HubShareLevel) => Promise<HubShareLevel>;
}

function askShareLevel(suggested: HubShareLevel): Promise<HubShareLevel> {
  const choices: Array<{ value: HubShareLevel; label: string }> = [
    { value: "conversation", label: `conversation — ${SHARE_LEVEL_SUMMARY.conversation}` },
    { value: "metadata", label: `metadata — ${SHARE_LEVEL_SUMMARY.metadata}` },
  ];
  return select("What should this machine share with the hub?", choices, suggested === "conversation" ? 0 : 1);
}

export async function runHubConnect(url: string, opts: HubConnectOptions = {}): Promise<void> {
  const hubUrl = resolveHubUrl(url);
  const flagShare = opts.share !== undefined ? parseShareLevel(opts.share) : undefined;
  const config = loadConfig();
  const machine = opts.machine ? machineName(opts.machine) : machineName();
  console.log(bold("agentblip hub connect"));
  console.log(dim(`pairing ${machine} with ${hubUrl}\n`));

  let spin: ReturnType<typeof spinner> | undefined;
  let result: PairResult;
  try {
    result = await pairWithHub(hubUrl, {
      machine,
      onCode: (pair) => {
        console.log(`  pairing code: ${bold(pair.code)}`);
        console.log(`  approve it in your browser: ${cyan(pair.verifyUrl)}`);
        console.log("");
        if (opts.open !== false) openBrowser(pair.verifyUrl);
        spin = spinner("waiting for you to approve…");
      },
    });
  } finally {
    spin?.stop();
  }

  const previous = config.hub?.url === hubUrl ? config.hub : undefined;
  let share: HubShareLevel;
  if (flagShare) {
    share = flagShare;
  } else {
    const suggested = suggestedShare(result.project, previous?.share);
    const interactive = opts.askShare !== undefined || (process.stdin.isTTY === true && process.stdout.isTTY === true);
    // Without a terminal nobody can answer: keep this machine's earlier choice,
    // else metadata. Conversation text needs an explicit yes.
    share = interactive ? await (opts.askShare ?? askShareLevel)(suggested) : (previous?.share ?? "metadata");
  }
  config.hub = {
    url: hubUrl,
    deviceId: result.deviceId,
    deviceToken: result.deviceToken,
    machine,
    person: result.person,
    project: result.project,
    includeDirs: previous?.includeDirs ?? [],
    excludeDirs: previous?.excludeDirs ?? [],
    pairedAt: Date.now(),
    share,
  };
  saveConfig(config);
  const who = result.person ? ` as ${result.person.name} (${result.person.email})` : "";
  console.log(green(`connected ${machine} to ${result.project.name}${who}`));
  console.log(dim(`  token and sharing rule saved to ${configPath()} (0600)`));
  const remotes = result.project.include.remotes;
  console.log(
    `  shares sessions in repos whose origin contains ${remotes.length ? remotes.map((r) => bold(r)).join(", ") : dim("(none)")}` +
      (result.project.include.dirs.length ? ` and under ${result.project.include.dirs.join(", ")}` : ""),
  );
  console.log(`  sharing level: ${bold(share)} — ${SHARE_LEVEL_SUMMARY[share]}`);
  console.log(dim(`  change it any time: agentblip hub share ${share === "conversation" ? "metadata" : "conversation"}`));
  const state = await reloadDaemon(config);
  if (state?.enabled) console.log(green("  the daemon is forwarding now"));
  else if (state === undefined) console.log(`  start the daemon: ${bold("agentblip start --detach")}`);
}

export interface HubStatusOptions {
  json?: boolean;
}

export async function runHubStatus(opts: HubStatusOptions = {}): Promise<void> {
  const config = loadConfig();
  const hub = config.hub;
  let daemon: HubState | undefined;
  let daemonError: string | undefined;
  if (await isDaemonUp(config.port)) {
    try {
      daemon = await getHubState(config.port);
    } catch (err) {
      daemonError = err instanceof Error ? err.message : String(err);
    }
  }
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          paired: hub !== undefined,
          url: hub?.url,
          machine: hub?.machine,
          person: hub?.person,
          project: hub ? { id: hub.project.id, name: hub.project.name } : undefined,
          share: hub ? hubShareLevel(hub) : undefined,
          include: hub ? { remotes: hub.project.include.remotes, dirs: [...hub.project.include.dirs, ...hub.includeDirs] } : undefined,
          exclude: hub?.excludeDirs,
          daemon: daemon ?? (daemonError ? { error: daemonError } : null),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!hub) {
    console.log(`not connected to a hub — ${bold(`agentblip hub connect ${EXAMPLE_HUB_URL}`)}`);
    return;
  }
  const rows: Array<[string, string]> = [
    ["hub", hub.url],
    ["project", `${hub.project.name} (${hub.project.id})`],
    ["paired as", hub.person ? `${hub.person.name} <${hub.person.email}> on ${hub.machine ?? "this machine"}` : (hub.machine ?? "this machine")],
    ["shares", [...hub.project.include.remotes, ...hub.project.include.dirs, ...hub.includeDirs].join(", ") || "(nothing)"],
    ["level", `${hubShareLevel(hub)} — ${SHARE_LEVEL_SUMMARY[hubShareLevel(hub)]}`],
  ];
  if (hub.excludeDirs.length) rows.push(["never shares", hub.excludeDirs.join(", ")]);
  if (!daemon) {
    rows.push(["daemon", daemonError ? red(daemonError) : yellow("not running — `agentblip start --detach`")]);
  } else if (!daemon.enabled) {
    rows.push(["daemon", yellow("running without hub forward — `agentblip stop && agentblip start --detach`")]);
  } else {
    const ago = (t?: number): string => (t ? `${formatDuration(Date.now() - t)} ago` : "never");
    rows.push(
      [
        "forwarding",
        daemon.halted
          ? red(`stopped: ${daemon.lastError ?? "token rejected"} — run \`agentblip hub connect ${hub.url}\``)
          : daemon.lastSendOk === false
            ? yellow(`retrying: ${daemon.lastError ?? "send failed"}`)
            : green("on"),
      ],
      ["last send", `${ago(daemon.lastSendAt)}${daemon.lastSendOk === false ? red(" (failed)") : ""}`],
      ["last success", ago(daemon.lastSuccessAt)],
      ["shared sessions", String(daemon.sharedSessions)],
      ["queued", String(daemon.queued)],
      ["dropped", String(daemon.dropped)],
    );
    if (daemon.rejected) rows.push(["rejected by hub", String(daemon.rejected)]);
  }
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`  ${dim(k.padEnd(width))}  ${v}`);
}

/** `agentblip hub share [level]`: show or change what this machine shares. */
export async function runHubShare(level?: string): Promise<void> {
  const config = loadConfig();
  const hub = requireHub(config);
  const current = hubShareLevel(hub);
  if (level === undefined) {
    console.log(`${bold(current)} — ${SHARE_LEVEL_SUMMARY[current]}`);
    return;
  }
  const next = parseShareLevel(level);
  config.hub = { ...hub, share: next };
  saveConfig(config);
  console.log(
    next === current
      ? green(`already sharing ${next} with ${hub.project.name}`)
      : green(`now sharing ${next} with ${hub.project.name}`),
  );
  console.log(`  ${SHARE_LEVEL_SUMMARY[next]}`);
  if (next === "conversation" && current !== "conversation") {
    console.log(dim("  text starts from now: nothing written before this moment is sent"));
  }
  await reloadDaemon(config);
}

export async function runHubDisconnect(): Promise<void> {
  const config = loadConfig();
  const hub = requireHub(config);
  config.hub = undefined;
  saveConfig(config);
  console.log(green(`disconnected from ${hub.url}; the device token was removed from ${configPath()}`));
  console.log(dim("  to revoke the device on the hub as well, use Devices on the board"));
  await reloadDaemon(config);
}

async function changeDir(input: string, kind: "include" | "exclude"): Promise<void> {
  const config = loadConfig();
  const hub = requireHub(config);
  const dir = resolveDir(input);
  if (!fs.existsSync(dir)) console.log(yellow(`  note: ${dir} does not exist (yet)`));
  config.hub = withDir(hub, dir, kind);
  saveConfig(config);
  console.log(
    kind === "include"
      ? green(`sessions and files under ${dir} are shared with ${hub.project.name}`)
      : green(`nothing under ${dir} is shared, whatever its remote`),
  );
  await reloadDaemon(config);
}

export function runHubInclude(dir: string): Promise<void> {
  return changeDir(dir, "include");
}

export function runHubExclude(dir: string): Promise<void> {
  return changeDir(dir, "exclude");
}

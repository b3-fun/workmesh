import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HUB_DEVICE_TOKEN_RE,
  hubPairPollResponseSchema,
  hubPairStartResponseSchema,
  hubShareLevelSchema,
} from "@workmesh/protocol";
import type { HubPairStartResponse, HubProjectRule, HubShareLevel } from "@workmesh/protocol";
import pkg from "../../package.json";
import { hubShareLevel, hubStickyShare, loadConfig, saveConfig } from "../lib/config";
import type { Config, HubConfig } from "../lib/config";
import { getHubState, isDaemonUp, reloadHub } from "../lib/daemon-client";
import { configPath } from "../lib/paths";
import { oneLine } from "../lib/untrusted";
import { readGithubLogin } from "../lib/github";
import { bold, cyan, dim, formatDuration, green, red, select, sleep, spinner, yellow } from "../lib/ui";
import { openBrowser } from "./setup";
import type { HubState } from "../daemon/server";

/** The team hub's address; `hub connect` takes any URL. */
export const EXAMPLE_HUB_URL = "https://workmesh.b3os.org";

const POLL_INTERVAL_MS = 2000;
const HTTP_TIMEOUT_MS = 10_000;

/** What each sharing level sends, in the words the CLI prints (SPEC §8: "state plainly"). */
export const SHARE_LEVEL_SUMMARY: Record<HubShareLevel, string> = {
  metadata:
    "metadata only: tool names, repo-relative paths, program + subcommand, issue ids, PR links. No prompt or agent text.",
  conversation:
    "metadata plus your prompts, the agent's text replies, a one-line description of each tool call and how long each " +
    "turn took, from every shared session (from the moment it is shared). Secrets are redacted on this machine first; tool " +
    "inputs, tool output and file contents never leave.",
};

/** How long a session stays shared, in the words the CLI prints. */
export function stickySummary(sticky: boolean): string {
  return sticky
    ? "sticky: once a session touches a shared repo, everything it does after that is shared, including later work " +
        "outside shared repos in the same session. `workmesh hub sticky off` shares such sessions turn by turn instead."
    : "per turn: a session whose folder is outside every shared repo is shared only for the turns that touch a shared " +
        "repo. `workmesh hub sticky on` restores the default.";
}

/** Parses a `hub sticky` argument. */
export function parseSticky(input: string): boolean {
  const v = input.trim().toLowerCase();
  if (v === "on" || v === "true" || v === "yes") return true;
  if (v === "off" || v === "false" || v === "no") return false;
  throw new Error(`unknown value "${input}" — use on or off`);
}

/** Parses a `--share` / `hub share` argument. */
export function parseShareLevel(input: string): HubShareLevel {
  const parsed = hubShareLevelSchema.safeParse(input.trim().toLowerCase());
  if (!parsed.success) throw new Error(`unknown sharing level "${input}" — use conversation or metadata`);
  return parsed.data;
}

/**
 * The level `hub connect` suggests when no `--share` was given: the one this
 * machine already chose for this hub, else the project's `defaultShare`, else
 * `conversation` (Sean, 11-24: "default max sharing").
 */
export function suggestedShare(project: HubProjectRule, previous?: HubShareLevel): HubShareLevel {
  return previous ?? project.defaultShare ?? "conversation";
}

/** A hub on this machine (local dev and tests): the only place plain http is accepted. */
function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
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
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
    throw new Error(`hub URL must be https (got ${url.protocol}//${url.host})`);
  }
  if (url.username || url.password) throw new Error("hub URL must not contain credentials");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** What `hub connect` may do with the approve link a hub sent: open it, or leave it and say why. */
export type PairLinkCheck = { open: true; url: string } | { open: false; why: string };

/**
 * Checks the approve link before it is opened (SPEC §3.1). The link comes from the hub's answer, and opening it hands
 * it to the system's `open` command, so it must lead back to the hub the person named: https on that hub's host and
 * port. Plain http passes only for a hub on this machine. What gets opened is the parsed link, never the text as sent.
 */
export function checkPairLink(hubUrl: string, link: string): PairLinkCheck {
  let hub: URL;
  let url: URL;
  try {
    hub = new URL(hubUrl);
    url = new URL(link);
  } catch {
    return { open: false, why: "it is not a web address" };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
    const what = url.protocol === "http:" ? `plain http to ${oneLine(url.host, 80)}` : `a ${oneLine(url.protocol, 40)} link`;
    return { open: false, why: `it is ${what}, not https` };
  }
  if (url.host !== hub.host) return { open: false, why: `it leads to ${oneLine(url.host, 80)}, not to ${hub.host}` };
  if (url.username || url.password) return { open: false, why: "it carries a user name or password" };
  return { open: true, url: url.href };
}

/** The one line printed under every pairing code. */
export const PAIR_CODE_WARNING = "approve only a code you see in your own terminal";

export interface AnnouncePairingOptions {
  /** False (`--no-open`): print the link, don't open it. */
  open?: boolean;
  /** Stands in for the system's browser opener (tests). */
  openLink?: (url: string) => void;
  print?: (line: string) => void;
}

/**
 * Shows a pairing code and where to approve it. The hub's link is printed and opened only when it passes
 * `checkPairLink`; otherwise the person gets the hub's own pairing page and the reason the link was left alone.
 */
export function announcePairing(
  hubUrl: string,
  pair: Pick<HubPairStartResponse, "code" | "verifyUrl">,
  opts: AnnouncePairingOptions = {},
): PairLinkCheck {
  const print = opts.print ?? ((line: string) => console.log(line));
  const link = checkPairLink(hubUrl, pair.verifyUrl);
  print(`  pairing code: ${bold(oneLine(pair.code, 40))}`);
  if (link.open) {
    print(`  approve it in your browser: ${cyan(link.url)}`);
  } else {
    print(yellow(`  the hub's link was not opened: ${link.why}`));
    print(`  open the hub's pairing page yourself and enter the code there: ${cyan(`${hubUrl}/pair`)}`);
  }
  print(yellow(`  ${PAIR_CODE_WARNING}`));
  print("");
  if (link.open && opts.open !== false) (opts.openLink ?? openBrowser)(link.url);
  return link;
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
  /** Sharing level, when already chosen: the hub's approve page names it (SPEC §8). */
  share?: HubShareLevel;
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
    client: opts.client ?? `workmesh/${pkg.version}`,
    ...(opts.share ? { share: opts.share } : {}),
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
    if (res.status === 401) throw new Error("the hub no longer knows this pairing — run `workmesh hub connect` again");
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
  throw new Error("pairing code expired — run `workmesh hub connect` again");
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
    console.log(yellow(`  restart it: ${bold("workmesh restart")}`));
    return undefined;
  }
}

function requireHub(config: Config): HubConfig {
  if (!config.hub) throw new Error(`not connected to a hub — run \`workmesh hub connect ${EXAMPLE_HUB_URL}\``);
  return config.hub;
}

export interface HubConnectOptions {
  open?: boolean;
  machine?: string;
  /** `--share conversation|metadata`; absent: ask in a TTY, else keep or use metadata. */
  share?: string;
  /** Injected for tests: answer the sharing question. */
  askShare?: (suggested: HubShareLevel) => Promise<HubShareLevel>;
  /** Injected for tests: the GitHub login `gh` reports. */
  readGithub?: () => Promise<string | undefined>;
  /** Injected for tests: stands in for the system's browser opener. */
  openLink?: (url: string) => void;
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
  console.log(bold("workmesh hub connect"));
  console.log(dim(`pairing ${machine} with ${hubUrl}\n`));

  let spin: ReturnType<typeof spinner> | undefined;
  let result: PairResult;
  // Known before pairing (flag, or this machine's earlier choice for this hub):
  // tell the hub so its approve page can say what will be shared.
  const knownShare = flagShare ?? (config.hub?.url === hubUrl ? config.hub.share : undefined);
  try {
    result = await pairWithHub(hubUrl, {
      machine,
      share: knownShare,
      onCode: (pair) => {
        announcePairing(hubUrl, pair, { open: opts.open, openLink: opts.openLink });
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
    // else the suggested level (max sharing by default, Sean 11-24).
    share = interactive ? await (opts.askShare ?? askShareLevel)(suggested) : suggested;
  }
  // v0.6: the avatar on the board and in teammates' menu bars (skipped when gh is absent).
  const github = (await (opts.readGithub ?? readGithubLogin)()) ?? previous?.github;
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
    stickyShare: previous?.stickyShare,
    github,
  };
  saveConfig(config);
  const who = result.person ? ` as ${result.person.name} (${result.person.email})` : "";
  console.log(green(`connected ${machine} to ${result.project.name}${who}`));
  console.log(dim(`  token and sharing rule saved to ${configPath()} (0600)`));
  if (github) console.log(dim(`  avatar: github.com/${github} (from gh)`));
  const remotes = result.project.include.remotes;
  console.log(
    `  shares sessions in repos whose origin contains ${remotes.length ? remotes.map((r) => bold(r)).join(", ") : dim("(none)")}` +
      (result.project.include.dirs.length ? ` and under ${result.project.include.dirs.join(", ")}` : ""),
  );
  console.log(`  sharing level: ${bold(share)} — ${SHARE_LEVEL_SUMMARY[share]}`);
  console.log(dim(`  change it any time: workmesh hub share ${share === "conversation" ? "metadata" : "conversation"}`));
  console.log(`  sessions: ${stickySummary(hubStickyShare(config.hub))}`);
  const state = await reloadDaemon(config);
  if (state?.enabled) console.log(green("  the daemon is forwarding now"));
  else if (state === undefined) console.log(`  start the daemon: ${bold("workmesh start --detach")}`);
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
    console.log(`not connected to a hub — ${bold(`workmesh hub connect ${EXAMPLE_HUB_URL}`)}`);
    return;
  }
  const rows: Array<[string, string]> = [
    ["hub", hub.url],
    ["project", `${hub.project.name} (${hub.project.id})`],
    ["paired as", hub.person ? `${hub.person.name} <${hub.person.email}> on ${hub.machine ?? "this machine"}` : (hub.machine ?? "this machine")],
    ["shares", [...hub.project.include.remotes, ...hub.project.include.dirs, ...hub.includeDirs].join(", ") || "(nothing)"],
    ["level", `${hubShareLevel(hub)} — ${SHARE_LEVEL_SUMMARY[hubShareLevel(hub)]}`],
    ["sessions", stickySummary(hubStickyShare(hub))],
  ];
  if (hub.github) rows.push(["avatar", `github.com/${hub.github}`]);
  if (hub.excludeDirs.length) rows.push(["never shares", hub.excludeDirs.join(", ")]);
  if (!daemon) {
    rows.push(["daemon", daemonError ? red(daemonError) : yellow("not running — `workmesh start --detach`")]);
  } else if (!daemon.enabled) {
    rows.push(["daemon", yellow("running without hub forward — `workmesh restart`")]);
  } else {
    const ago = (t?: number): string => (t ? `${formatDuration(Date.now() - t)} ago` : "never");
    rows.push(
      [
        "forwarding",
        daemon.halted
          ? red(`stopped: ${daemon.lastError ?? "token rejected"} — run \`workmesh hub connect ${hub.url}\``)
          : daemon.lastSendOk === false
            ? yellow(`retrying: ${daemon.lastError ?? "send failed"}`)
            : green("on"),
      ],
      ["last send", `${ago(daemon.lastSendAt)}${daemon.lastSendOk === false ? red(" (failed)") : ""}`],
      ["last success", ago(daemon.lastSuccessAt)],
      ["shared sessions", String(daemon.sharedSessions)],
      // v0.6: subagents go as their own sessions once the hub serves /relay/team.
      ["subagents", daemon.structured ? `${daemon.subagentSessions ?? 0} live, sent as sessions` : "folded into their sessions (hub has no team view)"],
      ["queued", String(daemon.queued)],
      ["dropped", String(daemon.dropped)],
    );
    if (daemon.rejected) rows.push(["rejected by hub", String(daemon.rejected)]);
  }
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`  ${dim(k.padEnd(width))}  ${v}`);
}

/** `workmesh hub share [level]`: show or change what this machine shares. */
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

export async function runHubSticky(value?: string): Promise<void> {
  const config = loadConfig();
  const hub = requireHub(config);
  const current = hubStickyShare(hub);
  if (value === undefined) {
    console.log(`${bold(current ? "on" : "off")} — ${stickySummary(current)}`);
    return;
  }
  const next = parseSticky(value);
  config.hub = { ...hub, stickyShare: next };
  saveConfig(config);
  console.log(green(`sticky sharing ${next ? "on" : "off"}`));
  console.log(`  ${stickySummary(next)}`);
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

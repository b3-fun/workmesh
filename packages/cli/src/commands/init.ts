import { loadConfig, loadConfigSafe, saveConfig } from "../lib/config";
import type { Config, HubConfig } from "../lib/config";
import { getHubState, isDaemonUp, reloadHub, startDaemonInBackground } from "../lib/daemon-client";
import { stopDaemon } from "../lib/daemon-control";
import { probeSystemdUser, serviceKind } from "../lib/service";
import { bold, cyan, dim, formatDuration, green, sleep, yellow } from "../lib/ui";
import type { HubState } from "../daemon/server";
import { resolveHubUrl, runHubConnect, runHubShare } from "./hub";
import type { HubConnectOptions } from "./hub";
import { LINGER_FIX, runServiceInstall } from "./service";
import { installHooksOnly } from "./setup";

/**
 * `workmesh init <hub-url>`: one command onboards a machine onto a team's hub (Sean, 11-25: the whole team is
 * installing). It installs or refreshes the hooks (Claude Code, Codex when found) and the MCP server, runs the
 * daemon (as a launchd / systemd service when it can, else in the background), and pairs with the hub in the
 * browser unless this machine is already paired with it. It prints each step. Running it again changes nothing
 * that is already right: hooks are left as they are, the daemon is restarted on the current build, and pairing
 * is skipped while the hub still accepts this machine's token (`--repair` pairs again).
 */

export interface InitOptions {
  /** conversation | metadata, passed to pairing (and applied to an existing pairing). */
  share?: string;
  /** `--codex` / `--no-codex`; undefined: only when a Codex install is found. */
  codex?: boolean;
  /** `--no-open`: print the approve link without opening a browser. */
  open?: boolean;
  machine?: string;
  claudeDir?: string;
  /** `--no-mcp`. */
  mcp?: boolean;
  /** `--no-service`: run the daemon in the background without launchd / systemd. */
  service?: boolean;
  /** `--no-wake`: no asyncRewake Stop hook. */
  wake?: boolean;
  /** Pair again even when the hub still accepts this machine's token. */
  repair?: boolean;
  /** Linux: `--no-linger` leaves lingering off (the daemon then stops when you log out). */
  linger?: boolean;
}

export type TokenCheck = "ok" | "rejected" | "unknown";

export interface InitDeps {
  /** Never the real `claude` CLI in tests (`null`). */
  claudeBin?: string | null;
  connect?: (url: string, opts: HubConnectOptions) => Promise<void>;
  setShare?: (level: string) => Promise<void>;
  checkToken?: (hub: Pick<HubConfig, "url" | "deviceToken">) => Promise<TokenCheck>;
  serviceInstall?: () => Promise<boolean>;
  /** Restart the daemon outside a service; true when one answers. */
  restartDaemon?: (config: Config) => Promise<boolean>;
  /** The daemon's first contact with the hub after init (tests). */
  firstContact?: (port: number) => Promise<Contact>;
  /** Linux: whether logging out stops the daemon (systemd without lingering). Tests. */
  stopsAtLogout?: () => boolean;
}

/** Linux with systemd and lingering off: the user's services, the daemon among them, stop at logout. */
function stopsAtLogout(): boolean {
  if (serviceKind() !== "systemd") return false;
  const sd = probeSystemdUser();
  return sd.systemctl && sd.linger === false;
}

/**
 * B3's hosted hub answers at both names (bullpen.b3os.org was its first): a pairing made at one is the pairing at the
 * other. Machines paired before the rename keep `bullpen` in their config.
 */
export const HUB_ALIASES: ReadonlyArray<readonly string[]> = [["https://workmesh.b3os.org", "https://bullpen.b3os.org"]];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The host's parent domain (`workmesh.b3os.org` → `b3os.org`), or the host when it has no parent with a dot. */
function parentDomain(host: string): string {
  const labels = host.split(".");
  return labels.length > 2 ? labels.slice(1).join(".") : host;
}

/**
 * Whether `url` is the hub this machine is already paired with under another address (An, 11-25: paired at
 * bullpen.b3os.org with agentblip 0.6.0, then `workmesh init https://workmesh.b3os.org` paired a second device).
 * Known aliases are the same hub. Otherwise the machine's token is shown to `url` only when both addresses sit under
 * one parent domain (or both on this machine), and the hub accepting it is the proof: a device token is valid only
 * at the hub that issued it. Elsewhere, or when `url` doesn't answer, it's a different hub.
 */
export async function sameHub(
  paired: Pick<HubConfig, "url" | "deviceToken">,
  url: string,
  check: (hub: Pick<HubConfig, "url" | "deviceToken">) => Promise<TokenCheck> = checkHubToken,
): Promise<boolean> {
  if (paired.url === url) return true;
  if (HUB_ALIASES.some((names) => names.includes(paired.url) && names.includes(url))) return true;
  let a: URL;
  let b: URL;
  try {
    a = new URL(paired.url);
    b = new URL(url);
  } catch {
    return false;
  }
  const local = LOCAL_HOSTS.has(a.hostname) && LOCAL_HOSTS.has(b.hostname) && a.port === b.port;
  const sibling = a.protocol === "https:" && b.protocol === "https:" && parentDomain(a.hostname) === parentDomain(b.hostname) && parentDomain(a.hostname).includes(".");
  if (!local && !sibling) return false;
  return (await check({ url, deviceToken: paired.deviceToken })) === "ok";
}

/** Points this machine's pairing at another address of the same hub (the token, sharing and dirs stay). */
function rehomeHub(url: string): HubConfig | undefined {
  try {
    const config = loadConfig();
    if (!config.hub) return undefined;
    config.hub = { ...config.hub, url };
    saveConfig(config);
    return config.hub;
  } catch {
    return undefined; // an unreadable config: pairing again rewrites it
  }
}

/** What the daemon heard back from the hub after init. */
export type Contact =
  | { kind: "ok"; at: number; sharedSessions: number }
  | { kind: "failed"; error: string }
  | { kind: "off" }
  | { kind: "no-daemon" };

/** Waits (≤ `timeoutMs`) for the daemon's forwarder to reach the hub once. */
export async function waitForFirstContact(port: number, timeoutMs = 10_000): Promise<Contact> {
  const deadline = Date.now() + timeoutMs;
  let last: HubState | undefined;
  while (Date.now() < deadline) {
    try {
      last = await getHubState(port);
    } catch {
      last = undefined;
    }
    if (last?.enabled && last.lastSuccessAt) return { kind: "ok", at: last.lastSuccessAt, sharedSessions: last.sharedSessions ?? 0 };
    if (last?.enabled && last.halted) return { kind: "failed", error: last.lastError ?? "token rejected" };
    await sleep(400);
  }
  if (!last) return (await isDaemonUp(port)) ? { kind: "off" } : { kind: "no-daemon" };
  if (!last.enabled) return { kind: "off" };
  return { kind: "failed", error: last.lastError ?? "no answer from the hub yet" };
}

/** Whether the hub still accepts this machine's device token (401 = no; anything else that answers = yes). */
export async function checkHubToken(hub: Pick<HubConfig, "url" | "deviceToken">, fetchImpl: typeof fetch = fetch): Promise<TokenCheck> {
  try {
    const res = await fetchImpl(`${hub.url}/relay/team`, {
      headers: { authorization: `Bearer ${hub.deviceToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) return "rejected";
    return "ok";
  } catch {
    return "unknown";
  }
}

async function restartInBackground(config: Config): Promise<boolean> {
  const stopped = await stopDaemon();
  if (stopped.kind === "stuck") return isDaemonUp(config.port);
  return startDaemonInBackground(config);
}

export async function runInit(url: string, opts: InitOptions = {}, deps: InitDeps = {}): Promise<void> {
  // Validate before touching anything.
  const hubUrl = resolveHubUrl(url);
  console.log(bold(`workmesh init ${hubUrl}`));
  console.log(dim("hooks and tools, the daemon, then pairing; safe to run again\n"));

  // 1. Hooks (Claude Code, Codex when found) and the MCP server.
  installHooksOnly({
    claudeDir: opts.claudeDir,
    codex: opts.codex,
    mcp: opts.mcp,
    wake: opts.wake,
    claudeBin: deps.claudeBin,
    title: "1. hooks and tools",
  });
  if (opts.claudeDir) process.env.CLAUDE_CONFIG_DIR = opts.claudeDir;

  // 2. The daemon, restarted on this build so it runs the hooks just installed.
  console.log(bold("\n2. daemon"));
  const before = loadConfigSafe();
  let up = false;
  if (opts.service !== false && serviceKind() && !process.env.WORKMESH_NO_SERVICE) {
    up = await (deps.serviceInstall ?? (() => runServiceInstall({ linger: opts.linger })))();
    // launchd reloads the job on install; systemd leaves a running unit as it is, so restart it onto this build.
    if (up && serviceKind() === "systemd") up = await (deps.restartDaemon ?? restartInBackground)(before);
  }
  if (!up) {
    up = await (deps.restartDaemon ?? restartInBackground)(before);
    console.log(
      up
        ? `  daemon: ${green(`running on 127.0.0.1:${before.port}`)}${dim(" (background; `workmesh service install` keeps it running across restarts)")}`
        : `  daemon: ${yellow("not answering yet; hooks start one on the next agent event")}`,
    );
  }

  // 3. Pairing.
  console.log(bold("\n3. hub"));
  const config = loadConfigSafe();
  let paired = config.hub?.url === hubUrl ? config.hub : undefined;
  if (!paired && config.hub && !opts.repair && (await sameHub(config.hub, hubUrl, deps.checkToken ?? checkHubToken))) {
    // The same hub under another address: keep the pairing (a second one would leave a ghost device on the board).
    const from = config.hub.url;
    paired = rehomeHub(hubUrl);
    if (paired) {
      config.hub = paired;
      console.log(`  ${hubUrl} is the hub this machine paired with at ${from}: ${green("pairing kept")}, forwarding to ${hubUrl} from now`);
    }
  }
  let token: TokenCheck | undefined;
  if (paired && !opts.repair) token = await (deps.checkToken ?? checkHubToken)(paired);
  if (paired && !opts.repair && token !== "rejected") {
    const who = paired.person ? ` as ${paired.person.name}` : "";
    console.log(`  ${green(`already paired with ${paired.project.name}${who}`)}${token === "unknown" ? dim(" (the hub didn't answer; pairing kept)") : ""}`);
    if (opts.share !== undefined) await (deps.setShare ?? runHubShare)(opts.share);
    if (up && !deps.connect) {
      try {
        await reloadHub(config.port);
      } catch {
        // an older daemon: the restart above already read the pairing
      }
    }
    console.log(dim("  pair again with `workmesh init --repair " + hubUrl + "`"));
  } else {
    if (token === "rejected") console.log(yellow("  the hub no longer accepts this machine's token: pairing again"));
    await (deps.connect ?? runHubConnect)(hubUrl, {
      ...(opts.open === false ? { open: false } : {}),
      ...(opts.machine ? { machine: opts.machine } : {}),
      ...(opts.share !== undefined ? { share: opts.share } : {}),
    });
  }

  // 4. The hub hears from this machine: what makes it show as online on the board.
  console.log(bold("\n4. check"));
  const contact = up ? await (deps.firstContact ?? waitForFirstContact)(loadConfigSafe().port) : ({ kind: "no-daemon" } as const);
  switch (contact.kind) {
    case "ok":
      console.log(
        `  hub: ${green("heard from this machine")}${dim(` (${formatDuration(Math.max(0, Date.now() - contact.at))} ago)`)}: ` +
          (contact.sharedSessions > 0 ? `online with ${contact.sharedSessions} shared session(s)` : "online on the board, no agents running yet"),
      );
      break;
    case "failed":
      console.log(`  hub: ${yellow(`not reached yet: ${contact.error}`)}`);
      console.log(dim("  `workmesh doctor` says why and what to run"));
      break;
    case "off":
      console.log(`  hub: ${yellow("the daemon isn't forwarding")}: run ${bold("workmesh restart")}, then ${bold("workmesh doctor")}`);
      break;
    case "no-daemon":
      console.log(`  hub: ${yellow("no daemon is running, so this machine shows as offline")}: run ${bold("workmesh restart")}, then ${bold("workmesh doctor")}`);
      break;
  }

  if ((deps.stopsAtLogout ?? stopsAtLogout)()) {
    console.log(`  ${yellow("once you log out, systemd stops the daemon and the board shows this machine offline")}: ${bold(LINGER_FIX)}`);
  }

  console.log("");
  console.log(green("Workmesh is set up on this machine."));
  console.log(`  board: ${cyan(hubUrl)}`);
  console.log(dim("  sessions show up once they work in a shared repo; check everything with `workmesh doctor`"));
  console.log(dim("  Slack status too? `workmesh setup` (optional)"));
}

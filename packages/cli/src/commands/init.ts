import { loadConfigSafe } from "../lib/config";
import type { Config } from "../lib/config";
import { isDaemonUp, reloadHub, startDaemonInBackground } from "../lib/daemon-client";
import { stopDaemon } from "../lib/daemon-control";
import { serviceKind } from "../lib/service";
import { bold, cyan, dim, green, yellow } from "../lib/ui";
import { resolveHubUrl, runHubConnect, runHubShare } from "./hub";
import type { HubConnectOptions } from "./hub";
import { runServiceInstall } from "./service";
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
}

export type TokenCheck = "ok" | "rejected" | "unknown";

export interface InitDeps {
  /** Never the real `claude` CLI in tests (`null`). */
  claudeBin?: string | null;
  connect?: (url: string, opts: HubConnectOptions) => Promise<void>;
  setShare?: (level: string) => Promise<void>;
  checkToken?: (hub: NonNullable<Config["hub"]>) => Promise<TokenCheck>;
  serviceInstall?: () => Promise<boolean>;
  /** Restart the daemon outside a service; true when one answers. */
  restartDaemon?: (config: Config) => Promise<boolean>;
}

/** Whether the hub still accepts this machine's device token (401 = no; anything else that answers = yes). */
export async function checkHubToken(hub: NonNullable<Config["hub"]>, fetchImpl: typeof fetch = fetch): Promise<TokenCheck> {
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
    up = await (deps.serviceInstall ?? runServiceInstall)();
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
  const paired = config.hub?.url === hubUrl ? config.hub : undefined;
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

  console.log("");
  console.log(green("Workmesh is set up on this machine."));
  console.log(`  board: ${cyan(hubUrl)}`);
  console.log(dim("  sessions show up once they work in a shared repo; check everything with `workmesh doctor`"));
  console.log(dim("  Slack status too? `workmesh setup` (optional)"));
}

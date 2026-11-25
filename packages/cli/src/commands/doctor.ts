import fs from "node:fs";
import path from "node:path";
import {
  areClaudeHooksInstalled,
  claudeSettingsPath,
  isClaudeWakeInstalled,
  staleClaudeHookNodes,
} from "../adapters/claude-code";
import {
  areCodexHooksInstalled,
  codexConfigPath,
  codexHooksPath,
} from "../adapters/codex";
import { askCodexHooks, codexNotifyState, codexTrustFromConfig, codexTrustFromList, describeCodexTrust } from "../adapters/codex-doctor";
import type { CodexHookTrust } from "../adapters/codex-doctor";
import { claudeJsonPath, isClaudeMcpInstalled, isCodexMcpInstalled, mcpServerCommand } from "../adapters/mcp-install";
import { findBin } from "../daemon/handoff-runner";
import { delegateSettings, hubShareLevel, loadConfig, loadConfigSafe } from "../lib/config";
import type { Config } from "../lib/config";
import { getHealth, getHubState, getTeamState, getUpdateStatus, sinkConfigured } from "../lib/daemon-client";
import pkg from "../../package.json";
import { readUpdateCheck } from "../lib/update-state";
import { isNewer } from "../lib/versions";
import { codexHome, configPath, hubForwardStatePath } from "../lib/paths";
import { serviceKind, serviceStatus } from "../lib/service";
import type { ServiceStatus } from "../lib/service";
import { readStateFile } from "../hub/persist";
import { LINGER_FIX } from "./service";
import { createSink } from "../sinks";
import { resolveClaudeDir } from "./setup";
import {
  dim,
  errorMessage,
  formatDuration,
  green,
  red,
  yellow,
} from "../lib/ui";

const HTTP_TIMEOUT_MS = 5000;

export interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

const ok = (name: string, detail: string): CheckResult => ({ name, status: "ok", detail });
const warn = (name: string, detail: string): CheckResult => ({ name, status: "warn", detail });
const fail = (name: string, detail: string): CheckResult => ({ name, status: "fail", detail });

export interface DoctorOptions {
  json?: boolean;
  /** Claude Code config dir to check (default $CLAUDE_CONFIG_DIR, else ~/.claude). */
  claudeDir?: string;
  /** The codex binary to ask about hook trust (tests); null: don't ask Codex, read config.toml. */
  codexBin?: string | null;
}

/** Whether Codex trusts Workmesh's hooks: Codex's own answer, else what config.toml records. */
export async function codexHookTrust(bin?: string | null): Promise<CodexHookTrust> {
  const codex = bin === null ? undefined : (bin ?? findBin("codex"));
  if (codex) {
    const list = await askCodexHooks({ bin: codex, env: { ...process.env, CODEX_HOME: codexHome() } });
    const t = list ? codexTrustFromList(list) : undefined;
    if (t && t.hooks.length > 0) return t;
  }
  const read = (f: string): string => {
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return "";
    }
  };
  return codexTrustFromConfig(codexHooksPath(), read(codexHooksPath()), read(codexConfigPath()));
}

/** Where Codex's notify (the fallback for builds without hooks) really leads. */
export function codexNotifyCheck(configText?: string, self = mcpServerCommand().args[0]): CheckResult {
  let text = configText;
  if (text === undefined) {
    try {
      text = fs.readFileSync(codexConfigPath(), "utf8");
    } catch {
      text = "";
    }
  }
  const n = codexNotifyState(text);
  if (n.kind === "none") return warn("codex notify", "not installed (a fallback for Codex builds without hooks) — run `workmesh setup --hooks-only --codex`");
  if (n.kind === "other") return ok("codex notify", `${n.via ?? "another tool"} owns notify; left alone (a fallback only: hooks report Codex turns)`);
  const how = n.kind === "chained" ? `through ${n.via ?? "another tool"}'s notify` : "direct";
  const target = n.target ?? "";
  if (path.isAbsolute(target) && !fs.existsSync(target)) {
    return warn("codex notify", `${how}, to ${target}, which no longer exists (fallback only: hooks report Codex turns)`);
  }
  if (path.isAbsolute(target) && self && path.resolve(target) !== path.resolve(self)) {
    return warn("codex notify", `${how}, to another Workmesh install (${target}); this one is ${self} (fallback only)`);
  }
  return ok("codex notify", `${how}, to this install (a fallback for Codex builds without hooks)`);
}

export async function runDoctor(opts: DoctorOptions): Promise<void> {
  const checks: CheckResult[] = [];

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push(
    nodeMajor >= 20
      ? ok("node", `v${process.versions.node}`)
      : fail("node", `v${process.versions.node} — Workmesh needs node >= 20`),
  );

  let config: Config | undefined;
  const file = configPath();
  if (!fs.existsSync(file)) {
    checks.push(warn("config", `${file} missing — run \`workmesh setup\``));
  } else {
    try {
      config = loadConfig();
      checks.push(ok("config", `mode ${config.mode}, granularity ${config.granularity}`));
    } catch (err) {
      checks.push(fail("config", errorMessage(err)));
    }
  }
  const cfg = config ?? loadConfigSafe();

  if (cfg.mode === "relay") {
    checks.push(
      cfg.deviceToken
        ? ok("device token", "present")
        : fail("device token", "missing — run `workmesh setup`"),
    );
  } else if (cfg.mode === "slack") {
    checks.push(
      cfg.slackToken
        ? ok("slack token", "present")
        : fail("slack token", "missing — run `workmesh setup`"),
    );
  }

  checks.push(
    ok(
      "status policy",
      cfg.statusPolicy === "respect"
        ? "respect — never overwrites a status Workmesh didn't set"
        : "overwrite — displaces an existing status while agents work, restores it after",
    ),
  );

  // 0.12 (SPEC §41): this version, a newer one when the daemon knows of it, and a daemon left on an older build.
  checks.push(await versionCheck(cfg.port));

  // Linux: what systemd does with the daemon (asked once; the service check and the offline causes read it).
  const svc: ServiceStatus | undefined = serviceKind() ? serviceStatus() : undefined;
  let daemonUp = false;
  try {
    const health = await getHealth(cfg.port);
    daemonUp = true;
    checks.push(
      ok("daemon", `running (pid ${health.pid}, up ${formatDuration(health.uptimeSec * 1000)})`),
    );
    if (health.lastError) {
      checks.push(fail("sink", health.lastError));
    }
    if (health.ownership?.backedOff) {
      checks.push(
        warn(
          "ownership",
          "standing down — your existing Slack status is untouched; Workmesh resumes when it clears",
        ),
      );
    }
  } catch {
    if (cfg.hub) {
      // Paired but silent: the board shows this machine offline. Say since when, why, and what to run.
      const last = lastContact(cfg.hub.url);
      const since = last ? `${formatDuration(Date.now() - last)} ago` : "it paired";
      checks.push(
        fail(
          "daemon",
          `not running, so the hub hasn't heard from this machine since ${since} and the board shows it offline${offlineCause(svc)} → \`workmesh restart\``,
        ),
      );
    } else {
      checks.push(warn("daemon", `not running on 127.0.0.1:${cfg.port} — \`workmesh start --detach\``));
    }
  }

  // Legacy-read probe: a token without users.profile:read still pushes, but
  // the ownership guard can't see an existing status (legacy blind pushes).
  if (cfg.mode !== "console" && sinkConfigured(cfg)) {
    try {
      const read = await createSink(cfg).getStatus();
      checks.push(
        read.readable
          ? ok("status read", "token can read the current status (ownership guard active)")
          : warn(
              "status read",
              "token lacks users.profile:read — existing statuses can't be detected (legacy mode); run `workmesh setup` to re-pair",
            ),
      );
    } catch (err) {
      checks.push(warn("status read", errorMessage(err)));
    }
  }

  if (cfg.mode === "relay") {
    try {
      const res = await fetch(new URL("/api/health", cfg.relayUrl), {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      checks.push(
        res.ok
          ? ok("relay", cfg.relayUrl)
          : fail("relay", `${cfg.relayUrl} responded ${res.status}`),
      );
    } catch {
      checks.push(fail("relay", `${cfg.relayUrl} unreachable`));
    }
  }

  if (cfg.hub) {
    const hub = cfg.hub;
    checks.push(
      ok(
        "hub",
        `paired with ${hub.url} (project ${hub.project.name}${hub.person ? `, as ${hub.person.name}` : ""})`,
      ),
    );
    const level = hubShareLevel(hub);
    checks.push(
      ok(
        "hub sharing",
        level === "conversation"
          ? "conversation — prompts, agent text, tool descriptions and turn times from shared repos, redacted on this machine"
          : "metadata — no prompt or agent text leaves this machine (`workmesh hub share conversation` to add it)",
      ),
    );
    try {
      const state = await getHubState(cfg.port);
      if (state.enabled && state.share !== undefined && state.share !== level) {
        checks.push(warn("hub sharing", `the daemon still shares ${state.share}: run \`workmesh hub share ${level}\` again or restart it`));
      }
      if (state.enabled && state.share === undefined) {
        checks.push(warn("hub forward", "the running daemon predates sharing levels — restart it: `workmesh restart`"));
      }
      const heard = state.enabled && state.lastSuccessAt ? `${formatDuration(Date.now() - state.lastSuccessAt)} ago` : undefined;
      if (!state.enabled) {
        checks.push(fail("hub forward", "the daemon isn't forwarding (it started before this machine paired?), so the board shows it offline → `workmesh restart`"));
      } else if (state.url !== hub.url) {
        checks.push(fail("hub forward", `the daemon forwards to ${state.url} but this machine is paired with ${hub.url} → \`workmesh restart\``));
      } else if (state.halted) {
        checks.push(fail("hub forward", `stopped: ${state.lastError ?? "token rejected"} → \`workmesh init ${hub.url}\``));
      } else if (state.lastSendOk === false) {
        checks.push(
          warn(
            "hub forward",
            `retrying: ${state.lastError ?? "send failed"}; the hub last heard from this machine ${heard ?? "before this daemon started"} (${state.queued} queued, ${state.dropped} dropped)`,
          ),
        );
      } else if (!state.lastSuccessAt) {
        checks.push(warn("hub forward", "the daemon hasn't reached the hub yet (it sends within a second of starting) → run `workmesh doctor` again"));
      } else {
        checks.push(
          ok(
            "hub forward",
            `online: the hub heard from this machine ${heard}; ` +
              (state.sharedSessions > 0
                ? `${state.sharedSessions} shared session(s)`
                : "no agents running in a shared repo right now (you show as online, no agents)") +
              (state.queued || state.dropped ? `, ${state.queued} queued, ${state.dropped} dropped` : ""),
          ),
        );
      }
    } catch {
      // daemon down: already reported above; an old daemon has no /hub
    }
    try {
      const team = await getTeamState(cfg.port);
      const c = team.coord;
      if (team.enabled && c === undefined) {
        checks.push(warn("coordination", "the running daemon predates leases and holds — restart it: `workmesh restart`"));
      } else if (c?.available === true) {
        checks.push(ok("coordination", `on (leases, holds, messages)${c.holds.length ? `; ${c.holds.length} of your agents held` : ""}${c.unread.length ? `; ${c.unread.length} unread message(s)` : ""}`));
      } else if (c?.available === false) {
        checks.push(warn("coordination", "this hub has no leases or messages yet (it predates Workmesh v1); agents work as before"));
      } else if (c) {
        checks.push(warn("coordination", "not synced with the hub yet"));
      }
      // v2 (SPEC §31): handoffs, approval gates, wake.
      const d = (team as { delegate?: { available: boolean; handoffs: unknown[]; approvals: unknown[] } }).delegate;
      if (c?.available === true) {
        if (team.enabled && d === undefined) {
          checks.push(warn("delegation", "the running daemon predates handoffs and approvals — restart it: `workmesh restart`"));
        } else if (d?.available) {
          const s = delegateSettings(cfg);
          checks.push(
            ok(
              "delegation",
              `on: handoffs ${s.accept}${s.roots.length ? `, roots ${s.roots.join(", ")}` : ""}; wake ${s.wake ? "on" : "off"}${d.approvals.length ? `; ${d.approvals.length} approval(s) pending` : ""}`,
            ),
          );
        } else if (d) {
          checks.push(warn("delegation", "this hub has no handoffs or approvals yet (it predates Workmesh v2); agents work as before"));
        }
      }
    } catch {
      // daemon down or older: reported above
    }
  }

  // v0.10 (SPEC §24): the daemon under launchd / systemd comes back after a crash, kill or reboot.
  if (svc) checks.push(...serviceChecks(svc, daemonUp));
  if (cfg.hub) {
    checks.push(
      fs.existsSync(hubForwardStatePath())
        ? ok("hub state", `${hubForwardStatePath()} (shared sessions survive a restart)`)
        : warn("hub state", "not saved yet (written by a v0.10+ daemon once it forwards)"),
    );
  }
  const claudeDir = opts.claudeDir ? resolveClaudeDir(opts.claudeDir) : undefined;
  const settingsPath = claudeSettingsPath(claudeDir);
  const claudeJson = claudeJsonPath(claudeDir);
  const staleNodes = staleClaudeHookNodes(settingsPath);
  checks.push(
    staleNodes.length > 0
      ? fail("claude code hooks", `${settingsPath} runs ${staleNodes.join(", ")}, which no longer exists — run \`workmesh setup --hooks-only\``)
      : areClaudeHooksInstalled(settingsPath)
        ? ok("claude code hooks", settingsPath)
        : warn("claude code hooks", `not installed in ${settingsPath} — run \`workmesh setup\``),
  );
  if (areClaudeHooksInstalled(settingsPath)) {
    checks.push(
      isClaudeWakeInstalled(settingsPath)
        ? ok("claude code wake", "asyncRewake Stop hook installed (idle shared sessions wake for messages)")
        : warn("claude code wake", "not installed — run `workmesh setup --hooks-only` (or it was turned off with --no-wake)"),
    );
  }
  // Codex only where it is installed: someone who doesn't use it has nothing to fix.
  const codexUsed = fs.existsSync(codexHome());
  if (codexUsed) {
    if (!areCodexHooksInstalled()) {
      checks.push(warn("codex hooks", "not installed — run `workmesh setup --hooks-only --codex`"));
    } else {
      // Installed isn't running: Codex skips a hook until its person trusts it in /hooks, and again after it changes.
      const trust = describeCodexTrust(await codexHookTrust(opts.codexBin));
      checks.push(trust.ok ? ok("codex hooks", `${codexHooksPath()}: ${trust.text}`) : warn("codex hooks", `${codexHooksPath()}: ${trust.text}`));
    }
  }
  checks.push(
    isClaudeMcpInstalled(claudeJson)
      ? ok("claude code mcp", `workmesh in ${claudeJson} (user scope)`)
      : warn("claude code mcp", "not registered — run `workmesh setup --hooks-only`"),
  );
  if (fs.existsSync(codexConfigPath())) {
    checks.push(
      isCodexMcpInstalled()
        ? ok("codex mcp", `[mcp_servers.workmesh] in ${codexConfigPath()}`)
        : warn("codex mcp", "not registered — run `workmesh setup --hooks-only`"),
    );
  }
  if (codexUsed) {
    checks.push(codexNotifyCheck());
  } else {
    checks.push(ok("codex", `not installed (${codexHome()}), skipped`));
  }

  const failed = checks.some((check) => check.status === "fail");
  if (opts.json) {
    console.log(JSON.stringify({ ok: !failed, checks }, null, 2));
  } else {
    console.log("workmesh doctor\n");
    const nameWidth = Math.max(...checks.map((check) => check.name.length));
    for (const check of checks) {
      const icon =
        check.status === "ok"
          ? green("✓")
          : check.status === "warn"
            ? yellow("!")
            : red("✗");
      const detail = check.status === "ok" ? dim(check.detail) : check.detail;
      console.log(`  ${icon} ${check.name.padEnd(nameWidth)}  ${detail}`);
    }
  }
  if (failed) process.exitCode = 1;
}

/**
 * "workmesh 0.12.0", or "0.12.1 available: `workmesh update`" (from the daemon's last check, else its saved one), or
 * the daemon still running an older build than the CLI.
 */
export async function versionCheck(port: number, current = pkg.version): Promise<CheckResult> {
  let daemon: string | undefined;
  try {
    daemon = (await getHealth(port)).version ?? "an older version";
  } catch {
    daemon = undefined;
  }
  let latest: string | undefined;
  let hint: string | undefined;
  try {
    const u = await getUpdateStatus(port);
    latest = u.latest;
    if (!u.install.canUpdate) hint = u.install.hint;
  } catch {
    latest = readUpdateCheck().latest;
  }
  if (daemon && daemon !== current) {
    return warn("version", `${current}, but the daemon still runs ${daemon} → \`workmesh update\` (or \`workmesh restart\`)`);
  }
  if (latest && isNewer(latest, current)) {
    return warn("version", `${current}; ${latest} available: \`workmesh update\`${hint ? ` (${hint})` : ""}`);
  }
  return ok("version", `${current}${latest ? " (latest)" : ""}`);
}

/** When the hub last accepted a send from this machine, as the daemon saved it (SPEC §24 state file). */
export function lastContact(url: string, file = hubForwardStatePath()): number | undefined {
  const raw = readStateFile(file) as { url?: unknown; lastContactAt?: unknown } | undefined;
  if (!raw || raw.url !== url || typeof raw.lastContactAt !== "number") return undefined;
  return raw.lastContactAt;
}

/** Why a daemon may be down, from the service manager's view (empty when nothing explains it). */
export function offlineCause(svc: ServiceStatus | undefined): string {
  const sd = svc?.systemd;
  if (sd?.systemctl && !sd.manager) return ` (no systemd user session: ${sd.error ?? "systemctl --user failed"}; the daemon stops when you log out: ${LINGER_FIX})`;
  if (sd?.systemctl && sd.linger === false) return ` (lingering is off, so systemd stopped it when you logged out: ${LINGER_FIX})`;
  if (svc && svc.kind && !svc.installed) return " (no daemon service is installed, so nothing brings it back)";
  return "";
}

/** The daemon-service checks: launchd, systemd --user and, on Linux, what happens at logout. */
export function serviceChecks(svc: ServiceStatus, daemonUp: boolean): CheckResult[] {
  const out: CheckResult[] = [];
  const sd = svc.systemd;
  if (sd && !sd.systemctl) {
    out.push(ok("daemon service", "none (no systemd on this machine): the daemon runs in the background; after a reboot the next agent event starts it"));
    return out;
  }
  if (sd && !sd.manager) {
    out.push(
      warn(
        "daemon service",
        `no systemd user session (${sd.error ?? "systemctl --user failed"}): the daemon can't run as a service and stops when you log out → \`${LINGER_FIX}\`, then \`workmesh service install\``,
      ),
    );
    return out;
  }
  if (!svc.installed) {
    out.push(warn("daemon service", "not installed: a killed or crashed daemon stays down until the next hook → `workmesh service install`"));
  } else if (svc.loaded && svc.pid) {
    out.push(ok("daemon service", `${svc.kind}, running (pid ${svc.pid})${svc.program?.[1] ? `, ${svc.program[1]}` : ""}`));
  } else if (daemonUp) {
    out.push(warn("daemon service", `${svc.kind}, installed but the running daemon isn't the service's (it won't come back after a crash) → \`workmesh service install\``));
  } else {
    out.push(warn("daemon service", `${svc.kind}, installed but ${svc.loaded ? "not running" : "not loaded"} → \`workmesh service install\``));
  }
  if (sd?.linger === false) {
    out.push(
      warn(
        "logout",
        `lingering is off: systemd stops the daemon when you log out (an SSH box then shows you offline on the board) → \`${LINGER_FIX}\``,
      ),
    );
  } else if (sd?.linger === true) {
    out.push(ok("logout", "lingering on: the daemon keeps running after you log out and starts at boot"));
  }
  return out;
}

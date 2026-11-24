import fs from "node:fs";
import {
  areClaudeHooksInstalled,
  claudeSettingsPath,
} from "../adapters/claude-code";
import {
  areCodexHooksInstalled,
  codexConfigPath,
  codexHooksPath,
  isCodexNotifyInstalled,
} from "../adapters/codex";
import { hubShareLevel, loadConfig, loadConfigSafe } from "../lib/config";
import type { Config } from "../lib/config";
import { getHealth, getHubState, sinkConfigured } from "../lib/daemon-client";
import { configPath } from "../lib/paths";
import { createSink } from "../sinks";
import {
  dim,
  errorMessage,
  formatDuration,
  green,
  red,
  yellow,
} from "../lib/ui";

const HTTP_TIMEOUT_MS = 5000;

interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

const ok = (name: string, detail: string): CheckResult => ({ name, status: "ok", detail });
const warn = (name: string, detail: string): CheckResult => ({ name, status: "warn", detail });
const fail = (name: string, detail: string): CheckResult => ({ name, status: "fail", detail });

export interface DoctorOptions {
  json?: boolean;
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

  try {
    const health = await getHealth(cfg.port);
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
    checks.push(
      warn("daemon", `not running on 127.0.0.1:${cfg.port} — \`workmesh start --detach\``),
    );
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
        checks.push(warn("hub forward", "the running daemon predates sharing levels — restart it: `workmesh stop && workmesh start --detach`"));
      }
      if (!state.enabled) {
        checks.push(warn("hub forward", "the daemon isn't forwarding — restart it: `workmesh stop && workmesh start --detach`"));
      } else if (state.halted) {
        checks.push(fail("hub forward", `stopped: ${state.lastError ?? "token rejected"} — run \`workmesh hub connect ${hub.url}\``));
      } else if (state.lastSendOk === false) {
        checks.push(warn("hub forward", `retrying: ${state.lastError ?? "send failed"} (${state.queued} queued, ${state.dropped} dropped)`));
      } else {
        checks.push(
          ok(
            "hub forward",
            `${state.sharedSessions} shared session(s), ${state.queued} queued, ${state.dropped} dropped` +
              (state.lastSuccessAt ? `, last sent ${formatDuration(Date.now() - state.lastSuccessAt)} ago` : ""),
          ),
        );
      }
    } catch {
      // daemon down: already reported above; an old daemon has no /hub
    }
  }

  checks.push(
    areClaudeHooksInstalled()
      ? ok("claude code hooks", claudeSettingsPath())
      : warn("claude code hooks", "not installed — run `workmesh setup`"),
  );
  checks.push(
    areCodexHooksInstalled()
      ? ok("codex hooks", `${codexHooksPath()} (trust them in Codex with /hooks)`)
      : warn("codex hooks", "not installed — run `workmesh setup`"),
  );
  checks.push(
    isCodexNotifyInstalled()
      ? ok("codex notify", codexConfigPath())
      : warn("codex notify", "not installed — run `workmesh setup`"),
  );

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

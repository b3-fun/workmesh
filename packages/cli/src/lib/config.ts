import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_DAEMON_PORT, DEFAULT_DEBOUNCE_MS, DEFAULT_STATUS_TTL_SEC } from "@workmesh/core";
import { HUB_DEVICE_TOKEN_RE, HUB_GITHUB_LOGIN_RE, hubProjectRuleSchema, hubShareLevelSchema } from "@workmesh/protocol";
import type { FormatOptions } from "@workmesh/core";
import type { HubShareLevel } from "@workmesh/protocol";
import { envSetting } from "./names";
import { configPath } from "./paths";

const templatesSchema = z
  .object({
    presence: z.string(),
    workingOne: z.string(),
    workingMany: z.string(),
    waitingSuffix: z.string(),
    activityOne: z.string(),
    activityMany: z.string(),
    repoActivityOne: z.string(),
    repoActivityMany: z.string(),
    waitingOnly: z.string(),
  })
  .partial();

/**
 * Hub forward (team hub): pairing result plus local include/exclude dirs.
 * Holds a device token, so it lives in the 0600 config file only.
 */
export const hubConfigSchema = z.object({
  url: z.url(),
  deviceId: z.string().min(1),
  deviceToken: z.string().regex(HUB_DEVICE_TOKEN_RE),
  machine: z.string().max(120).optional(),
  person: z.object({ email: z.string(), name: z.string() }).optional(),
  project: hubProjectRuleSchema,
  /** Absolute dirs shared on top of the project's rule (`workmesh hub include`). */
  includeDirs: z.array(z.string()).default([]),
  /** Absolute dirs never shared, whatever their remote (`workmesh hub exclude`). */
  excludeDirs: z.array(z.string()).default([]),
  pairedAt: z.number().int().optional(),
  /**
   * SPEC §8 sharing level, chosen by the person (`hub connect --share`,
   * `hub share`). Absent (0.6 pairings) means `metadata`: conversation text
   * never leaves without an explicit choice. An unknown value reads as absent.
   */
  share: hubShareLevelSchema.optional().catch(undefined),
  /** v0.6: the person's GitHub login, read from `gh` at `hub connect` (an avatar on the board and menu bar). */
  github: z.string().regex(HUB_GITHUB_LOGIN_RE).optional().catch(undefined),
});
export type HubConfig = z.infer<typeof hubConfigSchema>;

/** The level a hub section shares at: `metadata` unless the person chose `conversation`. */
export function hubShareLevel(hub: Pick<HubConfig, "share"> | undefined): HubShareLevel {
  return hub?.share ?? "conversation"; // max sharing by default (Sean, 11-24)
}

export const configSchema = z.object({
  mode: z.enum(["relay", "slack", "console"]).default("console"),
  relayUrl: z.url().default("https://agentblip.com"),
  deviceToken: z.string().optional(),
  slackToken: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(DEFAULT_DAEMON_PORT),
  granularity: z.enum(["off", "presence", "count", "activity"]).default("count"),
  /** How to treat a Slack status Workmesh didn't set (ownership guard). */
  statusPolicy: z.enum(["respect", "overwrite"]).default("respect"),
  showProject: z.boolean().default(false),
  /** Lead the activity status with the repo name ("b3iq: editing README.md"). */
  repoPrefix: z.boolean().default(true),
  statusTtlSec: z.number().int().nonnegative().default(DEFAULT_STATUS_TTL_SEC),
  debounceMs: z.number().int().nonnegative().default(DEFAULT_DEBOUNCE_MS),
  templates: templatesSchema.optional(),
  emoji: z
    .object({ working: z.string().optional(), waiting: z.string().optional() })
    .optional(),
  redactPatterns: z.array(z.string()).optional(),
  hideProjects: z.array(z.string()).optional(),
  adapters: z
    .object({
      claudeCode: z
        .object({ enabled: z.boolean().default(true) })
        .default({ enabled: true }),
      codex: z
        .object({
          enabled: z.boolean().default(true),
          sessionsDir: z.string().optional(),
        })
        .default({ enabled: true }),
      workflow: z
        .object({
          enabled: z.boolean().default(true),
          projectsDir: z.string().optional(),
        })
        .default({ enabled: true }),
    })
    .default({
      claudeCode: { enabled: true },
      codex: { enabled: true },
      workflow: { enabled: true },
    }),
  autoStartDaemon: z.boolean().default(true),
  /**
   * Present once paired with a hub (`workmesh hub connect`). A malformed
   * section reads as "not paired" instead of invalidating the Slack config.
   */
  hub: hubConfigSchema.optional().catch(undefined),
});

export type Config = z.infer<typeof configSchema>;

export function defaultConfig(): Config {
  return applyEnvOverrides(configSchema.parse({}));
}

/** Loads config, applying schema defaults and env overrides. Throws on a corrupt file. */
export function loadConfig(file = configPath()): Config {
  let raw: unknown = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        `invalid JSON in ${file} — fix or delete it, then run \`workmesh setup\``,
      );
    }
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid config at ${file}: ${detail}`);
  }
  return applyEnvOverrides(parsed.data);
}

/** Like loadConfig but never throws — falls back to defaults (used by `hook`). */
export function loadConfigSafe(file = configPath()): Config {
  try {
    return loadConfig(file);
  } catch {
    return defaultConfig();
  }
}

function applyEnvOverrides(config: Config): Config {
  // WORKMESH_*, or the pre-rename AGENTBLIP_* when that is all that is set.
  const relayUrl = envSetting("RELAY_URL");
  if (relayUrl) config.relayUrl = relayUrl;
  const token = envSetting("TOKEN");
  if (token) config.deviceToken = token;
  const port = envSetting("PORT");
  if (port) {
    const n = Number.parseInt(port, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) config.port = n;
  }
  const policy = envSetting("STATUS_POLICY");
  if (policy === "respect" || policy === "overwrite") config.statusPolicy = policy;
  return config;
}

export function saveConfig(config: Config, file = configPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  // writeFileSync's mode only applies on create — enforce on rewrite too.
  fs.chmodSync(file, 0o600);
}

/**
 * The subset of config the running daemon can change on the fly (via the menu
 * bar app / POST /config). Anything affecting the connection — mode, port,
 * tokens, relayUrl — needs a restart and is intentionally excluded.
 */
export const liveConfigPatchSchema = z
  .object({
    granularity: z.enum(["off", "presence", "count", "activity"]),
    statusPolicy: z.enum(["respect", "overwrite"]),
    showProject: z.boolean(),
    repoPrefix: z.boolean(),
  })
  .partial()
  .strict();

export type LiveConfigPatch = z.infer<typeof liveConfigPatchSchema>;

/** Config view safe to expose over the loopback API — never includes tokens. */
export interface SafeConfig {
  mode: Config["mode"];
  relayUrl: string;
  port: number;
  granularity: Config["granularity"];
  statusPolicy: Config["statusPolicy"];
  showProject: boolean;
  repoPrefix: boolean;
  statusTtlSec: number;
  debounceMs: number;
  /** Hub pairing without its token; absent when not paired. */
  hub?: { url: string; project: { id: string; name: string }; share: HubShareLevel };
}

export function safeConfig(config: Config): SafeConfig {
  return {
    mode: config.mode,
    relayUrl: config.relayUrl,
    port: config.port,
    granularity: config.granularity,
    statusPolicy: config.statusPolicy,
    showProject: config.showProject,
    repoPrefix: config.repoPrefix,
    statusTtlSec: config.statusTtlSec,
    debounceMs: config.debounceMs,
    ...(config.hub
      ? {
          hub: {
            url: config.hub.url,
            project: { id: config.hub.project.id, name: config.hub.project.name },
            share: hubShareLevel(config.hub),
          },
        }
      : {}),
  };
}

/**
 * The hub section as it is on disk right now: undefined when not paired,
 * "unreadable" when the file can't be parsed (callers then keep what they have).
 */
export function readHubConfig(file = configPath()): HubConfig | undefined | "unreadable" {
  try {
    return loadConfig(file).hub;
  } catch {
    return "unreadable";
  }
}

export function formatOptionsFromConfig(config: Config): FormatOptions {
  return {
    granularity: config.granularity,
    templates: config.templates,
    emoji: config.emoji,
    showProject: config.showProject,
    repoPrefix: config.repoPrefix,
    statusTtlSec: config.statusTtlSec,
    redactPatterns: config.redactPatterns,
  };
}

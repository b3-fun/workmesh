import { loadConfigSafe } from "../lib/config";
import { pauseDaemon, resumeDaemon } from "../lib/daemon-client";
import { SNOOZE_PRESETS } from "../lib/snooze";
import type { SnoozePreset } from "../lib/snooze";
import { green } from "../lib/ui";

export interface PauseOptions {
  /** Snooze preset: resume automatically after it. */
  for?: string;
}

export async function runPause(opts: PauseOptions = {}): Promise<void> {
  if (opts.for !== undefined && !(SNOOZE_PRESETS as readonly string[]).includes(opts.for)) {
    throw new Error(`--for must be one of ${SNOOZE_PRESETS.join(", ")}`);
  }
  const preset = opts.for as SnoozePreset | undefined;
  const config = loadConfigSafe();
  let pausedUntil: number | undefined;
  try {
    ({ pausedUntil } = await pauseDaemon(config.port, preset));
  } catch {
    throw new Error(
      `daemon not running on 127.0.0.1:${config.port} — nothing to pause`,
    );
  }
  if (pausedUntil !== undefined) {
    const at = new Date(pausedUntil).toLocaleString([], {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
    console.log(green(`snoozed until ${at} — Slack status cleared; sessions are still tracked`));
    return;
  }
  console.log(green("paused — Slack status cleared; sessions are still tracked"));
}

export async function runResume(): Promise<void> {
  const config = loadConfigSafe();
  try {
    await resumeDaemon(config.port);
  } catch {
    throw new Error(
      `daemon not running on 127.0.0.1:${config.port} — nothing to resume`,
    );
  }
  console.log(green("resumed — status updates active"));
}

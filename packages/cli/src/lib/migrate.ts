import fs from "node:fs";
import path from "node:path";
import { configDir, legacyConfigDir, legacyStateDir, stateDir } from "./paths";

/**
 * Files carried over from the pre-rename directories (~/.config/agentblip,
 * ~/.local/state/agentblip): the config with its Slack and hub pairings, the
 * daemon secret (so a daemon started before the rename still answers), and
 * the ownership state (so a displaced Slack status is still restored). The
 * pidfile, lock, log and start-failure marker are runtime-only and start fresh.
 */
const CARRIED: ReadonlyArray<{ dir: "config" | "state"; name: string }> = [
  { dir: "config", name: "config.json" },
  { dir: "state", name: "daemon.secret" },
  { dir: "state", name: "ownership.json" },
];

export interface MigrationDirs {
  configDir: string;
  stateDir: string;
  legacyConfigDir: string;
  legacyStateDir: string;
}

function defaultDirs(): MigrationDirs {
  return {
    configDir: configDir(),
    stateDir: stateDir(),
    legacyConfigDir: legacyConfigDir(),
    legacyStateDir: legacyStateDir(),
  };
}

/**
 * Copies each carried file whose new copy is missing and whose old copy
 * exists. The old file stays where it was, as a backup. Copies keep the old
 * file's permission bits, never wider than 0600 (they hold tokens). A copy
 * goes through a temp file and a hard link, so concurrent hooks never see a
 * half-written config and never overwrite a file another process just wrote.
 *
 * Runs on every CLI start, hooks included: once migrated, it costs one stat
 * per file. Never throws: a failed copy leaves the old file where it was, and
 * the next run tries again.
 *
 * Returns the new paths it wrote.
 */
export function migrateLegacyDirs(dirs: MigrationDirs = defaultDirs()): string[] {
  const copied: string[] = [];
  for (const file of CARRIED) {
    const to = path.join(file.dir === "config" ? dirs.configDir : dirs.stateDir, file.name);
    if (fs.existsSync(to)) continue;
    const from = path.join(file.dir === "config" ? dirs.legacyConfigDir : dirs.legacyStateDir, file.name);
    try {
      if (copyNoClobber(from, to)) copied.push(to);
    } catch {
      // best effort; the old file is untouched
    }
  }
  return copied;
}

function copyNoClobber(from: string, to: string): boolean {
  let mode: number;
  try {
    const stat = fs.statSync(from);
    if (!stat.isFile()) return false;
    mode = stat.mode & 0o600 || 0o600;
  } catch {
    return false; // nothing to carry
  }
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  const tmp = `${to}.migrating-${process.pid}`;
  try {
    fs.copyFileSync(from, tmp);
    fs.chmodSync(tmp, mode);
    fs.linkSync(tmp, to); // EEXIST when another process got there first
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

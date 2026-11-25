import fs from "node:fs";

/**
 * Helpers shared by the Claude Code and Codex hook installers: timestamped
 * backups, removing only our entries from a hooks object, and reading the
 * Node binary a hook command pins.
 */

/** `20261125T103000123Z`: sortable, no characters a filesystem dislikes. */
export function backupStamp(now = new Date()): string {
  return now.toISOString().replace(/[-:.]/g, "");
}

/**
 * Writes `original` next to `file` as `<file>.workmesh-backup-<stamp>`, a new
 * file each time, so the newest backup is always the state just before this
 * change. Returns its path.
 */
export function writeBackup(file: string, original: string, now = new Date()): string {
  const base = `${file}.workmesh-backup-${backupStamp(now)}`;
  let backup = base;
  for (let i = 1; fs.existsSync(backup); i++) backup = `${base}-${i}`;
  fs.writeFileSync(backup, original);
  return backup;
}

/**
 * Removes every hook whose command `isOurs` matches from a Claude-Code-style
 * hooks object (`{ Event: [{ matcher?, hooks: [{ command }] }] }`), in place.
 * Other tools' hooks stay exactly as they were; an entry left with no hooks,
 * and an event left with no entries, are dropped only when we emptied them.
 * Returns how many hooks were removed.
 */
export function removeOurHooks(hooks: Record<string, unknown>, isOurs: (command: unknown) => boolean): number {
  let removed = 0;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    let touched = false;
    const kept = entries.filter((entry: unknown) => {
      const list = (entry as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(list)) return true;
      const rest = list.filter((hook: unknown) => !isOurs((hook as { command?: unknown } | null)?.command));
      if (rest.length === list.length) return true;
      removed += list.length - rest.length;
      touched = true;
      if (rest.length === 0) return false;
      (entry as { hooks: unknown[] }).hooks = rest;
      return true;
    });
    if (!touched) continue;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  return removed;
}

/** The binary a hook command runs: its first quoted word (`"/path/node" "/path/index.js" hook …`). */
export function hookNodePath(command: string): string | undefined {
  return /^"([^"]+)"/.exec(command.trim())?.[1];
}

/** True when a Node binary sits in a version manager's tree (nvm, fnm, Volta, asdf, mise, n): lib/node-path.ts. */
export { versionManagedNode } from "./node-path";

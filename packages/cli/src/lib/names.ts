/**
 * Workmesh shipped as agentblip until 0.7 (and briefly as crewblip). These
 * former names are read, never written: hook commands installed under them are
 * recognised as ours and repointed, their config and state directories are
 * copied across once (lib/migrate.ts), and their env vars still work as
 * fallbacks.
 */

/** Directory name under XDG config/state, and the command. */
export const APP_NAME = "workmesh";

/** Directory name and env var prefix used before the rename. */
export const LEGACY_APP_NAME = "agentblip";

/** A hook command written by this tool under any of its names. */
export const OUR_COMMAND_RE = /workmesh|agentblip|crewblip/;

/** `WORKMESH_<key>`, falling back to the pre-rename `AGENTBLIP_<key>`. Empty counts as unset. */
export function envSetting(key: string): string | undefined {
  return process.env[`WORKMESH_${key}`] || process.env[`AGENTBLIP_${key}`] || undefined;
}

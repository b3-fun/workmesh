import { execFile } from "node:child_process";
import fs from "node:fs";
import { HUB_GITHUB_LOGIN_RE } from "@workmesh/protocol";

/**
 * v0.6 avatars (docs/SPEC.md §15): the person's GitHub login as the local `gh`
 * CLI reports it (`gh api user --jq .login`), read at `hub connect` and at
 * daemon start with a short timeout. Nothing else from `gh` is read or kept.
 * Undefined when `gh` is missing, not logged in, slow, or answers something
 * that isn't a login.
 */

/** Where `gh` usually lives; a daemon started from a GUI app may not have it on PATH. */
const GH_CANDIDATES = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];

export type ExecFn = (file: string, args: string[], timeoutMs: number) => Promise<string>;

const defaultExec: ExecFn = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });

export async function readGithubLogin(opts: { timeoutMs?: number; exec?: ExecFn; candidates?: string[] } = {}): Promise<string | undefined> {
  const exec = opts.exec ?? defaultExec;
  const timeoutMs = opts.timeoutMs ?? 5000;
  for (const bin of opts.candidates ?? GH_CANDIDATES) {
    if (bin.startsWith("/") && !fs.existsSync(bin)) continue;
    try {
      const out = (await exec(bin, ["api", "user", "--jq", ".login"], timeoutMs)).trim();
      return HUB_GITHUB_LOGIN_RE.test(out) ? out : undefined;
    } catch (err) {
      // Not found on PATH: try the next place. Found but failed (not logged in, offline, slow): stop.
      if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") continue;
      return undefined;
    }
  }
  return undefined;
}

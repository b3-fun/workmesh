import { execFile } from "node:child_process";
import { findBin } from "./handoff-runner";

/**
 * v2 wake for Codex (docs/SPEC.md §31): a message for an idle Codex thread goes in through Codex's own queue,
 * `codex queue --thread <id> --message <text>`. Verified on codex-cli 0.164.0: it exits 0 within ~0.2 s without
 * waiting for a turn; a thread an idle TUI holds starts a turn with it within a few seconds; a thread nobody holds
 * keeps it until it is resumed (next-turn delivery). An unknown thread exits 1 and the message stays in Workmesh's
 * inbox for the next tool boundary.
 */

/**
 * The text `codex queue` delivers: the wake inside a `<workmesh-wake>` block. Codex hands a queued message to the
 * thread as a user prompt (its UserPromptSubmit hook sees it as one), so without the wrapper the board showed
 * Workmesh's notice as something the person typed (live, 11-25). The tag is injected markup by SPEC §19's rule (a
 * lowercase hyphenated tag at the start), so the hook maps the turn to `InjectedPrompt` and no prompt is sent.
 */
export function codexWakeMessage(text: string): string {
  return `<workmesh-wake>\n${text.replace(/<\/workmesh-wake>/gi, "</workmesh-wake_>")}\n</workmesh-wake>`;
}

export type ExecFileLike = (
  file: string,
  args: string[],
  opts: { timeout: number; env?: NodeJS.ProcessEnv },
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

export function codexWaker(
  opts: {
    bin?: () => string | undefined;
    exec?: ExecFileLike;
    log?: (m: string) => void;
    /** The Codex home a thread lives in (from its rollout path), when it isn't the daemon's own. */
    homeOf?: (threadId: string) => string | undefined;
  } = {},
) {
  const exec: ExecFileLike =
    opts.exec ??
    ((file, args, o, cb) => {
      execFile(
        file,
        args,
        { timeout: o.timeout, encoding: "utf8", maxBuffer: 256 * 1024, ...(o.env ? { env: o.env } : {}) },
        (err, stdout, stderr) => cb(err, String(stdout ?? ""), String(stderr ?? "")),
      );
    });
  return (threadId: string, text: string): Promise<boolean> => {
    const bin = (opts.bin ?? (() => findBin("codex")))();
    if (!bin || !/^[\w-]{8,64}$/.test(threadId)) return Promise.resolve(false);
    // `codex queue` reaches the app server of one Codex home: the thread's, which a launchd daemon's env may not name.
    const home = opts.homeOf?.(threadId);
    const env = home ? { ...process.env, CODEX_HOME: home } : undefined;
    return new Promise((resolve) => {
      exec(bin, ["queue", "--thread", threadId, "--message", codexWakeMessage(text)], { timeout: 15_000, ...(env ? { env } : {}) }, (err, _out, stderr) => {
        if (err) opts.log?.(`codex queue for ${threadId.slice(0, 8)} failed: ${(stderr || err.message).trim().split("\n").pop()?.slice(0, 160)}`);
        resolve(!err);
      });
    });
  };
}

import { execFile } from "node:child_process";
import { findBin } from "./handoff-runner";

/**
 * v2 wake for Codex (docs/SPEC.md §31): a message for an idle Codex thread goes in through Codex's own queue,
 * `codex queue --thread <id> --message <text>`. Verified on codex-cli 0.164.0: it exits 0 within ~0.2 s without
 * waiting for a turn; a thread an idle TUI holds starts a turn with it within a few seconds; a thread nobody holds
 * keeps it until it is resumed (next-turn delivery). An unknown thread exits 1 and the message stays in Workmesh's
 * inbox for the next tool boundary.
 */

export type ExecFileLike = (
  file: string,
  args: string[],
  opts: { timeout: number },
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

export function codexWaker(opts: { bin?: () => string | undefined; exec?: ExecFileLike; log?: (m: string) => void } = {}) {
  const exec: ExecFileLike =
    opts.exec ??
    ((file, args, o, cb) => {
      execFile(file, args, { timeout: o.timeout, encoding: "utf8", maxBuffer: 256 * 1024 }, (err, stdout, stderr) =>
        cb(err, String(stdout ?? ""), String(stderr ?? "")),
      );
    });
  return (threadId: string, text: string): Promise<boolean> => {
    const bin = (opts.bin ?? (() => findBin("codex")))();
    if (!bin || !/^[\w-]{8,64}$/.test(threadId)) return Promise.resolve(false);
    return new Promise((resolve) => {
      exec(bin, ["queue", "--thread", threadId, "--message", text], { timeout: 15_000 }, (err, _out, stderr) => {
        if (err) opts.log?.(`codex queue for ${threadId.slice(0, 8)} failed: ${(stderr || err.message).trim().split("\n").pop()?.slice(0, 160)}`);
        resolve(!err);
      });
    });
  };
}

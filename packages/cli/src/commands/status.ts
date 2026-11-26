import { loadConfigSafe } from "../lib/config";
import { getState } from "../lib/daemon-client";
import type { DaemonState } from "../lib/daemon-client";
import { bold, dim, formatDuration, renderTable, yellow } from "../lib/ui";
import { updateNotice } from "./update";

export interface StatusOptions {
  json?: boolean;
}

export async function runStatus(opts: StatusOptions): Promise<void> {
  const config = loadConfigSafe();
  let state: DaemonState;
  try {
    state = await getState(config.port);
  } catch {
    const error = `daemon not running on 127.0.0.1:${config.port} — start it with \`workmesh start --detach\``;
    if (opts.json) console.log(JSON.stringify({ ok: false, error }));
    else {
      console.log(
        `${yellow("daemon not running")} on 127.0.0.1:${config.port} — start it with ${bold("workmesh start --detach")}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  // 0.12 (SPEC §41): a newer Workmesh, as the daemon last heard (from the hub, else npm): offered, or still inside
  // the waiting time; and a menu bar release that failed the signing check.
  const notice = await updateNotice(config.port);
  if (opts.json) {
    const { text: _text, ...update } = notice ?? { text: "" };
    console.log(JSON.stringify({ ok: true, ...state, ...(notice ? { update } : {}) }, null, 2));
    return;
  }

  if (state.paused) {
    console.log(
      yellow(
        state.pausedUntil
          ? `snoozed — status updates resume in ${formatDuration(state.pausedUntil - Date.now())} (or \`workmesh resume\`)`
          : "paused — status updates suspended (`workmesh resume`)",
      ),
    );
  }
  if (state.ownership?.backedOff) {
    console.log(
      yellow(
        bold(
          "standing down — your existing Slack status is untouched; Workmesh resumes when it clears",
        ),
      ),
    );
  }
  if (state.lastError) {
    console.log(yellow(`sink error: ${state.lastError}`));
  }
  const formatted = state.formatted;
  if (formatted) {
    const expires = formatted.expirationSec
      ? dim(` (expires in ${formatDuration(formatted.expirationSec * 1000 - Date.now())})`)
      : "";
    console.log(`would set: ${formatted.emoji} ${bold(formatted.text)}${expires}`);
  } else {
    console.log(`would set: ${dim("(clear — no active sessions)")}`);
  }

  console.log("");
  if (state.snapshot.sessions.length === 0) {
    console.log(dim("no live agent sessions"));
    if (notice) console.log(`\n${notice.text}`);
    return;
  }
  const rows = state.snapshot.sessions.map((s) => [
    s.source,
    s.state,
    s.activity ?? "—",
    s.project ?? "—",
    `${formatDuration(Date.now() - s.updatedAt)} ago`,
  ]);
  console.log(renderTable(["SOURCE", "STATE", "ACTIVITY", "PROJECT", "UPDATED"], rows));
  if (notice) console.log(`\n${notice.text}`);
}

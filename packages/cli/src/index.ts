import { Command } from "commander";
import pkg from "../package.json";
import {
  runApprovals,
  runClaim,
  runClaims,
  runGates,
  runHandoff,
  runHandoffs,
  runInbox,
  runLease,
  runLeases,
  runMcp,
  runNote,
  runNotes,
  runSend,
  runUnlease,
  runWhoami,
  runAsk,
} from "./commands/coord";
import { runDoctor } from "./commands/doctor";
import { runEmit } from "./commands/emit";
import { runHook } from "./commands/hook";
import { runInit } from "./commands/init";
import { runHandoffPolicy, runRoots } from "./commands/roots";
import { runWake, runWakeWait } from "./commands/wake";
import {
  EXAMPLE_HUB_URL,
  runHubConnect,
  runHubDisconnect,
  runHubExclude,
  runHubInclude,
  runHubShare,
  runHubStatus,
  runHubSticky,
} from "./commands/hub";
import { runPause, runResume } from "./commands/pause";
import { runReport } from "./commands/report";
import { runSetup } from "./commands/setup";
import { runServiceInstall, runServiceStatus, runServiceUninstall } from "./commands/service";
import { runRestart, runStart } from "./commands/start";
import { runStatus } from "./commands/status";
import { runStop } from "./commands/stop";
import { runUninstall } from "./commands/uninstall";
import { runUnlink } from "./commands/unlink";
import { migrateLegacyDirs } from "./lib/migrate";
import { errorMessage, red } from "./lib/ui";

function wrap<A extends unknown[]>(
  fn: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(red(`error: ${errorMessage(err)}`));
      process.exitCode = 1;
    }
  };
}

// Carry config and state over from the pre-rename agentblip directories once.
migrateLegacyDirs();

const program = new Command();

program
  .name("workmesh")
  .description("Your coding agents, live on your team's board and in your Slack status.")
  .version(pkg.version);

program
  .command("init")
  .description("Set this machine up for a team hub in one go: hooks, MCP tools, the daemon, and pairing (safe to run again)")
  .argument("<hub-url>", `the team's hub, e.g. ${EXAMPLE_HUB_URL}`)
  .option("--share <level>", "conversation | metadata (asked when omitted in a terminal)")
  .option("--codex", "install Codex hooks even when no Codex install is found")
  .option("--no-codex", "leave Codex's files alone")
  .option("--no-open", "print the approve link without opening a browser")
  .option("--machine <name>", "name this machine on the board (default: hostname)")
  .option("--claude-dir <path>", "Claude Code config dir to hook (default: $CLAUDE_CONFIG_DIR, else ~/.claude)")
  .option("--no-mcp", "don't register the workmesh MCP server")
  .option("--no-service", "run the daemon in the background, not under launchd / systemd")
  .option("--no-wake", "don't install the hook that wakes idle sessions for messages")
  .option("--repair", "pair again even if this machine is already paired with the hub")
  .action(wrap((url: string, opts: Parameters<typeof runInit>[1]) => runInit(url, opts)));

program
  .command("setup")
  .description("Connect Slack, pick a privacy level, and install agent hooks")
  .option(
    "--relay-url <url>",
    "relay to pair with (self-hosters: your own Worker URL)",
  )
  .option("--hooks-only", "only install or refresh agent hooks and the MCP server (no prompts, config untouched)")
  .option("--claude-dir <path>", "Claude Code config dir to hook (default: $CLAUDE_CONFIG_DIR, else ~/.claude)")
  .option("--codex", "install Codex hooks even when no Codex install is found")
  .option("--no-codex", "leave Codex's files alone")
  .option("--no-mcp", "don't register the workmesh MCP server with Claude Code and Codex")
  .option("--no-service", "don't run the daemon under launchd / systemd")
  .option("--no-wake", "don't install the hook that wakes idle sessions for messages")
  .action(wrap(runSetup));

const service = program
  .command("service")
  .description("Run the daemon under launchd (macOS) or systemd --user (Linux), so it comes back after a crash, kill or reboot");

service
  .command("install")
  .description("Install (or refresh) the daemon service and start it; stops a daemon running outside it first")
  .action(wrap(async () => {
    if (!(await runServiceInstall())) process.exitCode = 1;
  }));

service
  .command("uninstall")
  .description("Stop the daemon service and remove it (hooks start a daemon as before)")
  .action(wrap(runServiceUninstall));

service
  .command("status")
  .description("Whether the daemon service is installed, loaded and running")
  .option("--json", "machine-readable output")
  .action(wrap(runServiceStatus));

program
  .command("uninstall")
  .description("Remove Workmesh's hooks and MCP server from Claude Code and Codex, and its daemon service, keeping every other hook (backs up each file)")
  .option("--claude-dir <path>", "Claude Code config dir to unhook (default: $CLAUDE_CONFIG_DIR, else ~/.claude)")
  .option("--no-codex", "leave Codex's files alone")
  .option("--no-service", "keep the daemon service (launchd / systemd) installed")
  .action(wrap(runUninstall));

program
  .command("start")
  .description("Run the sync daemon (foreground unless --detach)")
  .option("-d, --detach", "run the daemon in the background")
  .action(wrap(runStart));

program
  .command("stop")
  .description("Stop the background daemon and wait for it to exit (clears your Slack status)")
  .action(wrap(async () => {
    await runStop();
  }));

program
  .command("restart")
  .description("Stop the daemon, wait for it to exit, and start it again in the background")
  .action(wrap(runRestart));

program
  .command("status")
  .description("Show live agent sessions and the status Workmesh would set")
  .option("--json", "machine-readable output")
  .action(wrap(runStatus));

program
  .command("emit")
  .description("Send a custom session event to the daemon")
  .option("--source <source>", "event source id", "custom")
  .option("--session-id <id>", "session identifier", "manual")
  .option("--kind <kind>", "start | working | waiting | idle | heartbeat | end")
  .option("--state <state>", "alias for --kind (working | waiting | idle)")
  .option("--activity <text>", "short activity label")
  .option("--project <name>", "project name")
  .option("--agents <n>", "concurrent agents this session represents")
  .option("--phase <label>", "orchestrator phase label")
  .action(wrap(runEmit));

program
  .command("report")
  .description("Report a fan-out of concurrent agents (workflows, CI) so \"N agents working\" is accurate")
  .option("--id <id>", "run/session id (one per concurrent fleet)", "run")
  .option("--source <source>", "event source id", "workflow")
  .option("--agents <n>", "number of concurrent agents", "1")
  .option("--phase <label>", "current phase, e.g. \"verify\" or \"2/4\"")
  .option("--activity <text>", "short activity label")
  .option("--project <name>", "project name")
  .option("--done", "clear this report (the fleet finished)")
  .action(wrap(runReport));

program
  .command("hook")
  .description("Adapter entrypoint for agent hooks — never fails the host session")
  .argument("<source>", "claude-code | codex-hooks | codex (notify) | custom")
  .argument("[payload]", "JSON payload (Codex notify passes it as an argument)")
  .action(runHook); // handles its own errors and always exits 0

program
  .command("pause")
  .description("Pause status updates and clear your Slack status")
  .option("--for <length>", "snooze, then resume on its own: 30m | 1h | tomorrow (9 AM)")
  .action(wrap(runPause));

program
  .command("resume")
  .description("Resume status updates")
  .action(wrap(runResume));

program
  .command("unlink")
  .description("Revoke this device on the relay and remove the saved token")
  .action(wrap(runUnlink));

const hub = program
  .command("hub")
  .description("Show your agent sessions on a team hub (the Workmesh board), from repos you share: metadata, or the conversation too");

hub
  .command("connect")
  .description("Pair this machine with a hub (device code, approved in the browser)")
  .argument("<url>", `hub URL, e.g. ${EXAMPLE_HUB_URL}`)
  .option("--no-open", "print the approve link without opening a browser")
  .option("--machine <name>", "name this machine on the board (default: hostname)")
  .option("--share <level>", "conversation | metadata (asked when omitted in a terminal)")
  .action(wrap(runHubConnect));

hub
  .command("share")
  .description("Show or set what this machine shares: conversation (prompts, agent text, redacted) or metadata")
  .argument("[level]", "conversation | metadata")
  .action(wrap(runHubShare));

hub
  .command("sticky")
  .description("Show or set whether a session stays shared after it touches a shared repo (on, the default) or is shared turn by turn (off)")
  .argument("[value]", "on | off")
  .action(wrap(runHubSticky));

hub
  .command("status")
  .description("Pairing, project, last send, queued and dropped events, shared sessions")
  .option("--json", "machine-readable output")
  .action(wrap(runHubStatus));

hub
  .command("disconnect")
  .description("Stop forwarding and remove the hub token from this machine")
  .action(wrap(runHubDisconnect));

hub
  .command("include")
  .description("Also share sessions and files under a directory")
  .argument("<dir>", "directory (absolute, relative, or ~/…)")
  .action(wrap(runHubInclude));

hub
  .command("exclude")
  .description("Never share anything under a directory, whatever its git remote")
  .argument("<dir>", "directory (absolute, relative, or ~/…)")
  .action(wrap(runHubExclude));

// v1 Coordinate (SPEC §21, §23): through the daemon, which holds the hub token. Inside an agent session (its Bash),
// these speak for that session; at a terminal, for you.
program
  .command("leases")
  .description("Active file leases on your team: who holds which paths, for how long")
  .option("--repo <owner/name>", "only this repo")
  .option("--json", "machine-readable output")
  .action(wrap(runLeases));

program
  .command("lease")
  .description("Lease files, directories or globs for this agent session (edits by other sessions are refused)")
  .argument("<paths...>", "paths or globs, absolute or relative to this directory")
  .option("--reason <text>", "what you're doing, shown to teammates")
  .option("--minutes <n>", "how long (1-240, default 30)")
  .option("--repo <owner/name>", "the repo, when the paths are repo-relative")
  .option("--json", "machine-readable output")
  .action(wrap(runLease));

program
  .command("unlease")
  .description("Release this agent session's leases (the paths given, or all of them)")
  .argument("[paths...]", "paths you leased")
  .option("--id <leaseId>", "one lease")
  .option("--repo <owner/name>", "only this repo")
  .option("--json", "machine-readable output")
  .action(wrap(runUnlease));

program
  .command("claims")
  .description("Linear issues claimed by your team's agents")
  .option("--json", "machine-readable output")
  .action(wrap(runClaims));

program
  .command("claim")
  .description("Claim a Linear issue for this agent session (--release to let it go)")
  .argument("<issue>", "e.g. B3-123")
  .option("--note <text>", "what you're doing on it")
  .option("--release", "release the claim instead")
  .option("--json", "machine-readable output")
  .action(wrap(runClaim));

program
  .command("send")
  .description("Message a teammate or their agent (delivered at its next tool call)")
  .argument("<to>", "a person (name, email or GitHub login), an agent's session name, or a hub session key")
  .argument("<text...>", "the message")
  .option("--kind <kind>", "person | agent | session, when <to> is ambiguous")
  .option("--thread <id>", "reply in a thread")
  .option("--json", "machine-readable output")
  .action(wrap(runSend));

program
  .command("inbox")
  .description("Messages waiting for this machine's agents (or, inside an agent session, for that session)")
  .option("--json", "machine-readable output")
  .action(wrap(runInbox));

program
  .command("note")
  .description("Leave a note every teammate's agent can read")
  .argument("<text...>", "the note")
  .option("--tag <tag...>", "one-word tags")
  .option("--json", "machine-readable output")
  .action(wrap(runNote));

program
  .command("notes")
  .description("Your team's newest shared notes")
  .option("--tag <tag>", "only this tag")
  .option("--json", "machine-readable output")
  .action(wrap(runNotes));

program
  .command("ask")
  .description("Ask the team board about teammates' agents, in plain words (read-only)")
  .argument("<question...>", "e.g. what is An's agent doing on B3-7167?")
  .option("--json", "machine-readable output")
  .action(wrap(runAsk));

program
  .command("whoami")
  .description("Who you are on the team hub, and which agent session this is")
  .option("--json", "machine-readable output")
  .action(wrap(runWhoami));

// v2 Delegate (SPEC §31): handoffs, approval gates, waking idle sessions.
program
  .command("handoff")
  .description("Hand a task to a teammate (or `me`: one of your other machines); their machine starts an agent for it once they accept")
  .argument("<to>", "a person (name, email or GitHub login), or me")
  .argument("<task...>", "what to do")
  .option("--repo <owner/name>", "the repo (default: this directory's)")
  .option("--issue <id>", "a Linear issue, e.g. B3-123")
  .option("--context <text>", "anything else the agent should know")
  .option("--json", "machine-readable output")
  .action(wrap(runHandoff));
const handoffs = program
  .command("handoffs")
  .description("Handoffs offered to you and sent by you; accept or decline one")
  .argument("[action]", "list | accept | decline")
  .argument("[id]", "the handoff, for accept and decline")
  .option("--note <text>", "why (decline)")
  .option("--json", "machine-readable output")
  .action(wrap(runHandoffs));
handoffs
  .command("policy")
  .description("Which handoffs this machine takes without a click: auto-self (default), ask, never")
  .argument("[policy]", "auto-self | ask | never")
  .action(wrap(runHandoffPolicy));
program
  .command("roots")
  .description("Where your repos live, so a handoff finds its checkout here (repos your sessions worked in count too)")
  .argument("[action]", "list | add | remove")
  .argument("[dir]", "a directory (absolute, relative, or ~/…)")
  .action(wrap(runRoots));
program
  .command("gates")
  .description("Approval gates on your own agents: they ask before they merge, deploy, publish, force-push or spend")
  .argument("[action]", "list | set | off (or a list, e.g. merge,deploy)")
  .argument("[gates]", "for set: merge,deploy,publish,force_push,spend,custom")
  .option("--json", "machine-readable output")
  .action(wrap(runGates));
program
  .command("approvals")
  .description("Approvals your agents asked for, and ones you can decide; approve or deny one")
  .argument("[action]", "list | approve | deny")
  .argument("[id]", "the approval, for approve and deny")
  .option("--note <text>", "why (shown to the agent)")
  .option("--json", "machine-readable output")
  .action(wrap(runApprovals));
program
  .command("wake")
  .description("Show or set whether an idle session wakes for a message, an approval or a handoff result (on by default)")
  .argument("[value]", "on | off")
  .action(wrap(runWake));
program
  .command("wake-wait", { hidden: true })
  .description("Claude Code asyncRewake Stop hook: wait for this session's next message (never fails the session)")
  .argument("<source>", "claude-code")
  .action(runWakeWait);

program
  .command("mcp")
  .description("Serve the team coordination tools over MCP (stdio), for Claude Code and Codex")
  .action(wrap(runMcp));

program
  .command("doctor")
  .description("Check config, daemon, relay, and hook installs")
  .option("--json", "machine-readable output")
  .option("--claude-dir <path>", "Claude Code config dir to check (default: $CLAUDE_CONFIG_DIR, else ~/.claude)")
  .action(wrap(runDoctor));

await program.parseAsync(process.argv);

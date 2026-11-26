# Config and environment

Workmesh keeps its settings in one JSON file, `~/.config/workmesh/config.json` (`$XDG_CONFIG_HOME/workmesh/config.json`
when that is set), mode `0600` because it holds your device tokens. `workmesh init`, `setup` and the `hub`, `handoffs`,
`roots`, `gates`, `wake` and `update --auto` commands write it for you; prefer them to editing by hand. After a hand
edit, run `workmesh restart`. The menu bar app changes `granularity`, `statusPolicy`, `showProject` and `repoPrefix` on
the running daemon without a restart.

The schema is `configSchema` in `packages/cli/src/lib/config.ts`. `npm run docs:ref:check` fails when a key there is
missing from this page.

## Team hub

Written by `workmesh hub connect` (or `init`). Don't copy this section between machines: each machine pairs on its own.

| Key | Default | What it is |
|---|---|---|
| `hub` | absent | Present once this machine is paired. A malformed section reads as "not paired". |
| `hub.url` | | The hub, e.g. `https://workmesh.b3os.org`. |
| `hub.deviceId` | | This machine's device id on the hub. |
| `hub.deviceToken` | | The token the daemon sends with every hub request. Treat it as a password. |
| `hub.machine` | hostname | The name the board shows (`init --machine`). |
| `hub.person` | | Who approved the pairing: `hub.person.name` and `hub.person.email`. |
| `hub.person.name` | | Your name on the board. |
| `hub.person.email` | | The login that approved the pairing. |
| `hub.project` | | The project and its sharing rule, as the hub sent it at pairing (B3: repos whose origin contains `github.com/b3-fun/`). |
| `hub.includeDirs` | `[]` | Folders shared on top of the rule (`workmesh hub include <dir>`). |
| `hub.excludeDirs` | `[]` | Folders never shared, whatever their remote (`workmesh hub exclude <dir>`). |
| `hub.pairedAt` | | When it paired (ms since epoch). |
| `hub.share` | `conversation` | `conversation` or `metadata` (`workmesh hub share <level>`). Absent means `conversation`. |
| `hub.stickyShare` | `true` | Whether a session stays shared once it touches a shared repo (`workmesh hub sticky on\|off`). |
| `hub.github` | | Your GitHub login, read from `gh` at pairing, for your avatar. |

## Delegation, gates, wake and updates

| Key | Default | What it is |
|---|---|---|
| `handoffs` | absent | Handoff settings for this machine. Absent means the defaults below. |
| `handoffs.accept` | `ask` | `ask` waits for your Accept on every handoff, your own too. `auto-self` starts handoffs you sent yourself with no click and waits on teammates'. It trusts every machine and token of yours: each of them, and any agent running there, can start an agent on this machine. `never` runs none here (`workmesh handoffs policy`). |
| `handoffs.runAccepted` | `confirm` | What this machine does with a handoff that was accepted somewhere else, such as on the board. `confirm`: it waits here until you say "run it here" (`workmesh handoffs run <id>`, or the menu bar). `auto`: this machine starts it. `auto` trusts the hub's word that you accepted it. |
| `handoffs.agent` | `claude` when found, else `codex` | The agent CLI that runs a handoff. |
| `handoffs.roots` | `[]` | Folders whose git repos count as checkouts for handoffs (`workmesh roots add <dir>`). |
| `handoffs.worktree` | `true` | Run each handoff in a new git worktree on its own branch. |
| `handoffs.maxRunning` | `2` | Handoffs running at once on this machine (0 to 10). |
| `handoffs.permissionMode` | `auto` | Claude Code `--permission-mode` for a handoff's session. The default stays `auto`: `acceptEdits` can't commit in a headless run, and you read the whole handoff and see the mode before you accept. |
| `handoffs.env` | `[]` | Environment variables a handoff's agent gets although their names look like secrets, for example `["GH_TOKEN"]`. The agent starts without such variables, except what its own tool signs in with. The run's log names what was left out. |
| `handoffs.model` | the agent's default | The model a handoff runs on, e.g. `sonnet`. |
| `handoffs.maxMinutes` | `120` | How long a handoff run may take (5 to 1440). |
| `wake` | `true` | Wake an idle session when a message, approval or handoff result arrives for it (`workmesh wake on\|off`). |
| `gates` | absent | Your own patterns for the `custom` approval gate. The gates themselves live on the hub (`workmesh gates set …`). |
| `gates.custom` | `[]` | Case-insensitive regexes over a shell command, up to 50. |
| `update` | absent | Updates the daemon installs on its own. Absent means off. |
| `update.auto` | `false` | `workmesh update --auto on\|off`. |
| `update.scope` | `patch` | `patch` takes 0.12.0 to 0.12.3; `minor` (`--auto on --minor`) takes 0.13.0 too. Never a new major. |

## Daemon and agents

| Key | Default | What it is |
|---|---|---|
| `port` | `4519` | The daemon's loopback port. |
| `autoStartDaemon` | `true` | A hook starts the daemon when it isn't running (a failed start waits 60 s before the next try). |
| `adapters` | all on | Which sources the daemon watches. |
| `adapters.claudeCode` | | Claude Code sessions and workflow journals. |
| `adapters.claudeCode.enabled` | `true` | |
| `adapters.claudeCode.configDir` | `$CLAUDE_CONFIG_DIR`, else `~/.claude` | The Claude Code profile the daemon reads (`setup --claude-dir`). |
| `adapters.codex` | | Codex session logs (a fallback for Codex builds without hooks). |
| `adapters.codex.enabled` | `true` | |
| `adapters.codex.sessionsDir` | `~/.codex/sessions` | |
| `adapters.workflow` | | Live agent counts for Claude Code workflow runs. |
| `adapters.workflow.enabled` | `true` | |
| `adapters.workflow.projectsDir` | `~/.claude/projects` | |

## Slack status

Only used when you set up a Slack status with `workmesh setup`. A machine set up with `init` alone has `mode`
`console`: nothing goes to Slack. See [Slack status](../guide/slack-status.md).

| Key | Default | What it is |
|---|---|---|
| `mode` | `console` | `relay` (through agentblip.com or your own relay), `slack` (your own Slack app's user token, no server) or `console` (no Slack). |
| `relayUrl` | `https://agentblip.com` | The Slack-status relay in `relay` mode. |
| `deviceToken` | | The relay's device token, from `setup`. |
| `slackToken` | | Your Slack user token in `slack` mode. |
| `granularity` | `count` | How much the status says: `off`, `presence`, `count` or `activity`. |
| `statusPolicy` | `respect` | `respect` never overwrites a status Workmesh didn't set; `overwrite` replaces it and puts it back after. |
| `showProject` | `false` | Append the project name. |
| `repoPrefix` | `true` | In `activity` mode, lead with the repo name. |
| `statusTtlSec` | `300` | Slack clears the status this many seconds after the last push (0: never). |
| `debounceMs` | `10000` | Minimum time between Slack pushes. |
| `templates` | | Status text, with `{agent}`, `{activity}`, `{project}`, `{working}`, `{total}` and `{waiting}` placeholders. |
| `templates.presence` | `heads down with agents` | |
| `templates.workingOne` | `{agent} agent working` | |
| `templates.workingMany` | `{working} agents working` | |
| `templates.waitingSuffix` | ` · {waiting} waiting on me` | |
| `templates.activityOne` | `{agent}: {activity}` | |
| `templates.activityMany` | `{working} agents · {activity}` | |
| `templates.repoActivityOne` | `{project}: {activity}` | |
| `templates.repoActivityMany` | `{working} agents · {project}: {activity}` | |
| `templates.waitingOnly` | `{waiting} agent(s) waiting on me` | |
| `emoji` | | Status emoji in Slack's `:name:` form. |
| `emoji.working` | `:robot_face:` | |
| `emoji.waiting` | `:raised_hand:` | |
| `redactPatterns` | | Strings or regexes scrubbed from the Slack status text (case-insensitive). |
| `hideProjects` | | Projects that still count toward "N agents working" but never name themselves in the status. |

`redactPatterns` and `hideProjects` apply to the Slack status. What reaches the team hub is redacted separately, on
your machine, by fixed rules: see [Sharing and privacy](../guide/sharing-and-privacy.md).

## Environment variables

| Variable | What it does |
|---|---|
| `WORKMESH_PORT` | The daemon port, over `port` in the config. |
| `WORKMESH_RELAY_URL` | The Slack-status relay, over `relayUrl`. |
| `WORKMESH_TOKEN` | The relay device token, over `deviceToken`. |
| `WORKMESH_STATUS_POLICY` | `respect` or `overwrite`, over `statusPolicy`. |
| `WORKMESH_NO_SERVICE` | `1` keeps the daemon out of launchd and systemd (tests, or a machine that runs the daemon its own way). |
| `WORKMESH_LAUNCHD_LABEL` | A launchd label other than `org.npclabs.workmesh.daemon`, for a second, separate install on one Mac (the smoke tests use it). |
| `WORKMESH_REGISTRY` | The npm registry `workmesh update` reads and installs from (else `npm_config_registry`, else npmjs.org). |
| `WORKMESH_RELEASES_URL` | Where the daemon looks up the menu bar app's release (the smoke tests point it at a mock). |
| `CLAUDE_CONFIG_DIR` | The Claude Code profile to hook and read, else `~/.claude`. |
| `CODEX_HOME` | Codex's home, else `~/.codex`. |
| `XDG_CONFIG_HOME`, `XDG_STATE_HOME` | Move `~/.config/workmesh` and `~/.local/state/workmesh`. |
| `NO_COLOR` | Plain output. |

Each `WORKMESH_*` setting above also reads the pre-rename `AGENTBLIP_*` name when the new one is unset.

Set by Workmesh itself, useful when you debug:

| Variable | Where |
|---|---|
| `WORKMESH_SERVICE` | In the daemon's environment when launchd or systemd runs it. |
| `WORKMESH_HANDOFF` | In a handoff run's environment: the handoff id. A session with it is never woken (nobody is there to answer). |

## Files

| Path | What it holds |
|---|---|
| `~/.config/workmesh/config.json` | This page's settings and your tokens (`0600`). |
| `~/.local/state/workmesh/daemon.secret` | The bearer secret for the daemon's loopback API (`0600`). |
| `~/.local/state/workmesh/daemon.log` | The daemon's log when it runs without a service. Under launchd it logs to `~/Library/Logs/workmesh-daemon.log`; under systemd, to the journal (`journalctl --user -u workmesh`). |
| `~/.local/state/workmesh/hub-forward.json` | Shared sessions and unsent events, so a restart loses nothing (`0600`). |
| `~/.local/state/workmesh/update.log`, `update/previous/` | The last `workmesh update` run and the copy it rolls back to. |
| `~/.local/state/workmesh/handoffs/` | Handoff runs on this machine. |
| `~/.local/state/workmesh/handoffs-accepted.json` | The ids of the handoffs that were accepted on this machine (`0600`). Only those are started here. |
| `~/Library/LaunchAgents/org.npclabs.workmesh.daemon.plist` | The daemon service on macOS. |
| `~/.config/systemd/user/workmesh.service` | The daemon service on Linux. |

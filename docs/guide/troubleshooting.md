# Troubleshooting

Start with `workmesh doctor`. Each line that isn't ✓ names its fix; this page explains the cause when the fix isn't
obvious. ✗ means Workmesh isn't working on this machine; `!` means something works less well than it should.

Logs: `~/Library/Logs/workmesh-daemon.log` on a Mac (launchd), `journalctl --user -u workmesh` under systemd, else
`~/.local/state/workmesh/daemon.log`.

## Doctor lines

### Daemon and hub

| Line | Cause | Fix |
|---|---|---|
| ✗ `daemon  not running, so the hub hasn't heard from this machine …` | The daemon is down, so the board shows you offline. The line ends with a cause when it knows one: no systemd user session, lingering off, or no daemon service installed. | `workmesh restart`. For the Linux causes, see [Linux](linux.md). |
| `!` `daemon  not running on 127.0.0.1:4519` | Not paired with a hub and no daemon. | `workmesh init https://workmesh.b3os.org` |
| ✗ `hub forward  the daemon isn't forwarding (it started before this machine paired?)` | The daemon started before the pairing and never read it. | `workmesh restart` |
| ✗ `hub forward  the daemon forwards to … but this machine is paired with …` | The pairing changed under a running daemon. | `workmesh restart` |
| ✗ `hub forward  stopped: … → workmesh init <url>` | The hub rejected this machine's token: it was revoked on the board, or a newer pairing of the same machine replaced it. | `workmesh init https://workmesh.b3os.org` pairs again. |
| `!` `hub forward  retrying: …; the hub last heard from this machine …` | The hub can't be reached: no network, a VPN or proxy blocking workmesh.b3os.org, or the hub is down. Events wait in a queue (up to 5,000) and go when it's back. | Check `curl -sI https://workmesh.b3os.org` from this machine. If the hub is down, nothing to do here. |
| `!` `hub forward  the daemon hasn't reached the hub yet` | It sends within a second of starting. | Run `workmesh doctor` again. |
| `!` `hub sharing  the daemon still shares …` | You changed the level and the running daemon didn't pick it up. | `workmesh restart` |
| `!` `hub forward` / `coordination` / `delegation`  `the running daemon predates …` | The daemon is an older build than the CLI. | `workmesh restart` |
| `!` `coordination  this hub has no leases or messages yet` / `delegation  this hub has no handoffs …` | The hub is older than your CLI. | Nothing; agents work as before. |
| `!` `coordination  not synced with the hub yet` | The first sync hasn't happened. | Wait a few seconds. |
| `!` `hub state  not saved yet` | The daemon writes it once it forwards. | Nothing. |
| `!` `new machine  A new machine joined your Workmesh account: …` | A machine was added to your account in the last day. See [When a machine joins your account](getting-started.md#when-a-machine-joins-your-account). | If it was you: nothing. Dismiss it in the menu bar, or it goes after 24 hours. If it wasn't: revoke the machine on the board (Your machines → Revoke). |

### Daemon service

| Line | Cause | Fix |
|---|---|---|
| `!` `daemon service  not installed` | Nothing restarts the daemon after a crash or kill; the next hook starts it. | `workmesh service install` |
| `!` `daemon service  …, installed but not running` / `not loaded` | launchd or systemd has the service but isn't running it. | `workmesh service install` |
| `!` `daemon service  …, installed but the running daemon isn't the service's` | A daemon started by hand runs beside the service. | `workmesh service install` (it stops the other one first) |
| `!` `daemon service  no systemd user session (…)` | Common over `su` or in some containers. | `sudo loginctl enable-linger $USER`, then `workmesh service install` |
| `!` `logout  lingering is off` | systemd stops the daemon when you log out. | `sudo loginctl enable-linger $USER`, then `workmesh restart` |

### Hooks and MCP

| Line | Cause | Fix |
|---|---|---|
| ✗ `node path  … run <node>, which no longer exists` | The Node that hooks, an MCP entry or the service run was removed (an nvm uninstall, or `brew upgrade` under a version before 0.12.1). | `workmesh setup --hooks-only` (under nvm, install Workmesh under your new Node first) |
| `!` `node path  … run <Cellar path>, Homebrew's versioned path` | Written by a version before 0.12.1; the next `brew upgrade node` breaks them. | `workmesh setup --hooks-only` (or `workmesh update`) |
| `!` `claude code hooks  not installed in …` | No Workmesh hooks in that Claude Code profile. | `workmesh setup --hooks-only` (with `--claude-dir` for another profile) |
| `!` `claude code wake  not installed` | Set up with `--no-wake`, or by an older version. | `workmesh setup --hooks-only` |
| `!` `claude code mcp  not registered` / `codex mcp  not registered` | The `workmesh` MCP server is missing. | `workmesh setup --hooks-only` |
| `!` `codex hooks  not installed` | Codex was installed after Workmesh. | `workmesh setup --hooks-only --codex` |
| `!` `codex hooks  …: Codex says N not trusted yet` / `changed since you trusted them` | Codex skips hooks you haven't trusted, and asks again after any change. | Open Codex and run `/hooks`; trust Workmesh's. |
| `!` `codex hooks  … turned off` | You turned them off in Codex. | Turn them on in Codex's `/hooks`. |
| `!` `codex notify  not installed` | The fallback for Codex builds without hooks is missing. | `workmesh setup --hooks-only --codex` |
| `!` `codex notify  …, to …, which no longer exists` / `to another Workmesh install` | `notify` points at an old checkout, often through another tool's notify chain. | Fallback only: hooks report Codex. Re-run `workmesh setup --hooks-only --codex`, or fix the other tool's setting. |

### Version and config

| Line | Cause | Fix |
|---|---|---|
| `!` `version  0.12.0; 0.12.1 available` | A newer release is out. | `workmesh update` |
| `!` `version  0.12.1, but the daemon still runs 0.12.0` | The CLI updated, the daemon didn't restart. | `workmesh update`, or `workmesh restart` |
| ✗ `node  … Workmesh needs node >= 20` | Node is too old. | Install Node 20+, then `npm i -g @b3os/workmesh@latest && workmesh setup --hooks-only` |
| `!` `config  … missing` | No config file. | `workmesh init https://workmesh.b3os.org` |
| ✗ `config  …` with an error | `config.json` isn't valid JSON, or a value is out of range. | Fix the value the error names. If you can't, move the file aside and run `init` again (you pair again). |
| ✗ `device token` / `slack token` / `relay` / `sink`, `!` `status read` / `ownership` | Slack status lines. | See [Slack status](slack-status.md). |

## npm install fails with "File exists: …/bin/agentblip"

You're installing 0.12.0 or older while the old `agentblip` package is installed globally: both provide an `agentblip`
command. Install `@b3os/workmesh@latest` (0.12.1 and newer don't), or `npm rm -g agentblip` and install again.

## The board shows me offline

`workmesh doctor` first. Past the daemon and hub lines above:

- **Asleep.** A laptop with its lid closed sends nothing; the board marks it asleep, then offline. It comes back when
  the Mac wakes.
- **A second device.** If you paired the same machine twice under different names, one of them is stale. Revoke it
  under Your machines on the board (only you can revoke your own). Since 0.11.1 pairing the same machine again under
  the same name replaces the old device by itself; two machines with one hostname need `--machine`.

## My session isn't on the board

- It isn't in a `b3-fun` repo. Only sessions that touch one are shared: see [Sharing](sharing-and-privacy.md).
  `workmesh hub status` shows how many sessions are shared now.
- Codex hooks aren't trusted (above).
- `workmesh status` lists the sessions the daemon sees on this machine. If yours is missing there, the hooks didn't
  fire: check the `claude code hooks` and `codex hooks` lines.

## A session says its Workmesh tools are older

Sessions that started before an update keep the old MCP server. In Claude Code run `/mcp reconnect workmesh`; in Codex
start a new thread (`/new`). Each such session is told once.

## My agent is held

Its tool calls are refused with "Held by <name>: <reason>". The person who held it, or you as its owner, releases it:
Release on the session's page on the board, or "resume" on the Linear issue when the hold came from Linear. The held
agent can still `send` and read its `inbox`, so it can ask. If the hub is unreachable, a hold your daemon already knew
about lasts up to 30 minutes.

## A message didn't arrive

Messages land after the recipient's next tool call, or with its next prompt. An idle Claude Code session is woken only
with the wake hook (Claude Code 2.1.330 or later, `workmesh wake` on). A Codex thread closed more than a minute ago has
ended: the message waits until it's resumed. `workmesh inbox` shows what is still waiting.

The recipient's machine also decides, and the sender is not told:

- **It did not wake the session.** By default only the recipient's own messages and replies wake an idle session. An
  unasked message waits for the session's next turn. The recipient can run `workmesh wake team` to let any teammate's
  message wake their sessions.
- **It is held.** A session that runs with permission prompts skipped does not get a teammate's message until its
  person delivers it. On the recipient's machine, `workmesh inbox --held` and the menu bar list it. It is dropped
  after 60 minutes with no answer.
- **It was dropped.** `messages.from` on the recipient's machine can limit whose messages it takes
  ([config](../reference/config.md#messages)).

## The hub said to slow down

The hub has limits, such as how many messages one person may send another in a minute. Over a limit, `send` and
`handoff` fail with the hub's reason, and with the wait when the hub gives one: "Workmesh: …; try again in 40 s".
Wait that long, then send again.

## An update went wrong

`workmesh update` checks the new version (the daemon must come back on it; hooks and the MCP server must be in place)
and rolls back to the version you had when a check fails, saying so. To go back by hand to a release from 0.12.0 on:

```bash
workmesh update --to 0.12.0
```

Before 0.12.0, use npm: `npm i -g @b3os/workmesh@0.11.1 && workmesh setup --hooks-only && workmesh restart`. The menu
bar app keeps its previous copy in `~/Library/Application Support/Workmesh/menubar-previous/`: quit Workmesh and move
it back to undo an app update.

## Still stuck

Post `workmesh doctor` output in the team channel. It holds no tokens or secrets, but it does show your paths and
machine name.

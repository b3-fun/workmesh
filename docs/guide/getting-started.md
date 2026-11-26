# Getting started

One command sets up a machine: it installs the agent hooks and MCP tools, runs the daemon, and pairs the machine with
B3's hub. This page covers what it changes, how to undo it, the macOS menu bar app, and reading your first
`workmesh doctor`.

## Before you start

- Node 20, 22 or 24 (`node -v`).
- Claude Code, Codex, or both, on this machine.
- A Google login on npclabs.org. The board at https://workmesh.b3os.org sits behind Cloudflare Access and lets only
  those in.

## Install

```bash
npm i -g @b3os/workmesh@latest && workmesh init https://workmesh.b3os.org
```

`init` prints four steps: hooks and tools, the daemon, the hub, and a check. At the hub step it asks "What should this
machine share with the hub?" (Enter keeps `conversation`; read [Sharing and privacy](sharing-and-privacy.md) first if
you're unsure, or pass `--share metadata`), prints a pairing code such as `BFNH-0792`, and opens the approve page. Check the code matches,
approve, and the terminal carries on:

```text
connected ans-laptop to B3 as An (an@example.com)
  shares sessions in repos whose origin contains github.com/b3-fun/
...
4. check
  hub: heard from this machine (0s ago): online on the board, no agents running yet
```

Your machine is now on the board, with no sessions until an agent works in a `b3-fun` repo. Running `init` again is
safe: it keeps the pairing and only fixes what is missing.

Useful flags: `--machine <name>` if two of your machines share a hostname, `--no-open` on a box without a browser (open
the printed link on your laptop), `--no-codex` to leave Codex alone. The full list is in the
[CLI reference](../reference/cli.md#workmesh-init).

## What changed on your machine

| Where | What `init` did |
|---|---|
| `~/.claude/settings.json` | Added Workmesh's hooks on nine Claude Code events, plus a second `Stop` hook that wakes an idle session when a message arrives. Your other hooks and settings stay. The file as it was is saved beside it as `settings.json.workmesh-backup-<time>`. |
| Claude Code MCP | Registered the `workmesh` MCP server at user scope (`claude mcp add -s user`, or a merge into `~/.claude.json` when the `claude` command isn't found). |
| `~/.codex/` (only if it exists) | Hooks in `hooks.json`, a `notify` line and `[mcp_servers.workmesh]` in `config.toml`, each file backed up first. |
| The daemon | A background process on `127.0.0.1:4519`, run by launchd (`org.npclabs.workmesh.daemon`) on macOS or by a systemd user unit (`workmesh.service`) on Linux, so it comes back after a crash or reboot. On Linux it also turns on lingering: see [Linux](linux.md). |
| `~/.config/workmesh/config.json` | Your hub pairing and settings, including the device token (`0600`). |
| `~/.local/state/workmesh/` | The daemon's secret, log and saved state. |

The hooks run Node by a path that survives upgrades (Homebrew's `/opt/homebrew/bin/node`, not its versioned Cellar
path). Under nvm, asdf or Volta they run the version you installed with: if you remove it, `workmesh doctor` flags it
and `workmesh setup --hooks-only` points everything at the new one.

## Undo it

```bash
workmesh uninstall    # hooks, MCP server and daemon service out; every file backed up first
workmesh stop
workmesh hub disconnect
npm rm -g @b3os/workmesh
```

Then revoke the machine on the board (Your machines → Revoke). Details and what stays behind:
[Updating and uninstalling](updating-and-uninstalling.md).

## The menu bar app (macOS)

`Workmesh.app` shows your agents in the menu bar: the icon turns orange when one needs you, and the menu lists waits,
approvals and handoffs for you, your sessions, and your teammates' agents. It reads everything from the daemon, so
install the CLI first. It needs macOS 13 or later.

The app isn't signed with an Apple Developer ID, and we hand it to the team ourselves. Installed from Terminal it has
nothing for macOS to ask about: `curl` doesn't mark the download as coming from the internet, so the app opens like one
you built yourself.

```bash
mkdir -p ~/Applications
curl -L -o /tmp/Workmesh.zip https://github.com/b3-fun/workmesh/releases/latest/download/Workmesh-menubar-macos.zip
ditto -x -k /tmp/Workmesh.zip ~/Applications
xattr -dr com.apple.quarantine ~/Applications/Workmesh.app   # does nothing after curl; clears the flag otherwise
open ~/Applications/Workmesh.app
```

If you downloaded the zip in a browser, the app is quarantined and macOS asks once. On macOS 15 (Sequoia), 26
(Tahoe) and later:

1. Double-click the zip, move `Workmesh.app` to `~/Applications` (or `/Applications`) and open it. macOS says
   "“Workmesh” Not Opened". Click **Done**, not Move to Trash.
2. Open System Settings → **Privacy & Security** and scroll to **Security**: "“Workmesh” was blocked to protect your
   Mac." Click **Open Anyway** (it shows for about an hour after step 1).
3. macOS asks once more: click **Open Anyway**, then enter your login password (or use Touch ID).

On macOS 13 and 14, right-click the app → **Open** → **Open** instead. If macOS says "“Workmesh” is damaged and can't
be opened" (the menu bar app from 0.12.1 and older, whose bundle wasn't sealed; there is no Open Anyway for it), click
**Cancel** and run the `xattr` line above, then open it again.

That's the only time. The app updates itself afterwards and the new version opens without a prompt (see
[Updating](updating-and-uninstalling.md#the-menu-bar-app)). To start it at login, add it under System Settings →
General → Login Items.

Keep the app in `~/Applications` or `/Applications`, not in Downloads: it replaces itself when a new release is out,
and it can't from a quarantined or read-only location.

## Your first doctor

```bash
workmesh doctor
```

Every line should start with ✓. Trimmed, from a test machine paired as An:

```text
  ✓ version            0.12.0 (latest)
  ✓ daemon             running (pid 64881, up 3s)
  ✓ hub                paired with https://workmesh.b3os.org (project B3, as An)
  ✓ hub sharing        conversation — prompts, agent text, tool descriptions and turn times from shared repos, redacted on this machine
  ✓ hub forward        online: the hub heard from this machine 1s ago; no agents running in a shared repo right now (you show as online, no agents)
  ✓ coordination       on (leases, holds, messages)
  ✓ delegation         on: handoffs ask; wake on
  ✓ claude code hooks  /Users/an/.claude/settings.json
  ✓ claude code wake   asyncRewake Stop hook installed (idle shared sessions wake for messages)
  ✓ claude code mcp    workmesh in /Users/an/.claude.json (user scope)
```

A ✗ is something that stops Workmesh working; a `!` is something to fix when you can. Each one names its fix. If the
fix isn't clear, look the line up in [Troubleshooting](troubleshooting.md).

Next: start a Claude Code or Codex session in a `b3-fun` repo and watch it appear on the board. Then read
[Working together](working-together.md).

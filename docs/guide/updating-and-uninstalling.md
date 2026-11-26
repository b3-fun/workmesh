# Updating and uninstalling

`workmesh update` keeps a machine current; `workmesh uninstall` takes Workmesh out of your agents. Both print each
step and back up every file they change.

## Update

```bash
workmesh update
```

It installs the newest release the way you installed Workmesh (npm, pnpm, bun, yarn or Volta, globally), then the new
version re-runs the setup steps that changed, restarts the daemon, and checks itself: the daemon must come back on the
new version, and the hooks and MCP server must still be in place. If a check fails it rolls back to the version you
had. Running it again changes nothing.

On 0.11 or older there is no `update` yet. Once:

```bash
npm i -g @b3os/workmesh@latest && workmesh update
```

Other forms:

```bash
workmesh update --check          # only report: "up to date (latest is 0.12.0)"
workmesh update --to 0.12.0      # a specific version, older ones too (0.12.0 or later)
workmesh update --auto on        # the daemon installs patch releases itself, at most once a day
workmesh update --auto on --minor
workmesh update --auto off
```

`workmesh doctor`, `workmesh status` and the menu bar say when a release is out. A git checkout or a project
dependency isn't updated; `update` says what to run instead.

### New releases wait a day

A release that just came out is not offered right away. `doctor`, `status` and the menu bar offer it once it is 24
hours old, and auto-update waits the same time. If a bad release ever goes out, that day is the time to pull it before
machines take it on their own. Until then `status` says when it will be offered:

```text
0.12.4 is out: offered in 21h 0m (new releases wait 24 h)
```

Run by hand, `workmesh update` does not wait. It installs the newest release at once, and tells you when that release
is younger than the waiting time.

To change the wait, set `update.waitHours` in `~/.config/workmesh/config.json`. Setting it to `0` turns the wait off:

```json
{ "update": { "waitHours": 0 } }
```

A release that comes out during the wait starts a wait of its own.

After an update, agent sessions that were already running keep the older MCP server. Each one is told once; run
`/mcp reconnect workmesh` in Claude Code, or start a new thread in Codex.

### The menu bar app

When a release is out the menu shows "Update available". Click it: a window runs `workmesh update` and shows the
output. If the release has a newer menu bar app, the window offers to relaunch with it. The app downloads the release's
zip, checks its SHA-256 against the release, clears the quarantine flag on the new version, swaps it in and relaunches.
There is nothing to allow: macOS doesn't ask again, however you installed it the first time.

It keeps one copy of the version it replaced, in `~/Library/Application Support/Workmesh/menubar-previous/`; each
update replaces that copy. To go back, quit Workmesh and put that app back in place of yours:

```bash
rm -rf ~/Applications/Workmesh.app
ditto ~/Library/Application\ Support/Workmesh/menubar-previous/Workmesh.app ~/Applications/Workmesh.app
open ~/Applications/Workmesh.app
```

The app updates itself only where it can write: not from Downloads (macOS runs a quarantined app from a read-only
copy there) or a disk image. It says so and changes nothing; move it to `~/Applications` and try again.

### Signed releases

The menu bar app has no Apple Developer ID, so macOS can't tell you who built it. Workmesh can check that itself,
with releases that a maintainer signs. That check is not switched on yet: the maintainers have not made a key. Until
they do, the app's download is checked against the hash GitHub lists for the release, as before.

Once it is on, each release carries a list of its files with their SHA-256 hashes. A maintainer signs that list with
a key that is kept off GitHub, and Workmesh ships with the matching public keys. The daemon then offers the app only
from a release whose list a maintainer key signed. The app checks its download against the hash in that list.

A release that fails the check offers no app, and your installed app keeps running. `workmesh doctor` and
`workmesh status` say why:

```text
the menu bar app in release 0.12.4 is not offered: the release has no workmesh-release.json.sig, so no maintainer key vouches for its files
```

On a Mac, the `release signing` line of `workmesh doctor` says whether signing is on.

## Uninstall

```bash
workmesh uninstall
```

It removes Workmesh's hooks and MCP server from Claude Code and Codex and the daemon service, and leaves every other
hook and setting. Each file is backed up first:

```text
workmesh uninstall
  claude code: removed 10 hook(s) from /Users/an/.claude/settings.json (backup: /Users/an/.claude/settings.json.workmesh-backup-20261125T205218026Z)
  claude code mcp: removed from /Users/an/.claude.json (backup: …)
  …
still on this machine:
  workmesh stop             stop a daemon running outside the service (clears your Slack status)
  workmesh hub disconnect   remove the hub token
  workmesh unlink           revoke the Slack relay device
```

To remove everything:

```bash
workmesh uninstall
workmesh stop
workmesh hub disconnect          # deletes the hub token from config.json
workmesh unlink                  # only if you set up a Slack status
npm rm -g @b3os/workmesh
rm -rf ~/.config/workmesh ~/.local/state/workmesh
```

Then on the board, Your machines → Revoke, so the hub stops expecting this machine. On macOS, quit the menu bar app,
delete `~/Applications/Workmesh.app`, and take it out of Login Items. On Linux, `loginctl disable-linger` if nothing
else needs lingering.

`--no-codex` leaves Codex's files alone; `--no-service` keeps the daemon service; `--claude-dir` picks another Claude
Code profile.

## Coming from agentblip

Workmesh was called agentblip until 0.7. Moving over keeps your setup:

- The first `workmesh` command copies `~/.config/agentblip/config.json` (pairings, sharing level, settings),
  `daemon.secret` and `ownership.json` to the Workmesh directories, with the same `0600` permissions. The old files
  stay as a backup.
- `workmesh setup --hooks-only` repoints hooks an agentblip install wrote, in place, without duplicating them.
- `workmesh restart` stops a daemon agentblip started, then starts the new one.
- `AGENTBLIP_*` environment variables are read when the `WORKMESH_*` one is unset.
- `Workmesh.app` (bundle id `org.npclabs.workmesh.menubar`) replaces `agentblip.app`.

Since 0.12.1 the command is `workmesh` only, so installing over an old global `agentblip` works in one go. Remove the
old package afterwards if you like; nothing uses it once `init` has repointed the hooks:

```bash
npm i -g @b3os/workmesh@latest && workmesh init https://workmesh.b3os.org
npm rm -g agentblip   # optional cleanup
```

On 0.12.0 and older, npm refuses the install with `npm error File exists: …/bin/agentblip` while the old package is
installed: run `npm rm -g agentblip` first.

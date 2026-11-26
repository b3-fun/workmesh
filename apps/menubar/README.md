# Workmesh menu bar app (macOS)

A tiny native SwiftUI menu bar app — the "on-air light" for your AI agents, on
your own screen, and since 0.5 your team's too. It's a **thin client of the
local daemon**: it holds no logic of its own, just polls the daemon's loopback
API and renders the blip.

```
menu bar app ──GET /state, /config, /team──▶ workmesh daemon (127.0.0.1:4519) ──▶ Slack
            ◀──POST /pause /resume /config /sessions/dismiss /coord/op── └──▶ team hub (/relay/team)
```

All the real work — session aggregation, status formatting, the ownership guard,
reading the hub — stays in `@workmesh/core` and the daemon. The daemon polls the
hub and caches the team view; the app only reads `GET /team` on loopback. The
app is presentation + control only, so there's zero logic to keep in sync.

## What it shows

- **Menu bar icon**: a ring when nothing runs; a dot (numbered past one) while
  agents work, filled while syncing to Slack and outlined while sync is off
  (paused, snoozed, or standing down for your own status). **Orange only when a
  session needs you**, numbered when more than one does. Everything else is a
  template image, so it sits calmly with the system icons.
- **Header**: the exact text your Slack status shows (or why it shows nothing:
  snoozed until 9:00 AM, paused, your own status is up), with a snooze menu:
  30 minutes, 1 hour, until tomorrow (9 AM), or pause until you resume.
- **Needs you** (orange, longest wait first): your agents waiting on you, on
  this Mac and, when you're paired with a hub, on your other machines (marked
  with a small computer). A wait the hub also lists shows once, with the hub's
  reason as its line.
- **Held messages** (orange): a teammate's message for a session that runs
  with no permission prompts. The agent has not seen it. **Deliver** hands it
  to the session, **Drop** removes it, and the tooltip says when it is dropped
  if you do nothing. It comes from `GET /team`'s `coord.held` and answers
  through `POST /coord/op` (`inbox`); an older daemon sends none.
- **Handoffs for you** (v2): tasks a teammate handed you, with who, repo and
  issue, and **Accept** / **Decline** (Accept starts an agent for it on this
  Mac); ones already running here say so. Up to four, the header counts all.
- **Approvals** (v2): merges, deploys, publishes, force-pushes and spends an
  agent may not do without a yes. Ones you may decide get **Approve** /
  **Deny** (orange header); your own agents' asks that someone else decides say
  "Waiting for approval". Both sections answer through the daemon's
  `POST /coord/op` and come from `GET /team`'s `delegate`; an older daemon
  sends none and they stay hidden.
- **Sessions on this Mac**: **Working**, **Background** (teal: only waiting on
  its own shells or subagents), **Idle** (collapsed). Each row leads with the
  project, then the activity and the agent's session name, the agent's mark
  (Anthropic for Claude Code, OpenAI for Codex; SF Symbols for workflows and
  others), `+N` for subagents or workflow agents running under it, and the time
  in its current state. Hover for the full text and path. `/state` stays the
  source of truth for this Mac.
- **Team** (when paired): each teammate with their GitHub avatar (initials
  while it loads or without one), a presence dot, and their agents in a few
  words ("2 working · 1 waiting", "idle", "offline"). People with agents
  running come first, then whoever's online. Click a person for their sessions
  (mark, name, what it's doing, repo, `+N`, time in state). A hub without the
  team view says so in one quiet line; unpaired, the menu shows the
  `workmesh hub connect` command with a copy button; a hub that rejected this
  Mac shows the command to pair again.
- **Update available** (above the footer, only when there's something to do):
  one quiet row, "Workmesh 0.12.1 · you have 0.12.0". Click it and an
  **Updating Workmesh** window runs `workmesh update` and shows its output; when
  this install can't update itself (a git checkout, say) the row shows the
  daemon's one-line hint with a copy button for its command instead. When only
  the menu bar app is behind the release, the row offers that ("Menu bar app
  0.12.1 · you have 0.12.0"). See [Updates](#updates).
- **Footer**: settings, the hub connection ("Connected to b3os.org", "Hub
  unreachable", "Reconnect needed") over your sharing level, **Open board**,
  and Quit.
- **Row actions** (click or right-click): copy the session name or ID, reveal
  the project folder in Finder, dismiss a stale wait or a finished session.
  Rows from the hub: copy the name, open the board.
- **Notifications**: one native notification per new wait, from this Mac or
  the hub, with the hub's reason when it has one. Waits already there when the
  app starts don't fire. On by default; Settings turns them off.
- **Settings** (gear): Slack detail level, what to do when your own status is
  set, lead with the repo name, notifications, and the config file.

The team view is read every 5 s while the menu is open (with `?open=1`, so the
daemon reads the hub faster) and every 15 s otherwise; `/state` every 2 s. A
daemon without `GET /team` (404) hides the team UI.

## Requirements

- macOS 13 (Ventura) or later — uses SwiftUI `MenuBarExtra`.
- The `workmesh` CLI installed and the daemon running (`npm i -g @b3os/workmesh`,
  then `workmesh setup` / `workmesh start --detach`). The app finds the daemon via the
  same `~/.local/state/workmesh/daemon.secret` and `~/.config/workmesh/config.json`
  the CLI uses (XDG paths respected; while only the pre-rename `agentblip` files
  exist, it reads those).

## Build & run

```bash
cd apps/menubar
swift build                 # compile
./scripts/make-app.sh 0.5.0 # → dist/Workmesh.app (a menu-bar agent, LSUIElement)
open dist/Workmesh.app
```

`make-app.sh` seals the bundle with an ad hoc signature (`codesign --sign -`: no Apple
Developer ID, no account; Sean, 11-25: no Developer ID signing for now). A local build
carries no quarantine flag, so it opens as is. A copy downloaded in a browser is
quarantined and needs Open Anyway once on macOS 15 and later; the clicks are in
[Getting started](../../docs/guide/getting-started.md#the-menu-bar-app-macos).
`Workmesh --version` prints the version and exits before AppKit starts.

To start it at login, a LaunchAgent with the label `org.npclabs.workmesh.menubar`
(the bundle id) that runs `Workmesh.app/Contents/MacOS/Workmesh` with `RunAtLoad`
and `KeepAlive` works until the app offers launch at login itself.

## Updates

The daemon's `GET /update` says whether a newer Workmesh is out, how this
install can take it, and where the release's menu bar zip is (with its SHA-256,
as GitHub lists it for the release asset). The app reads it every 10 minutes and
when the menu opens (at most every 30 s); a daemon without the endpoint (404)
shows nothing.

**Workmesh itself.** When `install.canUpdate`, the row opens the update window,
which runs the daemon's `run` argv as a child of the app (not through the
daemon, which restarts at the end), with `NO_COLOR=1` and the directory of
`run[0]` first on `PATH`, and streams its output. Exit 0 = updated (the window
waits for the daemon to come back and names the version it runs), 1 = failed
(the output says whether it rolled back), 3 = this install can't be updated
that way (the output says what to do). Closing the window doesn't stop the
run; the row then reads "Updating Workmesh · Show progress".

**The menu bar app.** When the release's menu bar app is newer than this one
(`CFBundleShortVersionString`), the window offers **Relaunch with the new menu
bar app 0.12.1** after a good run, and the row offers it on its own when only
the app is behind. It:

1. downloads the zip (https only; plain http to 127.0.0.1 for the mock),
2. refuses it unless its SHA-256 equals the release's,
3. unpacks it with `ditto -x -k` and requires one app whose bundle id is this
   app's and whose version is the release's,
4. clears `com.apple.quarantine` from every item in the new app (a read-only one gets
   owner write for that moment), and refuses with the install-by-hand steps if it can't,
5. copies the running app beside the rollback copy in
   `~/Library/Application Support/Workmesh/menubar-previous/`, then swaps it for the old
   one, so there's always exactly one and a stale, partial or read-only one never blocks
   an update,
6. swaps the new app into place (`FileManager.replaceItemAt`, keeping the old one under
   `.Workmesh.app.replaced` and deleting it itself, read-only folders too),
7. relaunches: a shell in its own session waits for this process to exit, then
   `open`s the app (unless launchd's KeepAlive already started it again).

It refuses, in plain words and before downloading, when the app runs from a
read-only volume, from App Translocation (a quarantined app opened where it was
downloaded), or from a folder it can't write. To roll back, quit Workmesh and
put the app from `menubar-previous` back.

**Gatekeeper.** Gatekeeper only assesses an app carrying `com.apple.quarantine`, so
the update makes sure the new one carries none. Verified on macOS 27.2.1 (11-25):

- The app's own download (URLSession) carries only `com.apple.provenance`: the app
  doesn't set `LSFileQuarantineEnabled`. A zip a browser saved spreads its flag to
  everything `ditto -x` unpacks, and a zip made with ditto from a downloaded copy keeps
  the flags of the items inside (not the `.app` folder's own, with `--keepParent`);
  unpacking restores them. So the updater clears whatever it finds.
- Unsealed (0.12.1 and older: only the linker's signature on the binary, Info.plist not
  bound), `codesign --verify --strict` and `spctl` say "code has no resources but
  signature indicates they must be present", and a quarantined copy is "“Workmesh” is
  damaged and can't be opened", with no Open Anyway. Sealed ad hoc, it verifies ("valid
  on disk"), and `spctl --assess` says "rejected" like any app that isn't notarized:
  the case Privacy & Security's Open Anyway is for (checked from the command line; the
  dialogs weren't put on screen). The seal survives a zip round trip with quarantine
  flags inside and the update's swap.
- Make the release zip on a Mac from source with `ZIP=1 ./scripts/make-app.sh <version>`,
  never from a downloaded copy.

`scripts/test-self-update.sh` checks all of it, headless (no menu bar item, window or
activation): it builds 0.0.1 to 0.0.4 under a test bundle id and runs the older copy's
update (`WORKMESH_DEV_SELF_UPDATE_URL`/`_SHA256`/`_VERSION`: the menu's
`AppSelfUpdate.install` without the window or the relaunch) against a mock-served zip,
for a clean zip, one whose inner items carry the flag, one whose `.app` folder does, one
with read-only items (then two more updates from that app), two updates in a row, and a
stale, partial, read-only or misplaced rollback copy. After each it checks the version,
`--version`, no quarantine flag, modes as in the zip, the seal, the rollback copy (same
bytes, modes and seal, the only one) and that nothing is left behind; then a first
install with `curl`. Evidence of the 11-25 run: before the fix, the second update from
an app with read-only folders swapped and then failed, and the third (or any update over
a read-only rollback copy) failed with "an item with the same name already exists".

## Develop without a daemon: mock + snapshots

`scripts/mock-daemon.mjs` (plain Node, no deps) serves `/health`, `/state`,
`/config`, `/hub` and `/team` with fixture data. It writes its secret and port
under `XDG_STATE_HOME` / `XDG_CONFIG_HOME`, which it requires and which must not
be your real `~/.config` / `~/.local/state`, so run the app with the same two
variables and it talks to the mock, never your daemon.

`GET /update`: `legacy` answers 404, the other fixture scenarios "up to date".
The update scenarios are `team` plus a release:

- `update`: `workmesh update` can run here. `run` is `scripts/mock-update.mjs`,
  which prints like the real command for a few seconds, exits 0 and restarts
  the mock (down 3 s, back on a new secret); `/update` then says it's current.
- `update-fail`: the run fails, says it rolled back, exits 1.
- `update-git`: a git checkout, no `run`, a hint with a command to copy.
- `update-menubar`: the CLI is current, only the menu bar app is behind.

Options: `--current 0.12.0 --latest 0.12.1 --menubar-version <latest>`,
`--menubar-zip <path>` (served at `/mock/Workmesh-menubar-macos.zip` with its
real SHA-256; without it, a placeholder that won't unpack) and
`--menubar-sha256 <hex>` (announce another digest: a tampered download).

Snapshot mode renders the menu to a PNG and exits: set `WORKMESH_SNAPSHOT` to
the output path, optionally `WORKMESH_SNAPSHOT_EXPAND=An` (comma-separated
names) and `WORKMESH_SNAPSHOT_APPEARANCE=dark`. `WORKMESH_SNAPSHOT_SHEET=update-running`
(or `update-finished`, `update-failed`, `update-cant`, `update-app-failed`)
draws the update window in that state with fixture output instead (no daemon
read; build the app at 0.12.0 so `update-finished` shows the relaunch offer). It hosts the menu in an
off-screen window and draws it at 2x, so real controls render (no
ImageRenderer placeholders); it adds no menu bar item and posts nothing.

```bash
export XDG_CONFIG_HOME=/tmp/wm/config XDG_STATE_HOME=/tmp/wm/state
node scripts/mock-daemon.mjs --port 45190 --scenario team &   # or coord, delegate, empty, unpaired, halted, noteam, legacy, update, update-fail, update-git, update-menubar
OUT=/tmp/wm/dist BUNDLE_ID=org.npclabs.workmesh.menubar.dev ./scripts/make-app.sh 0.5.0
WORKMESH_SNAPSHOT=/tmp/wm/team.png WORKMESH_SNAPSHOT_EXPAND=An \
  /tmp/wm/dist/Workmesh.app/Contents/MacOS/Workmesh
```

`BUNDLE_ID` gives a dev build its own defaults domain, apart from an installed
Workmesh.app. Without `WORKMESH_SNAPSHOT` the same command runs the live menu
against the mock.

To watch a self-update in the UI end to end, build two dev versions, serve the newer one's
zip, and run the older one from a scratch folder. `WORKMESH_DEV_AUTOUPDATE=app`
starts the app update once it's offered (`cli` runs `workmesh update`,
`cli+app` also takes the relaunch offer after it), echoing the window's lines
to stdout; `WORKMESH_DEV_CAPTURE=<dir>` saves the live window as PNGs. The
relaunch keeps `XDG_CONFIG_HOME`/`XDG_STATE_HOME` and drops these switches.

```bash
for v in 0.0.1 0.0.2; do OUT=/tmp/wm/v$v BUNDLE_ID=org.npclabs.workmesh.menubar.dev ZIP=1 ./scripts/make-app.sh $v; done
mkdir -p /tmp/wm/app && ditto /tmp/wm/v0.0.1/Workmesh.app /tmp/wm/app/Workmesh.app
node scripts/mock-daemon.mjs --port 45193 --scenario update-menubar --menubar-version 0.0.2 \
  --menubar-zip /tmp/wm/v0.0.2/Workmesh-menubar-macos.zip &
WORKMESH_DEV_AUTOUPDATE=app /tmp/wm/app/Workmesh.app/Contents/MacOS/Workmesh
```

A dev build (any `BUNDLE_ID` but the release's) keeps the previous app in
`~/Library/Application Support/<bundle id>/menubar-previous/`, never the installed
app's `Workmesh/menubar-previous/`; remove that folder after a dev run.

## Layout

```
Sources/WorkmeshMenuBar/
  App.swift          # @main MenuBarExtra scene
  AppModel.swift     # poll loops (/state 2 s, /team 5 s open / 15 s closed) + actions
  DaemonClient.swift # authed HTTP to the loopback API
  Models.swift       # mirrors of /state, /config, /team (tolerant), needs-you merge, BlipState
  Paths.swift        # XDG-aware secret/config resolution (matches the CLI)
  StatusIcon.swift   # SF Symbol menu bar icon (template, orange for "needs you")
  MenuContent.swift  # the dropdown: header, needs you, this Mac, team, footer
  SessionRow.swift   # the shared agent row, the local session row, the action menu
  TeamViews.swift    # avatar, presence dot, person row, teammate session row
  AgentMark.swift    # Anthropic/OpenAI marks as SwiftUI shapes (tiny SVG path parser)
  Notifier.swift     # "needs you" notifications, one per wait across both sources
  Updater.swift      # runs `workmesh update`; downloads, checks, swaps and relaunches the app
  UpdateWindow.swift # the "Updating Workmesh" panel: output, result, relaunch offer
  SnapshotMode.swift # WORKMESH_SNAPSHOT: render the menu (or the update window) to a PNG and exit
scripts/make-app.sh      # bundles the binary into Workmesh.app (ZIP=1: the release zip too)
scripts/mock-daemon.mjs  # fixture daemon for development and snapshots
scripts/mock-update.mjs  # stand-in for `workmesh update`, run by the mock's update scenarios
scripts/test-self-update.sh # the app's self-update against temp copies, headless
```

The app stays a thin client. Everything it shows comes from the daemon: the
state per session, `background`, `stateSince`, the session `name` and `cwd`,
`subagents`/`foldedInto` for fan-out, `pausedUntil`, and the team view
(`people`, `needsMe`, `sessions`, connection and sharing level). Its actions are
daemon calls (`POST /pause {for}`, `/resume`, `/sessions/dismiss`, `/config`,
`/coord/op` for handoffs and approvals) or
local ones (copy, reveal in Finder, open the board, run the `run` argv the
daemon gave for an update). The one thing it decides itself is whether the
release's menu bar app is newer than the app it is, which only it knows. Grouping is a direct read
of `state` and `background`; showing a wait once when both `/state` and
`needsMe` list it (the hub key ends with `:` + the local key), ordering and time
formatting are presentation. Team ages use the hub's `serverNow`.

## Roadmap

**Now** (0.12)
- Update available: `workmesh update` from the menu with its output in a
  window, the daemon's hint when this install can't, and the app replacing
  itself from the release zip after a SHA-256 check.

**Shipped in 0.5**
- Team section from the daemon's `GET /team`: people, presence, counts,
  expandable sessions, GitHub avatars.
- Needs you across machines, with the hub's reason; one notification per wait,
  on by default.
- Hub status and sharing level in the footer, Open board.
- The agents' real marks (Anthropic, OpenAI) in every row.
- Mock daemon and snapshot mode for development.

**Shipped in 0.2**
- Live list redesign: project first, activity and session name, source glyph,
  `+N` fan-out, time in state, full text on hover.
- Sections: Needs you, Working, Background, Idle (collapsed).
- Icon: calm template states; orange only when a session needs you.
- Row actions: copy name or ID, reveal in Finder, dismiss.
- Snooze Slack sync for 30 minutes, 1 hour or until tomorrow, with auto-resume
  in the daemon.
- Settings moved into one gear menu.
- Notification when a session newly needs you.

**Next**
- Jump to the session's terminal. Claude Code's session file carries a `tmux`
  target and a name, but there's no supported way yet to raise the right
  Harness or terminal window. Build it once one exists, not by scripting
  windows.
- Flag "needs you" the moment a turn ends with a question (on `Stop`), instead
  of after Claude Code's 60-second idle reminder.
- Keep a pause or snooze across daemon restarts.
- Launch at login from the menu (SMAppService) instead of a hand-made
  LaunchAgent.
- Signed and notarized build, Homebrew cask (not for now: Sean, 11-25).

**Later**
- A short per-session timeline: what it did in the last hour.
- Reply to a waiting session from the menu, if Claude Code exposes a stable
  way to send it input.
- Codex parity: session names, crash reaping, background detection.
- Global shortcut to open the menu; keyboard navigation of rows.

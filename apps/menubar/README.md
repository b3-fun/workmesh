# Workmesh menu bar app (macOS)

A tiny native SwiftUI menu bar app — the "on-air light" for your AI agents, on
your own screen, and since 0.5 your team's too. It's a **thin client of the
local daemon**: it holds no logic of its own, just polls the daemon's loopback
API and renders the blip.

```
menu bar app ──GET /state, /config, /team──▶ workmesh daemon (127.0.0.1:4519) ──▶ Slack
            ◀──POST /pause /resume /config /sessions/dismiss──          └──▶ team hub (/relay/team)
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

The build is unsigned, so on first launch macOS Gatekeeper will complain —
right-click the app → **Open**, or `xattr -dr com.apple.quarantine dist/Workmesh.app`.
For distribution we'd notarize it or ship a Homebrew cask (`brew install --cask workmesh`).

To start it at login, a LaunchAgent with the label `org.npclabs.workmesh.menubar`
(the bundle id) that runs `Workmesh.app/Contents/MacOS/Workmesh` with `RunAtLoad`
and `KeepAlive` works until the app offers launch at login itself.

## Develop without a daemon: mock + snapshots

`scripts/mock-daemon.mjs` (plain Node, no deps) serves `/health`, `/state`,
`/config`, `/hub` and `/team` with fixture data. It writes its secret and port
under `XDG_STATE_HOME` / `XDG_CONFIG_HOME`, which it requires and which must not
be your real `~/.config` / `~/.local/state`, so run the app with the same two
variables and it talks to the mock, never your daemon.

Snapshot mode renders the menu to a PNG and exits: set `WORKMESH_SNAPSHOT` to
the output path, optionally `WORKMESH_SNAPSHOT_EXPAND=An` (comma-separated
names) and `WORKMESH_SNAPSHOT_APPEARANCE=dark`. It hosts the menu in an
off-screen window and draws it at 2x, so real controls render (no
ImageRenderer placeholders); it adds no menu bar item and posts nothing.

```bash
export XDG_CONFIG_HOME=/tmp/wm/config XDG_STATE_HOME=/tmp/wm/state
node scripts/mock-daemon.mjs --port 45190 --scenario team &   # or empty, unpaired, halted, noteam, legacy
OUT=/tmp/wm/dist BUNDLE_ID=org.npclabs.workmesh.menubar.dev ./scripts/make-app.sh 0.5.0
WORKMESH_SNAPSHOT=/tmp/wm/team.png WORKMESH_SNAPSHOT_EXPAND=An \
  /tmp/wm/dist/Workmesh.app/Contents/MacOS/Workmesh
```

`BUNDLE_ID` gives a dev build its own defaults domain, apart from an installed
Workmesh.app. Without `WORKMESH_SNAPSHOT` the same command runs the live menu
against the mock.

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
  SnapshotMode.swift # WORKMESH_SNAPSHOT: render the menu to a PNG and exit
scripts/make-app.sh      # bundles the binary into Workmesh.app
scripts/mock-daemon.mjs  # fixture daemon for development and snapshots
```

The app stays a thin client. Everything it shows comes from the daemon: the
state per session, `background`, `stateSince`, the session `name` and `cwd`,
`subagents`/`foldedInto` for fan-out, `pausedUntil`, and the team view
(`people`, `needsMe`, `sessions`, connection and sharing level). Its actions are
daemon calls (`POST /pause {for}`, `/resume`, `/sessions/dismiss`, `/config`) or
local ones (copy, reveal in Finder, open the board). Grouping is a direct read
of `state` and `background`; showing a wait once when both `/state` and
`needsMe` list it (the hub key ends with `:` + the local key), ordering and time
formatting are presentation. Team ages use the hub's `serverNow`.

## Roadmap

**Now** (0.5)
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
- Signed and notarized build, Homebrew cask.

**Later**
- A short per-session timeline: what it did in the last hour.
- Reply to a waiting session from the menu, if Claude Code exposes a stable
  way to send it input.
- Codex parity: session names, crash reaping, background detection.
- Global shortcut to open the menu; keyboard navigation of rows.

# agentblip menu bar app (macOS)

A tiny native SwiftUI menu bar app — the "on-air light" for your AI agents, on
your own screen. It's a **thin client of the local daemon**: it holds no logic
of its own, just polls the daemon's loopback API and renders the blip.

```
menu bar app ──GET /state, /config──▶ agentblip daemon (127.0.0.1:4519) ──▶ Slack
            ◀──POST /pause /resume /config /sessions/dismiss──
```

All the real work — session aggregation, status formatting, the ownership guard
— stays in `@workmesh/core` and the daemon. The app is presentation + control
only, so there's zero logic to keep in sync.

## What it shows

- **Menu bar icon**: a ring when nothing runs; a dot (numbered past one) while
  agents work, filled while syncing to Slack and outlined while sync is off
  (paused, snoozed, or standing down for your own status). **Orange only when a
  session needs you**, numbered when more than one does. Everything else is a
  template image, so it sits calmly with the system icons.
- **Header**: the exact text your Slack status shows (or why it shows nothing:
  snoozed until 9:00 AM, paused, your own status is up), with a snooze menu:
  30 minutes, 1 hour, until tomorrow (9 AM), or pause until you resume.
- **Sessions**, grouped by what they need from you: **Needs you** (orange,
  longest wait first), **Working**, **Background** (teal: only waiting on its
  own shells or subagents), **Idle** (collapsed). Each row leads with the
  project, then the activity and the agent's session name, a source glyph
  (Claude, Codex, workflow), `+N` for subagents or workflow agents running under
  it, and the time in its current state. Hover for the full text and path.
- **Row actions** (click or right-click): copy the session name or ID, reveal
  the project folder in Finder, dismiss a stale wait or a finished session.
- **Settings** (gear): Slack detail level, what to do when your own status is
  set, lead with the repo name, an opt-in notification when a session newly
  needs you, and the config file.

## Requirements

- macOS 13 (Ventura) or later — uses SwiftUI `MenuBarExtra`.
- The `agentblip` CLI installed and the daemon running (`npm i -g agentblip`,
  then `agentblip setup` / `agentblip start`). The app finds the daemon via the
  same `~/.local/state/agentblip/daemon.secret` and `~/.config/agentblip/config.json`
  the CLI uses (XDG paths respected).

## Build & run

```bash
cd apps/menubar
swift build                 # compile
./scripts/make-app.sh 0.2.0 # → dist/agentblip.app (a menu-bar agent, LSUIElement)
open dist/agentblip.app
```

The build is unsigned, so on first launch macOS Gatekeeper will complain —
right-click the app → **Open**, or `xattr -dr com.apple.quarantine dist/agentblip.app`.
For distribution we'd notarize it or ship a Homebrew cask (`brew install --cask agentblip`).

## Layout

```
Sources/AgentblipMenuBar/
  App.swift          # @main MenuBarExtra scene
  AppModel.swift     # poll loop + control actions (ObservableObject)
  DaemonClient.swift # authed HTTP to the loopback API
  Models.swift       # Codable mirrors of /state and /config, SessionGroup, BlipState
  Paths.swift        # XDG-aware secret/config resolution (matches the CLI)
  StatusIcon.swift   # SF Symbol menu bar icon (template, orange for "needs you")
  MenuContent.swift  # the dropdown: header, grouped list, settings
  SessionRow.swift   # one session row + its action menu
  Notifier.swift     # opt-in "needs you" notifications
scripts/make-app.sh  # bundles the binary into agentblip.app
```

The app stays a thin client. Everything it shows comes from the daemon: the
state per session, `background`, `stateSince`, the session `name` and `cwd`,
`subagents`/`foldedInto` for fan-out, `pausedUntil`. Its actions are daemon
calls (`POST /pause {for}`, `/resume`, `/sessions/dismiss`, `/config`) or local
ones (copy, reveal in Finder). Grouping is a direct read of `state` and
`background`; ordering and time formatting are presentation.

## Roadmap

**Now** (shipped in 0.2)
- Live list redesign: project first, activity and session name, source glyph,
  `+N` fan-out, time in state, full text on hover.
- Sections: Needs you, Working, Background, Idle (collapsed).
- Icon: calm template states; orange only when a session needs you.
- Row actions: copy name or ID, reveal in Finder, dismiss.
- Snooze Slack sync for 30 minutes, 1 hour or until tomorrow, with auto-resume
  in the daemon.
- Settings moved into one gear menu.
- Opt-in notification when a session newly needs you.

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

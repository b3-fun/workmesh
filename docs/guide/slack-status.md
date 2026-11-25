# Slack status

Optional, and separate from the team board: the daemon can also set your Slack status from your agents, such as
`claude agent working`, `3 agents working` or `✋ 1 agent(s) waiting on me`. `workmesh init` doesn't turn it on.

## Turn it on

```bash
workmesh setup
```

Pick `relay` mode. It pairs your Slack account in the browser through agentblip.com (the Workmesh app in the NPC Labs
Slack workspace) and asks how much your status may say. Your hub pairing and hooks stay as they are.

agentblip.com receives only the finished status: text, emoji and an expiry. It never sees your prompts, tools, files
or projects unless you choose a level that puts them in the status text. The status expires five minutes after the last
push, so a crashed daemon or a sleeping laptop clears it.

## How much it says

| `granularity` | Your status reads |
|---|---|
| `off` | never set |
| `presence` | `heads down with agents` |
| `count` (default) | `claude agent working`, `3 agents working` |
| `activity` | `claude: finalizing CI/CD`, `3 agents · finalizing CI/CD` |

Change it from the menu bar app's settings, or in `~/.config/workmesh/config.json` with `workmesh restart`. Templates,
emoji and redaction for the status text are in the [config reference](../reference/config.md#slack-status).

## Your own status wins

With `statusPolicy: "respect"` (the default) a status you set yourself, or another app's, is never overwritten:
Workmesh stands down and resumes when it clears. `"overwrite"` replaces it and puts it back when your agents finish.
A status you change by hand while agents work always wins.

## Pause, snooze, stop

```bash
workmesh pause --for 1h          # or 30m, tomorrow (9 AM); plain `pause` until you resume
workmesh resume
workmesh unlink                  # revoke this device on the relay and clear the status
```

## Counting fan-out

Claude Code workflow runs are counted automatically. For other fan-outs (a CI matrix, a batch job), report the count
so "N agents working" is right:

```bash
workmesh report --agents 5 --phase verify --activity "reviewing findings"
workmesh report --done
```

Anything else can report itself as a session with one HTTP request to the daemon: see
[INTEGRATIONS.md](../INTEGRATIONS.md). To run your own relay instead of agentblip.com:
[SELF_HOSTING.md](../SELF_HOSTING.md).

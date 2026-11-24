# Integrating with agentblip

The daemon's localhost HTTP API is agentblip's stable public interface. Claude Code
hooks, the Codex adapter, and `agentblip emit` all speak it — and so can anything you
build. If your tool can make an HTTP request, it can be a blip.

## The daemon API

Loopback only, default `http://127.0.0.1:4519` (`port` in
`~/.config/agentblip/config.json`).

Every endpoint except `GET /health` requires the daemon's local API secret as a
bearer token. The daemon generates the secret automatically and stores it with
`0600` permissions at `~/.local/state/agentblip/daemon.secret` (`XDG_STATE_HOME`
respected). Grab it in one line:

```bash
AUTH="authorization: Bearer $(cat ~/.local/state/agentblip/daemon.secret)"
```

| Method & path | Body | Purpose |
|---|---|---|
| `POST /event` | session event (below) | Report a session event. `200` on accept, `400` on schema failure, `401` without the bearer secret |
| `GET /state` | — | Current sessions, the formatted status, and status ownership, as JSON |
| `POST /pause` | optional `{"for": "30m"\|"1h"\|"tomorrow"}` or `{"until": epochMs}` | Pause Slack updates (daemon keeps tracking). With a body it's a snooze that resumes on its own; `tomorrow` = 9 AM local. Echoes `pausedUntil` |
| `POST /resume` | — | Resume Slack updates |
| `POST /sessions/dismiss` | `{"key": "source:sessionId"}` | Drop a session from the list (it returns with its next event). `{ok, removed}` |
| `GET` / `POST /config` | live config patch | Read or live-tune `granularity`, `statusPolicy`, `showProject`, `repoPrefix` |
| `GET /health` | — | Liveness probe (no auth) |

### The `/state` response

`GET /state` returns the daemon's full view, including an `ownership` block — the
state of the [status-ownership machine](../packages/core/src/ownership.ts) that keeps
agentblip from overwriting a Slack status it didn't set:

```json
{
  "snapshot": {
    "sessions": [
      {
        "key": "claude-code:abc123",
        "source": "claude-code",
        "sessionId": "abc123",
        "state": "working",
        "activity": "editing format.ts",
        "project": "agentblip",
        "cwd": "/Users/you/code/agentblip",
        "name": "agentblip-3f",
        "agents": 1,
        "subagents": 0,
        "startedAt": 1751830000000,
        "updatedAt": 1751830042000,
        "stateSince": 1751830031000
      }
    ],
    "working": 1,
    "waiting": 0,
    "idle": 0,
    "total": 1,
    "latestActivity": "editing format.ts",
    "signature": "…"
  },
  "formatted": {
    "text": "claude agent working",
    "emoji": ":robot_face:",
    "expirationSec": 1751830342
  },
  "paused": false,
  "pausedUntil": 1751871600000,
  "ownership": {
    "backedOff": false,
    "savedPrior": false,
    "policy": "respect"
  }
}
```

Per session: `stateSince` is when the current state began; `background: true` marks a
working session that is only waiting on its own shells or subagents; `cwd` and `name`
are local-only (never formatted into Slack); `subagents` counts agents running under the
session (its own `agents − 1` plus workflows naming it as `orchestrator`), and
`foldedInto` marks a session already counted in another row. `pausedUntil` is present
while snoozed.

| `ownership` field | Meaning |
|---|---|
| `backedOff` | `true` while the daemon is standing down because a status it didn't set is up; it resumes when that status clears |
| `savedPrior` | `true` when a foreign status was displaced under `statusPolicy: "overwrite"` and will be restored when sessions end (boolean, not the status itself — the relay never exposes another app's status text) |
| `policy` | The active `statusPolicy`: `"respect"` or `"overwrite"` |

## The event schema

`POST /event` bodies are validated against `sessionEventSchema` from
[`@workmesh/core`](../packages/core/src/events.ts):

| Field | Type | Required | Notes |
|---|---|---|---|
| `source` | string, 1–64 chars | yes | Adapter id: `"claude-code"`, `"codex"`, or your own slug |
| `sessionId` | string, 1–128 chars | yes | Stable per session — `(source, sessionId)` identifies the session |
| `kind` | enum | yes | `start` \| `working` \| `waiting` \| `idle` \| `heartbeat` \| `end` |
| `activity` | string, ≤200 chars | no | Short label of what's happening, e.g. `"editing format.ts"` |
| `project` | string, ≤120 chars | no | Usually the basename of the session's cwd |
| `agents` | int, 1–999 | no | How many concurrent agents this one session represents (default 1). Orchestrators set it so `agentCount` = total agents, not sessions |
| `phase` | string, ≤60 chars | no | Orchestrator phase label, e.g. `"verify"` or `"2/4"`; appended to the status |
| `orchestrator` | string, ≤200 chars | no | Session key (`source:sessionId`) whose row already accounts for this session's agents |
| `background` | boolean | no | With `working`: only waiting on its own background work. Cleared by the next working event without it |
| `cwd` | string, ≤1024 chars | no | Full working directory, local only (menu bar "Reveal in Finder") |
| `name` | string, ≤120 chars | no | Human session name, local only |
| `detail` | object | no | Local-only hook facts for the hub forwarder: `hookEvent`, `tool`, `filePath` (absolute), `filePaths`, `command`, `prompt`, `toolResponseText`, `ok`, `desc` (one-line tool description), `transcriptPath`, `lastAssistantMessage`. Never stored on the session, never in the Slack status, never sent to the relay; the hub forwarder reduces it to metadata, plus redacted prompt text, descriptions and transcript messages when the person shares at the `conversation` level (see the README's "Hub forward"). A malformed `detail` is dropped, the event is kept |
| `ts` | positive int | no | Epoch **milliseconds**; defaults to receipt time |

`GET /state`'s snapshot reports both `working` (number of working *sessions*) and
`agentCount` (sum of each working session's `agents`). "N agents working" uses
`agentCount`, so one session that reports `agents: 5` shows as five. The
[`agentblip report`](#) command is the friendly wrapper for this — see the README's
"Report a fan-out" section.

Well-known sources get friendly display names in status text (`claude-code` →
`claude`, `codex`, `gemini-cli` → `gemini`, `cursor`, `opencode`); anything else
displays as-is.

## Event kinds

| `kind` | Meaning | Session state after |
|---|---|---|
| `start` | Session opened, not yet working | idle |
| `working` | Agent is actively doing something | working |
| `waiting` | Agent blocked on the human (permission prompt, question) | waiting |
| `idle` | Turn finished, session still open | idle |
| `heartbeat` | Refresh liveness without changing state | unchanged (idle if the session is new) |
| `end` | Session closed | removed |

Details worth knowing:

- **Activity is sticky while working.** A `working` event without an `activity`
  keeps the previous label — tool chatter often arrives label-less between richer
  events. `project`, `agents`, and `phase` are sticky the same way, so a bare
  heartbeat won't wipe an orchestrator's reported fan-out. All of them reset when
  the session is demoted to idle.
- **Out-of-order events are dropped.** An event whose `ts` is older than the
  session's last event is ignored.
- **Only working sessions surface an activity.** The status shows the most recently
  updated working session's label.

## Staleness rules

The daemon assumes adapters die without saying goodbye, so liveness is enforced
(constants from `@workmesh/core`):

- A `working` session silent for **3 minutes** is demoted to idle and its activity
  cleared (a `waiting` one gets **30 minutes**, since waiting is quiet by design).
  During long operations, send `heartbeat` (or repeat `working`) more often than that.
- Claude Code sessions also get a process check every 15 seconds: one whose process
  is gone for **2 minutes** without a `SessionEnd` is ended, and one Claude Code
  reports busy is kept working without hook events.
- An idle session silent for **15 minutes** is evicted entirely.
- Independently, the Slack status itself carries a rolling **5-minute** expiration —
  if the whole daemon dies, Slack clears the status on its own.

Don't worry about event volume: the daemon debounces Slack pushes (10s default) and
only pushes when the formatted status actually changes. Fire events as often as you
like.

## curl examples

Start working:

```bash
curl -s -X POST http://127.0.0.1:4519/event \
  -H "authorization: Bearer $(cat ~/.local/state/agentblip/daemon.secret)" \
  -H "content-type: application/json" \
  -d '{"source":"my-agent","sessionId":"run-42","kind":"working","activity":"training model","project":"acme-api"}'
```

Finish:

```bash
curl -s -X POST http://127.0.0.1:4519/event \
  -H "authorization: Bearer $(cat ~/.local/state/agentblip/daemon.secret)" \
  -H "content-type: application/json" \
  -d '{"source":"my-agent","sessionId":"run-42","kind":"end"}'
```

Wrap any long-running command in a blip:

```bash
blip() {
  local label="$1"; shift
  local sid="shell-$$-$RANDOM"
  local url="http://127.0.0.1:4519/event"
  local state="${XDG_STATE_HOME:-$HOME/.local/state}/agentblip"
  local auth="authorization: Bearer $(cat "$state/daemon.secret")"
  curl -s -o /dev/null -X POST "$url" -H "$auth" -H "content-type: application/json" \
    -d "{\"source\":\"shell\",\"sessionId\":\"$sid\",\"kind\":\"working\",\"activity\":\"$label\",\"project\":\"$(basename "$PWD")\"}"
  "$@"
  local code=$?
  curl -s -o /dev/null -X POST "$url" -H "$auth" -H "content-type: application/json" \
    -d "{\"source\":\"shell\",\"sessionId\":\"$sid\",\"kind\":\"end\"}"
  return $code
}

blip "running the eval suite" npm test
```

For shell scripting without hand-rolled curl, `agentblip emit` wraps `POST /event`,
and `agentblip hook <source>` adapts hook JSON on stdin into events.

## Writing an adapter

1. **Pick a stable `source` slug** (lowercase, ≤64 chars). It's how sessions are
   grouped and how the agent is named in status text.
2. **Reuse one `sessionId` per session or run.** New id → new blip; same id → state
   transitions on the same blip.
3. **Map your tool's lifecycle onto kinds**: `start` when a session opens, `working`
   with a short `activity` as work happens, `waiting` whenever the human must act,
   `idle` at turn end, `end` on close.
4. **Heartbeat through long silences** — anything quieter than 3 minutes gets demoted
   to idle by design.
5. **Leave secrets out of `activity` and `project`.** These strings can end up in a
   Slack status at `activity` granularity. Users can also scrub patterns client-side
   via `redactPatterns`, but the best redaction is the string you never sent.

The Claude Code, Codex, and workflow adapters in
[`packages/cli/src/adapters/`](../packages/cli/src/adapters/) are the reference
implementations.

## Workflow watcher (ultracode fan-out)

Claude Code fires hooks per session, so a single session that fans out into an
ultracode `Workflow` can't tell agentblip how many agents are running. The daemon's
`workflow` adapter fills that gap: it polls Claude Code's per-workflow journals
(`~/.claude/projects/**/subagents/workflows/*/journal.jsonl`), where each agent writes
a `started` line on spawn and a `result` line on finish. Live agents = `started −
result`. Each workflow is reported as a `workflow:<runId>` session with that `agents`
count, and cleared when it drains. No hooks, no setup — it just works while the daemon
runs. It depends on Claude Code's internal layout, so it degrades to a no-op if the
directory or format isn't what it expects. Toggle via `adapters.workflow.enabled`.

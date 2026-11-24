# Bullpen v0 ("See"): build contract

Bullpen (working name) is a hub where every teammate's coding agents and the people they work for share one live
board. v0 is read-only visibility: every Claude Code and Codex session that Sean, An and Gio run on B3 repos shows on
one board, with each tool call as a metadata line within 5 seconds. Linear stays the team's system of record.

Linear: parent B3-7165, this phase B3-7166 (project "B3OS Beta"). Research behind it: the Linear document
"Research: multiplayer agents".

Two halves, built against this file:

| Half | Where | What |
|---|---|---|
| Relay | `seangeng/agentblip` (MIT, already installed on Sean's Mac) | A generic "hub forward" output in agentblip's daemon, plus Codex hook support and a `hub` command group. |
| Hub + board | this repo, `b3-fun/bullpen` | Cloudflare Worker + one Durable Object per project, and the board (React SPA) served by the same Worker. |

If this file and the code disagree, fix one of them in the same change.

---

## 1. Deployment facts (fixed)

- Cloudflare account: NPC Labs `4300a93c2dcb252fa91df03f18e8e44c`. Pin `account_id` in `wrangler.jsonc`. Never deploy
  to another account.
- Worker name `bullpen`, host `https://bullpen.sean-430.workers.dev`.
- Cloudflare Access (team domain `npclabs.cloudflareaccess.com`) is already configured:
  - App "Bullpen board" on the whole host: allow emails at `npclabs.org`. AUD tag
    `a3f9a834dccc7096ab27aa4f3470df3b5bd14618c40e641e92b751b696b70f63`.
  - App "Bullpen relay" on `/relay/*`: bypass (no Access login). The Worker authenticates these requests with device
    tokens.
- The Worker MUST verify the Access JWT itself on every `/api/*` request (header `Cf-Access-Jwt-Assertion`,
  RS256, keys from `https://npclabs.cloudflareaccess.com/cdn-cgi/access/certs`, `aud` = the board AUD above, `iss` =
  `https://npclabs.cloudflareaccess.com`). No valid JWT → 401. Never trust `Cf-Access-Authenticated-User-Email` alone.
  For local dev only, `DEV_USER_EMAIL` (a var that must be unset in production) skips the check.

## 2. Identity

- A **person** is an Access email (`an@npclabs.org`). Display name = the local part capitalized (`An`), overridable in
  the hub's `people` table later.
- A **device** is one machine paired by one person. Tokens: `bp_` + 64 lowercase hex, shown once; the hub stores only
  SHA-256. A device belongs to one project.
- A **session** is one agent session on one device. Hub key = `<deviceId>:<source>:<sessionId>`. The relay never
  chooses the owner: the hub takes it from the device token.

v0 has one project, id `b3`, name "B3". Its sharing rule (sent to relays at pairing):

```json
{ "include": { "remotes": ["github.com/b3-fun/"], "dirs": [] }, "issueKeys": ["B3"] }
```

## 3. Relay → hub wire format (v1)

All relay endpoints live under `/relay/*`, JSON bodies, max 256 KB per request.

### 3.1 Pairing (device-code flow, same shape as agentblip's Slack pairing)

`POST /relay/pair/start` `{ "machine": "seans-mac-studio", "client": "agentblip/0.6.0" }`
→ `{ "code": "ABCD-1234", "deviceId": "dev_<ulid>", "pollSecret": "<32 hex>", "verifyUrl": "https://bullpen.sean-430.workers.dev/pair?code=ABCD-1234", "expiresInSec": 600 }`

The person opens `verifyUrl` (Access login), sees "Connect *seans-mac-studio* to B3 as *Sean*?", and approves:
`POST /api/pair/approve { "code": "ABCD-1234" }` (Access-authenticated).

`POST /relay/pair/poll` `{ "deviceId", "pollSecret" }`
→ `{ "status": "pending" | "complete" | "expired", "deviceToken"?: "bp_…", "person"?: { "email", "name" }, "project"?: { "id": "b3", "name": "B3", "include": {…}, "issueKeys": [...] } }`
`deviceToken` is returned exactly once, on the first `complete` poll. Codes expire after 10 minutes. Rate limit pair
starts to 10 per IP per hour.

### 3.2 Ingest

`POST /relay/ingest`, `Authorization: Bearer bp_…`

```jsonc
{
  "v": 1,
  "sentAt": 1795545600000,           // epoch ms
  "full": false,                      // true on heartbeat: `sessions` is the complete shared set for this device
  "sessions": [SessionUpsert],        // sessions whose shared fields changed since the last send (or all, if full)
  "events": [ActivityEvent]           // new events, oldest first, at most 500
}
```

`SessionUpsert`:

| Field | Type | Notes |
|---|---|---|
| `key` | string ≤ 200 | `<source>:<sessionId>`, unique on the device |
| `source` | string ≤ 64 | `claude-code`, `codex`, `workflow`, or a custom id |
| `name` | string ≤ 120, opt | session name, e.g. Claude Code's `documents-07` |
| `state` | `working` \| `waiting` \| `idle` \| `ended` | `waiting` = blocked on its own person |
| `activity` | string ≤ 200, opt | agentblip's label: "editing vm.rs", "running commands", "needs my input" |
| `background` | bool, opt | working only on its own background shells/subagents |
| `agents` | int 1–999, opt | concurrent agents this session represents (workflow fan-out) |
| `phase` | string ≤ 60, opt | orchestrator phase label |
| `orchestrator` | string ≤ 200, opt | `key` of the session that launched this one |
| `repo` | string ≤ 200, opt | `b3-fun/b3os-beta` (owner/name, from the git remote) |
| `branch` | string ≤ 200, opt | current branch of that repo |
| `issues` | string[] ≤ 20, opt | Linear ids seen in this session (`B3-7166`) |
| `startedAt`, `updatedAt`, `stateSince` | epoch ms | |

`ActivityEvent`:

| Field | Type | Notes |
|---|---|---|
| `id` | string ≤ 40 | relay-generated, unique; the hub dedupes on `(deviceId, id)` |
| `key` | string | session key |
| `ts` | epoch ms | |
| `kind` | `start` \| `prompt` \| `tool` \| `waiting` \| `idle` \| `end` | `prompt` = the person sent a message (text never sent) |
| `tool` | string ≤ 64, opt | tool name only: `Edit`, `Bash`, `apply_patch`, `shell` |
| `label` | string ≤ 200, opt | agentblip activity label |
| `path` | string ≤ 400, opt | repo-relative path, only inside an included repo |
| `cmd` | string ≤ 60, opt | program and allow-listed subcommand only, e.g. `cargo test`, `gh pr create` |
| `repo`, `branch` | string, opt | repo the event touched |
| `issues` | string[], opt | Linear ids extracted locally |
| `pr` | string ≤ 300, opt | PR URL on an included repo, e.g. opened by `gh pr create` |
| `ok` | bool, opt | tool succeeded (when the CLI reports it) |

Responses: `200 { "ok": true, "accepted": <events stored> }`; `400` schema error (the hub rejects the whole request
and logs why); `401` unknown or revoked token (the relay stops forwarding and tells the person to re-pair); `413`
over 256 KB; `429` with `Retry-After`.

### 3.3 What may leave a machine (relay rules, enforced in agentblip)

The relay sends **only** the fields above. Never: prompt text, assistant text, tool input or output, file contents,
full commands or arguments beyond the allow-listed subcommand, environment variables, absolute paths, or anything
from a repo outside the include rule.

Inclusion:
1. Resolve a path (a file tool's path, or the session's cwd) to its git root and `origin` remote; cache per root.
   Worktrees count as their main repository.
2. A path is **shared** when its remote URL contains an `include.remotes` entry, or it sits under an `include.dirs`
   entry (absolute dirs added locally by the person).
3. A session is **shared** once its cwd is shared or any of its file events touched a shared path. Unshared sessions
   send nothing.
4. In a shared session whose cwd is NOT shared (e.g. an orchestrator started in `~/Documents`): forward state changes,
   `prompt` events (no text), file events on shared paths, and Bash/shell events only when the command mentions an
   absolute path inside a shared root seen in that session. Drop the rest.
5. `cmd`: the first token's basename plus one subcommand word, only when the program is on the allow list (`git`,
   `gh`, `cargo`, `pnpm`, `npm`, `npx`, `bun`, `yarn`, `node`, `python`, `python3`, `pytest`, `go`, `make`, `just`,
   `wrangler`, `linear`, `docker`, `kubectl`, `terraform`, `rustc`, `tsc`, `vitest`, `jest`, `biome`, `eslint`,
   `prettier`, `uv`, `pip`) and the subcommand matches `^[a-z][a-z0-9:-]{0,24}$`. Otherwise just the program name if
   it is on the list, else nothing.
6. `issues`: ids matching `\b(KEY)-\d{1,6}\b` for each `issueKeys` entry, extracted locally from prompts, Bash
   commands and PR titles. Only the ids leave the machine.
7. `pr`: the first `https://github.com/<owner>/<repo>/pull/<n>` in a `gh pr create|view|merge` tool response, when
   `<owner>/<repo>` is shared.

Cadence: batch every 1 s while there are events; heartbeat with `full: true` every 30 s. On network failure, keep
up to 5,000 events in memory and resend (dedupe makes resends safe); beyond that drop the oldest and count them.

## 4. Hub

- Worker (Hono). Routes: `/relay/*` (device token), `/api/*` (Access JWT), everything else = static board assets
  (SPA fallback).
- Durable Object `Project` (SQLite storage), one instance per project id (`b3`). It owns devices, pairing codes,
  sessions, events and the board's WebSockets (hibernation API).
- Tables (sketch, refine as needed): `people(email, name)`, `devices(id, email, machine, client, token_hash,
  created_at, last_seen_at, revoked_at)`, `pairings(code, device_id, poll_secret_hash, machine, client, created_at,
  approved_by, delivered)`, `sessions(hub_key PK, device_id, email, source, key, name, state, activity, background,
  agents, phase, orchestrator, repo, branch, issues_json, started_at, updated_at, state_since, ended_at)`,
  `events(device_id, id, hub_key, ts, kind, tool, label, path, cmd, repo, branch, issues_json, pr, ok,
  PRIMARY KEY(device_id, id))`.
- Retention: events 7 days (an alarm prunes hourly); ended sessions drop off the board after 12 h; a device with no
  ingest for 2 min shows its sessions as `offline`.
- Board API (Access): `GET /api/me`, `GET /api/state` (people, devices, sessions, last 300 events),
  `GET /api/sessions/:hubKey/events?before=<ts>&limit=200`, `GET /api/stream` (WebSocket: server pushes
  `{type:"session", session}`, `{type:"events", events}`, `{type:"device", device}`), `POST /api/pair/approve`,
  `GET /api/devices` (mine), `POST /api/devices/:id/revoke` (mine only).
- Every ingest updates `devices.last_seen_at`, upserts sessions (owner from the token), inserts events (dedupe),
  and broadcasts the changes to connected boards.

## 5. Board (v0)

Read the mock in `docs/research.html` (section "The board"). Three columns, left to right:

1. **Waiting on a person**: sessions in `waiting`, the viewer's own first, with how long they have waited.
2. **People**: one lane per person (Sean, An, Gio), their sessions grouped by repo: state dot, session name, activity,
   branch, issue chips (link to `https://linear.app/npclabs/issue/<id>`), subagent count, age of last event. Ended
   and offline sessions dimmed and collapsed under the lane.
3. **Live tail**: the selected session's events (all shared sessions when nothing is selected), newest at the top,
   one line each: time, who, tool and path or `cmd`, PR links.

Top bar: project name, counts (agents working, waiting on people, people online), and "Connect a machine" (a dialog
with the one command to run). `/pair?code=…` is the approve page. Empty state explains how to connect the first
machine.

Design: the B3 brand used in `docs/research.html`: Manrope for text, Geist Mono for machine data, zinc neutrals,
`#306AFF` as the only signal colour, light and dark themes, calm motion (rows ease in, no pulsing except the live
dot). Radix primitives for dialogs and menus; no native `alert`/`confirm`. Works at 1280 px and at 400 px.

## 6. Relay (agentblip) changes

- `SessionEvent` gains an optional local-only `detail` (`tool`, `filePath` absolute, `command` raw, `prompt` raw,
  `toolResponseText` truncated, `ok`) filled by the Claude Code and Codex hook mappers. It travels hook → daemon on
  loopback only, never to Slack or the agentblip relay, and the forwarder reduces it to the hub fields above.
- New `HubForwarder` in the daemon, enabled when config has `hub`. It runs beside the Slack pusher and never blocks it.
- `agentblip hub connect <url>` (pairing), `agentblip hub status`, `agentblip hub disconnect`,
  `agentblip hub include <dir>` / `exclude <dir>`.
- Codex: install hooks into `~/.codex/hooks.json` (merge, never overwrite existing entries) for SessionStart,
  UserPromptSubmit, PreToolUse, PostToolUse, Stop and SessionEnd, mapped like Claude Code. Keep the `notify` path as
  a fallback.

## 7. Done means

An opens `https://bullpen.sean-430.workers.dev`, signs in with Access, and sees every B3 session Sean is running, each
tool call within 5 seconds, with nothing from non-B3 repos and no prompt or file text anywhere in the hub's storage.

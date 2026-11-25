# Workmesh team hub: build contract

Workmesh (named Bullpen until 2026-11-24) is a hub where every teammate's coding agents and the people they work for
share one live board. v0 is read-only visibility: every Claude Code and Codex session that Sean, An and Gio run on B3
repos shows on one board, with each tool call as a metadata line within 5 seconds. Linear stays the team's system of
record.

Linear: parent B3-7165, this phase B3-7166 (project "B3OS Beta"). Research behind it: the Linear document
"Research: multiplayer agents".

Three parts of one repo, `b3-fun/workmesh`, built against this file (§14 has the layout):

| Part | Where | What |
|---|---|---|
| Relay | `packages/cli` (`@b3os/workmesh`, formerly agentblip) | A generic "hub forward" output in the daemon, plus Codex hook support and a `hub` command group. |
| Protocol | `packages/protocol` (`@workmesh/protocol`) | §3 and §10 as code: the wire schemas both sides validate against. |
| Hub + board | `apps/hub` (`@workmesh/hub`) | Cloudflare Worker + one Durable Object per project, and the board (React SPA) served by the same Worker. |

If this file and the code disagree, fix one of them in the same change. Sections 1–13 were written while the hub was
Bullpen and the relay was agentblip, in separate repos; where they say agentblip, read the Workmesh CLI.

---

## 1. Deployment facts (fixed)

- Cloudflare account: NPC Labs `4300a93c2dcb252fa91df03f18e8e44c`. Pin `account_id` in `apps/hub/wrangler.jsonc`.
  Never deploy to another account.
- Host `https://workmesh.b3os.org`, and `https://bullpen.b3os.org` kept as an alias so relays paired there keep
  working (both Workers custom domains on the NPC Labs zone `b3os.org`). `workers_dev` and `preview_urls` are off, so
  the only ways in are the Access-protected custom domains.
- Worker script name `bullpen`: its Durable Object holds every pairing, session and event, and a Worker under a new
  name would start with an empty one. Keep the name.
- Cloudflare Access (team domain `npclabs.cloudflareaccess.com`) is configured on both hosts, one audience:
  - The board app on the whole host: allow emails at `npclabs.org`. AUD tag
    `a3f9a834dccc7096ab27aa4f3470df3b5bd14618c40e641e92b751b696b70f63`.
  - The relay app on `/relay/*`: bypass (no Access login). The Worker authenticates these requests with device
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

### 3.1 Pairing (device-code flow, same shape as the relay's Slack pairing)

`POST /relay/pair/start` `{ "machine": "seans-mac-studio", "client": "workmesh/0.8.0" }`
→ `{ "code": "ABCD-1234", "deviceId": "dev_<ulid>", "pollSecret": "<32 hex>", "verifyUrl": "https://workmesh.b3os.org/pair?code=ABCD-1234", "expiresInSec": 600 }`

The person opens `verifyUrl` (Access login), sees "Connect *seans-mac-studio* to B3 as *Sean*?", and approves:
`POST /api/pair/approve { "code": "ABCD-1234" }` (Access-authenticated).

`POST /relay/pair/poll` `{ "deviceId", "pollSecret" }`
→ `{ "status": "pending" | "complete" | "expired", "deviceToken"?: "bp_…", "person"?: { "email", "name" }, "project"?: { "id": "b3", "name": "B3", "include": {…}, "issueKeys": [...] } }`
`deviceToken` is returned exactly once, on the first `complete` poll. Codes expire after 10 minutes. Rate limit pair
starts to 10 per IP per hour (`429` with `Retry-After`).

Errors: poll with an unknown `deviceId` or a wrong `pollSecret` → `401`. Approve: unknown code `404`, already approved
by someone else `409`, expired `410`. A code approved in time delivers its token on the next poll. The approve page
reads the pairing with `GET /api/pair/:code` → `{ code, machine, client, status: "pending" | "approved" | "expired",
expiresAt, approvedBy }`.

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
| `activity` | string ≤ 200, opt | the relay's label: "editing vm.rs", "running commands", "needs my input" |
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
| `label` | string ≤ 200, opt | the relay's activity label |
| `path` | string ≤ 400, opt | repo-relative path, only inside an included repo |
| `cmd` | string ≤ 60, opt | program and allow-listed subcommand only, e.g. `cargo test`, `gh pr create` |
| `repo`, `branch` | string, opt | repo the event touched |
| `issues` | string[], opt | Linear ids extracted locally |
| `pr` | string ≤ 300, opt | PR URL on an included repo, e.g. opened by `gh pr create` |
| `ok` | bool, opt | tool succeeded (when the CLI reports it) |

Responses: `200 { "ok": true, "accepted": <events stored> }`; `400` schema error (the hub rejects the whole request
and logs why); `401` unknown or revoked token (the relay stops forwarding and tells the person to re-pair); `413`
over 256 KB; `429` with `Retry-After`.

Hub-side validation (a second guard on §3.3; any failure rejects the whole request with `400` and the failing field
paths, never the values):
- Unknown fields are dropped, so nothing outside these tables is stored. Optional fields may be omitted or `null`.
- `repo` is `owner/name`. `path` is repo-relative: no leading `/`, `\`, `~` or drive letter, and no `..` segment.
- `cmd` matches `^[a-z0-9][a-z0-9._-]{0,30}( [a-z][a-z0-9:-]{0,24}){0,2}$`: a program and at most two subcommand
  words, so `gh pr create` (the example in the `cmd` row) passes and arguments do not.
- Epoch-ms fields that arrive fractional are rounded, not rejected.
- `issues` entries look like `B3-7166`; `pr` is `https://github.com/<owner>/<repo>/pull/<n>`; `tool` is `[A-Za-z0-9_.:-]+`.
- At most 1,000 sessions and 500 events per request.

Order of checks: `413`, then `401` for a missing or malformed token, then `400`, then `401` for an unknown or revoked
token. `429` after 300 requests per device per minute. On `full: true`, the device's sessions that are missing from
`sessions` and not already ended are marked `ended`.

### 3.3 What may leave a machine (relay rules, enforced in `packages/cli`)

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
  As built, `sessions` also has `last_event_at` and `seen_at` (hub clock, last ingest that carried the session), and
  `events` has `email` (owner, from the token) and `received_at`. A `pair_starts(ip_hash, ts)` table backs the
  pair-start limit; IPs are stored only as SHA-256.
- Retention: events 7 days (an alarm prunes hourly); ended sessions drop off the board after 12 h, and so do sessions
  no ingest has carried for 12 h; a device with no ingest for 2 min shows its sessions as `offline` (the board
  computes this from `devices.lastSeenAt`). Sessions unseen for 7 days and pairings older than a day are deleted.
- Board API (Access): `GET /api/me`, `GET /api/state` (project, me, people, devices, sessions, last 300 events newest
  first, `serverNow`, and since v0.2 `summarizer` and `digest`), `GET /api/sessions/:hubKey/events?before=<ts>&limit=200` (`limit` ≤ 500),
  `GET /api/stream` (WebSocket: server pushes `{type:"hello", serverNow}` on connect, then
  `{type:"session", session}`, `{type:"events", events}`, `{type:"device", device}`; the client may send `ping` and
  gets `pong`), `GET /api/pair/:code`, `POST /api/pair/approve`, `GET /api/devices` (mine),
  `POST /api/devices/:id/revoke` (mine only; also ends that device's open sessions). Non-GET `/api/*` requests with
  a foreign `Origin` get `403`.
- Every ingest updates `devices.last_seen_at`, upserts sessions (owner from the token), inserts events (dedupe),
  and broadcasts the changes to connected boards.
- Local dev: with `DEV_USER_EMAIL` set (and `ENVIRONMENT` not `production`) the Worker skips Access and the viewer is
  `DEV_USER_EMAIL`, or the `X-Dev-User-Email` header so the fake relay can approve as Sean, An and Gio. If
  `DEV_USER_EMAIL` is set while `ENVIRONMENT` is `production`, every `/api/*` request gets `500`.

## 5. Board (v0)

The mock is in the Linear document "Research: multiplayer agents" (section "The board"). Three columns, left to right:

1. **Waiting on a person**: sessions in `waiting`, the viewer's own first, with how long they have waited.
2. **People**: one lane per person (Sean, An, Gio), their sessions grouped by repo: state dot, session name, activity,
   branch, issue chips (link to `https://linear.app/npclabs/issue/<id>`), subagent count, age of last event. Ended
   and offline sessions dimmed and collapsed under the lane.
3. **Live tail**: the selected session's events (all shared sessions when nothing is selected), newest at the top,
   one line each: time, who, tool and path or `cmd`, PR links.

Top bar: project name, counts (agents working, waiting on people, people online), and "Connect a machine" (a dialog
with the one command to run). `/pair?code=…` is the approve page. Empty state explains how to connect the first
machine.

Design (v0.1): the B3 brand used in the research document. Superseded by §13: the board is a B3OS console surface.

## 6. Relay changes (then agentblip, now `packages/cli`)

- `SessionEvent` gains an optional local-only `detail` (`tool`, `filePath` absolute, `command` raw, `prompt` raw,
  `toolResponseText` truncated, `ok`) filled by the Claude Code and Codex hook mappers. It travels hook → daemon on
  loopback only, never to Slack or the Slack-status relay, and the forwarder reduces it to the hub fields above.
- New `HubForwarder` in the daemon, enabled when config has `hub`. It runs beside the Slack pusher and never blocks it.
- `workmesh hub connect <url>` (pairing), `workmesh hub status`, `workmesh hub disconnect`,
  `workmesh hub include <dir>` / `exclude <dir>`.
- Codex: install hooks into `~/.codex/hooks.json` (merge, never overwrite existing entries) for SessionStart,
  UserPromptSubmit, PreToolUse, PostToolUse, Stop and SessionEnd, mapped like Claude Code. Keep the `notify` path as
  a fallback.

## 7. Done means

An opens `https://workmesh.b3os.org`, signs in with Access, and sees every B3 session Sean is running, each
tool call within 5 seconds, with nothing from non-B3 repos and no prompt or file text anywhere in the hub's storage.

---

# v0.2: conversation view and summaries (Sean, 2026-11-24)

Sean: "use a small llm or something to help summarize ... to improve the UX" and "show way more detail, like the
prompts + updates as we go", like Claude Code's own transcript (prompts, the agent's text updates, grouped tool calls
such as "Ran 2 shell commands", turn durations).

## 8. Sharing levels (per device)

| Level | What leaves the machine, beyond §3.3 metadata |
|---|---|
| `metadata` | Nothing more (v0 behavior). |
| `conversation` | Prompt text, the agent's text messages, a one-line description per tool call, turn ends with duration. |

- Chosen at `workmesh hub connect` (`--share conversation|metadata`; in a TTY without the flag, ask, default
  `conversation` when the hub's project rule says `defaultShare: "conversation"`, which project `b3` does). Changeable
  any time with `workmesh hub share <level>`. The approve page and the CLI both state plainly what the chosen level
  shares, and the board marks metadata-only people.
- Hub side: `POST /relay/pair/start` takes an optional `share` (the level the relay will use) so the approve page can
  name it; `GET /api/pair/:code` returns it as `share` (null when the relay didn't say). The poll's `project` carries
  `defaultShare`.
- A device that goes from `conversation` back to `metadata` loses its text on the hub at once: prompt and message
  text, tool descriptions, turn summaries, now lines and waiting reasons from it are cleared, cached digests are
  dropped, and boards get `{type:"purge", deviceId}`.
- Only shared sessions (§3.3 rules 1–4) send anything. A session that becomes shared mid-way sends conversation text
  only from that moment on; nothing written before it was shared is ever sent.
- Every ingest body carries `share`; the hub stores it per device and drops any text fields from a `metadata` device.

## 9. Relay additions

- **Redaction, on the machine, before anything is queued:** API keys and tokens (Anthropic `sk-ant-…`, OpenAI `sk-…`,
  GitHub `ghp_/gho_/ghu_/ghs_/ghr_` and `github_pat_`, Slack `xox?-`, AWS `AKIA…`, npm `npm_…`, Linear `lin_api_…`,
  hub device tokens `bp_…`), JWTs, PEM private key blocks, `Bearer <token>`, `key|secret|token|password = value` pairs, URLs with
  embedded credentials, and long high-entropy strings next to those words → `[redacted]`. Absolute home paths →
  `~/…`. A unit-tested list; a privacy test feeds a corpus of real-looking secrets through the whole pipeline.
- **Prompts:** from UserPromptSubmit `prompt` (Claude Code) and the Codex equivalent. Cap 4,000 chars (`truncated`).
- **Agent messages:** tail the session transcript (`transcript_path` from the hook payload; Codex rollout file) from
  a saved byte offset, read on every hook event for a shared session and on Stop, and emit each assistant text block
  (never thinking, never tool results) as a `message` event. Cap 4,000 chars each. Main thread only in this pass;
  subagent transcripts are skipped.
- **Tool descriptions (`desc`, ≤ 200):** Bash `description`; Agent/Task `description`; WebSearch query; WebFetch host;
  Skill name; MCP tools as `server · tool`. Paths and `cmd` as in §3.3.
- **Turns:** a `turn` event at Stop with `durationMs` (from the transcript's turn-duration record when present, else
  prompt → stop).

## 10. Wire additions (still `v: 1`; all optional, old relays keep working)

- Body: `share: "metadata" | "conversation"`. Absent (relays before v0.2) means `metadata`.
- `ActivityEvent.kind` adds `message` and `turn`.
- `ActivityEvent` adds `text` (≤ 4,000; on `prompt` and `message`), `truncated` (bool), `desc` (≤ 200), `durationMs`.
- The relay splits batches to stay under 256 KB.
- Hub side: lengths count UTF-16 code units (JS `string.length`). Text over 4,000 and `desc` over 200 are cut and
  marked `truncated` instead of failing the batch (a redaction can lengthen text after the relay's cap); over 16,000
  and 1,000 they are schema errors. `text` is kept on `prompt` and `message` only; a `message` without text is
  dropped. As a second guard behind §9, the hub replaces obvious credentials in `text` and `desc` (the §9 token
  shapes, JWTs, PEM blocks, `Bearer` values, credentials in URLs) with `[redacted]` before storing them.
- Storage: `events` gains `text`, `truncated`, `descr` (the wire's `desc`), `duration_ms` and `summary`; `devices`
  and `pairings` gain `share`; `sessions` gains `now_line`, `now_at`, `waiting_reason` and summary bookkeeping.
  Board types carry them as `HubEvent.text/truncated/desc/durationMs/summary`, `Session.nowLine/nowAt/waitingReason`
  and `Device.share`.

## 11. Summaries (hub)

- Provider, chosen at runtime behind one interface (`apps/hub/src/worker/summaries/provider.ts`):
  1. **OpenRouter** when the Worker secret `OPENROUTER_API_KEY` is set: `POST https://openrouter.ai/api/v1/chat/completions`
     over plain fetch, headers `HTTP-Referer: https://workmesh.b3os.org` and `X-Title: Workmesh`. Model from the var
     `SUMMARY_MODEL`, default `anthropic/claude-haiku-5.5` ($0.10 / $0.50 per M tokens in November 2026, structured
     outputs); `SUMMARY_MODEL_FALLBACK` (comma-separated, default `openai/gpt-6-luna`) becomes OpenRouter's `models`
     fallback list. Requests use `response_format: json_schema` (strict) with `provider.require_parameters` and
     `reasoning.effort: "low"`; if no endpoint takes that (400/404), the hub retries once in JSON mode with the schema
     in the prompt and remembers it for that model. Any parse failure skips the summary. On an outage or rate limit
     the same request goes once to Workers AI, when bound; a refusal or a cut-off answer is final.
  2. **Workers AI** through the `AI` binding when no OpenRouter key is set: `@cf/google/gemma-4-26b-a4b-it` (2026,
     4B active parameters, JSON-schema output, reasoning off, $0.10 / $0.30 per M tokens).
  The board's footer names it: "Summaries by Claude Haiku 5.5 via OpenRouter" or "Summaries by Gemma 4 26B on
  Workers AI" (`BoardState.summarizer`; null = off).
- Outputs, all plain text, stored in the Durable Object and pushed to boards:
  1. **Now line** per session (≤ 90 chars): what the agent is doing right now, e.g. "Publishing agentblip 0.6.0;
     waiting on Sean's security key". Refreshed when a turn ends, when the state changes, and while working: at most
     every 30 s when new prompts or messages arrived, every 2 min when only tool calls did. Pushed as `session`.
  2. **Turn summary** (≤ 220 chars, one or two sentences) when a turn ends: asked → did → result or blocker. Stored
     on the `turn` event (`HubEvent.summary`), pushed as `{type:"turnSummary", deviceId, id, hubKey, summary}`.
  3. **Waiting reason** (≤ 80 chars) when a session enters `waiting`: what it needs from its person. Cleared when a
     new wait starts (the board shows the activity label until the new reason lands) and never written for a wait
     that ended while the model ran.
  4. **Digest** per viewer ("Since you looked", 1–4 lines ≤ 110 chars): a viewer back after more than 30 min away
     (last `/api/state`, socket close or socket ping) starts a visit; its digest covers turn summaries since they last
     looked, is built once off the request path, served in `/api/state` for 10 minutes, and pushed to that viewer's
     sockets as `{type:"digest", digest}`. No turn summaries in the window: no digest.
- Off the ingest path: ingest only records a job per session (`summary_jobs`, one row per session, triggers merged,
  due 1.5 s after the trigger so a burst lands together); the Durable Object's alarm, which also runs the hourly
  prune, runs due jobs (6 at a time). Ingest latency is unchanged.
- Metadata-only sessions are summarized from tools, paths, commands and issue ids alone.
- Guards: per session at least 10 s between calls; skip when nothing is new since the last now line (no newer event,
  same state); events older than 15 min on arrival (a resent backlog) trigger nothing; a daily cap per project
  (`SUMMARY_DAILY_CAP`, default 3,000 calls per UTC day), where now-line-only refreshes stop at 90 % so turn
  summaries, waiting reasons and digests keep working; outages and rate limits retry once a minute later; graceful
  degradation (no summary, never an error on the board) on refusal, rate limit or outage.
- Transcript text is untrusted input: it goes inside `<activity>` / `<turns>` tags that the system prompt calls
  material to describe, never instructions; the output is a JSON object; each field is flattened to one line, stripped
  of markup and capped before storage; the board renders it as text.
- Usage per UTC day (calls, failures, skips, tokens, milliseconds, cost when OpenRouter reports it) is kept in
  `summary_usage` and served at `GET /api/summaries`. Each call logs one JSON line (`msg: "summary"`, kind, provider,
  ms, tokens or failure reason), never the prompt or the output.

## 12. Board v0.2

- **Conversation view** for a selected session, modeled on Claude Code's transcript: header (person, session, repo,
  branch, state, now line, issues, PRs); turns in order, each with the prompt (full text, collapsible when long), the
  turn summary, the agent's messages as paragraphs (safe markdown subset: code spans and blocks, bold, lists, links;
  no raw HTML), consecutive tool calls folded into one line ("Ran 3 shell commands · Edited 2 files · Called
  claude-in-chrome 2 times") that expands to each call's tool, desc, path or cmd and failure, and a closing line
  "Worked for 1m 34s · 4:06 PM". New items stream in; the view follows the bottom unless the reader scrolled up.
- **Lanes** show the now line (falling back to the activity label); **Waiting** shows the waiting reason.
- **Digest strip** at the top when there is one; dismissible.
- **Metadata-only** sessions show the tool timeline and say the person shares activity only.

As built (v0.2):
- Selecting a session swaps the right column from the all-sessions live tail to the conversation and widens it
  (the lanes give up width); at 400 px the columns stack and the conversation scrolls on its own. The live tail
  shows one-line previews of prompts and messages and "turn ended · 1m 34s" rows.
- Prompts render verbatim (pre-wrapped, collapsed past 8 lines or 600 chars, "Cut at 4,000 characters" when
  `truncated`). Messages render through `apps/hub/src/board/lib/markdown.ts`: paragraphs, headings as bold lines, fenced
  code, inline code, bold, italics, nested lists, quotes, simple tables; links only for http(s) and mailto, opened
  with `target="_blank" rel="noopener noreferrer"`; everything else is text nodes, never HTML.
- Tool folds (`apps/hub/src/board/lib/transcript.ts`) group by kind in order of first appearance: shell commands, edited and
  read files (distinct paths), searches, web searches and fetches, agents, plan updates, skills, MCP calls per
  server, other tools by name; a failed call turns the fold's marker red and adds "· N failed".
- A now line written before the session's current working or waiting state began (a new turn whose refresh hasn't
  landed) is not shown; the relay's activity label stands in until it does. The relay's label also stays as a small
  trace under the summary.
- "Earlier" loads 500 events per page and hides once the session's start is loaded. (The layout, the digest and the
  footer changed in §13.)


---

# v0.3: the board as a B3OS console surface (Sean, 2026-11-24)

Sean: remove "Summaries by … via OpenRouter", "make it look more like b3os … utilizing that same matching style and
design principles", "copy it exactly, extracting components".

## 13. Board v0.3

- **Name:** the system (relay, hub and board) is **Workmesh** (Sean, 2026-11-24, tying in with B3IQ's Workcell). Every
  user-visible "Bullpen" on the board reads "Workmesh"; the connect dialog shows `npm i -g @b3os/workmesh` and
  `workmesh hub connect <this host>`. (The host, repo and code names followed in v0.4, §14.)

- **Built from the console's components, not redrawn.** `apps/hub/src/board/b3os/` is a verbatim copy, at the same paths, of
  b3os-beta `apps/web/src/` at `65e00f860` (the foundation kit, signature pixel pieces, primitives, the console's
  `primitives.tsx`, `AuthCard`, `ThemeSwitch`, `Icon`, and its stylesheets and tokens), plus four marked shims; its
  README lists what came over and how to refresh it. The design rules are the console's
  (`apps/web/docs/design-rules.md` at that commit).
- **Shell:** the console's `app-shell`: sidebar (wordmark and "Workmesh" chip, Connect a machine as the glossy create
  button, nav with the sliding pill and a pixel grid that plays on the hovered row: Board, Machines, then People, one
  row per person narrowing the board), Dark mode switch, account card; the page on the raised stage with its footer
  (the live connection's status on the left). Under 1024 px a sticky top bar and the sidebar in a drawer. Light by
  default (the console's theme bootstrap, `b3os-theme`, `?theme=dark`).
- **Routes:** `/` the board (`?person=<email>` narrows it), `/sessions/:hubKey` a session's conversation, `/machines`
  your machines, `/pair` the approve page.
- **Board** (Home's frame): `PageHeaderView` "Board"; the Attention line ("2 sessions waiting on a person", quiet
  "Nobody is waiting"); a `FigureStrip` (agents working, sessions open, people online); then, side by side from
  1280 px, the sessions waiting on a person and each person's sessions as `RowCard`s (the agent's real mark: Anthropic
  for Claude Code, OpenAI for Codex; state as a kit `Status`; the now line or waiting reason, repo, branch, issues as
  the meta line; age or wait as the value; copy the session id on hover) beside "Since you looked" (the digest, said
  once as panel content, dismissible) and Activity (the live tail). Ended and offline sessions fold under each person.
- **Session page:** a console detail page: back to Board, the agent's mark on the tile, the session's name and
  `Status`, the now line (or waiting reason) as its line, person and machine, repo, branch, issue and PR links as its
  meta line, copy id; then the transcript (§12) in a 760 px column on the console's tokens, `Working` (the pixel
  loader) while the agent works, a `Note` for activity-only sessions. It lands on the newest item and follows it.
- **Machines:** `RowCard`s for your machines (connected or offline, client, sharing level), Revoke through the shared
  `ConfirmDialog`; Connect a machine opens a `ResponsiveDialog` (a drawer on a phone) with the command on the dark code
  island and one `Note` on what is shared.
- **Approve page:** the console's CLI sign-in card (`Device.tsx`): `AuthHead`, the code large, the facts (machine,
  client, what it shares), Approve and Cancel; the animated check when connected; `AuthNote` with Retry when a lookup
  fails.
- **States:** a skeleton built from the page's own parts on the first read only (`PageReveal`); a failed board read
  says so once in the Attention slot with Retry, the figures showing dashes; failed history or machine reads show an
  `InlineError` with the request id (`cf-ray`) and Retry; empty states offer one way to start.
- **Removed:** the footer naming the summary model (nothing in the UI names a model or vendor), the digest banner, left
  and top accent bars.

---

# v0.4: one system, one repo (Sean, 2026-11-24)

Sean chose a single public monorepo: the relay, the hub and the board in `b3-fun/workmesh`, under one name.

## 14. Layout, protocol and hosts

- **Repo:** `b3-fun/workmesh` (public, MIT), npm workspaces with one root lockfile:

  | Path | Package | What |
  |---|---|---|
  | `packages/cli` | `@b3os/workmesh` (published) | The relay: CLI, daemon, hooks, hub forwarder, Slack sinks |
  | `packages/core` | `@workmesh/core` (private) | Session model, aggregation, Slack status formatting |
  | `packages/protocol` | `@workmesh/protocol` (private) | The relay ↔ hub wire format (§3, §8, §10) |
  | `apps/hub` | `@workmesh/hub` (private) | This hub: Worker, Durable Object, board, summaries |
  | `apps/menubar` | (SwiftPM) | Workmesh.app, the menu bar client of the daemon |
  | `app/`, `src/`, `workers/` | root | agentblip.com: the site and the Slack-status relay Worker |

  The hub came over from `b3-fun/bullpen` (now archived) with its history; each imported commit carries an
  `Imported-From: b3-fun/bullpen@<sha>` trailer. The research document stays in Linear ("Research: multiplayer
  agents"); it quotes teammates and is not in the repo.
- **One protocol:** `packages/protocol` is the code form of §3.1–3.2 and §10. Each body has two readings from the same
  field rules. The relay builds what it sends from the strict schemas (unknown keys fail, no `null`, integer epoch
  ms, `cmd` with one subcommand word, text ≤ 4,000 and `desc` ≤ 200). The hub reads with the accept schemas (§3.2's
  hub-side validation: unknown keys dropped, `null` as absent, fractional ms rounded, `cmd` with up to two subcommand
  words, text ≤ 16,000 and `desc` ≤ 1,000 for the hub to cut after its redaction pass). A body the strict schemas
  accept parses unchanged under the accept schemas, and both name the same fields; the protocol's tests hold both. A
  wire change is one edit there, and both sides' tests run against it.
- **Hosts:** `https://workmesh.b3os.org` is the hub's address in the board, the docs and the CLI's examples.
  `https://bullpen.b3os.org` serves the same Worker, so relays paired there keep sending without re-pairing; a
  pairing's verify URL names the host the relay asked. The Worker script stays `bullpen` (§1). Device tokens keep
  their `bp_` prefix.
- **Deploys:** the hub deploys by hand from `main` (`npm run deploy -w @workmesh/hub`, wrangler OAuth on an NPC Labs
  account) until CI has an NPC Labs Workers token. CI runs every workspace's tests and typecheck, the CLI build, the
  site build and the board build. agentblip.com still deploys from CI on every push to `main`.

---

# v0.5 and v0.6: the team in the menu bar, subagents, agent messages, links (Sean, 2026-11-24)

## 15. Wire additions (still `v: 1`; all optional, old hubs and old relays keep working)

The code form is `packages/protocol` (strict to send, accept to read, as in §14). An old hub drops the new keys
(unknown keys are dropped) and 400s the new event kind, so a relay holds `agent_message` events back for 10 minutes
after such a 400, as it does for `message`/`turn`.

`SessionUpsert` adds:

| Field | Type | Level | Notes |
|---|---|---|---|
| `parent` | string ≤ 200 | metadata | `key` of the session this one runs under (a subagent, a workflow agent) |
| `role` | `main` \| `subagent` \| `workflow` \| `background` | metadata | absent = a top-level session; the hub reads an unknown role as absent |
| `agentType` | string ≤ 64 | metadata | Claude Code's `subagent_type` (`general-purpose`, `Explore`), a workflow agent's type |
| `title` | string ≤ 200 | conversation | a subagent's task description, redacted (§9); the hub accepts ≤ 1,000 and cuts |
| `model` | string ≤ 80 | metadata | the model id the agent's transcript reports |
| `tokensIn`, `tokensOut` | int ≥ 0 | metadata | cumulative for the session: input (incl. cache reads and writes) and output |
| `costUsd` | number ≥ 0 | metadata | only when the agent records it; never estimated by the relay |
| `statusLine` | string ≤ 120 | metadata | from the relay's fixed vocabulary only: "waiting on 1 shell", "running commands", "editing vm.rs" |

`ActivityEvent` adds:
- kind `agent_message`: one agent wrote to another. `from`, `to` (≤ 200: agent names, agent ids or session keys,
  never a person's handle), `channel` (`claude-session` = Claude Code `SendMessage` and messages between sessions,
  `codex-mail` = Codex inter-agent messages, `workmesh` = Workmesh's own, later). `text` (≤ 4,000, redacted) only at
  `conversation`; at `metadata` the event goes without it. The hub reads an unknown channel as absent.
- `links`: up to 10 of `{ type: "linear" | "slack" | "github_pr" | "github_issue" | "url", id?, url?, label? }`, each
  with an `id` (≤ 200, no spaces: `B3-7166`, `b3-fun/workmesh#12`, `C0123ABC/1712345678.123456`) or a `url` (≤ 500,
  https, no credentials), `label` ≤ 120. What a relay sends:
  - `linear`: the ids it already sends in `issues` (§3.3 rule 6), with `https://linear.app/<workspace>/issue/<id>`
    when the workspace is known. Metadata.
  - `github_pr` / `github_issue`: from `gh pr|issue create|view|merge|…` commands and their responses, only when
    `<owner>/<repo>` is shared (§3.3 rule 7). Metadata.
  - `slack`: from Slack MCP tool calls (send, read thread, …): channel id and message ts, the permalink when the
    response carries one or the workspace host is known, `label` = the channel name when the call names it.
    Conversation level only.
  - `url`: not sent by the relay in this pass.
  The hub reads links tolerantly: a link it can't read is dropped on its own, past 10 it keeps the first ten.

Ingest body adds `person: { github?: string ≤ 40 }`: the person's GitHub login as the local `gh` CLI reports it
(`gh api user --jq .login`, read at `hub connect` and at daemon start, 5 s timeout, skipped when `gh` is absent or not
logged in), sent on every heartbeat for the board's and menu bar's avatars. The hub reads a malformed value as absent.

What still never leaves a machine (§3.3 holds): tool input or output, file contents, full commands, a subagent's
prompt or its text messages (the main thread's only, §9), anything from an unshared session. A subagent is shared
exactly when its parent session is.

## 16. `GET /relay/team` (v0.5, the menu bar's read)

Device token (`Authorization: Bearer bp_…`), under the `/relay/*` Access bypass. `401` as for ingest; an older hub
answers `404`, which a relay reads as "no team view yet" and retries after 10 minutes. The response is the team as the
device's person sees it (`hubTeamResponseSchema`; relays read it with `hubTeamAcceptSchema`, which drops a malformed
person or session on its own instead of failing):

```jsonc
{
  "me": { "name": "Sean", "email": "sean@npclabs.org", "github": "seangeng" },
  "people": [{ "name": "An", "github": "an-b3", "online": true, "counts": { "working": 2, "waiting": 0, "idle": 1 } }],
  "needsMe": [{ "session": "<hubKey>", "reason": "Approve the deploy", "since": 1795545600000,
                "name": "documents-07", "source": "claude-code", "repo": "b3-fun/workmesh", "owner": "Sean" }],
  "sessions": [{ "key": "<hubKey>", "owner": "An", "name": "codex-3", "source": "codex", "state": "working",
                 "now": "Fixing the ingest test", "repo": "b3-fun/workmesh", "branch": "main", "subagents": 2,
                 "stateSince": 1795545600000 }],
  "serverNow": 1795545700000
}
```

- `people`: everyone in the project, `me` included; `online` = a device of theirs reached the hub in the last 2
  minutes; `counts` = their open, top-level sessions by state.
- `needsMe`: the viewer's own `waiting` sessions, oldest first (later: asks addressed to the viewer); `reason` = the
  waiting reason, else the activity label.
- `sessions`: open top-level sessions (not ended, not subagents), `state` may be `offline`; `now` = now line, else
  waiting reason, else activity label; `subagents` = live subagents under it.
- Text in `now` and `reason` follows the owner's sharing level, as on the board.
- The relay polls it every 15 s while the menu is open or something needs the person, every 60 s otherwise, and
  serves the last answer on its loopback API (`GET /team`); the menu bar reads only that.

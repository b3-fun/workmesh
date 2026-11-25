# Workmesh protocol: the relay ↔ hub contract

Workmesh puts every teammate's coding agents, and the people they work for, on one live board. Two sides meet in this
file: the relay on each machine (this repo, open source) and a team hub. It is their public contract: what may leave a
machine, the wire format, sharing levels, redaction, and the privacy rules a hub keeps. B3 hosts the hub at
https://workmesh.b3os.org; the hosted hub's code and internals are private (§14).

| Part | Where | What |
|---|---|---|
| Relay | `packages/cli` (`@b3os/workmesh`, formerly agentblip) | A generic "hub forward" output in the daemon, plus Codex hook support and a `hub` command group. |
| Protocol | `packages/protocol` (`@workmesh/protocol`) | §3 and §10 as code: the wire schemas both sides validate against. |
| Hub | hosted by B3 (private) | Pairs machines, keeps what they share, writes summaries, serves the board. |

If this file and the code disagree, fix one of them in the same change. Section numbers are stable because code cites
them (§3.3, §8, §9); the numbers missing here (§4, §5, §7, §11–13, §17–18, §20, §22, §25, §27, §28, §32–34, §37) covered the hub's internals, which moved to the
hosted hub's own docs. Sections 1–13 were written while the hub was Bullpen and the relay was agentblip; where they say
agentblip, read the Workmesh CLI.

Linear: parent B3-7165, v0 B3-7166 (project "Workmesh"). Research behind it: the Linear document
"Research: multiplayer agents".

## Privacy rules

What a hub may learn from a machine, and what it does with it. Each rule points at the section that makes it precise.

- **Only shared repos.** A session sends nothing until it touches a repo the project's sharing rule includes (§2,
  §3.3; B3's rule is `github.com/b3-fun/` remotes), and nothing from before that moment. A folder the person excludes
  is never shared, whatever its remote.
- **Two levels, chosen per machine** (§8). `metadata`: session state, Workmesh's activity label, tool names,
  repo-relative paths, `owner/name` and branch, a program and one allow-listed subcommand, issue ids, PR links; since
  v0.6 also which agents run under which (parent, role, agent type, model, token counts, a status line from the relay's
  vocabulary), which agent wrote to which, links to Linear issues and to PRs and issues on shared repos, and the
  person's GitHub login (§15). `conversation`: also prompt text, the agent's text messages, a one-line description per
  tool call, and turn durations; since v0.6 a subagent's task description, the text agents send each other, and links
  to Slack messages agents posted or read (§15). A machine that goes back to `metadata` has its stored text deleted
  from the hub at once.
- **Never, at any level:** tool input or output, file contents, command arguments beyond the allow-listed subcommand,
  environment variables, absolute paths, the agent's thinking, a subagent's own prompt and transcript text, Slack
  message text, or anything from a repo outside the rule (§3.3, §9, §15).
  The relay builds every request from strict schemas, so a field outside this contract can't be sent (§14).
- **Coordination (v1, §21)** sends only what an agent or person asks for: lease paths (repo-relative) and reasons,
  claimed issue ids and notes, and the text of messages and project notes they write on purpose (at either level,
  redacted first). Holds, leases and messages are read back by the relay; nothing about local files beyond a lease's
  own paths leaves the machine.
- **Delegation (v2, §30)** sends what a person or agent writes on purpose (a handoff's task and context), and, only
  for an action the person gated for their own agents, a few words naming it (`gh pr merge 212 --merge in
  b3-fun/b3os-beta`), redacted first. A relay starts an agent for a handoff only once its person accepted it, or by
  their own policy for one they sent themselves (§31).
- **Memory (v3, §35)** sends what an agent or person writes down on purpose for the team (a memory's title, body,
  scope, links; a reason to retire one; a search query), at either sharing level, redacted first. An agent's memory
  reaches other agents only after a person accepts it (or its own person chose to accept their agents' memories). A
  hub may propose memories from a finished session's shared turn summaries, only for devices at `conversation`; a
  person accepts each one, and going back to `metadata` deletes the proposals drawn from that device's sessions. To
  search by meaning, B3's hub embeds memories and recall questions with Cloudflare Workers AI (its own account).
- **Redaction on the machine**, before anything is queued (§9): keys, tokens, JWTs, private keys, credentials in URLs
  and secret-valued settings become `[redacted]`, home paths `~/…`. The hub blanks obvious secrets again before it
  stores text (§10).
- **What the hub does with it.** It takes the owner from the device token, never from the body (§2); keeps events for
  7 days; shows them only to the project's signed-in members (on B3's hub, npclabs.org logins through Cloudflare
  Access); and may summarize shared text with a language model (B3's hub: OpenRouter with a dedicated key, else
  Cloudflare Workers AI), as material to describe, never as instructions. Its logs carry no prompt, message or summary
  text.
- **The Slack-status relay is separate.** agentblip.com only ever receives the finished status (text, emoji,
  expiration); see the README.

---

## 1. Hosts

- B3's hosted hub is `https://workmesh.b3os.org`. `https://bullpen.b3os.org`, the hub's first name, serves the same
  hub, so relays paired there keep sending without re-pairing; a pairing's verify URL names the host the relay asked.
- People sign in to the board (on B3's hub, Cloudflare Access). `/relay/*` needs no sign-in: the hub authenticates
  relays with device tokens (§2).

## 2. Identity

- A **person** is a signed-in email (`an@example.com`; on B3's hub, the Access login). Display name = the local part
  capitalized (`An`).
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

**A machine paired again retires its older pairing** (0.11.1). When a person completes a pairing for a machine name
they already have a device for, the hub revokes that older device: its open sessions end, it leaves the board, and its
token answers every `/relay/*` call with `401 { "error": "superseded: <machine> paired with this hub again …",
"reason": "superseded" }` (a token revoked by hand keeps the plain `401`). A relay that gets it stops forwarding and
says so; the relay that paired again sends its open sessions under the new device. Two machines with the same name
need their own names (`workmesh init <hub> --machine <name>`).

**One hub, several addresses** (0.11.1). `workmesh init <url>` keeps an existing pairing when `<url>` is the hub it
already paired with under another address: B3's two hosts (§1) always; another host under the same parent domain (or
both on this machine) when it accepts the machine's device token (`GET /relay/team` answers anything but `401`/`403`).
The relay never shows a token to a host outside that domain. The pairing is kept and the relay forwards to `<url>`
from then on.

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
`sessions` and not already ended are marked `ended` (before v0.10; since then they are `missing` first, §24).

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

---

# v0.2: conversation sharing (Sean, 2026-11-24)

Sean: "show way more detail, like the prompts + updates as we go", like Claude Code's own transcript (prompts, the
agent's text updates, grouped tool calls such as "Ran 2 shell commands", turn durations).

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
  only from that moment on; nothing written before it was shared is ever sent. At `conversation` this includes a
  session whose cwd is not shared (§3.3 rule 4): its prompts carry text, and its shell calls go with `desc` and `cmd`
  even when they name no shared root. Rule 4's "no text" is the `metadata` reading.
- Sharing is sticky by default: once a session is shared it stays shared for the rest of its life, so a session whose
  cwd is outside every shared repo (an orchestrator in `~/Documents`) that touched a shared repo once also sends its
  later turns, including work on other repos. `hub.stickyShare: false` in the relay's config (`workmesh hub sticky
  off`) makes such a session unshared again at each new prompt; it is shared again only by a turn that touches a
  shared repo (a file there, or a shell command naming a shared root it has seen), and that turn's prompt, which came
  first, is not sent. Sessions whose cwd is in a shared repo, and subagents and workflow agents started while their
  parent was shared, are not affected. Nothing changes on the wire: the session just stops appearing in the relay's
  heartbeats until it is shared again.
- Every ingest body carries `share`; the hub stores it per device and drops any text fields from a `metadata` device.

## 9. Relay additions

- **Redaction, on the machine, before anything is queued:** API keys and tokens (Anthropic `sk-ant-…`, OpenAI `sk-…`,
  GitHub `ghp_/gho_/ghu_/ghs_/ghr_` and `github_pat_`, Slack `xox?-`, AWS `AKIA…`, npm `npm_…`, Linear `lin_api_…`,
  hub device tokens `bp_…`), JWTs, PEM private key blocks, `Bearer <token>`, `key|secret|token|password = value` pairs, URLs with
  embedded credentials, and long high-entropy strings next to those words → `[redacted]`. Also context-free: long
  mixed-case alphanumeric runs with real entropy, base64 runs containing `/`, and 48+ bare hex digits unless a hash
  word labels them (`sha256:`, `commit`, `checksum`) or they are `0x…`; and short mixed letter-and-digit values after
  a generic name (`key=`, `sig:`, `pass:`). Absolute home paths → `~/…`. A unit-tested list; a privacy test feeds a
  corpus of real-looking secrets through the whole pipeline. Redaction targets secrets only: names, email addresses,
  customer details and other personal data in prompts or agent text are not detected and are sent as written.
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

---

# v0.4 and the split: one protocol, an open client, a hosted hub (Sean, 2026-11-24)

v0.4 put the relay, the hub and the board in one public monorepo under one name. Later the same day Sean split it:
"separate the UI from the agent/daemon, so that the platform always remains hosted / by us, while the piece that gets
installed on users machine is open source".

## 14. Layout and protocol

- **Repo:** `b3-fun/workmesh` (public, MIT) is everything that runs on a person's machine, the protocol, and
  agentblip.com. npm workspaces with one root lockfile:

  | Path | Package | What |
  |---|---|---|
  | `packages/cli` | `@b3os/workmesh` (published) | The relay: CLI, daemon, hooks, hub forwarder, Slack sinks |
  | `packages/core` | `@workmesh/core` (private) | Session model, aggregation, Slack status formatting |
  | `packages/protocol` | `@workmesh/protocol` (private) | The relay ↔ hub wire format (§3, §8, §10) |
  | `apps/menubar` | (SwiftPM) | Workmesh.app, the menu bar client of the daemon |
  | `app/`, `src/`, `workers/` | root | agentblip.com: the site and the Slack-status relay Worker |

- **The hosted hub:** B3's hub, its board and its summaries are built in a private repository that pins this one as a
  git submodule and reads `@workmesh/protocol` from it. From v0.4 until the split the hub lived here, in `apps/hub`;
  that code is still in this repo's history, but it is no longer developed here. A wire change lands here first
  (`packages/protocol` and this file, with the relay's side); the hub follows by moving its pin, and keeps reading
  relays older and newer than its pin.
- **One protocol:** `packages/protocol` is the code form of §3.1–3.2 and §10. Each body has two readings from the same
  field rules. The relay builds what it sends from the strict schemas (unknown keys fail, no `null`, integer epoch
  ms, `cmd` with one subcommand word, text ≤ 4,000 and `desc` ≤ 200). The hub reads with the accept schemas (§3.2's
  hub-side validation: unknown keys dropped, `null` as absent, fractional ms rounded, `cmd` with up to two subcommand
  words, text ≤ 16,000 and `desc` ≤ 1,000 for the hub to cut after its redaction pass). A body the strict schemas
  accept parses unchanged under the accept schemas, and both name the same fields; the protocol's tests hold both. A
  wire change is one edit there: the relay's tests here run against it, and the hub's when it moves its pin.
- **Deploys:** agentblip.com deploys from CI on every push to `main`. CI runs every workspace's tests and typecheck,
  the CLI build and the site build.

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
| `tokensIn`, `tokensOut` | int ≥ 0 | metadata | as Claude Code counts an agent: `tokensIn` its context now (input, cache reads and cache writes of its latest call), `tokensOut` what it has generated (output summed over its calls); Claude Code's own "tokens" is tokensIn + the latest call's output |
| `costUsd` | number ≥ 0 | metadata | only when the agent records it; never estimated by the relay (Claude Code and Codex record none per agent today, so the relay sends none) |
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
  - `slack`: from Slack MCP tool calls (send, read thread, search, …), read from the call's response (PostToolUse):
    channel id and message ts, the permalink when the response carries one or the workspace host is known, and
    `label` = what happened and where, `"<Action> · <place>"` or one of them alone: the action from the tool's name
    (`Sent`, `Drafted`, `Scheduled`, `Read`, `Searched`, `Reacted`, `Listed`, `Created`, `Updated`, `Uploaded`,
    `Used`), the place from the response or an earlier call in the session (`#eng`, `DM`, `group DM`, `3 channels`
    for a search across several). Never message text, search terms or user ids. One link per action and place in a
    session (a DM's sends, a thread's reads; a search per what it found): the first permalink stands for the rest.
    Conversation level only.
  - `url`: not sent by the relay in this pass.
  The hub reads links tolerantly: a link it can't read is dropped on its own, past 10 it keeps the first ten.

Ingest body adds `person: { github?: string ≤ 40 }`: the person's GitHub login as the local `gh` CLI reports it
(`gh api user --jq .login`, read at `hub connect` and at daemon start, 5 s timeout, skipped when `gh` is absent or not
logged in), sent on every heartbeat for the board's and menu bar's avatars. The hub reads a malformed value as absent.

Linear ids (rule 6, and these `linear` links) are never read from a prompt the agent tool injected, from Workmesh's
own lines (its guidance, inbox notes and heads-ups start with "Workmesh"), from an id written as an example
("e.g. B3-123"), or from past a command's first line (a heredoc's or a script's body is file text).

What still never leaves a machine (§3.3 holds): tool input or output, file contents, full commands, a subagent's
prompt or its transcript text (the main thread's only, §9; what agents write to each other travels as
`agent_message`), anything from an unshared session. A subagent is shared exactly when its parent session is.

How the relay builds them (`packages/cli`, verified on Claude Code 2.1.331 and Codex 0.164, shapes only):
- **Claude Code subagents:** `SubagentStart` / `SubagentStop` hooks (`agent_id`, `agent_type`; Stop adds
  `agent_transcript_path`) and the `agent_id` every hook inside a subagent carries. Each subagent is a session keyed
  `<parent key>/<agent id>` (source `claude-code`, `role: "subagent"`, `parent` = the main session); its tool calls
  go on its own timeline; `title` from its `agent-<id>.meta.json` `description`; `model` and tokens from its
  `agent-<id>.jsonl`; `statusLine` = its activity label; `ended` at SubagentStop or when its parent goes. The relay
  sends subagent sessions only to a hub that serves `GET /relay/team` (§16): an older hub keeps seeing their tool
  calls on the parent, as before. A subagent nothing confirms (no `agent_type`, no task, no hook of its own, no
  tokens) is held back until it has lasted 2 s, and never sent when it ends sooner: Claude Code fires
  SubagentStart/SubagentStop pairs with nothing between them (calls replayed on resume), and each one sent was a
  nameless agent on the board (relays after 0.12.1; hubs also drop the ones older relays sent: unnamed, no events,
  ended within 2 s of starting). A main session's `statusLine` says what it waits on ("waiting on 1 shell") from its
  Stop's `background_tasks`.
- **Codex spawned threads:** already their own sessions (`codex:<thread id>`); the rollout's first `session_meta`
  line names `parent_thread_id`, `agent_role` (→ `agentType`) and `agent_path` (→ `title`, conversation level);
  tokens and model from its `token_count` and `turn_context` lines.
- **Workflows:** `workflow:<run id>` sessions get `role: "workflow"`, `parent` = the launching session, tokens summed
  over the run's agent transcripts.
- **Agent messages:** Claude Code `SendMessage` (hook; `to` an agent id → that subagent's key, a local socket address
  → "another session"); peer messages in the main transcript (`origin.kind: "peer"`, from a subagent or another
  session; read at the conversation level, from the transcript tail); Codex `send_message`, `followup_task`,
  `spawn_agent` calls in the rollout (conversation level). A prompt Claude Code injects (a task notice, a
  cross-session or teammate message) is never sent as the person's prompt.

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
- A `200` here is also how a relay knows the hub reads v0.6 session structure: from then on it sends subagents as
  their own sessions (§15). A `404` turns that off again.
- `latestClient` (relay 0.12.0, §40): the newest published relay, as the hub last read it from npm.

---

# v0.7: polish from real use (Sean, 2026-11-24)

Found on the live board with real sessions. All of it is optional on the wire (still `v: 1`): old relays and old hubs
keep working, and a hub reads what an old relay sends the way this section says.

## 19. Names, injected content, orchestrators

**Subagent names.** A relay sends `name` (≤ 120) on every subagent session (§15: Claude Code subagents, Codex spawned
threads that have no name of their own) so no reader has to show a key: the task `title` where the title may be sent
(conversation level, the same redacted text cut to 120), else the `agentType` (`Explore`, `general-purpose`). `name`
stays metadata: at the metadata level it is never more than the agent type.

**Injected content.** Agent tools put their own markup into the text a relay reads, and none of it was written by the
person or the agent: a background task's completion notice arrives as a prompt (`<task-notification>…`), another
agent's message arrives wrapped (`<agent-message from="…">…</agent-message>`, `<cross-session-message>`,
`<teammate-message>`), a message can open with provenance markers (`<artifact-content-authored-by-others/>` plus a
one-line notice), and `<system-reminder>` blocks ride along anywhere. `stripInjected` in `@workmesh/protocol` (zod-free,
also importable alone as `@workmesh/protocol/injected`) is the one reading of it, tested on real-shaped fixtures:
- A leading block or marker whose tag is a lowercase name joined by `-` or `_` is injected: a block goes with
  everything in it (an unclosed one, cut at the text cap, takes the rest), a self-closing marker with its notice line.
  `<system-reminder>` blocks go wherever they are. Plain HTML a person pasted (`<div>`, `<time>`) and tags mentioned in
  prose stay.
- A wrapper around another agent's message keeps its body (cleaned the same way); a slash command recorded as
  `<command-name>` markup reads as the person typed it (`/review PR 12`).
- Prompts: one that is wholly injected (a notice, a wrapped message, only markers) is no prompt at all: the relay
  starts the turn and sends none (Claude Code and Codex hooks alike). One that opens with markers before the
  person's words is sent without them.
- Agent text (`message`, `agent_message`): sent without the markup; a `message` with nothing left is not sent, an
  `agent_message` goes without `text`.
- The relay cleans before redacting and before the 4,000 cap. The hub runs the same function on ingest as a backstop
  (it drops a wholly injected prompt, strips the rest) and the board on rows stored before v0.7.

**Orchestrators.** A session whose cwd is outside every shared repo (§3.3 rule 4: an orchestrator started in
`~/Documents`) becomes shared when it touches a shared repo. Its `SessionUpsert` adds:

| Field | Type | Level | Notes |
|---|---|---|---|
| `repos` | string[] 1–10, `owner/name`, no repeats | metadata | only for such a session: the shared repos it has touched (a file tool on a path inside one, or a shell command naming a shared root it has seen), most recent first; `repo` is the first |

A session started in a repo never sends `repos`, whatever else it touches. The hub reads `repos` tolerantly: an entry
that isn't `owner/name` is dropped on its own, repeats once, past 10 the first ten, an empty list as absent. The board
groups an orchestrator under its `repo` (the repo it touched most recently), marks it as an orchestrator, and names
the repos it works across.

---

# v1 Coordinate: leases, claims, messages, notes, holds (Sean, 2026-11-25)

Agents on one team stop colliding: a session leases the files it is about to rework, claims the Linear issue it works
on, messages another person's agent instead of editing under it, and a person can hold any agent from the board.
Linear B3-7167. All of it is new endpoints beside ingest: an older hub answers `404`, and the relay then carries on
as before (nothing is ever blocked because a hub can't coordinate).

## 21. Coordination endpoints

Code form: `packages/protocol/src/coord.ts` (two readings per body, as in §14) and `lease-paths.ts` (zod-free, also
`@workmesh/protocol/lease-paths`). Every endpoint takes the device token (`Authorization: Bearer bp_…`) under the
`/relay/*` Access bypass, and the hub takes the person from it, never from a body. Status codes as for ingest
(§3.2): `400` schema error, `401` unknown or revoked token, `404` an older hub, `429` with `Retry-After`.

**Keys.** In a request, `sessionKey` (and a message's `from`) is the session's ingest `key` (`<source>:<sessionId>`,
§3.2); the hub prefixes the device id. Everything a hub sends back names sessions by hub key
(`<deviceId>:<source>:<sessionId>`, §2). A hub reads a request key that already carries this device's id the same way.

**Lease paths.** Repo-relative paths or globs (`lease-paths.ts`): `*` within a segment, `?` one character, `**` any
number of whole segments; every other character is literal (`app/[id]/page.tsx`). An entry covers what it matches and
everything under it (`packages/cli` covers `packages/cli/src/index.ts`; `**` is the whole repo). No leading `/`, `~`,
drive letter or `..`, no empty or `.` segments, no trailing `/`, ≤ 400 chars. Two entries overlap when some file is
covered by both (`leasePathsOverlap`, exact for plain paths).

| Endpoint | Body | Answer |
|---|---|---|
| `POST /relay/leases` | `{ action: "acquire" \| "release" \| "renew", sessionKey, repo, paths: string[] ≤ 50, ttlSec?: 60..14400 (default 1800), reason?: ≤ 200, leaseId? }` | `{ ok: true, lease }` (acquire, renew), `{ ok: true, released }` (release); `409` (or `200`) `{ ok: false, conflicts: [{ leaseId, holder: { person, sessionKey, sessionName? }, paths, expiresAt, reason? }] }` |
| `POST /relay/claims` | `{ action: "claim" \| "release", sessionKey, issue: "B3-123", note?: ≤ 500 }` | `{ ok: true, claim? }`; `409` (or `200`) `{ ok: false, holder, since? }` |
| `POST /relay/messages` | `{ from?: sessionKey, to: { person } \| { session: hubKey } \| { agent: sessionName }, text: 1..4000, thread?: ≤ 64 }` | `{ ok: true, id }`; `404` `{ ok: false, error }` for no such recipient |
| `POST /relay/notes` | `{ sessionKey?, text: 1..4000, tags?: ≤ 10 words }` | `{ ok: true, id }` |
| `GET /relay/sync?cursor=<opaque>` | | the state below |
| `POST /relay/inbox/ack` | `{ ids: string[] 1..200 }` | `{ ok: true }` |

- **Leases.** `acquire` takes 1–50 paths in one repo (`owner/name`). A lease is exclusive: an acquire whose paths
  overlap an active lease of another session in the same repo fails with that lease as a conflict, and the same
  person's other sessions conflict too (leases are about agents colliding). A session's own leases never conflict
  with it; its subagents (`<key>/<agentId>`) count as the session. `renew` and `release` name the session's leases
  in `repo` by `leaseId`, else by `paths` (its leases with any of them), else all of them in that repo; `renew`
  restarts the ttl (`ttlSec` or the lease's own). A lease ends at `expiresAt`, at `release`, or when its session ends.
- **Claims.** One active claimant per issue id (read case-insensitively, `b3-7167` is `B3-7167`); claiming an issue
  this session already holds refreshes its note. A claim ends at `release` or when its session ends. The hub may
  mirror claims to Linear.
- **Messages** go to a person (display name, email or GitHub login as the roster shows them; the hub picks which of
  their sessions gets it, else holds it for their next one), one session, or an agent by its session name. `from`
  absent = the person wrote it themselves (the CLI outside any agent session). Text is written on purpose by an agent
  or a person, so it is sent at either sharing level, redacted on the machine first (§9).
- **Notes** are the project's shared notes, written by a session or a person, read by everyone's agents. Text as for
  messages.
- **Holds** are set by people on the hub (the board, a Linear comment); relays only read them.

`GET /relay/sync` → (`hubSyncResponseSchema`; relays read it with `hubSyncAcceptSchema`, which keeps every item it can
read and drops the rest one by one):

```jsonc
{
  "cursor": "c_42",                 // opaque: sent back on the next sync
  "serverNow": 1795545605000,       // optional: the hub's clock
  "me": { "person": "Sean" },       // optional: this device's person, as the lists name people
  "leases": [Lease],                // every active lease in the project
  "holds": [{ "sessionKey": "<hubKey>", "by": "An", "reason": "reworking the cell layout", "since": 1795545600000 }],
  "inbox": [{ "id": "m_1", "to": "<hubKey of one of this device's sessions>", "from": { "person": "An", "sessionName": "b3iq-strategy", "sessionKey": "<hubKey>" },
              "text": "…", "ts": 1795545600000, "thread": "t_1" }],   // oldest first, until acked
  "claims": [{ "issue": "B3-7167", "holder": Holder, "since": 1795545600000, "note": "relay side" }],
  "roster": [{ "person": "An", "github": "an-b3", "sessions": [{ "hubKey": "<hubKey>", "name": "b3iq-strategy", "state": "working", "repo": "b3-fun/workmesh" }] }],
  "notes": [Note],                  // optional: the newest 50
  "edits": [{ "repo": "b3-fun/workmesh", "path": "packages/cli/src/index.ts", "person": "An", "sessionKey": "<hubKey>", "sessionName": "b3iq-strategy", "ts": 1795545600000 }]
}
```

- `Lease` = `{ id, repo, paths, holder: { person, sessionKey, sessionName? }, since?, expiresAt, reason? }`;
  `Note` = `{ id, by: { person, sessionKey?, sessionName? }, text, tags?, ts }`.
- `inbox` lists every message for this device's sessions that the relay hasn't acked, on every sync; a relay may see
  an item again before its ack lands and delivers it once (by `id`). Leases, holds, claims and roster are complete
  lists too; the cursor is the hub's own (a relay sends back what it got). A relay keeps an undelivered item a hub
  stops listing for a day (its session may come back), so a hub that lists each item once still works.
- `edits` (optional): files sessions edited in the last 10 minutes (one row per session and path, the newest),
  from the `path` the hub already has (§3.2). A relay warns its agent before it edits a file another person's
  session touched there.

## 23. The relay side (`packages/cli`)

- **Sync** (`hub/coord.ts`). The daemon polls `/relay/sync` every 5 s while any shared top-level session is live, every
  60 s otherwise (a shared session's event brings the next poll forward), backing off on errors (10 s doubling to
  5 min) and waiting out a `429`'s `Retry-After`; `404` turns coordination off and asks again in 10 minutes; `401`
  stops it, as for ingest. It keeps the last good answer in memory, with the hub's clock offset (`serverNow`) for
  expiries.
- **Fail-open.** Nothing is ever blocked because the hub or the daemon is unreachable. A hook gets no answer when the
  daemon doesn't answer within its usual timeout, and Claude Code and Codex then run the tool as they would without
  Workmesh. Leases and recent edits count only while the last good sync is under 90 s old. The one exception is a
  hold the daemon already knew about: it stays in force until a sync answers without it, or for 30 minutes after the
  last sync that carried it. A `404` or `401` drops holds at once.
- **Enforcement** (`daemon/coord-hooks.ts`; Claude Code and Codex `PreToolUse`). The hook sends its event on the same
  loopback request as before (`POST /event`) with the hook's event name in an `x-workmesh-hook` header; the daemon
  answers `{ ok: true, coord?: { deny?, context? } }` from its cached state, with no network call in the hook path,
  and an older daemon ignores the header. The hook prints Claude Code's documented hook JSON (Codex 0.164's hook
  output schemas take the same fields): `hookSpecificOutput.permissionDecision: "deny"` with
  `permissionDecisionReason`, and `additionalContext`. It never answers `allow`: the agent's own permissions stand.
  - A hold on the session (or the session a subagent runs under) refuses every tool call, naming who held it and why,
    and how to reach them. Through a hold (0.11.x) go only what lets the agent talk to people and read the board: the
    workmesh MCP tools `whoami`, `roster`, `send`, `inbox`, `leases`, `notes`, `ask`, `release` and `unlease`, and a
    shell command that is exactly one `workmesh send|inbox|whoami|claims|leases|notes …` (no `;`, `&`, `|`,
    redirects, `$(…)`, backticks or env prefix outside single quotes), so an agent whose session predates the MCP
    tools can still answer the person who held it.
  - An edit to a file another session's lease covers is refused, naming the file, the holder (person and session), the
    reason, the entries that cover it, when the lease expires, and how to ask them. Edits are Edit, Write, MultiEdit,
    NotebookEdit (their path), Codex `apply_patch` (every file in the patch), and shell commands that plainly write a
    path (`> file`, `tee`, `rm`, `mv`, `cp`, `touch`, `truncate`, `ln`, `dd of=`, `sed -i`/`perl -i`, `git rm|mv|restore`,
    `git checkout -- <paths>`; `cd` moves the base; variables, substitutions and heredoc bodies are not read). Only
    paths in shared repos (§3.3) are checked, as repo-relative paths.
  - An edit to a file another person's session edited in the last 10 minutes (`edits`) goes ahead, with a note to the
    agent saying who is working there (once per file and editor per 10 minutes).
  - A refused call is applied as a heartbeat: the session stays alive, and nothing about the call reaches Slack or the
    hub.
- **Inbox.** A session's messages reach its agent at its next tool boundary (`additionalContext` on PostToolUse and
  UserPromptSubmit, Claude Code and Codex alike), at most five at a time, as "Message from An (b3iq-strategy): …",
  framed as a colleague's note; they are then acked (`POST /relay/inbox/ack`). A message for a subagent
  (`<key>/<agentId>`) reaches only that subagent. The MCP `inbox` tool and `workmesh inbox` list them too.
- **MCP** (`mcp/server.ts`). `workmesh mcp` (stdio, JSON-RPC 2.0, one message per line; protocol versions 2024-11-05 to
  2025-11-25) gives every agent `whoami`, `roster`, `send`, `inbox`, `claim`, `release`, `lease`, `unlease`, `leases`,
  `note` and `notes` (v2 adds `handoff`, `handoffs` and `ask`). It talks to the local daemon only (`POST /coord/op` on the loopback API, bearer secret as
  everywhere) and never holds the device token; the daemon makes the hub calls. The daemon tells which session is
  calling from the caller's parent process (Claude Code's `~/.claude/sessions/<pid>.json`), else
  `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`, else the live session in the caller's directory that moved last;
  none of them means the person at a terminal. Message and note text is redacted (§9) before it is sent.
  `send`'s `to` (0.11.x) resolves on the machine from the last sync's roster: a person (name or GitHub login), a
  session by the name the board shows or its key (`claude-code:<id>`, or the start of the id, 6+ characters), or a hub
  key; a name that fits several live sessions is refused, listing them, rather than guessed (`--kind session|agent|
  person` narrows it). An agent's reply wakes its recipient (§30 `wake: true`) when it is in a thread a message to the
  sender opened or carried, or goes to the session (or that session's person) that wrote to the sender in the last 30
  minutes; other agent messages keep the hub's default (they don't wake). A claim, release, lease or unlease the hub
  took is applied to the cached sync at once, so `claims` and `leases` (and the hooks) show it before the next sync;
  so is the person's own gate policy from `gates set` (0.12.1; §31), and memory writes to the brief (§36).
- **Registration.** `workmesh setup` (and `setup --hooks-only`; `--no-mcp` skips it) registers the server with Claude
  Code at user scope (`claude mcp add -s user workmesh -- <node> <cli> mcp` when the `claude` CLI is on PATH, else a
  merge into `~/.claude.json`, written by rename) and with Codex as `[mcp_servers.workmesh]` in `~/.codex/config.toml`.
  Both back the file up once before the first change, repoint an older install of theirs, and leave alone another
  server named `workmesh` or a file they can't read. `workmesh doctor` checks both, and whether the running daemon
  coordinates. `<node>` here, in every hook command, Codex's `notify` and the service (§24) is a stable path for the
  running Node (0.12.1, `lib/node-path.ts`): Homebrew's `<prefix>/bin/node` or `<prefix>/opt/<formula>/bin/node`
  rather than its `Cellar/<formula>/<version>` path, which the next upgrade deletes; nvm's `current`, fnm's
  `aliases/default` or mise's major-version link when one resolves to the same binary; never a per-project shim
  (Volta, asdf, mise `shims/`). `init`, `setup` and `update` repoint what an older version wrote, and `doctor` names
  any of them whose Node is gone (fail) or versioned with a stable name for it (warn), with the fix.
- **Guidance.** A shared top-level session gets a five-line note once (`SessionStart`, or the first boundary after it
  becomes shared) while the hub coordinates: it is on Workmesh with its team, and how to claim, lease, read its inbox,
  and message a holder instead of editing leased files.
- **Menu bar.** `GET /team` adds `coord: { available, holds: [{ session, name, by, reason, since }], unread: [{ id,
  session, name, from, fromSession, text, ts, delivered }] }` for this machine's sessions; Workmesh.app shows "On
  hold" and "Messages for your agents".
- **CLI.** `workmesh leases`, `lease`, `unlease`, `claims`, `claim`, `send`, `inbox`, `note`, `notes`, `whoami` (and
  `ask`), through the same daemon call as the MCP tools; a refusal (a claim someone else holds, a lease conflict)
  exits 1 and `--json` says `ok: false`.

---

# v0.10: liveness and persistence (Sean, 2026-11-25)

"I see myself as offline at times, maybe when the daemon is interrupted." Two causes: the board worked out presence in
the browser from a `lastSeenAt` the hub stopped sending while a device was busy, and a restarted daemon forgot which
sessions it shared, so its first heartbeat ended them all. Still `v: 1`; every field below is optional.

## 24. Liveness

**Wire** (`packages/protocol`):
- Ingest body `client`: the relay's name and version, `workmesh/0.10.0` (`HUB_CLIENT_RE`), on every request. The hub
  keeps the latest one per device (before this it only had the pairing's).
- `SessionUpsert.alive`: `true` when the relay saw the agent's process running, `false` when it is gone (the hub
  ends the session at once), absent when the relay can't know (a Codex thread, a custom source).
- `SessionUpsert.quietSince`: the session is working and alive but has sent no event since then (a long tool call, or
  an agent that is stuck).
- `GET /relay/team` people gain `presence` (below); `online` stays for older menu bars and is true for `online` and
  `reconnecting`.

**Presence** is the hub's, computed from ingests and pushed to boards; no client works it out from timestamps:
`online` (an ingest within 90 s), `reconnecting` (90 s to 5 min), then `asleep` if the device went quiet with sessions
open (a Mac that slept, a daemon that was killed) or `offline` if it had none. A person's presence is the best of their
devices'. A relay sends at least one request every 30 s while it runs (a heartbeat, `full` or not), so only a stopped,
killed or sleeping relay leaves `online`.

**Heartbeats never end sessions on their own.** A session missing from a `full` heartbeat is `missing`: it keeps its
state, the board shows it as unconfirmed for 10 minutes and then folds it away, and the hub ends it after 30 minutes
missing. It ends at once on a SessionEnd (`state: "ended"`) or `alive: false`. A missing session that shows up again
takes the state it reports.

**The relay keeps its place across restarts** (`packages/cli`):
- The hub forwarder writes its state to `~/.local/state/workmesh/hub-forward.json` (0600, atomic rename, at most once
  a second when it changed, and on SIGTERM/SIGINT): the shared sessions (their last state, roots, repos, labels,
  issues, conversation start time and transcript offsets) and the unsent queue (newest 1,000 events). Unshared
  sessions are not kept. A daemon that starts reads it back before its first send, puts the sessions back in its
  store, ends the ones whose process is gone (Claude Code: `~/.claude/sessions/<pid>.json`) with `alive: false`, and
  carries on where it stopped: no text from before a session was shared, no event twice (ids are stable, the hub
  dedupes). A file for another hub, or older than a day, is ignored; `hub disconnect` deletes it.
- No `full` heartbeat goes out before that read is done, and none that is empty during the first 2 minutes after a
  start (until something is shared); those heartbeats go as `full: false`, still every 30 s.
- `workmesh setup` (and `setup --hooks-only`; `--no-service` skips it) runs the daemon as a service: on macOS under
  launchd (`~/Library/LaunchAgents/org.npclabs.workmesh.daemon.plist`: RunAtLoad, KeepAlive unless it exited cleanly,
  ThrottleInterval 10, log in `~/Library/Logs/workmesh-daemon.log`), on Linux as a systemd `--user` unit
  (`workmesh.service`, Restart=on-failure). A crash or kill brings it back within seconds, a login or reboot starts
  it; `workmesh stop` leaves it stopped (the daemon exits 0 only for a stop it was told about). `workmesh restart`,
  `start --detach` and the hooks' autostart go through the service when it is installed, and a service daemon that
  finds another one running waits for it to exit instead of starting a second. `workmesh service
  install|uninstall|status` manages it by hand; `workmesh doctor` reports it and the state file.

**Onboarding on Linux** (0.11.1, after Mitch's `b3-box` on 11-25: paired over SSH, sent one heartbeat, then nothing):
- A relay sends a heartbeat every 30 s whether or not it has sessions, so a paired machine with no agents running is
  `online` on the board ("online, no agents running"). A machine that paired but never sent is "paired, never
  connected" on the board, with `workmesh doctor` as the next step.
- systemd stops a user's services about 10 s after their last session ends unless the user lingers. On a box you SSH
  into, that stopped the daemon at logout. `workmesh init`, `setup` and `service install` turn lingering on
  (`loginctl enable-linger`, no password prompt; allowed for yourself where polkit runs, as on Ubuntu Server and
  Fedora). Where logind refuses (no polkit, as on a minimal Debian), they offer `sudo loginctl enable-linger <user>` in
  a terminal and otherwise print it; `--no-linger` leaves lingering off. `workmesh doctor` warns while it is off.
- No unit file is written unless `systemctl --user` reaches the user's manager. A shell without `XDG_RUNTIME_DIR`
  (`su`, `sudo -u`, cron) gets `/run/user/<uid>` for its systemctl calls. Without systemd (a container, WSL without
  systemd, a minimal VM) the daemon runs detached (its own session, so it outlives the shell that started it), and
  the next agent hook starts it after a reboot.
- `workmesh init` ends by waiting (≤ 10 s) for the daemon's first accepted send and says whether the hub heard from
  the machine. The forwarder's state file keeps `lastContactAt`, the last time the hub accepted a send, so `doctor`
  can say since when the hub hasn't heard from a machine whose daemon is down, and why: no daemon (`workmesh
  restart`), lingering off or no systemd user session (`sudo loginctl enable-linger $USER`), no service installed, a
  daemon forwarding to another hub address than the one paired, or a superseded or rejected token (`workmesh init`).

---

# v0.11: the session mirror (Sean, 2026-11-25)

"We want better representation of what the users see on their actual codex/claude sessions, ideally synced to this."
The board's session page reads like the person's terminal: the title, harness and model at the top; prompts, the
agent's messages and folded tool runs in order; the agent tool's own lines (a background agent waiting on its work, a
shell that finished, a compaction, a plan update); each turn's end with what is still running; and a footer with the
mode, the background tasks and the agents. Still `v: 1`; every field below is optional, and an older hub drops them
(an older hub 400s the `notice` kind, so a relay holds notices back for 10 minutes after such a 400, as for `message`).

## 26. Mirror fields

**Wire** (`packages/protocol`):

| Where | Field | Level | What |
|---|---|---|---|
| `SessionUpsert` | `title` (≤ 200) | conversation | since v0.11 also a main session's title: Claude Code's `custom-title` (a `/rename`), else its `ai-title`; redacted (§9) |
| `SessionUpsert` | `mode` (`HUB_MODE_RE`, ≤ 40) | metadata | Claude Code's `permissionMode` (`default`, `auto`, `acceptEdits`, `plan`, `bypassPermissions`); Codex's approval and sandbox reduced to one word (`full-access`, `auto`, `read-only`, `untrusted`) |
| `SessionUpsert` | `tasks` | metadata | background tasks running now: `{ shells?, monitors?, agents?, workflows?, other? }`, each 0–999 |
| `SessionUpsert` | `model` | metadata | (v0.6) now also sent for a main Claude Code session, from its transcript |
| `ActivityEvent` | kind `notice` + `noticeKind` | metadata | a line the agent tool writes itself (below) |
| `ActivityEvent` | `desc` on a notice | conversation | the title the notice names: a background agent's task, a background command's description, a workflow's name |
| `ActivityEvent` | `durationMs` on a notice | metadata | how long the task ran (agent notices), or the compaction took |
| `ActivityEvent` | `ok` on a notice | metadata | the task completed (`true`) or failed (`false`) |
| `ActivityEvent` | `tasks` on a `turn` | metadata | background tasks still running when the turn ended ("3 shells, 2 monitors still running", "waiting for 1 background agent") |
| `ActivityEvent` | `plan` on a `plan` notice | conversation | 1–30 `{ step ≤ 200, status: pending \| in_progress \| completed }`, redacted |

`noticeKind`: `agent_waiting` (a background agent stopped with background work of its own), `agent_done`,
`agent_failed`, `agent_stopped`, `shell_done`, `shell_failed`, `shell_stopped`, `shell_running` (still running after a
long time with no new output), `monitor_event`, `monitor_ended`, `workflow_done`, `workflow_failed`, `compact`, `plan`,
`task` (any other task notice). A hub reads an unknown kind as absent and shows the event as a plain task notice; it
reads a malformed `mode`, `tasks` or `plan` as absent, a bad plan step or task count on its own.

What still never leaves a machine (§3.3 holds): a monitor's output (a `monitor_event` notice carries its kind only),
a background command's command line, the text of a task's result, the agent's thinking, anything from a subagent's
transcript beyond counts. A notice's `desc` and a plan are conversation text: a metadata device sends the notice's kind,
duration and outcome only, and no `plan` notice at all. A metadata device's `title` stays a subagent's type (§19).

**How the relay reads them** (`packages/cli`, verified on Claude Code 2.1.332 and Codex 0.164 rollouts, shapes only):
- **Claude Code main transcript** (the tail of §9, from the moment the session is shared): `ai-title` (`aiTitle`) and
  `custom-title` (`customTitle`) lines give the title, the custom one winning; `permission-mode` (`permissionMode`)
  the mode (metadata, so the relay also reads the latest one from the file's last 64 KB when the tail starts);
  `assistant` lines' `message.model` the model; `system` `compact_boundary` a `compact` notice (its
  `compactMetadata.durationMs`); `system` `turn_duration`'s `pendingBackgroundAgentCount` and `pendingWorkflowCount`
  the turn's waiting agents and workflows; `user` lines whose `origin.kind` is `task-notification` a notice, read from
  Claude Code's own `<summary>` templates (`Agent "<title>" is waiting on its own background work`, `Agent "<title>"
  finished`, `Background command "<description>" completed (exit code 0)`, `Monitor "<description>" stream ended`,
  `Dynamic workflow "<name>" completed`, …) with `<task-id>`, `<status>` and `<duration_ms>`. A template the relay
  doesn't know sends `task` with no `desc`.
- **Background tasks:** the Stop and SubagentStop hooks' `background_tasks` (`id`, `type`: `shell`, `monitor`,
  `subagent`, `workflow`, or another kind; `status`) are the session's running tasks, by id and kind only. A notice
  whose `<task-id>` names one ends it; a background `Bash` (`toolUseResult.backgroundTaskId`), a `Monitor`
  (`toolUseResult.taskId`) or a workflow launched in the tail adds one. A subagent's own tasks come from its
  `agent-<id>.jsonl` the same way (launches minus completion notices), so the relay can say "waiting on 1 shell,
  1 monitor" per agent. A subagent that stopped with tasks of its own (its SubagentStop with tasks running, or the
  `agent_waiting` notice naming its id) stays open, `idle`, with that status line, until its `agent_done` /
  `agent_failed` / `agent_stopped` notice or its parent ends.
- **Codex rollouts:** `turn_context` gives `model` and `mode` (`approval_policy` `never` + `sandbox_policy`
  `danger-full-access` → `full-access`; `on-request` + `workspace-write` → `auto`; `read-only` sandbox → `read-only`;
  `untrusted` → `untrusted`); `compacted` lines and `item_completed` items of type `ContextCompaction` a `compact`
  notice; `function_call` `update_plan` (`plan: [{step, status}]`) a `plan` notice. Exec cells are the tool events the
  Codex hooks already send (§6), token use the v0.6 `tokensIn`/`tokensOut`.
- **Freshness:** besides reading on every hook event, the relay checks each open shared session's transcript once a
  second (a stat, then only new complete lines), so a notice or title Claude Code writes between hooks reaches the hub
  within about two seconds.

---

# Ask: an agent asks the team's hub (Sean, 2026-11-25)

A hub may answer questions about the team's agents in plain words ("what are An's agents working on?", "who touched
apps/hub today?"). People ask on the board (the hosted hub's side); this section is the relay's way in, for an MCP
tool the relay will add. Still `v: 1`; an older hub answers `404`, which a relay reads as "this hub has no Ask".

## 29. `POST /relay/ask`

- **Request:** `POST /relay/ask` with the device token (`Authorization: Bearer bp_…`, under the `/relay/*` bypass),
  body `{ question: string 1..2000, zone?: string ≤ 64 }`. `zone` is the IANA time zone ("America/New_York") that
  "today" and clock times are read in; absent, UTC.
- **Answer:** `200 { ok: true, answer: string, sessions: [{ hubKey, name, person, state }] }`. `answer` is plain text
  that names sessions and people by name; `sessions` lists the sessions it names (hub keys, §2), so a caller can link
  or message them. `400` schema error, `401` as for ingest, `429` with `Retry-After` (a few questions a minute per
  device, and a daily cap per person shared with the board), `502` the hub's model failed, `503` the hub has no model.
  `Cache-Control: no-store`.
- **What it may say:** only what the hub already shows the device's person, read-only: sessions, states, now lines,
  turn summaries, waiting reasons, tool activity and file paths, claims, leases, holds and notes. Never another
  session's prompt, message or tool-description text, at any sharing level. An agent's question can't act: no
  messages, holds or notes come of it (on B3's hub, people propose those on the board and confirm each one).
- **Privacy:** the question goes to the hub and its model provider (B3's hub: OpenRouter, as for summaries, §Privacy
  rules); the hub keeps no conversation for it, only a count toward the person's daily limit. Logs carry no question
  or answer.
- **The relay side (0.11.x):** an `ask { question }` tool in `workmesh mcp` (§23) and `workmesh ask <question…>`,
  answered by the daemon calling this endpoint with the device token (the agent never holds it): the question redacted
  on the machine (§9), the machine's time zone as `zone`, text only, no streaming, one question in flight per session
  (or per person at a terminal), up to 90 s. The answer is the text, then the sessions it names with their hub keys
  (for `send`). The hub's no fails soft, as a plain answer rather than a tool error, so the agent carries on: `404`
  (a hub without Ask) and `503` (Ask off) are remembered for 10 minutes and `429` until its `Retry-After`, without
  asking the hub again meanwhile; `502` and no answer say so. Code form: `packages/protocol/src/ask.ts`.

---

# v2 Delegate: handoffs, approval gates, waking idle sessions (Sean, 2026-11-25)

"Proceed with next v2 delegate." An agent hands a task to a person (another teammate, or yourself on another of your
machines), and that person's relay starts an agent for it; a person gates their own agents' risky actions (merge,
deploy, publish, force-push, spend) behind an approval; and a message wakes a session that sits idle. Linear B3-7168.
All of it is new endpoints and optional fields beside v1 (§21): an older hub answers `404` and sends none of the new
sync lists, and a relay then carries on as before (nothing is gated, nothing is handed off, messages wait for the
next turn). Nothing here can stop an agent unless its own person opted in (§31).

## 30. Delegate endpoints

Code form: `packages/protocol/src/delegate.ts` (two readings per body, §14). Auth, keys and status codes as in §21:
the device token names the person, requests carry ingest keys, answers carry hub keys.

| Endpoint | Body | Answer |
|---|---|---|
| `POST /relay/handoffs` | `{ action: "create", from?: sessionKey, to: { person }, task: 1..4000, repo?: owner/name, issue?: id, context?: 1..4000 }` | `{ ok: true, handoff }`; `404` `{ ok: false, error }` for no such person |
| `POST /relay/handoffs` | `{ action: "accept" \| "decline" \| "start" \| "done" \| "fail", id, sessionKey?, note?: ≤ 500 }` | `{ ok: true, handoff }`; `404` no such handoff; `409` `{ ok: false, error, handoff? }` a move its state doesn't allow |
| `POST /relay/approvals` | `{ action: "request", sessionKey, gate: GateAction, detail: 1..500, renew?: true }` | `{ ok: true, approval }` |
| `POST /relay/approvals` | `{ action: "approve" \| "deny", id, note?: ≤ 500, via?: "menubar" \| "cli" }` | `{ ok: true, approval }`; `403` not yours to decide, `404`, `409` already decided |
| `POST /relay/gates` | `{ actions: GateAction[] }` (the device's person's own gates; `[]` turns them off) | `{ ok: true, gates: GatePolicy }` |
| `POST /relay/messages` | (§21) gains `wake?: boolean` | as §21 |

- **Handoff** = `{ id, from: { person, sessionKey?, sessionName? }, to: { person }, task, repo?, issue?, context?,
  status, createdAt, updatedAt?, device?, sessionKey?, note? }`. `status`: `offered` → `accepted` → `started` →
  `done` | `failed`, or `offered` → `declined`. Only the recipient accepts or declines (on the board, in their menu
  bar, from one of their agents, or by their relay's policy for a handoff they sent themselves, §31). An `accept`
  from a relay makes that device the runner (`device`); one accepted on the board has no `device` until a relay
  starts it, and then the first `start` wins (the hub answers the others `409`). `start`, `done` and `fail` come from
  the runner; `start` may carry the session it started (`sessionKey`), and a second `start` from the same device only
  adds it. The hub shows the handoff on the board linked to that session. `from` absent = the person wrote it
  themselves. Task and context are written on purpose by an agent or a person, so they go at either sharing level,
  redacted on the machine first (§9), like messages.
- **GateAction**: `merge` (a PR), `deploy`, `publish` (a package or a release), `force_push`, `spend` (paid API or
  infra), `custom`. **GatePolicy** = `{ owner, actions, approvers? }`: the owner's agents need an approval before an
  action in `actions`, from the owner (or one of `approvers` when set). A relay only ever enforces its own person's
  policy; the board may set it too.
- **Approval** = `{ id, sessionKey, owner?, gate, detail, status: "pending" | "approved" | "denied", ts, decidedAt?,
  by?, via?, note? }`. `via` (0.12.1) is where `by` decided it: `board`, `menubar` (their menu bar app) or `cli`
  (`workmesh approvals approve|deny`). A relay's `approve`/`deny` says which of its two it was; the hub records
  `board` for a decision on the board, and none for a relay that didn't say. A reader drops a place it doesn't know. `detail` names the action in a few words, as the relay's matcher reads it from the command
  (`gh pr merge 212 --merge in b3-fun/b3os-beta`), redacted; it is the one piece of a command beyond §3.3's
  program + subcommand that leaves a machine, and only when the person gated that action. A second `request` for
  the same session, gate and detail while one is pending answers the pending one (and B3's hub also answers with a
  decision made in the last few minutes). `renew: true` (0.11.x) says the relay used the last approval for its one
  run (§31): the hub answers only with a pending one, making a new request if none is pending, never with a decision.
  A hub that predates it ignores the field.
- **Wake**: an inbox item (§21) may carry `wake: true`, meaning "start a turn in this session if it is idle". Absent,
  a relay wakes for a message a person wrote (no `from.sessionKey`) and not for one an agent sent; a sender sets
  `wake` on the request to choose. The hub copies it onto the inbox item.

`GET /relay/sync` (§21) gains three optional lists. A hub without v2 sends none; a relay reads their absence as "no
v2 on this hub", and an empty list as "v2, nothing now".

```jsonc
{
  // … §21 …
  "handoffs":  [Handoff],     // offered to this device's person, sent by them, and recently finished; newest first, ≤ 200
  "gates":     [GatePolicy],  // the project's policies (a relay enforces its own person's)
  "approvals": [Approval]     // asked by this device's sessions, and pending ones its person may decide; newest first, ≤ 500
}
```

A relay keeps every item it can read and drops the rest one by one (an unknown handoff status or gate action drops
that item, so a relay never acts on a state it can't read).

## 31. The relay side (`packages/cli`, 0.11.0)

Everything below is opt-in where it could stop an agent, and fails open: no gate holds a command unless its person
turned that gate on and the hub answers v2 with a sync under 90 s old; a request that doesn't reach the hub lets the
command run; a waiter that can't reach the daemon ends.

- **Sync.** The v1 sync (§23) carries the v2 lists; their absence means "no v2" (nothing gated, no handoffs). The
  relay's v2 calls (`/relay/handoffs`, `/relay/approvals`, `/relay/gates`) treat a `404` as "this hub has no v2" for
  10 minutes, without turning v1 coordination off.
- **Approval gates** (`daemon/gates.ts`, `daemon/delegate.ts`). At `PreToolUse` of a shell tool in a shared session,
  a small table reads the command's words the way the shell splits them (`cd`, env assignments, wrappers such as
  `sudo`, `npx`, `pnpm dlx`, and `sh -c "…"` are looked through) for: `merge` (`gh pr merge`, `gh api … /pulls/N/merge`
  with PUT, `glab mr merge`), `deploy` (wrangler deploy/publish/rollback and pages/versions deploy, `vercel --prod`,
  `netlify deploy --prod`, fly/flyctl deploy, railway up, firebase deploy, kubectl apply/rollout/…, helm, terraform /
  tofu apply, pulumi up, cdk deploy, serverless deploy, gcloud … deploy, aws cloudformation/lambda/ecs deploys, and
  `deploy*` scripts through npm/pnpm/yarn/bun/make/just), `publish` (npm/pnpm/yarn/bun publish, `release*` scripts,
  cargo, twine, uv, poetry, gem, docker push, gh release create, changeset, semantic-release, goreleaser),
  `force_push` (`git push` with `-f`, `--force`, `--force-with-lease`, `--force-if-includes`, `--mirror` or a `+`
  refspec), `spend` (a few paid-infra creates: aws ec2 run-instances, gcloud compute instances create, hcloud, doctl,
  vastai, runpodctl, fly scale), and `custom` (the person's own regexes, `gates.custom` in config). When the person's
  policy (`gates`, owner = this device's person) gates the action, the relay looks for an approval for this session,
  gate and detail. Approved (0.11.x): it lets through the exact command it was asked for (the command's words with
  runs of whitespace made one, hashed and kept on the machine), once, within 30 minutes of the decision; the same
  command again, or another command with the same detail, is held and asked anew with `renew: true`. (An approval the
  daemon didn't see asked, after a restart, lets one command with its gate and detail through.) Denied (within the
  hour) refuses it with who and why. Pending, or none yet, holds it with "Waiting for Sean's approval to merge (gh pr
  merge 212 --merge in b3-fun/b3os-beta); Workmesh asked Sean on the team board…", which also says that an approval
  is the person's go-ahead for this exact command, once, and to run it again as written when it arrives; with none
  yet the daemon asks (`request`) in the background, never in the hook path. A request the hub doesn't take (an error, a `404`, no answer) lets that
  command through for 10 minutes and tells the agent so. A decision reaches the session that asked as a notice
  (below), waking it. The `detail` is program, subcommand, the PR or target, safe flags and the repo, never a flag
  value or env value, and is redacted (§9). Agents can't set gates or decide approvals: `gates` and
  `approvals approve|deny` refuse a caller the daemon identifies as an agent session, and the MCP server has no tools
  for them. (A cooperative guard rail, not a sandbox: anything running as the person can call the hub.)
- **Handoffs** (`daemon/delegate.ts`, `daemon/handoff-runner.ts`). MCP `handoff { to, task, repo?, issue?, context? }`
  (repo: the calling session's, by default; `to: "me"` is the person themselves) and `handoffs { action: list |
  accept | decline, id?, note? }`; CLI `workmesh handoff`, `handoffs`, `handoffs policy`, `roots`. Task and context
  are redacted (§9). The policy `handoffs.accept` in config: `auto-self` (absent = this): a handoff the person sent
  themselves is accepted by a machine of theirs at once (the sending machine waits 20 s so another of their machines
  may take it first), anyone else's waits for the person; `ask`: every handoff waits; `never`: this machine runs
  none. Accepted for this device (`device`), or accepted on the board with no device, the runner `start`s it (the
  hub's first-start-wins decides between the person's machines) and runs it: it finds a main checkout of `repo` (the
  shared repos this machine's sessions worked in, remembered in `checkouts.json`, and repos up to two levels under
  `handoffs.roots`), makes `git worktree add -b workmesh/handoff-<id> <checkout>-handoff-<id> <origin's default
  branch>` (`handoffs.worktree: false` runs in the checkout), and starts the agent detached, wrapped in `sh` so its
  exit code lands in a file: `claude -p <prompt> --session-id <uuid chosen before start> --output-format json
  --permission-mode <handoffs.permissionMode, default auto> --name "handoff: …"`, or `codex exec --json -C <dir> --approve-for-me -o <file> <prompt>`
  (§42) (its thread id, read from the first event, goes to the hub as a second
  `start`), each with `--model` / `-m <handoffs.model>` when the person set one (e.g. `haiku`). A handoff with no repo runs in a scratch dir under the state dir, which is shared (it is Workmesh's own
  and holds nothing else). At exit the runner sends `done` (exit 0) or `fail`, with the agent's last words as the
  note at the conversation level (redacted, ≤ 500) and only how it ended at `metadata`. Runs survive a daemon
  restart (`handoffs/running.json`, 0600), at most `handoffs.maxRunning` (2) at once, stopped after
  `handoffs.maxMinutes` (120). The session that sent a handoff gets a notice when it is accepted, declined, started,
  done or failed (the last three wake it). `handoffs` (list) and `approvals` (list) sync first when the last sync is
  over 5 s old, so a person at a terminal sees a handoff offered a moment ago.
- **Notices.** The daemon writes notices for its own sessions (an approval decided, a handoff's progress) into the
  same inbox as teammates' messages, delivered the same way and never acked to the hub.
- **Wake.** An inbox item wakes an idle session when its `wake` says so, else when a person wrote it; the daemon's
  notices about outcomes wake too. Claude Code: `workmesh setup` (and `init`; `--no-wake` skips it) adds a Stop hook
  `{ type: "command", command: "<node> <cli> wake-wait claude-code", asyncRewake: true, timeout: 3600, rewakeMessage,
  rewakeSummary }`: the last two (0.11.x) replace Claude Code's "Stop hook blocking error from command …" before the
  text the model reads with "Workmesh, the team tool your person installed, woke this session (not an error):", and
  the "Stop hook feedback" line the person sees with "Workmesh". Claude Code runs it in the background after each
  turn; it long-polls the daemon (`POST /wake/wait {session, timeoutMs ≤ 55 s}`, bearer secret) and exits 2 with the
  messages on stderr, which Claude Code shows the model and so starts a turn, or exits 0 when the session ends, a
  newer waiter takes over, its parent goes, the daemon is gone for 5 minutes, or after 59 minutes; the next Stop arms
  a new one. It runs only for Claude Code 2.1.330 or newer, read from the transcript's `version` (an older one could
  run an async hook in the foreground), and never for a headless session (`WORKMESH_HANDOFF` set, or
  `CLAUDE_CODE_ENTRYPOINT` sdk-*: `claude -p`, an SDK), which nobody would answer and which Claude Code keeps from
  exiting while an asyncRewake hook runs (found live on a handoff run, 11-25). The daemon hands a
  waiter messages only while its session isn't working (a working session gets them at its next tool boundary, §23),
  marks them delivered when it answers, and frees a waiter whose request closed. Codex: for an idle thread the daemon
  runs `codex queue --thread <id> --message <text>` once per message (verified on codex-cli 0.164: an idle TUI holding
  the thread starts a turn within seconds; a thread nobody holds keeps it until resumed); a failure leaves the message
  for the next tool boundary. `workmesh wake off` turns waking off. The texts say where they come from: a wake for a
  teammate's message asks the agent to answer and not to start unrelated work on a teammate's say-so; an approval
  notice names who decided and as whom ("Your person, Sean," or "An, whom your person Sean named to answer their
  approvals,"), where (0.12.1, from `via`: "on the team board", "in their Workmesh menu bar", "in their terminal";
  no place when the approval carries none, so a notice never claims the board for a decision made elsewhere), quotes the exact command the session was held on (local only: it never leaves the machine), and says
  that this is the person's consent for exactly that command, once, in the next 30 minutes, and that the gate checks
  the approval itself when the command runs.
- **Team knowledge.** The SessionStart note (§23) adds the project's notes tagged `rule` or `convention` (newest first,
  one line each, ≤ 15 lines with the claims) and the person's open claims. When the person gated some actions
  (0.11.x), it also says so up front: which actions wait for whose approval, that the session should end its turn or
  carry on meanwhile, and that an approval, which arrives as a Workmesh wake quoting the command, is the person's
  consent to run exactly that command once, without asking again in the terminal. A person's own rule (a CLAUDE.md
  saying automated messages are never their approval) still wins: live on 11-25, Haiku then mostly asked in the
  terminal (1 of 6 carried on), Sonnet carried on (6 of 6, taking the person's request as the authorization and the
  gate as the check).
- **Menu bar.** `GET /team` adds `delegate: { available, handoffs, approvals }` (handoffs offered to the person or
  running here; pending approvals this machine's agents asked for or the person may decide); Workmesh.app shows
  "Handoffs for you" (Accept / Decline) and "Approvals" (Approve / Deny), answered through `POST /coord/op` as the
  person.
- **`workmesh init <hub-url>`.** Hooks and MCP (as `setup --hooks-only`), the daemon (the service when it can,
  restarted on this build; else in the background), and `hub connect` unless this machine is paired with that hub and
  the hub still accepts its token (`--repair` pairs again; `--share` sets the level either way).

---

# v3 Memory: the team's shared knowledge base (Sean, 2026-11-25)

Sean's first ask (11-24) was agents across several people working toward a shared long-horizon goal "with humans in
the loop, and potentially shared knowledge base". Until now that knowledge was v1's notes: one-word tags, no search,
no review. Memory makes it a knowledge base: decisions, conventions, gotchas, rules and facts that people and their
agents write down, a person accepts, and every agent gets the relevant ones at the start of a session and can search.
All of it is new endpoints and one optional sync field beside v1 and v2: an older hub answers `404` and sends no
`memory`, and a relay then keeps v1's notes (§23, §31).

## 35. Memory endpoints

Code form: `packages/protocol/src/memory.ts` (two readings per body, §14). Auth, keys and status codes as in §21: the
device token names the person, requests carry ingest keys, answers carry hub keys.

| Endpoint | Body | Answer |
|---|---|---|
| `POST /relay/memories` | `{ action: "remember", sessionKey?, kind, title: 1..120, body?: ≤ 2000, scope?: { repo, paths?: ≤ 20 globs }, links?: { issues?, prs? }, tags?: ≤ 10 words, supersedes?: id }` | `{ ok: true, memory }` |
| `POST /relay/memories` | `{ action: "forget", sessionKey?, id, reason?: ≤ 500 }` | `{ ok: true, memory }`; `404` no such memory; `409` `{ ok: false, error }` nothing to retire |
| `POST /relay/memories` | `{ action: "used", sessionKey, ids: 1..50, how: "start" }` | `{ ok: true }` |
| `POST /relay/recall` | `{ sessionKey?, query: 1..500, repo?, paths?: ≤ 20, kinds?, limit?: 1..20 (default 8) }` | `{ ok: true, memories: [Memory & { score }] }`, best first |
| `GET /relay/memories` | | `{ ok: true, rev, memories: [Brief] }` (every accepted memory, newest first, ≤ 500) |

- **Memory** = `{ id, kind, title, body, scope?, links?, tags?, by: { person, sessionKey?, sessionName? }, origin?,
  status, supersedes?, supersededBy?, retire?, createdAt, updatedAt, usedAt?, uses? }`.
  - `id` is short and per project, `m` and a number (`m12`), for people and agents to cite.
  - `kind`: `decision` (a choice made and why), `convention` (how the team does a thing), `gotcha` (a trap hit and
    how it was solved), `rule` (must or must never), `fact` (anything else worth knowing).
  - `scope` absent: the whole project. `{ repo }`: that repo. `{ repo, paths }`: those paths or globs in it, in
    lease-path syntax (§21).
  - `links`: Linear issue ids, GitHub PR links (`https://github.com/owner/name/pull/N`; a relay reads
    `owner/name#N` as one), and the hub keys of the sessions it came from (the hub fills these in).
  - `origin`: `agent` (an agent's `remember`), `person` (the board, a terminal, Ask on a person's confirm), `session`
    (the hub proposed it from a finished session, below), `note` (a v1 note).
  - `status`: `proposed` → `accepted` | `rejected`; an accepted memory becomes `superseded` when a memory naming it in
    `supersedes` is accepted (`supersededBy` points at the newer one), or `retired` when a `forget` takes effect.
    `retire` = `{ by, reason?, ts }` is a pending `forget` on an accepted memory, which stays accepted meanwhile. People
    decide on the board (accept, edit, reject, retire, restore); relays only propose.
  - `usedAt` and `uses`: when an agent last had it (at a session's start, or in a recall's answer), and how often.
- **Who decides.** The hub takes the person from the device token. A memory written with no `sessionKey` is the
  person's own (a terminal) and is `accepted`; one written by an agent session is `proposed`, unless its person turned
  on "accept my agents' memories" (on the hub; off by default) and it doesn't supersede someone else's memory. A
  `forget` follows the same rule (an agent's on a memory its own person wrote, with that setting on, retires it at
  once; anyone else's is a proposal), and an agent's `forget` of its own person's proposal withdraws it (`rejected`).
  Only accepted memories reach agents: the brief, recall answers and the notes list below never carry a proposed,
  rejected, superseded or retired one.
- **Recall** searches titles, bodies, tags and links of accepted memories, by words and by meaning (B3's hub: SQLite
  full-text search with bm25, fused with Workers AI embeddings; full text alone when the model doesn't answer).
  Memories scoped to the asker's `repo` weigh more (those whose paths cover one of the asker's `paths` more still),
  project-wide ones next, other repos' least, so a much better match from elsewhere can still come first. A memory
  found only by meaning must be close to the question. Each hit counts as a use for the asking session. The question
  goes to the hub (and, on B3's hub, to Workers AI to be embedded), redacted first (§9).
- **The brief** is what a relay needs to pick a new session's memories without a network call in the hook path:
  every accepted memory with its body cut to 600 characters, `scope`, linked `issues`, `tags`, `by.person`,
  `updatedAt`. `GET /relay/sync` (§21) gains `memory: { rev }`, which moves whenever the accepted set changes (an
  accept, an edit, a supersede, a retire, a restore); a relay fetches the brief when it moves. Absent: this hub has
  no memory.
- **Notes are memories.** On a hub with memory, `POST /relay/notes` (§21) writes a memory under the same rule: tag
  `rule` or `convention` (or their plurals) gives that kind, else `fact`; the first line is the title (cut at 120),
  the rest the body; the other tags stay tags. Sync's `notes` lists accepted memories in the note shape (text = title,
  a blank line and the body; tags = the kind and the memory's tags), so a 0.11 relay keeps putting rules and
  conventions in its sessions.
- **Proposed from sessions.** A hub may read a finished top-level session's shared turn summaries (§Privacy rules:
  conversation-level devices only, never metadata) and propose at most two memories when something durable was
  learned (a decision made, a gotcha hit and solved, a convention a person stated). These are always `proposed`,
  attributed to the session's person and linked to the session, redacted as summaries are. B3's hub: one setting per
  project, on by default.
- **Privacy.** Title, body, scope, links, a `forget`'s reason and a recall's query are written on purpose by an agent
  or a person, so they are sent at either sharing level, redacted on the machine first (§9); the hub blanks obvious
  secrets again before storing them (§10). Memories are shown to the project's signed-in members and its relays. A
  device that goes back to `metadata` keeps the memories people accepted; the proposals the hub drew from its sessions
  are deleted.

## 36. The relay side (`packages/cli`, 0.12.0)

- **Sync.** When a sync carries `memory.rev` and it differs from the brief's, the daemon fetches `GET /relay/memories`
  (at most every 10 s; errors back off 10 s doubling to 5 min, a `429` waits out its `Retry-After`) and keeps the brief
  in memory. A brief whose own `rev` is newer than the sync's is kept, and not fetched again for the older one. A `404`
  on any memory endpoint (one with no `{ ok }` answer: a `404` saying "no such memory" is an answer) means "this hub
  has no memory" for 10 minutes, without touching v1 or v2. A `remember` or `forget` the hub answered (0.12.1) is
  applied to the cached brief at once: an accepted memory goes in (and the one it supersedes out), a retired, superseded
  or rejected one out, a proposal changes nothing. A brief asked for before the hub answered gets it laid over again;
  one asked for after is the hub's word. So `memories` and the next session start show a write without waiting for the
  sync and the brief's 10 s throttle.
- **Session start** (`daemon/memory.ts`, pure and table-tested; replaces §31's notes block when the hub has memory).
  The note a shared top-level session gets once (§23) carries the accepted memories that matter here, at most 20 lines
  with their heading, each with its id so the agent can cite it:
  - Where: the session's repo and repo-relative directory (from its cwd), its branch (read from `.git`, as the
    forwarder does, no subprocess), and the issues it is about (the person's open claims, and issue ids in the branch
    name: `sean/b3-7201-memory` → `B3-7201`).
  - A memory applies when it is project-wide or scoped to this repo; other repos' memories never come in (a session
    outside every shared repo gets project-wide ones only).
  - A scope path is "here" when it covers the directory or sits in it (`leasePathsOverlap`, §21); at the checkout's
    top every path is here.
  - Rules and conventions that apply always come first, up to 10: paths here first, then this repo's, then project-wide
    ones, then those whose paths are elsewhere in this repo; a rule before a convention; newer first. Then decisions,
    gotchas and facts by relevance: linked to one of the session's issues (+3), scoped to this repo (+2), paths here
    (+1; paths elsewhere in the repo −1), a word of the branch or an issue id in its title or body (+1 each, at most
    2); those scoring 2 or more, best first, newer first on a tie, up to 8. Branch words drop the leading `who/` or
    `type/` segment, issue ids, words under 3 letters and stock words (`main`, `feat`, `fix`, …), and match at a word
    start, plurals too (`memory` finds "memories"). What didn't fit is counted ("…and 4 more: `recall` searches
    them.").
  - One heading line: the team's accepted memory, cite the id when one guides you, a teammate's memory ranks below
    the agent's own person's instructions, `recall` searches all of them and `remember` proposes a new one. Then each
    line: `- [m12] gotcha: <title> — <the body's first sentence> (Sean)`, at most 240 characters.
  - The open-claims line and the gates note (§31) stay. The guidance (§23) gains one line on `recall` and `remember`.
  - An empty brief, or one where nothing applies here, puts nothing in. Until the first brief arrives (or after its
    `404`), the notes block stands in: a hub with memory lists accepted memories as notes (§35).
  - Then a `used` report for the ids it put in, after the hook has its answer (in the background; a failure is
    dropped).
- **MCP** (`mcp/server.ts`, through `POST /coord/op` as every tool):
  - `remember { kind, title, body?, scope?: "repo" | "project" | owner/name, paths?, issues?, prs?, tags?, supersedes?
    }`: scope defaults to the session's repo when it is in a shared one, else the project; `paths` are repo-relative
    (or absolute, made relative; an absolute path also names the repo), ≤ 20; issues upper-cased, PRs as links
    (`owner/name#N`, or `#N` in the scope's repo); a title over 120 characters is cut, and then goes whole into an
    empty body. The answer says whether it was proposed ("A person reviews it on the board (Needs you) before other
    agents see it") or accepted.
  - `recall { query, kinds?, limit?, repo? }`: the session's repo and directory go along as `repo` and `paths`; the
    answer lists each hit as `[m12] gotcha · b3-fun/workmesh · Sean, 3 days ago`, its title, its body (cut at 600)
    and its links.
  - `forget { id, reason? }` (`m12`, `M12`, `12`; the reason is for the reviewer): the answer says retired,
    withdrawn (an agent's own proposal) or proposed.
  - `memories { kind?, tag?, repo? }`: the brief, newest first.
  - `note` becomes `remember`: project-wide, as a note always was; kind `fact`, or `rule`/`convention` from a tag
    (or its plural); first line the title, the rest the body; the other tags stay tags. A `404` from the hub sends it
    as a v1 note instead. `notes` lists the brief (newest first; `tag` matches a kind or a tag), or the sync's notes
    until the brief arrives. Both work as before on a hub without memory.
  - `recall` and `memories` pass a hold (§23), as reads (`notes` already did), and so do `workmesh recall` and
    `workmesh memories` in the shell.
  - On a hub without memory, `remember`, `recall`, `forget` and `memories` say so plainly (`remember` and `forget` as
    a failure, since nothing was saved; the reads as an answer).
- **CLI.** `workmesh remember <title…> --kind <kind> [--body] [--project | --repo [owner/name]] [--path …] [--issue
  …] [--pr …] [--tag …] [--supersedes]` (paths relative to the current directory, unless `--repo owner/name` names
  the repo they are relative to), `workmesh recall <words…> [--kind …] [--limit] [--repo]`, `workmesh forget <id>
  [--reason]`, `workmesh memories [--kind] [--tag] [--repo]` (the brief). From a terminal outside an agent session
  these are the person's own words (§35: accepted at once). The caller is found as in §23, so a terminal in a live
  agent session's directory reads as that session and its memory is a proposal: the safe side of the two mistakes.
- Text (title, body, reason, query) is redacted on the machine (§9) before it is sent.

# Keeping current (relay 0.12.0, Sean 2026-11-25)

Every release from 0.10.0 to 0.11.1 meant a message to each teammate with an npm command, and sessions started before
an upgrade went on without the new tools until someone restarted them. From 0.12.0 the relay keeps itself current.

## 40. Versions on the wire

- Every ingest carries `client: workmesh/<version>` (since 0.10, §24): the hub keeps each device's version.
- `GET /relay/team` adds `latestClient` (optional, `0.12.1`): the newest `@b3os/workmesh` on npm, as the hub last read
  it (it reads the registry every hour). Absent until the hub has read it. Relays read it with `hubTeamAcceptSchema`,
  which drops anything that isn't a release version.
- The board compares the two: a device whose `client` is older than `latestClient` is behind. It says so quietly
  (each device's version on Settings → Devices, who's behind in the team view with the command to run, a dot in the
  header for the viewer's own), never with a banner.

## 41. The relay side (`packages/cli`, 0.12.0)

- **`workmesh update`.** Reads how Workmesh was installed from the path of the CLI file that runs
  (`lib/install-method.ts`): a global npm install (`<prefix>/lib/node_modules/@b3os/workmesh`), pnpm (its store path is
  read through the `node_modules/@b3os/workmesh` symlink), bun, yarn classic or Volta; a git checkout (a `.git` above
  the package with no `node_modules` between: `npm link` resolves into one), a project dependency, npx's cache, or
  something else. Only the first five can be updated; the others change nothing, exit 3 and say what to do (a git
  checkout: pull, build, `workmesh restart`). An npm prefix this user can't write says to use `sudo npm i -g`. The
  newest version is the `latest` dist-tag from the registry npm is configured with (`npm config get registry`, so a
  mirror in `~/.npmrc` counts). When it is newer, the update:
  1. keeps a copy of the installed package (npm: `~/.local/state/workmesh/update/previous/<version>`; other managers
     reinstall the old version from the registry on a rollback);
  2. installs `@b3os/workmesh@<latest>` the same way (`npm install --global --prefix <prefix>`, `pnpm add -g`,
     `bun add -g`, `yarn global add`, `volta install`), its output indented under the step;
  3. runs the NEW version's `workmesh update --finish`, so the code that knows the new hooks and tools re-runs the setup
     steps: Claude Code hooks where Workmesh's are installed (the wake hook only if it was), Codex hooks and notify
     where installed, the MCP registration where registered (a file merge, never the `claude` CLI), then stops the
     daemon cleanly and starts it on the new build (by its service, whose definition is rewritten when it changed).
     Its core checks: the daemon answers `/health` with the new version within 20 s, hooks still installed and pointing
     at a Node that exists, MCP still registered, `workmesh --version` prints the new version. A failed check exits 2;
  4. on that exit code (or a crash), rolls back: the copy goes back (or the old version is reinstalled), the old
     version's own setup steps run and its daemon restarts, and it says so (exit 1).
  Each step prints what it did. Up to date and set up, it changes nothing. Up to date but never set up here (installed
  with `npm i -g` by hand, as 0.11.x users do once), or with the daemon still on an older build, it runs the setup
  steps for this version. `update.json` (state dir, 0600) records the version whose setup last ran (`init` and
  `setup` write it too) and the last update (`ok`, `rolledBack`, `auto`). One update at a time (`update.lock`).
  `--check` only reports (`--json` too); `--to <version>` picks a version (0.12.0 or newer).
- **Notices.** The daemon serves `GET /update` (bearer secret): `{current, latest?, available, checkedAt?, source?:
  "hub" | "npm", install: {method, canUpdate, hint?}, run?: [node, cli, "update"], auto: {enabled, scope}, last?,
  menubar?}`. `latest` is the hub's `latestClient` (§40) when the hub sends it, else (or when the hub's is older than this
  relay, a hub that hasn't read npm since a release) the registry's, read at most every 6 h (attempts count, failed ones too; kept in `update-check.json` across restarts); the newer of the two wins.
  `menubar` (macOS) is the latest GitHub release's `Workmesh-menubar-macos.zip` with the SHA-256 digest GitHub reports
  for the asset, read at most every 6 h; a release without a digest offers nothing. `/health` adds `version`.
  `workmesh status` ends with "0.12.1 available: `workmesh update`"; `doctor` has a `version` check (that notice, or the
  daemon still on an older build than the CLI).
- **Auto-update** (opt-in: `workmesh update --auto on`, `--minor` to include minor releases, `--auto off`; config
  `update: {auto, scope}`). The daemon starts `workmesh update --auto-run` at most once a day for a release within the
  scope (patch: same major.minor; minor: same major; never a major or a prerelease), never again for a version whose
  update failed, and only for an install it can update. It runs detached in its own session (launchd cleans up only the
  job's process group), on Linux in its own transient unit (`systemd-run --user`: stopping `workmesh.service` kills its
  cgroup), with its output in `update.log`.
- **Stale sessions.** A hook sends its version (`x-workmesh-client`) and, at SessionStart, the start's source
  (`x-workmesh-start`: `startup`, `resume`, `clear`, `compact`) and a fingerprint of what a session takes from Workmesh
  at start (`x-workmesh-surface`: the MCP tools' names and input schemas, the hook events). A new process (`startup`,
  `resume`) records what it started under; `/clear` and compaction keep the process and the record
  (`session-versions.json`, 0600, 14 days). When the daemon runs a newer version with a different fingerprint, the
  session's next hook that carries context (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse; not a subagent's,
  not a refused call) says once: "Workmesh was updated to 0.12.1 (this session started under 0.12.0)." plus what
  reloads its tools (below). With no record (a session from before 0.12.0), a
  Claude Code process (its `~/.claude/sessions/<pid>.json` `startedAt`) older than the daemon's first run of this
  version counts as started under the previous one. Hook commands themselves run the files on disk, so they're new at
  once; the `workmesh mcp` server a session started is not.
- **What reloads** (verified live on Claude Code 2.1.332 and Codex 0.164, 11-25; the note's advice follows it). Claude
  Code: hooks added to settings.json apply to running sessions within seconds; `/clear` keeps the MCP servers (it only
  fires SessionStart with `clear`); `/mcp reconnect workmesh` (or Reconnect in the `/mcp` menu) starts a new MCP process
  from the files on disk. Codex: a thread keeps the MCP servers and hooks it started with, a new thread (`/new`, or a
  new `codex`) gets new ones, and there is no MCP reconnect (restarting Codex's background server reloads every
  thread). So the note tells a Claude Code session its hooks are current and to run `/mcp reconnect workmesh` or start
  a new session, and a Codex thread to start a new thread.
- **Menu bar.** Workmesh.app reads `GET /update`: one "Update available" item that runs `run` in a window with its
  output, and, when the release's menu bar app is newer than itself, downloads the zip, checks its SHA-256 against
  `menubar.sha256`, swaps itself in place and relaunches (apps/menubar/README.md).

---

# Codex parity (relay 0.12.x, Sean 2026-11-25)

"Teammates use Codex too." The 11-25 two-person test was Claude Code only, and Codex support had been built against
fixtures. A live run (codex-cli 0.164 in temp `CODEX_HOME`s, its background app server auto-updated to 0.172, two
relays paired with a local hub as two people) found what follows. No wire change: everything here is on the relay.

## 42. Codex on the relay (`packages/cli`)

- **Where Codex runs threads.** Codex 0.164+ runs threads in a shared app server per Codex home (a background daemon
  that updates itself); the TUI and `codex exec` are its clients. Quitting the TUI fires no `SessionEnd` (the thread
  stays loaded); the server unloads it about a minute later and then fires `SessionEnd`. Restarting or updating the
  server unloads every thread, firing `SessionEnd`, and an open TUI resumes its thread a second or two later, firing
  nothing.
- **SessionEnd** (`daemon/codex-liveness.ts`). A Codex `SessionEnd` waits 10 s. If by then Codex holds the thread again
  (its writer lock `<home>/thread-writer-locks/<id>.lock` exists, made at or after the end; `<home>` read from the
  rollout path, so a `CODEX_HOME` the daemon's env lacks still counts), the session stays, as idle; otherwise it ends.
  A hook event from the thread meanwhile drops the pending end. Without this the board showed a live thread ended and
  the daemon stopped waking it until its person typed.
- **Notify.** Codex also notifies for its own helper threads (a thread's title is generated in one whose "last
  message" is `{"title":…}`). A notify (`detail.hookEvent: "notify"`, local only) counts only for a thread the daemon
  already knows and whose hooks don't run (an older Codex, hooks not trusted yet); otherwise it is dropped. Before,
  every titled thread left a ghost session in the menu bar.
- **Rollout watcher.** For a thread whose hooks run, a rollout write is only a heartbeat (nothing, once the thread
  ended): Codex writes a turn's last records after its Stop hook, which flipped the idle thread back to working for
  the three minutes until the stale sweep, and no wake reached it (an approval waited minutes, live). Without hooks the
  watcher still marks the thread working.
- **Title** (conversation level). A main thread's title is the name its TUI shows, the last `thread_name` for the
  thread in `<home>/session_index.jsonl` (Codex 0.164 writes it nowhere in the rollout), read 1.5 s after each turn
  ends. A spawned thread's stays its task name (§15).
- **MCP tools without prompts.** Every Workmesh tool carries MCP annotations: `readOnlyHint` (`whoami`, `roster`,
  `inbox`, `leases`, `notes`, `ask`, `recall`, `memories`) or `destructiveHint: false, openWorldHint: false` (the
  rest: they change team state on the hub, a closed domain, and delete nothing). Codex's default `auto` approval then
  runs them without asking; without the hints Codex asked the person before every Workmesh call (so a woken session
  stalled on "Allow the workmesh MCP server to run tool send?") and, under `approval_policy = "never"` (`codex exec`,
  so every handoff run), refused them all. Claude Code ignores the hints; its permissions stand.
- **The shell can't reach the daemon.** Codex's sandbox blocks loopback connections (`curl 127.0.0.1:4519` exits 7 in
  `workspace-write`), so the `workmesh` CLI run by a Codex agent fails unless the person approves an escalation. A
  Codex session's guidance, hold refusal and lease refusal name the MCP tools only (the MCP server runs outside the
  sandbox). A Codex refusal drops its final period: Codex prints "Command blocked by PreToolUse hook: <reason>.
  Command: …".
- **Messages are framed as their sender's.** The daemon's own notices have `wmn_` ids. The hub's message ids are
  `wm_<ULID>`, which the daemon's notices used to share, so a teammate's message read as "news about its own earlier
  work" with no "Message from An" (Claude Code and Codex alike).
- **Wake.** `codex queue --thread <id> --message <text>` gets the wake inside `<workmesh-wake>…</workmesh-wake>`: Codex
  hands a queued message to the thread as a user prompt, and the tag makes the hook read it as injected (§19), so the
  board shows a turn and no prompt the person didn't type. `codex queue` runs in the thread's Codex home. A thread
  Codex unloaded (its TUI closed a minute ago) has ended: the message waits in the inbox and is delivered when the
  person resumes the thread (`codex resume <id>` fires `SessionStart`, the daemon queues it, the thread answers).
- **Handoff runs.** `codex exec --json -C <dir> --approve-for-me --skip-git-repo-check -o <file> -c
  sandbox_workspace_write.network_access=true [-m <model>] <prompt>`, plus a line in the prompt that `git commit` and
  `git push` need escalated sandbox permissions. Under `-s workspace-write` with approvals off a run edited files but
  never committed: Codex keeps the repo's git metadata read-only, a worktree's gitdir included (even when added with
  `--add-dir`), and gave it no network to push. `--approve-for-me` keeps that sandbox and sends each escalation to
  Codex's automatic reviewer, Codex's counterpart of the `auto` permission mode a Claude Code handoff runs in. A Codex
  whose `exec --help` lacks the flag runs as before.
- **Doctor.** `workmesh doctor` asks Codex itself whether it trusts Workmesh's hooks: `codex app-server` over stdio,
  `initialize`, then `hooks/list` for the home directory (what Codex's `/hooks` reads), reporting trusted, not trusted
  yet, changed since trusted (Codex re-asks after any change to a hook's command or timeout) and turned off. When Codex
  can't answer it reads `[hooks.state."<hooks.json>:<event>:<group>:<hook>"]` `trusted_hash` tables in config.toml
  (which can't show a change). It follows `notify` through another tool's chain (Codex Computer Use passes the
  previous notify on as a JSON array) to the Workmesh CLI it runs, and warns when that file is gone or is another
  install.
- **Uninstall** also removes `[mcp_servers.workmesh.tools.*]` tables (Codex writes them for "Always allow"): left
  alone, they make an `mcp_servers.workmesh` with no command, and Codex then won't load its config at all.
- **Not available in Codex** (and what stands in):
  - A live process check (`alive`): no per-thread process; the writer lock and the 15-minute idle sweep stand in.
  - `update_plan`: Codex 0.164+ in its default code mode has no plan tool, so `plan` notices come only from older
    builds' rollouts.
  - A per-tool `desc`: Codex's shell calls carry no description (only an escalation's justification).
  - An MCP reconnect: a thread keeps the MCP server it started with; a new thread (`/new`) gets the current one.
  - The shell CLI inside the default sandbox (above): the MCP tools stand in.
  - A wake for a thread nobody has open: the message waits for its next turn, as for a closed Claude Code session.

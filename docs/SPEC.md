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
them (§3.3, §8, §9); the numbers missing here (§4, §5, §7, §11–13, §17–18, §20, §22, §25, §27, §28) covered the hub's internals, which moved to the
hosted hub's own docs. Sections 1–13 were written while the hub was Bullpen and the relay was agentblip; where they say
agentblip, read the Workmesh CLI.

Linear: parent B3-7165, v0 B3-7166 (project "B3OS Beta"). Research behind it: the Linear document
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
  - `slack`: from Slack MCP tool calls (send, read thread, …): channel id and message ts, the permalink when the
    response carries one or the workspace host is known, `label` = the channel name when the call names it.
    Conversation level only.
  - `url`: not sent by the relay in this pass.
  The hub reads links tolerantly: a link it can't read is dropped on its own, past 10 it keeps the first ten.

Ingest body adds `person: { github?: string ≤ 40 }`: the person's GitHub login as the local `gh` CLI reports it
(`gh api user --jq .login`, read at `hub connect` and at daemon start, 5 s timeout, skipped when `gh` is absent or not
logged in), sent on every heartbeat for the board's and menu bar's avatars. The hub reads a malformed value as absent.

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
  calls on the parent, as before. A main session's `statusLine` says what it waits on ("waiting on 1 shell") from
  its Stop's `background_tasks`.
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
  - A hold on the session (or the session a subagent runs under) refuses every tool call, naming who held it and why.
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
  `note` and `notes`. It talks to the local daemon only (`POST /coord/op` on the loopback API, bearer secret as
  everywhere) and never holds the device token; the daemon makes the hub calls. The daemon tells which session is
  calling from the caller's parent process (Claude Code's `~/.claude/sessions/<pid>.json`), else
  `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`, else the live session in the caller's directory that moved last;
  none of them means the person at a terminal. Message and note text is redacted (§9) before it is sent.
- **Registration.** `workmesh setup` (and `setup --hooks-only`; `--no-mcp` skips it) registers the server with Claude
  Code at user scope (`claude mcp add -s user workmesh -- <node> <cli> mcp` when the `claude` CLI is on PATH, else a
  merge into `~/.claude.json`, written by rename) and with Codex as `[mcp_servers.workmesh]` in `~/.codex/config.toml`.
  Both back the file up once before the first change, repoint an older install of theirs, and leave alone another
  server named `workmesh` or a file they can't read. `workmesh doctor` checks both, and whether the running daemon
  coordinates.
- **Guidance.** A shared top-level session gets a five-line note once (`SessionStart`, or the first boundary after it
  becomes shared) while the hub coordinates: it is on Workmesh with its team, and how to claim, lease, read its inbox,
  and message a holder instead of editing leased files.
- **Menu bar.** `GET /team` adds `coord: { available, holds: [{ session, name, by, reason, since }], unread: [{ id,
  session, name, from, fromSession, text, ts, delivered }] }` for this machine's sessions; Workmesh.app shows "On
  hold" and "Messages for your agents".
- **CLI.** `workmesh leases`, `lease`, `unlease`, `claims`, `claim`, `send`, `inbox`, `note`, `notes`, `whoami`, through
  the same daemon call as the MCP tools.

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
- **The relay side (to come):** an `ask { question }` tool in `workmesh mcp` (§23), answered by the daemon calling this
  endpoint with the device token (the agent never holds it): text only, no streaming, one question in flight per
  session, `404` remembered for 10 minutes like the other v1 endpoints.

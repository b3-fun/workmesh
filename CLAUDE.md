# CLAUDE.md — Workmesh

> Single source of truth for AI-assisted development. Keep updated as work progresses.

---

## Project Overview

- **Product**: Workmesh (formerly agentblip) — your team's coding agents, live on one board and in your Slack status. Each session is a blip on your team's radar: "claude agent working", "3 agents working", "claude: finalizing CI/CD". This repo is the client and the protocol: the relay on each machine (CLI, daemon, hooks, menu bar app), the wire protocol between relay and hub (`packages/protocol`, contract in `docs/SPEC.md`), and agentblip.com (site + Slack-status relay). **The hosted platform is private:** the team hub and its board (formerly Bullpen) live in `b3-fun/workmesh-cloud`, which pins this repo as a submodule (split 2026-11-24, Sean: the platform stays hosted by B3; what's installed on a user's machine is open source).
- **Domain**: agentblip.com (kept; the Worker script, routes and KV keep their agentblip names so the live site and device records survive)
- **Hub**: https://workmesh.b3os.org (B3's hosted hub, Cloudflare Access), also served at bullpen.b3os.org so relays paired there keep working. Code, deploys and internals: private repo `b3-fun/workmesh-cloud`
- **Repo**: github.com/b3-fun/workmesh (open source, MIT; renamed from b3-fun/agentblip, old URLs redirect)
- **npm**: `@b3os/workmesh` (bins `workmesh` and the `agentblip` alias), published from the npclabs npm account
- **Status**: building
- **Last updated**: 2026-11-25 (v2 Delegate: wire merged #22; relay side 0.11.0: `workmesh init`, wake, handoffs, approval gates, team knowledge at session start)

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Runtime | Cloudflare Workers | Relay backend + site, one Worker |
| API Framework | Hono | Typed `Hono<{ Bindings: Env }>` |
| Language | TypeScript | Strict mode, no `any` |
| Frontend | React Router v7 (framework mode, SSR) | `@cloudflare/vite-plugin`, landing + /pair pages |
| Styling | Tailwind CSS v4 | `@tailwindcss/vite` |
| Validation | Zod v4 | Slack-relay contracts in `packages/core/src/events.ts`; relay ↔ hub in `packages/protocol` |
| Storage | Cloudflare KV only (Slack relay) | Pairing codes (TTL) + device records. No D1, no ORM |
| CLI | Commander.js + tsup | ESM single-file bundle, published as `@b3os/workmesh` |
| Tests | Vitest | Pure-logic units in core, protocol, CLI + worker lib |

---

## Architecture

```
Claude Code hooks ─┐
Codex watcher ─────┤   POST /event      ┌────────────────────┐  POST /api/status   ┌──────────────┐
Any tool (curl) ───┼──────────────────▶ │ workmesh daemon    │ ───────────────────▶│ relay Worker │──▶ Slack API
                   │  localhost:4519    │ SessionStore →     │  pre-formatted      │ (or direct   │   users.profile.set
                   └                    │ formatStatus →sink │  SlackStatus only   │  Slack sink) │
                                        └────────────────────┘                     └──────────────┘
```

- **The daemon is the only thing that sees raw session data.** The relay receives a pre-formatted `SlackStatus` (text/emoji/expiration) — nothing else. Privacy by construction.
- Slack status carries a rolling `status_expiration` (default 5 min), so a dead daemon auto-clears your status.
- Three sinks: `relay` (hosted or self-hosted Worker), `slack` (direct user token, no server), `console` (dry run).

## Project Structure

```
├── CLAUDE.md                  # ← this file (keep updated)
├── README.md                  # flagship OSS readme
├── wrangler.jsonc             # Worker config: KV STORE, custom domains, secrets docs
├── workers/app.ts             # Worker entry: Hono /api + RR7 SSR catch-all
├── src/                       # Worker backend
│   ├── env.ts                 # Env bindings/secrets types
│   ├── api/                   # Hono routes: pair, slack oauth, status, health
│   └── lib/                   # kv store, slack client, token crypto, rate limit
├── app/                       # React Router v7 (SSR)
│   ├── root.tsx
│   ├── routes.ts
│   ├── routes/                # _index (landing), pair, privacy
│   └── app.css                # Tailwind v4
├── packages/
│   ├── core/                  # @workmesh/core — shared, dependency-light (zod only)
│   │   └── src/               # events (zod wire contracts), aggregate, format, redact
│   ├── protocol/              # @workmesh/protocol — relay ↔ hub wire schemas (strict to send, accept to read), limits
│   └── cli/                   # @b3os/workmesh npm CLI (daemon + adapters + sinks)
│       └── src/
│           ├── commands/      # init, setup, start/restart, stop, status, emit, hook, wake, pause, unlink, doctor, hub, coord, roots
│           ├── lib/           # config, paths + names (workmesh dirs, legacy agentblip names), migrate (one-time copy), daemon-control (stop/start pidfile logic)
│           ├── adapters/      # claude-code (hooks), codex (hooks.json + notify + watcher), workflow (ultracode journal watcher), detail (local-only hook facts)
│           ├── hub/           # hub forward: git (.git reader), rules (SPEC §3.3 reductions), redact (SPEC §9), transcript (tailer), forwarder (batching/retry), coord (v1 sync client), shell-writes (paths a command writes)
│           ├── mcp/           # `workmesh mcp`: stdio MCP server (hand-written JSON-RPC), talks to the daemon only
│           └── sinks/         # relay, slack-direct, console
├── apps/
│   └── menubar/               # native SwiftUI macOS menu bar app (thin daemon client)
│       ├── Sources/WorkmeshMenuBar/   # App, AppModel(poll loop), DaemonClient, Models, StatusIcon, MenuContent, SessionRow, Notifier
│       └── scripts/make-app.sh        # SwiftPM build → Workmesh.app (LSUIElement)
└── docs/                      # SPEC.md (relay ↔ hub protocol + privacy rules), SELF_HOSTING.md, INTEGRATIONS.md, slack-app-manifest
```

## API Routes (Worker)

- `GET  /api/health` — public health check
- `POST /api/pair/start` — CLI begins pairing → `{code, deviceId, pollSecret, verifyUrl}` (IP rate-limited)
- `POST /api/pair/poll` — CLI polls → `{status, deviceToken?}` (token plaintext returned once)
- `GET  /api/slack/install?code=` — redirects to Slack OAuth (user_scope: `users.profile:write,users.profile:read`)
- `GET  /api/slack/callback` — OAuth exchange, links Slack user to pending pairing
- `GET  /api/slack/status` — `Bearer ab_…` device token; returns `{readable, status}` (`statusReadResponseSchema`) — current Slack status, read transiently for the daemon's ownership decision; `readable:false` = token predates the read scope (legacy blind pushes)
- `POST /api/status` — `Bearer ab_…` device token; body `{status: SlackStatus | null}`; null clears
- `POST /api/unlink` — revoke device; body `{clear?: boolean}` (default true) decides whether to wipe the status (CLI runs the ownership plan and sends `clear:false` for foreign/restored statuses)

### Daemon loopback API (127.0.0.1:4519, bearer secret except /health)

- `GET /health` · `GET /state` · `POST /event` · `POST /resume`
- `POST /pause` — empty body pauses until resumed; `{for: "30m"|"1h"|"tomorrow"}` or `{until}` snoozes, the pusher's sweep tick auto-resumes (`lib/snooze.ts`); `/state.pausedUntil`
- `POST /sessions/dismiss {key}` — drops a session (`SessionStore.remove`); it returns with its next event
- `GET /config` — token-free `safeConfig` view · `POST /config` — live-tune `granularity`/`statusPolicy`/`showProject`/`repoPrefix` (validated by `liveConfigPatchSchema`, applied via `pusher.applyConfig()`, persisted). Used by the menu bar app.
- `GET /hub` — hub forwarder status (`{enabled:false}` when not paired) · `POST /hub/reload` — re-read the config's `hub` section and restart the forwarder (used by `workmesh hub connect|disconnect|include|exclude`)
- `GET /team` (v0.5) — the team from the hub's `/relay/team` (polled by `hub/team.ts`), with `hubUrl`, `boardUrl`, `share`, `connected`, `halted`, `available` (false = older hub, 404); `?open=1` = the menu is open (15 s polling). The menu bar's team section reads only this.
- v1 (SPEC §21, §23): `POST /event` with an `x-workmesh-hook: <HookEvent>` header answers `{ok, coord?: {deny?, context?}}`
  from the cached coordination state (`daemon/coord-hooks.ts`; the hook prints it as hook JSON); `POST /coord/op
  {op, args, caller}` runs an MCP/CLI coordination call (`daemon/coord-ops.ts`; the daemon resolves the caller's
  session and makes the hub call); `GET /team` adds `coord` (holds on this machine's agents, undelivered messages).
- `/state` sessions are `SessionView`s: `stateSince`, `background`, `cwd`, `name` (local only), `subagents` + `foldedInto` (fan-out folding). Keep it additive: the menu bar app and Sean's desk clock (~/dev/studio-pixbar) both read it.

Wire contracts: `packages/core/src/events.ts` (zod schemas, shared CLI ↔ agentblip.com Worker). Hub wire format:
`packages/protocol/src/index.ts` (shared CLI ↔ hub).

## Hub forward

A second output beside the Slack pusher: the daemon forwards session metadata to a team hub (contract:
`docs/SPEC.md` §3, §8–10; B3's hub at https://workmesh.b3os.org).

- Hook mappers fill a local-only `SessionEvent.detail` (tool, absolute path, raw command, raw prompt, truncated shell
  output, ok). It goes hook → daemon on loopback only; `SessionStore` never copies it, so Slack and the Workmesh relay
  never see it (tested in `test/detail.test.ts`).
- `HubForwarder` (`packages/cli/src/hub/forwarder.ts`) runs when config has `hub`. `observe()` is sync and cheap;
  network runs on its own 1 s timer. Inclusion: path → git root + origin (read from `.git`, no subprocess, worktrees →
  main repo), shared when origin contains an `include.remotes` entry or sits under an include dir; `hub exclude` dirs
  beat everything. Sessions in an unshared cwd follow SPEC rule 4. Labels are reduced to Workmesh's fixed vocabulary;
  `cmd` is program + one subcommand from an allow list; issues/PRs are extracted locally.
- Every record is validated against `@workmesh/protocol`'s strict schemas (the hub reads the same fields with its
  accept schemas); a bad optional field is dropped rather than costing the batch a 400. Full heartbeat every 30 s,
  5,000-event buffer, stable ids, backoff, `Retry-After`, halt on 401.
- Pairing: `workmesh hub connect <url>` (device code). Token + project rule live in `config.json` (0600) under `hub`;
  a malformed `hub` section reads as unpaired instead of breaking the Slack config.
- Codex: `workmesh setup` merges `~/.codex/hooks.json`; `hook codex-hooks` maps it. Codex needs `/hooks` trust once.
- Sharing level (0.7.0, SPEC §8-10): `hub.share` in config (absent = `conversation`, Sean 11-24), set by
  `hub connect --share` (a terminal asks, suggesting the earlier choice, else the project's `defaultShare`, else
  conversation; no terminal keeps the earlier choice or conversation) and `hub share <level>`. Every ingest body
  carries `share`. `hub.stickyShare` (absent = true; `hub sticky off`) decides whether a session outside every shared
  repo stays shared after it touched one, or is shared turn by turn.
- At `conversation`, for every shared session, rule-4 orchestrators included (da9fbe1, Sean 11-24: "default max
  sharing"; the 0.7.0 rule that kept their text home is gone):
  prompt `text` (from UserPromptSubmit), `message` events (assistant text blocks tailed from the transcript),
  `desc` on tool events, `turn` events with `durationMs`. `hub/redact.ts` scrubs every text and desc before it is
  queued; home paths become `~`. Caps: text 4,000 (`truncated`), desc 200.
- Transcript tailing (`hub/transcript.ts`): a tail starts at the file's size when the session becomes
  conversation-shared (never earlier text); reads run async after `observe()` returns (setImmediate), complete
  lines only, ≤ 2 MB per read, oversized lines skipped, truncation or a new inode restarts at the new end. Claude
  Code: `transcript_path`, `assistant` text blocks (not thinking/tool_use, not sidechain, not `isApiErrorMessage`),
  `system`/`turn_duration` (written just after the Stop hook, so a Stop waits up to 5 s for it, else prompt → stop).
  Codex: `transcript_path` or `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` (UUIDv7 → its day), `response_item`
  assistant `output_text`, `event_msg` `task_complete.duration_ms`; threads only in `thread_history_*.sqlite` fall
  back to Stop's `last_assistant_message`.
- Batching is by size (< 256 KB, ≤ 4 requests per tick while a backlog drains, 16 MB buffer). A hub that 400s the
  new kinds gets message/turn/agent_message events held back 10 min while everything else still flows.
- v0.6 structure (SPEC §15, `hub/agents.ts` readers): SubagentStart/SubagentStop hooks (heartbeats for the parent:
  Slack unchanged) and the `agent_id` on hooks inside a subagent make `<parent key>/<agentId>` sessions (role,
  agentType, meta.json title at conversation level, model + tokens from `agent-<id>.jsonl`, status line); sent only
  while the hub serves `/relay/team` (`setStructured`), else their tool calls stay on the parent. Codex threads read
  `session_meta` for their parent; workflow runs sum their agents' tokens. `agent_message` from SendMessage (hook),
  peer messages and Codex sends (transcript tail). Links per event (Linear ids, gh PR/issue on shared repos, Slack
  at conversation level). `person.github` from `gh api user` (`lib/github.ts`) on heartbeats.
- v1 Coordinate (SPEC §21, §23): `CoordClient` (`hub/coord.ts`) polls `/relay/sync` (5 s while a shared session is
  live, else 60 s; backoff, 429, 404 off for 10 min, 401 halt) and makes lease/claim/message/note calls for the MCP
  server and CLI. Hooks get refusals (hold; edit to another session's leased file, shell writes via
  `hub/shell-writes.ts`), heads-ups (another person edited the file in the last 10 min), guidance once per shared
  session and inbox messages (then acked), all from memory. Fail-open: leases need a sync under 90 s old; a known hold
  lasts 30 min without one. A refused call is applied as a heartbeat. `workmesh setup` registers `workmesh mcp` for
  Claude Code (`claude mcp add -s user`, else a `~/.claude.json` merge) and Codex (`[mcp_servers.workmesh]`); tests
  pass `claudeBin: null` so the real `claude` CLI never runs.
- v0.11 session mirror (SPEC §26, `hub/mirror.ts`): the tail (now kept for metadata-level shared sessions too, which
  send only states and counts from it) also reads `ai-title`/`custom-title` (main session `title`, conversation),
  `permission-mode` (`mode`), the model, `compact_boundary`, task notices (Claude Code's `<summary>` templates →
  `notice` events, the template's quoted title as `desc` at conversation level, never a monitor event's output) and
  background launches (`toolUseResult.backgroundTaskId`/`taskId`/`async_launched`). Stop's `background_tasks` (ids +
  kinds, `detail.backgroundTasks`) is the session's `TaskSet`; ending notices remove by id; turns and notices carry
  `tasks`. Subagents count their own tasks from `agent-<id>.jsonl` (ClaudeUsageReader) and stay open (`bgWait`) after
  a SubagentStop with tasks running, until their `agent_done` notice. Codex: `turn_context` → model + mode,
  compactions, `update_plan` → `plan` notice (conversation). Every tick marks live sessions' tails dirty (one stat
  when unchanged), so lines written between hooks arrive in ~1–2 s. An older hub's 400 holds `notice` like `message`.
- v0.7 (SPEC §19): system-injected markup is read by `stripInjected` (`@workmesh/protocol`, zod-free, also
  `@workmesh/protocol/injected` for the hub's board). A wholly injected prompt (task notice, wrapped agent message,
  only provenance markers) maps to `InjectedPrompt` in the Claude Code and Codex hooks: a turn starts, no prompt is
  sent; the forwarder strips markup from prompt, message and agent_message text before redaction (`textOf`).
  Subagent sessions send `name` (task title at conversation level, else agent type). A session whose cwd is outside
  every shared repo sends `repos` (shared repos touched by file tools or by shell commands naming a seen root, most
  recent first, `Tracked.recent`); its `repo` is the first.
- v0.10 liveness (SPEC §24): `HubForwarder` saves its shared sessions, transcript offsets and unsent queue to
  `~/.local/state/workmesh/hub-forward.json` (`hub/persist.ts`: atomic, 0600, ≤ 1/s, on stop) and reads it back in
  `start()` before the first send (`restoreState`; `seedSessions` → `SessionStore.restore`; `isGone` from Claude
  Code's session files ends dead ones with `alive: false`). No empty `full` heartbeat in the first 2 min after a
  start; heartbeats still go every 30 s. Every ingest carries `client: workmesh/<version>`; upserts carry `alive`
  (process seen) and `quietSince` (working, no hook event for 60 s). The daemon runs as a service (`lib/service.ts`,
  `workmesh service install|uninstall|status`, installed by `setup`): launchd `org.npclabs.workmesh.daemon`
  (KeepAlive unless a clean exit) or systemd `--user` `workmesh.service`; `stop` writes `daemon.stop-requested` so
  the daemon exits 0 for a stop and 75 for any other SIGTERM under the service; a service daemon waits for a running
  one to exit. `WORKMESH_NO_SERVICE=1` turns service use off (the CLI tests set it).

- v2 Delegate (SPEC §30, §31, 0.11.0): `CoordClient` reads the optional v2 sync lists (absent = no v2) and makes the
  v2 calls (a `404` there turns off only v2, for 10 min); the daemon writes its own notices into the inbox (`wm_` ids,
  never acked). `daemon/delegate.ts`: approval gates in `PreToolUse` (matcher `daemon/gates.ts`, table-tested; asks in
  the background; approved within the hour runs, denied refuses, a failed ask lets it run), handoff policy
  (`handoffs.accept`, default `auto-self`), sender notices, and wake waiters (`POST /wake/wait`, long-poll ≤ 55 s).
  `daemon/handoff-runner.ts`: checkout index (`checkouts.json` + `handoffs.roots`), worktree, detached `claude -p
  --session-id` / `codex exec` wrapped in `sh` (exit code file), done/fail, `handoffs/running.json`. Claude Code wake is
  the `wake-wait claude-code` asyncRewake Stop hook (exit 2 + stderr), Codex is `codex queue` (`daemon/codex-wake.ts`).
  `commands/init.ts` is the one-step onboarding. Agents can't set gates or decide approvals (no MCP tools; the ops
  refuse an agent caller).

## The hosted hub (private)

- **The hosted platform is private; this repo is the client and protocol.** The team hub (Cloudflare Worker
  `bullpen` and its Durable Object, NPC Labs), its board, summaries and the vendored B3OS UI kit live in
  `b3-fun/workmesh-cloud` (private, proprietary) with their own CLAUDE.md: deploys, secrets, internals
  (`docs/HUB.md`). Never copy hub or board code, the B3OS kit or hub internals into this repo.
- workmesh-cloud pins this repo as a git submodule (`vendor/workmesh`) and reads `@workmesh/protocol` from it. A wire
  change lands here first (`packages/protocol` + `docs/SPEC.md`, with the relay's side and tests); the hub follows by
  moving its pin. Keep the hub's reading tolerant: relays update on their own schedule.
- From v0.4 until the split the hub lived here in `apps/hub`; that code stays in this repo's history (public history
  is not rewritten), but nothing is developed here any more.

## Working rules

- **Contract:** `docs/SPEC.md` is the relay ↔ hub contract (wire format, what may leave a machine, sharing levels,
  redaction, privacy rules). Change it in the same commit as any code that departs from it.
- **Linear:** parent B3-7165, v0 B3-7166 (project "B3OS Beta", team NPC Labs). Sean's agents prefix every Linear
  comment with "(Claude, for Sean)", comment at each merge and deploy, and re-read the issue's comments before each
  merge or deploy. A person's comment is an instruction; "hold" pauses the work.
- **Deploy:** agentblip.com deploys from CI on every push to `main` (`.github/workflows/deploy.yml`). The hub
  deploys from workmesh-cloud.
- **Privacy:** the hub stores metadata (SPEC §3.3) and, from devices that chose `conversation` (SPEC §8, Sean's word
  on 2026-11-24), prompt and agent message text and one-line tool descriptions. Anything beyond that (tool input or
  output, file contents, full commands) is out of scope without Sean's word.
- **Commits:** small, pushed after each one. Never force-push, never skip hooks. Commit messages end with the
  Co-Authored-By line for the model that wrote them.
- **Never edit a live checkout:** Sean's hooks run `~/Documents/workmesh/packages/cli/dist/index.js`; work in a
  worktree.

## KV Schema (binding: STORE)

- `pair:{code}` → `{deviceId, pollSecretHash, status, deviceToken?, team?}` (TTL 15 min; `deviceToken` plaintext, only during OAuth→CLI handover — single-use with a 60s delivered-grace)
- `pairdev:{deviceId}` → code (TTL 900s) — pairing-code lookup for polling
- `pairstate:{nonce}` → code (TTL 600s) — OAuth CSRF state
- `device:{sha256(token)}` → `{slackUserId, teamId, teamName, encToken, createdAt, lastSeenAt, provisional?}` (provisional until first authenticated use, 24h TTL if never used)
- `rl:{scope}:{key}:{minute}` → counter (TTL 2 min)

## Key Decisions

| Date | Decision | Rationale |
|---|---|---|
| 2026-07-06 | KV-only, no D1/Better Auth in v1 | Relay is a token store, not an app DB. Self-hosters set up 1 KV namespace + 2 secrets. Accounts/dashboard can come later |
| 2026-07-06 | CLI formats status locally; relay is dumb | Server never sees session/project/tool data — only final status text. Best privacy story for OSS |
| 2026-07-06 | Device pairing flow (code → browser → Slack OAuth → token) | No accounts needed; mirrors happyuptime CLI claim flow |
| 2026-07-06 | Slack tokens AES-GCM-encrypted in KV (`TOKEN_ENCRYPTION_KEY` secret) | KV dump alone can't leak xoxp tokens |
| 2026-07-06 | Rolling `status_expiration` (5 min default) | Dead daemon → status auto-clears; no stale "working" lies |
| 2026-07-06 | Hook/adapter events → tiny localhost HTTP API | One integration surface; Claude Code hooks, Codex, and any custom tool all speak the same `POST /event` |
| 2026-07-07 | macOS menu bar app is a thin native SwiftUI client of the daemon's loopback API (apps/menubar), NOT a reimplementation | Preserves DRY — all logic stays in core/daemon; app is presentation+control only. SwiftPM executable + make-app.sh bundle (no Xcode/pbxproj), so it builds from CLI. Needed a live `GET`/`POST /config` on the daemon so the app retunes settings without a restart |
| 2026-07-08 | Fan-out reporting: a session carries an `agents` count + `phase`; `StatusSnapshot.agentCount` = Σ agents over working sessions is what "N agents working" shows. `workmesh report` is the orchestrator wrapper | Claude Code hooks fire per session and expose no subagent/workflow count (verified live: a 10-agent workflow folds into one session). Self-reporting is the only way to make the "N agents working" headline true for ultracode/CI fan-out. Plain sessions unchanged (agentCount == working) |
| 2026-07-08 | Workflow watcher adapter (packages/cli/src/adapters/workflow.ts) polls Claude Code's `~/.claude/projects/**/subagents/workflows/*/journal.jsonl` (started − result = live agents) and auto-reports each ultracode workflow as a `workflow:<runId>` session | Ships in the CLI so *every* user gets accurate "N agents working" for ultracode with zero setup — the only automatic route, since Workmesh can't change the Workflow tool itself. Poll-based (bounded cost over the deep tree), pure `stepWorkflows`/`liveAgentCount` for testability, degrades to no-op on missing dir/format. Verified live: 5-agent workflow → "5 agents · running a workflow" → drained → cleared |
| 2026-07-06 | npm workspaces (core, cli) + root Worker app | Matches newest house projects (littledemo, motioness); core stays source-only, bundled by consumers |
| 2026-07-06 | RR7 SSR framework mode | Current house standard (extractvibe, stackhooks, ogrender) |
| 2026-07-06 | Static OG image v1 (no satori) | One marketing page; not worth the wasm weight yet |
| 2026-07-06 | Daemon port 4519 | Unassigned range, no common collisions |
| 2026-07-06 | Daemon loopback API requires an auto-generated bearer secret (`~/.local/state/workmesh/daemon.secret`, 0600) on `/event` `/state` `/pause` `/resume`; `/health` open | localhost isn't a trust boundary — blocks other local users and browser-based (DNS-rebinding) event injection |
| 2026-07-06 | Pairing handover: plaintext device token only in the pair record (≤15 min, single-use + 60s delivered-grace); device records provisional (24h TTL) until first authenticated use | Keeps privacy claims strictly true; abandoned pairings self-clean |
| 2026-07-06 | Status ownership protocol: new `users.profile:read` user scope; daemon reads current status before each push, core `planStatusUpdate()` (packages/core/src/ownership.ts) decides push/restore/clear/skip; `statusPolicy: "respect"` (default) never overwrites a foreign status and resumes when it clears, `"overwrite"` saves the displaced status and restores it on clear; a manual mid-session change always wins; tokens without the read scope degrade to legacy blind pushes (`readable:false`) | Workmesh must never clobber a status it didn't set; the status field is shared with the human and other apps |

| 2026-11-23 | Claude Code `idle_prompt` is "needs my input" only when the turn ended by asking: the hook reads the transcript tail (64 KB → 1 MB) for the last assistant text (question mark, ask phrases, "## Needs your OK" headings, negation-aware) or an unanswered AskUserQuestion/ExitPlanMode; otherwise idle/"done"; background work → working/background; unreadable → waiting | The idle reminder fires for every unanswered turn, so Slack/menu bar/desk clock said "waiting on me" for turns waiting on a colleague. ~1 ms on 400 MB transcripts |
| 2026-11-23 | Daemon liveness probe over `~/.claude/sessions/<pid>.json` every 15s (`daemon/claude-liveness.ts`): reap a session seen alive then gone > 2 min; `SessionStore.touch` working sessions Claude reports busy/shell; annotate session names | Crashed sessions never send SessionEnd. Never reaps a session it never saw alive (older Claude Code, other config dirs). `touch` is separate from `updatedAt` so a probe can't make apply() drop a real hook event as out-of-order |
| 2026-11-24 | Hub forward (0.6.0): local-only `detail` on SessionEvent + `HubForwarder` beside the pusher; relay schemas mirror the hub's validation | Bullpen needs per-tool-call metadata, but the Workmesh relay's privacy-by-construction must hold. Detail never reaches a session, Slack or the relay; the forwarder reduces it to allow-listed metadata, and strict schemas make extra fields unsendable |
| 2026-11-24 | Codex lifecycle hooks via `~/.codex/hooks.json` (merge, never overwrite), notify + watcher kept as fallbacks | Codex 0.16x has Claude-Code-style hooks; payload fields verified against the JSON schemas embedded in the codex binary. Gives Codex tool-level activity and a real waiting state (`PermissionRequest`, `request_user_input`) |
| 2026-11-24 | Git resolution reads `.git` files directly (HEAD, commondir, config) with a 5 s cache | The forwarder sits in the daemon's request path; spawning `git` per event would block it |
| 2026-11-24 | Conversation sharing (0.7.0): opt-in `conversation` level; text only from cwd-shared sessions, from the moment they are shared; redaction on the machine before queueing | Sean asked for prompts and agent updates on the board. Rule-4 orchestrators (cwd outside shared repos) work on other repos too, so their text stays home; starting the transcript tail at the file's current end makes "nothing before sharing" structural, not a filter |
| 2026-11-24 | Redaction tuned against real agent text (shapes only) | A pattern list alone mangled markdown labels, secret names, doc links and timestamps; a local audit over ~16.7k real assistant blocks found them without copying any content |
| 2026-11-24 | Rename to Workmesh (Sean): `@b3os/workmesh` (bins `workmesh` + `agentblip` alias), `@workmesh/core`, `~/.config/workmesh` + `~/.local/state/workmesh`, `WORKMESH_*` env, `Workmesh.app` / `org.npclabs.workmesh.menubar`, repo b3-fun/workmesh. Old names are read, never written: every CLI start copies a missing config.json / daemon.secret / ownership.json from the agentblip dirs (≤ 0600, no clobber, old kept); `AGENTBLIP_*` env fallbacks; hook installers recognise agentblip/crewblip/workmesh commands and repoint them; the daemon mirrors its secret to the old state dir while it exists (older menu bar app, desk clock, hooks of an old checkout). Worker name, routes, KV and agentblip.com unchanged | Ties in with B3IQ's Workcell; one name for relay + hub. Renaming the Worker would orphan the live site and its device records; copying (not moving) keeps a rollback path |
| 2026-11-24 | `stop` returns only after the daemon exits (SIGTERM, 5 s, SIGKILL); a starting daemon ignores a pidfile whose process is gone or isn't ours (`ps` command line), and waits for one still shutting down; a daemon removes the pidfile only if it still names itself; `workmesh restart` | `stop && start --detach` raced a daemon still clearing its status: the hook-spawned or explicit start saw the live pid and died, leaving nothing running |
| 2026-11-24 | One public monorepo (v0.4, Sean): the hub comes in from b3-fun/bullpen under `apps/hub` with its history (rewritten under the prefix, `docs/research.html` filtered out, `Imported-From` trailers); npm workspaces with one lockfile; `docs/SPEC.md` is the one contract | One system, one place to change it. The research document quotes teammates' Slack messages, so it stays in Linear and never entered this repo's history |
| 2026-11-24 | `@workmesh/protocol`: one wire package with two readings per body (strict to send, accept to read), tested so every strict-valid body parses unchanged on the hub | The relay and hub each had a copy of the schemas, kept in step by hand. The hub must stay tolerant (old and new relays, Postel), the relay strict (privacy: an extra field can't be sent), so both readings live together from shared field rules |
| 2026-11-24 | Hub serves workmesh.b3os.org and bullpen.b3os.org; Worker script stays `bullpen` | Paired relays keep working without re-pairing; a renamed script would orphan the Durable Object |
| 2026-11-24 | Split (Sean): the hub, board, summaries and B3OS kit move to the private `b3-fun/workmesh-cloud` (with `apps/hub`'s history, same path); this repo keeps the CLI, core, protocol, menu bar app, site, SPEC (protocol + privacy) and the one ROADMAP. workmesh-cloud pins this repo as a submodule for `@workmesh/protocol` | "The platform always remains hosted / by us, while the piece that gets installed on users machine is open source". Public history is not rewritten: the hub's code up to the split stays in it |
| 2026-11-25 | v1 relay: hooks answered from the daemon's cached `/relay/sync` on the existing loopback request (a header, not a new endpoint, so new hooks and old daemons mix); fail-open everywhere except a known hold (30 min); the MCP server holds no token | More teammates are installing it; Sean: it must never get in the way of anyone's work. Hook latency measured unchanged (130-138 ms p50) |
| 2026-11-25 | v2 relay: gates and handoffs opt-in per person, wake via Claude Code's `asyncRewake` Stop hook (2.1.330+ by the transcript's version) and `codex queue`; handoffs in a new worktree; texts say the gate re-checks so an agent needn't trust a wake | The whole team onboards at once: nothing may stop anyone's work. Live, a woken model won't treat hook feedback as consent, which is right; the gate's own re-check is what makes the retry safe |
| 2026-11-23 | Menu bar 0.2: grouped live list, SF Symbol template icon (orange only for needs-you), row actions, snooze; all new data via `/state` fields and daemon endpoints | Keeps the thin-client rule; roadmap in apps/menubar/README.md |
| 2026-11-24 | v0.7 (SPEC §19): one zod-free `stripInjected` in the protocol package for relay, hub and board; subagent `name` = task at conversation, type at metadata; orchestrators send `repos` | Injected markup reached the board as prompts and agent messages (and a tmp path in a task notice); one tested reading keeps relay, hub backstop and board in step. Subagents showed as raw keys. An orchestrator's repo flipped with each file it touched and said nothing about the others |
| 2026-11-24 | v0.5/v0.6 relay: daemon polls the hub's `/relay/team` and serves `GET /team` for the menu bar; subagents are hub sessions with `parent`/`role`, sent only once the hub answers `/relay/team`; tokens as Claude Code counts an agent | One capability signal keeps an older hub's board from filling with subagents; Claude Code's own `totalTokens` matched the context + output reading exactly on 5 of 6 real subagents, while a billing sum ran 1.1–6× larger |

## Cloudflare Resources

| Resource | Binding | Notes |
|---|---|---|
| Worker | — | script name `agentblip` (kept through the Workmesh rename; routes agentblip.com + www) |
| KV | STORE | id in wrangler.jsonc (create per-deploy) |
| Var | BASE_URL | https://agentblip.com |
| Var | SLACK_CLIENT_ID | public by design |
| Secret | SLACK_CLIENT_SECRET | via wrangler secret put |
| Secret | TOKEN_ENCRYPTION_KEY | base64 32 bytes, AES-GCM |

## Development

- `npm run dev` — RR7 + Worker dev server
- `npm test` — every workspace (CLI, core, protocol) + the site/relay worker units (vitest)
- `npm run typecheck` — RR typegen + tsc -b + workspaces
- `npm run deploy` — build + wrangler deploy
- CLI dev: `npm run dev -w packages/cli` (tsup watch), `node packages/cli/dist/index.js`

## Current State

### Working (deployed to agentblip.com)
- [x] core: events/aggregate/format/redact/slack + 19 tests
- [x] Worker relay: pairing (provisional records, delivered-grace, code normalization), Slack OAuth, status API, rate limits — 52 tests
- [x] CLI: daemon (bearer-secret loopback API), claude-code + codex adapters, relay/slack/console sinks, 10 commands — 99 tests
- [x] 0.6.0 (merged): hub forward + `hub` commands + Codex hooks — CLI 307 tests, core 53, worker 62
- [x] 0.7.0 (branch `hub-conversation`, not merged/published): sharing levels, redaction, prompt/message/desc/turn capture, transcript tailing — CLI 451 tests, core 59, worker 62
- [x] Rename to Workmesh (branch `workmesh-rename`): dirs + one-time migration, `WORKMESH_*`, `stop` waits / `restart`, Workmesh.app, site + docs — CLI 478 tests, core 59, worker 62
- [x] One repo (branch `monorepo`, 0.8.0, not published): hub + board under `apps/hub` with history, `@workmesh/protocol`, one SPEC/CONTRIBUTING, hub on workmesh.b3os.org + bullpen.b3os.org — CLI 478 tests, core 55, protocol 14, hub 105, worker 62
- [x] Split (branch `split-hosted`): hub, board and B3OS kit moved to the private `b3-fun/workmesh-cloud` with their history; SPEC is the public protocol + privacy rules — CLI 478 tests, core 55, protocol 14, worker 62
- [x] v0.6 wire (#3, merged): protocol 22 tests
- [x] v1 Coordinate wire (#10, merged): protocol 60 tests
- [x] v1 Coordinate relay (0.10.0): sync, hook enforcement, inbox, MCP, setup, menu bar
- [x] v2 Delegate wire (#22, merged): protocol 79 tests
- [ ] v2 Delegate relay (branch `delegate-v2`, 0.11.0 not published): init, wake, handoffs, gates, knowledge, menu bar — CLI 769 tests
- [ ] v0.5/v0.6 relay (branch `relay-v06`): subagents, agent messages, links, avatars, `/team`, multiplayer menu bar — CLI 525 tests
- [x] Landing + /pair + /privacy (RR7 SSR), deployed with custom domain
- [x] GitHub github.com/b3-fun/workmesh public, CI + push-to-deploy green (secrets set)
- [x] E2E smoke: daemon lifecycle + live relay pairing/auth verified

### Pending (needs Sean)
- [ ] Slack app creation from docs/slack-app-manifest.json → set SLACK_CLIENT_ID var + SLACK_CLIENT_SECRET secret, redeploy (OAuth leg untestable until then)
- [ ] npm publish of packages/cli (needs npm auth)
- [ ] www.agentblip.com DNS propagation (record created at deploy; verify)

## Work Log

### 2026-07-06 — Project start → shipped v0.1 skeleton-to-production in one day
- Named agentblip (domain bought, whois-verified); recon of house style across 12 sibling projects
- Scaffolded per house standard; core package with full unit tests
- Parallel 4-agent build (worker API / landing / CLI / docs+CI), integration pass
- 5-dimension adversarial review: 39 agents, 33 confirmed findings → all fixed (see Decisions)
- Deployed to agentblip.com (KV cb8fd24c…, secrets set; SLACK_CLIENT_SECRET is a placeholder until the Slack app exists)
- Next: Slack app creds, npm publish, real-world dogfood with Claude Code hooks

### 2026-11-24 — Renamed to Workmesh
- Repo b3-fun/workmesh, npm `@b3os/workmesh`, `@workmesh/core`, workmesh config/state dirs with a one-time copy from agentblip's, `WORKMESH_*` env, Workmesh.app, site copy (team board section); `stop` waits for exit, `restart` added
- Kept on purpose: the `agentblip` bin alias, reads of the old dirs/env/hook commands, agentblip.com and the Worker/KV names

### 2026-11-24 — One repo (v0.4)
- Hub + board from b3-fun/bullpen under `apps/hub` with its 13 commits (research.html filtered out), pnpm → npm workspace `@workmesh/hub`
- `packages/protocol` replaces `packages/core/src/hub.ts` and the hub's `schema.ts`; docs/SPEC.md, one CONTRIBUTING, AGENTS rules here
- Hub deployed with workmesh.b3os.org beside bullpen.b3os.org; CI runs hub tests + board build; hub deploys stay manual

### 2026-11-24 — Split: open client, hosted platform
- Sean: "separate the UI from the agent/daemon, so that the platform always remains hosted / by us, while the piece that gets installed on users machine is open source"
- `apps/hub` (Worker, DO, board, summaries, vendored B3OS kit, fake relay) moved to the private `b3-fun/workmesh-cloud` with its history at the same path; it pins this repo as a submodule for `@workmesh/protocol`
- Here: `apps/hub` removed from `main` (still in history), workspaces/lockfile/CI without it, SPEC split (protocol + privacy public, hub internals in workmesh-cloud `docs/HUB.md`)

## Roadmap

`ROADMAP.md` is the project roadmap, kept public (Workmesh: the relay, formerly agentblip, and the hosted hub, formerly Bullpen, as one system; hub work in workmesh-cloud updates it here too, without hub internals). Update it in the same PR as any work that changes an item's status, and log product decisions there.

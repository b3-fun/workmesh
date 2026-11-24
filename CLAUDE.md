# CLAUDE.md — agentblip

> Single source of truth for AI-assisted development. Keep updated as work progresses.

---

## Project Overview

- **Product**: agentblip — your Slack status, synced with your local AI agent sessions. Each session is a blip on your team's radar: "claude agent working", "3 agents working", "claude: finalizing CI/CD".
- **Domain**: agentblip.com
- **Repo**: github.com/b3-fun/agentblip (open source, MIT)
- **npm**: `agentblip` (CLI)
- **Status**: building
- **Last updated**: 2026-11-24 (0.7.0 conversation sharing)

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Runtime | Cloudflare Workers | Relay backend + site, one Worker |
| API Framework | Hono | Typed `Hono<{ Bindings: Env }>` |
| Language | TypeScript | Strict mode, no `any` |
| Frontend | React Router v7 (framework mode, SSR) | `@cloudflare/vite-plugin`, landing + /pair pages |
| Styling | Tailwind CSS v4 | `@tailwindcss/vite` |
| Validation | Zod v4 | Wire contracts in `packages/core/src/events.ts` |
| Storage | Cloudflare KV only | Pairing codes (TTL) + device records. No D1, no ORM |
| CLI | Commander.js + tsup | ESM single-file bundle, published as `agentblip` |
| Tests | Vitest | Pure-logic units in core + worker lib |

---

## Architecture

```
Claude Code hooks ─┐
Codex watcher ─────┤   POST /event      ┌────────────────────┐  POST /api/status   ┌──────────────┐
Any tool (curl) ───┼──────────────────▶ │ agentblip daemon   │ ───────────────────▶│ relay Worker │──▶ Slack API
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
│   ├── core/                  # @agentblip/core — shared, dependency-light (zod only)
│   │   └── src/               # events (zod wire contracts), aggregate, format, redact
│   └── cli/                   # `agentblip` npm CLI (daemon + adapters + sinks)
│       └── src/
│           ├── commands/      # setup, start, status, emit, hook, pause, unlink, doctor, hub
│           ├── adapters/      # claude-code (hooks), codex (hooks.json + notify + watcher), workflow (ultracode journal watcher), detail (local-only hook facts)
│           ├── hub/           # hub forward: git (.git reader), rules (SPEC §3.3 reductions), redact (SPEC §9), transcript (tailer), forwarder (batching/retry)
│           └── sinks/         # relay, slack-direct, console
├── apps/
│   └── menubar/               # native SwiftUI macOS menu bar app (thin daemon client)
│       ├── Sources/AgentblipMenuBar/  # App, AppModel(poll loop), DaemonClient, Models, StatusIcon, MenuContent, SessionRow, Notifier
│       └── scripts/make-app.sh        # SwiftPM build → agentblip.app (LSUIElement)
└── docs/                      # SELF_HOSTING.md, INTEGRATIONS.md, slack-app-manifest
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
- `GET /hub` — hub forwarder status (`{enabled:false}` when not paired) · `POST /hub/reload` — re-read the config's `hub` section and restart the forwarder (used by `agentblip hub connect|disconnect|include|exclude`)
- `/state` sessions are `SessionView`s: `stateSince`, `background`, `cwd`, `name` (local only), `subagents` + `foldedInto` (fan-out folding). Keep it additive: the menu bar app and Sean's desk clock (~/dev/studio-pixbar) both read it.

Wire contracts: `packages/core/src/events.ts` (zod schemas, shared CLI ↔ Worker). Hub wire format: `packages/core/src/hub.ts`.

## Hub forward (Bullpen)

A second output beside the Slack pusher: the daemon forwards session metadata to a team hub (contract: Bullpen
`SPEC.md` §3 in `b3-fun/bullpen`; hub at https://bullpen.b3os.org).

- Hook mappers fill a local-only `SessionEvent.detail` (tool, absolute path, raw command, raw prompt, truncated shell
  output, ok). It goes hook → daemon on loopback only; `SessionStore` never copies it, so Slack and the agentblip relay
  never see it (tested in `test/detail.test.ts`).
- `HubForwarder` (`packages/cli/src/hub/forwarder.ts`) runs when config has `hub`. `observe()` is sync and cheap;
  network runs on its own 1 s timer. Inclusion: path → git root + origin (read from `.git`, no subprocess, worktrees →
  main repo), shared when origin contains an `include.remotes` entry or sits under an include dir; `hub exclude` dirs
  beat everything. Sessions in an unshared cwd follow SPEC rule 4. Labels are reduced to agentblip's fixed vocabulary;
  `cmd` is program + one subcommand from an allow list; issues/PRs are extracted locally.
- Every record is validated against strict schemas that mirror the hub's own validation; a bad optional field is
  dropped rather than costing the batch a 400. Full heartbeat every 30 s, 5,000-event buffer, stable ids, backoff,
  `Retry-After`, halt on 401.
- Pairing: `agentblip hub connect <url>` (device code). Token + project rule live in `config.json` (0600) under `hub`;
  a malformed `hub` section reads as unpaired instead of breaking the Slack config.
- Codex: `agentblip setup` merges `~/.codex/hooks.json`; `hook codex-hooks` maps it. Codex needs `/hooks` trust once.
- Sharing level (0.7.0, SPEC §8-10): `hub.share` in config (absent = `metadata`), set by `hub connect --share` (a
  terminal asks, suggesting the earlier choice, else the project's `defaultShare`, else metadata; no terminal keeps
  the earlier choice or metadata) and `hub share <level>`. Every ingest body carries `share`.
- At `conversation`, only for shared sessions whose cwd is in a shared repo (rule-4 orchestrators stay metadata):
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
  new kinds gets message/turn events held back 10 min while everything else still flows.

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
| 2026-07-08 | Fan-out reporting: a session carries an `agents` count + `phase`; `StatusSnapshot.agentCount` = Σ agents over working sessions is what "N agents working" shows. `agentblip report` is the orchestrator wrapper | Claude Code hooks fire per session and expose no subagent/workflow count (verified live: a 10-agent workflow folds into one session). Self-reporting is the only way to make the "N agents working" headline true for ultracode/CI fan-out. Plain sessions unchanged (agentCount == working) |
| 2026-07-08 | Workflow watcher adapter (packages/cli/src/adapters/workflow.ts) polls Claude Code's `~/.claude/projects/**/subagents/workflows/*/journal.jsonl` (started − result = live agents) and auto-reports each ultracode workflow as a `workflow:<runId>` session | Ships in the CLI so *every* user gets accurate "N agents working" for ultracode with zero setup — the only automatic route, since agentblip can't change the Workflow tool itself. Poll-based (bounded cost over the deep tree), pure `stepWorkflows`/`liveAgentCount` for testability, degrades to no-op on missing dir/format. Verified live: 5-agent workflow → "5 agents · running a workflow" → drained → cleared |
| 2026-07-06 | npm workspaces (core, cli) + root Worker app | Matches newest house projects (littledemo, motioness); core stays source-only, bundled by consumers |
| 2026-07-06 | RR7 SSR framework mode | Current house standard (extractvibe, stackhooks, ogrender) |
| 2026-07-06 | Static OG image v1 (no satori) | One marketing page; not worth the wasm weight yet |
| 2026-07-06 | Daemon port 4519 | Unassigned range, no common collisions |
| 2026-07-06 | Daemon loopback API requires an auto-generated bearer secret (`~/.local/state/agentblip/daemon.secret`, 0600) on `/event` `/state` `/pause` `/resume`; `/health` open | localhost isn't a trust boundary — blocks other local users and browser-based (DNS-rebinding) event injection |
| 2026-07-06 | Pairing handover: plaintext device token only in the pair record (≤15 min, single-use + 60s delivered-grace); device records provisional (24h TTL) until first authenticated use | Keeps privacy claims strictly true; abandoned pairings self-clean |
| 2026-07-06 | Status ownership protocol: new `users.profile:read` user scope; daemon reads current status before each push, core `planStatusUpdate()` (packages/core/src/ownership.ts) decides push/restore/clear/skip; `statusPolicy: "respect"` (default) never overwrites a foreign status and resumes when it clears, `"overwrite"` saves the displaced status and restores it on clear; a manual mid-session change always wins; tokens without the read scope degrade to legacy blind pushes (`readable:false`) | agentblip must never clobber a status it didn't set; the status field is shared with the human and other apps |

| 2026-11-23 | Claude Code `idle_prompt` is "needs my input" only when the turn ended by asking: the hook reads the transcript tail (64 KB → 1 MB) for the last assistant text (question mark, ask phrases, "## Needs your OK" headings, negation-aware) or an unanswered AskUserQuestion/ExitPlanMode; otherwise idle/"done"; background work → working/background; unreadable → waiting | The idle reminder fires for every unanswered turn, so Slack/menu bar/desk clock said "waiting on me" for turns waiting on a colleague. ~1 ms on 400 MB transcripts |
| 2026-11-23 | Daemon liveness probe over `~/.claude/sessions/<pid>.json` every 15s (`daemon/claude-liveness.ts`): reap a session seen alive then gone > 2 min; `SessionStore.touch` working sessions Claude reports busy/shell; annotate session names | Crashed sessions never send SessionEnd. Never reaps a session it never saw alive (older Claude Code, other config dirs). `touch` is separate from `updatedAt` so a probe can't make apply() drop a real hook event as out-of-order |
| 2026-11-24 | Hub forward (0.6.0): local-only `detail` on SessionEvent + `HubForwarder` beside the pusher; relay schemas mirror the hub's validation | Bullpen needs per-tool-call metadata, but the agentblip relay's privacy-by-construction must hold. Detail never reaches a session, Slack or the relay; the forwarder reduces it to allow-listed metadata, and strict schemas make extra fields unsendable |
| 2026-11-24 | Codex lifecycle hooks via `~/.codex/hooks.json` (merge, never overwrite), notify + watcher kept as fallbacks | Codex 0.16x has Claude-Code-style hooks; payload fields verified against the JSON schemas embedded in the codex binary. Gives Codex tool-level activity and a real waiting state (`PermissionRequest`, `request_user_input`) |
| 2026-11-24 | Git resolution reads `.git` files directly (HEAD, commondir, config) with a 5 s cache | The forwarder sits in the daemon's request path; spawning `git` per event would block it |
| 2026-11-24 | Conversation sharing (0.7.0): opt-in `conversation` level; text only from cwd-shared sessions, from the moment they are shared; redaction on the machine before queueing | Sean asked for prompts and agent updates on the board. Rule-4 orchestrators (cwd outside shared repos) work on other repos too, so their text stays home; starting the transcript tail at the file's current end makes "nothing before sharing" structural, not a filter |
| 2026-11-24 | Redaction tuned against real agent text (shapes only) | A pattern list alone mangled markdown labels, secret names, doc links and timestamps; a local audit over ~16.7k real assistant blocks found them without copying any content |
| 2026-11-23 | Menu bar 0.2: grouped live list, SF Symbol template icon (orange only for needs-you), row actions, snooze; all new data via `/state` fields and daemon endpoints | Keeps the thin-client rule; roadmap in apps/menubar/README.md |

## Cloudflare Resources

| Resource | Binding | Notes |
|---|---|---|
| KV | STORE | id in wrangler.jsonc (create per-deploy) |
| Var | BASE_URL | https://agentblip.com |
| Var | SLACK_CLIENT_ID | public by design |
| Secret | SLACK_CLIENT_SECRET | via wrangler secret put |
| Secret | TOKEN_ENCRYPTION_KEY | base64 32 bytes, AES-GCM |

## Development

- `npm run dev` — RR7 + Worker dev server
- `npm test` — core + worker unit tests (vitest)
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
- [x] Landing + /pair + /privacy (RR7 SSR), deployed with custom domain
- [x] GitHub github.com/b3-fun/agentblip public, CI + push-to-deploy green (secrets set)
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

## Roadmap

`ROADMAP.md` is the project roadmap (Crewblip: agentblip + the Bullpen hub, becoming one system). Update it in the same PR as any work that changes an item's status, and log product decisions there.

# Contributing to Workmesh

Thanks for helping. This is a small, sharp codebase — the goal is to keep it that way.

Workmesh is one repo: the relay that runs on each machine (CLI, daemon, hooks, menu bar app), the team hub and its
board, the wire protocol between them, and agentblip.com (the site plus the Slack-status relay). `docs/SPEC.md` is the
hub's build contract: wire format, what may leave a machine, sharing levels, summaries, board.

## Dev setup

Node.js 20+ (CI runs 22). One `npm ci` at the root installs every workspace:

```bash
git clone https://github.com/b3-fun/workmesh.git
cd workmesh
npm ci
npm run dev        # Worker + React Router site (relay + landing/pair pages)
```

CLI development:

```bash
npm run dev -w packages/cli        # tsup watch
node packages/cli/dist/index.js    # run the built CLI
```

If your own machine runs Workmesh's hooks from a checkout, develop in a git worktree, never in that checkout: every
agent session's hooks run its `packages/cli/dist/index.js`, and a half-built bundle breaks them. Swap a new build in
with one `mv`.

Hub and board:

```bash
cp apps/hub/.dev.vars.example apps/hub/.dev.vars   # DEV_USER_EMAIL skips Access locally; never in production
npm run dev -w @workmesh/hub        # builds the board, then wrangler dev on http://localhost:8787
npm run dev:board -w @workmesh/hub  # optional: Vite with HMR, proxying the API to :8787
npm run fake-relay -w @workmesh/hub # synthetic sessions for several people against localhost
```

Try your machine against a hub: `npm i -g @b3os/workmesh && workmesh setup --hooks-only && workmesh start --detach &&
workmesh hub connect https://workmesh.b3os.org`.

## Layout

```
workers/app.ts     Worker entry (agentblip.com): Hono /api + React Router SSR catch-all
src/               Slack-status relay backend — api/ (pair, slack oauth, status, health),
                   lib/ (kv store, slack client, token crypto, rate limit)
app/               React Router v7 site (landing, /pair, privacy)
packages/core/     @workmesh/core — zod wire contracts for the Slack-status relay (events.ts),
                   session aggregation (aggregate.ts), status formatting (format.ts)
packages/protocol/ @workmesh/protocol — the relay ↔ hub wire format (pairing, ingest body,
                   sessions, events, share levels, limits); the CLI's hub forwarder and the
                   hub's ingest both validate against it
packages/cli/      the @b3os/workmesh npm package (command `workmesh`) — daemon,
                   commands, adapters (claude-code, codex), hub forward,
                   sinks (relay, slack, console)
apps/hub/          @workmesh/hub — the team hub: Worker (src/worker), Project Durable
                   Object, summaries, and the board (src/board, built into the Worker's
                   static assets; src/board/b3os is vendored from the B3OS console)
apps/menubar/      Workmesh.app, the SwiftUI menu bar client of the daemon
docs/              SPEC.md (hub contract), SELF_HOSTING.md, INTEGRATIONS.md, slack-app-manifest.json
```

## Checks

```bash
npm run typecheck   # RR typegen + tsc -b + every workspace (the hub's four tsconfigs too)
npm test            # vitest across workspaces (CLI, core, protocol, hub) + worker units
npm run build       # Worker/site build
npm run build -w @b3os/workmesh   # CLI build
npm run build -w @workmesh/hub    # board build
```

All five must pass — CI runs exactly these. Touching the menu bar app? Also
`cd apps/menubar && ./scripts/make-app.sh` (macOS only, not in CI).

## PRs

- Keep them focused; one change per PR. Small PRs, merge on green. Never force-push, never skip hooks.
- New logic in `packages/core`, `packages/protocol`, `src/lib` or `apps/hub/src/worker` gets vitest coverage.
- TypeScript strict, no `any`. Zod v4 for anything crossing a wire.
- Wire-contract changes update both sides in the same PR: the Slack-status relay's in `packages/core/src/events.ts`
  (CLI + agentblip.com Worker), the hub's in `packages/protocol` (CLI + hub) together with `docs/SPEC.md`.
- Update the docs when behavior changes — README, docs/SPEC.md, INTEGRATIONS, SELF_HOSTING.
- The privacy invariants are non-negotiable. The Slack-status relay only ever receives a pre-formatted `SlackStatus`
  (text, emoji, expiration). The hub only receives what `docs/SPEC.md` §3.3 and §8 allow for the person's sharing
  level. PRs that send more past the daemon will be declined.
- UI on the board: Radix primitives for dialogs, menus and form controls, never native `alert()`/`confirm()`; the
  B3OS console's components and design rules (`apps/hub/src/board/b3os/README.md`).

## The team hub (B3)

B3's hub is live at <https://workmesh.b3os.org> (also `bullpen.b3os.org`, the hub's first name, kept so paired relays
keep working), behind Cloudflare Access for npclabs.org Google logins.

How we work:

- Linear, project "B3OS Beta": parent **B3-7165**; v0 See **B3-7166**, v1 Coordinate **B3-7167**, v2 Delegate
  **B3-7168**. Research: the Linear document "Research: multiplayer agents".
- The team protocol (b3os-beta `docs/how-we-work.md`): one human owner per epic; an agent claims an issue with a plan
  comment, reports at each merge and deploy, re-reads comments before each step, and marks its comments
  "(Claude, for <person>)". "hold" from a person pauses the work.

Deploy and secrets:

- Deploys are manual for now: `npx wrangler whoami` (must show NPC Labs `4300a93c2dcb252fa91df03f18e8e44c`, pinned in
  `apps/hub/wrangler.jsonc`), then `npm run deploy -w @workmesh/hub` (board build + `wrangler deploy` to both hosts).
  Never run two wrangler commands at once. The hub's scripts pass `-c wrangler.jsonc`: the site build leaves a
  `.wrangler/deploy/config.json` redirect at the repo root, which a bare `wrangler` in `apps/hub` would find and refuse.
- The Worker script is named `bullpen` and stays so: its Durable Object holds every pairing, session and event.
- Access covers both hosts with one audience: the board app on the whole host (npclabs.org emails) and a bypass app
  on `/relay/*` (the Worker checks device tokens). The Worker verifies the Access JWT itself.
- Worker secret `OPENROUTER_API_KEY`: a dedicated OpenRouter key (named "Bullpen / prod / 2026-11-24", from before
  the rename; $50/month limit). Summary model: var `SUMMARY_MODEL` (fallback `SUMMARY_MODEL_FALLBACK`). Without a key,
  Workers AI is used.
- Never print, log or commit a secret, token or device token.

Privacy rules:

- Only sessions in `github.com/b3-fun/` repos are shared, and only from the moment a session touches one.
- Each machine picks its level at `workmesh hub connect`: `conversation` (default: prompts, agent messages, tool
  descriptions, turn durations) or `metadata` (tools, repo-relative paths, program + subcommand, issue ids, PR links).
  `workmesh hub share <level>` changes it; switching to metadata deletes that machine's stored text on the hub.
- Secrets and home paths are redacted on the machine before anything is queued; the hub blanks obvious secrets again.
  Tool inputs, tool output and file contents never leave a machine.
- Anything beyond that (tool input or output, file contents, full commands) is out of scope without Sean's word.

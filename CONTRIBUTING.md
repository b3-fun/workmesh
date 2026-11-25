# Contributing to Workmesh

Thanks for helping. This is a small, sharp codebase — the goal is to keep it that way.

This repo is Workmesh's open-source client and protocol: the relay that runs on each machine (CLI, daemon, hooks,
menu bar app), the wire protocol between a relay and a team hub, and agentblip.com (the site plus the Slack-status
relay). `docs/SPEC.md` is the relay ↔ hub contract: wire format, what may leave a machine, sharing levels, redaction
and privacy rules. The team hub and its board are hosted by B3 at <https://workmesh.b3os.org>; their code is private
and not in this repo.

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

Try your machine against a hub: `npm i -g @b3os/workmesh && workmesh init https://workmesh.b3os.org`.

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
                   hosted hub's ingest both validate against it
packages/cli/      the @b3os/workmesh npm package (command `workmesh`) — daemon,
                   commands, adapters (claude-code, codex), hub forward,
                   sinks (relay, slack, console)
apps/menubar/      Workmesh.app, the SwiftUI menu bar client of the daemon
docs/              SPEC.md (relay ↔ hub protocol, privacy rules), SELF_HOSTING.md,
                   INTEGRATIONS.md, slack-app-manifest.json
```

## Checks

```bash
npm run typecheck   # RR typegen + tsc -b + every workspace
npm test            # vitest across workspaces (CLI, core, protocol) + worker units
npm run build       # Worker/site build
npm run build -w @b3os/workmesh   # CLI build
```

All four must pass — CI runs exactly these. Touching the menu bar app? Also
`cd apps/menubar && ./scripts/make-app.sh` (macOS only, not in CI).

## PRs

- Keep them focused; one change per PR. Small PRs, merge on green. Never force-push, never skip hooks.
- New logic in `packages/core`, `packages/protocol` or `src/lib` gets vitest coverage.
- TypeScript strict, no `any`. Zod v4 for anything crossing a wire.
- Wire-contract changes: the Slack-status relay's in `packages/core/src/events.ts` update the CLI and the
  agentblip.com Worker in the same PR; the hub's in `packages/protocol` go together with `docs/SPEC.md` and the
  relay's side. Keep them additive and optional (old hubs and old relays keep working); the hosted hub picks a change
  up after it lands here.
- Update the docs when behavior changes — README, docs/SPEC.md, INTEGRATIONS, SELF_HOSTING.
- The privacy invariants are non-negotiable. The Slack-status relay only ever receives a pre-formatted `SlackStatus`
  (text, emoji, expiration). The hub only receives what `docs/SPEC.md` §3.3 and §8 allow for the person's sharing
  level. PRs that send more past the daemon will be declined.

## The team hub (B3)

B3's hub is live at <https://workmesh.b3os.org> (also `bullpen.b3os.org`, the hub's first name, kept so paired relays
keep working), behind Cloudflare Access for npclabs.org Google logins. The hosted platform is private: its code,
deploys and secrets live in B3's private `b3-fun/workmesh-cloud`, which pins this repo for the protocol. Until the
split on 2026-11-24 the hub was here, in `apps/hub`; that code is still in this repo's history, but it is no longer
developed here.

How we work:

- Linear, project "B3OS Beta": parent **B3-7165**; v0 See **B3-7166**, v1 Coordinate **B3-7167**, v2 Delegate
  **B3-7168**. Research: the Linear document "Research: multiplayer agents".
- The team protocol (b3os-beta `docs/how-we-work.md`): one human owner per epic; an agent claims an issue with a plan
  comment, reports at each merge and deploy, re-reads comments before each step, and marks its comments
  "(Claude, for <person>)". "hold" from a person pauses the work.

Privacy rules:

- Only sessions in `github.com/b3-fun/` repos are shared, and only from the moment a session touches one. From then
  on the whole session is shared, including later work outside b3-fun repos, unless the machine runs
  `workmesh hub sticky off`.
- Each machine picks its level at `workmesh hub connect`: `conversation` (default: prompts, agent messages, tool
  descriptions, turn durations) or `metadata` (tools, repo-relative paths, program + subcommand, issue ids, PR links).
  `workmesh hub share <level>` changes it; switching to metadata deletes that machine's stored text on the hub.
- Secrets and home paths are redacted on the machine before anything is queued; the hub blanks obvious secrets again.
  Tool inputs, tool output and file contents never leave a machine.
- Anything beyond that (tool input or output, file contents, full commands) is out of scope without Sean's word.
- The full list, with the sections that make each rule precise: [docs/SPEC.md](docs/SPEC.md#privacy-rules).

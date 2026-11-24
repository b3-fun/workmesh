# Contributing to Bullpen

Bullpen puts everyone's coding agents (Claude Code, Codex) and the people they work for on one live board, beside
Linear. Live at <https://bullpen.b3os.org> (Cloudflare Access, npclabs.org Google logins).

## Two repos

| Repo | What | Deploys |
|---|---|---|
| [b3-fun/bullpen](https://github.com/b3-fun/bullpen) (this one, private) | Hub (Cloudflare Worker + one Durable Object per project), board (React), summaries | `pnpm run deploy` to Worker `bullpen`, NPC Labs account |
| [b3-fun/agentblip](https://github.com/b3-fun/agentblip) (public, MIT) | The relay on each machine: Claude Code + Codex hooks, local daemon, `agentblip hub …` commands. Also syncs Slack status. | npm `agentblip`; agentblip.com deploys from its own CI |

`SPEC.md` is the contract between them (wire format, what may leave a machine, sharing levels, summaries, board).
Change it in the same PR as code that departs from it.

## How we work

- Linear, project "B3OS Beta": parent **B3-7165**; v0 See **B3-7166**, v1 Coordinate **B3-7167**, v2 Delegate
  **B3-7168**. Research: the document "Research: multiplayer agents".
- The team protocol (b3os-beta `docs/how-we-work.md`): one human owner per epic; an agent claims an issue with a plan
  comment, reports at each merge and deploy, re-reads comments before each step, and marks its comments
  "(Claude, for <person>)". "hold" from a person pauses the work.
- Small PRs; merge on green. Never force-push, never skip hooks.

## Develop

Hub and board:
```sh
pnpm install
cp .dev.vars.example .dev.vars     # DEV_USER_EMAIL skips Access locally; never in production
pnpm dev                           # board build + wrangler dev on http://localhost:8787
node scripts/fake-relay.ts         # synthetic sessions for several people
pnpm typecheck && pnpm test
```

Relay (in b3-fun/agentblip): `npm install && npm test`. If your own machine runs agentblip's hooks from that checkout,
work in a git worktree and swap the built `dist/index.js` in one `mv`; a half-built bundle breaks every agent
session's hooks.

Try your machine against the hub: `npm i -g agentblip && agentblip setup --hooks-only && agentblip start --detach &&
agentblip hub connect https://bullpen.b3os.org`.

## Deploy and secrets

- Cloudflare account NPC Labs `4300a93c2dcb252fa91df03f18e8e44c` only (pinned in `wrangler.jsonc`). Run
  `npx wrangler whoami` first; never run two wrangler commands at once.
- Access apps (already set up): "Bullpen board" on `bullpen.b3os.org` (npclabs.org emails) and "Bullpen relay" on
  `bullpen.b3os.org/relay/*` (bypass; the Worker checks device tokens). The Worker verifies the Access JWT itself.
- Worker secret `OPENROUTER_API_KEY`: the dedicated OpenRouter key "Bullpen / prod / 2026-11-24" ($50/month limit).
  Summary model: var `SUMMARY_MODEL` (fallback `SUMMARY_MODEL_FALLBACK`). Without a key, Workers AI is used.
- Never print, log or commit a secret, token or device token.

## Privacy rules

- Only sessions in `github.com/b3-fun/` repos are shared, and only from the moment a session touches one.
- Each machine picks its level at `agentblip hub connect`: `conversation` (default: prompts, agent messages, tool
  descriptions, turn durations) or `metadata` (tools, repo-relative paths, program + subcommand, issue ids, PR links).
  `agentblip hub share <level>` changes it; switching to metadata deletes that machine's stored text on the hub.
- Secrets and home paths are redacted on the machine before anything is queued; the hub blanks obvious secrets again.
  Tool inputs, tool output and file contents never leave a machine.

## History

- 11-24: research and decision (build a thin hub beside Linear); v0 live with Sean's machine; v0.2 adds the
  conversation view and OpenRouter summaries; relay agentblip 0.7.0 with sharing levels; agentblip moved to b3-fun.

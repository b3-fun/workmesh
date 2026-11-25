# Workmesh roadmap

**Workmesh** (formerly agentblip + Bullpen) is one system where every teammate's coding agents and the people they
work for share a live board: a relay on each machine (CLI, daemon, hooks, menu bar app; open source, this repo) and a
team hub with a web board (hosted by B3; its code is private, in `b3-fun/workmesh-cloud`). Linear stays the team's
system of record.

This file is the project's one roadmap, for the client and the hosted hub alike, and it stays public. Agents and
people update it in the same PR as the work it describes (hub work: a PR here beside the workmesh-cloud change, with
no hub internals): move an item when it starts or lands, and add a line to the decision log for every product call.

Status keys: **done** · **in progress** · **next** · **later**. Dates are 2026.

## Where things stand

| Milestone | What | Status |
|---|---|---|
| v0 See | Every B3 session on one live board; metadata only; Access login; pairing | **done** (11-24) |
| v0.2 Conversation + summaries | Prompts, agent messages, tool descriptions, turn durations; now lines, turn summaries, waiting reasons, digest (OpenRouter) | **done** on the hub; relay 0.7.0 merged; first `@b3os/workmesh` publish in progress |
| v0.3 B3OS look | Board rebuilt from the B3OS console component library, exactly | **done** (11-24) |
| v0.4 One system | Monorepo, rename to Workmesh, shared protocol package | **done** (11-24); hub deploys from CI next |
| v0.5 Multiplayer menu bar | The team in the menu bar | **in progress**: relay + menu bar on branch `relay-v06`; hub `/relay/team` in parallel |
| v0.6 Structure + tabs | Subagent trees, cross-agent messages, graph canvas, Linear + Slack context | **in progress**: wire merged (#3), relay capture on `relay-v06`; board in parallel |
| v1 Coordinate | Claims, file leases, hold, Linear agent identities | later |
| v2 Delegate | Messages into running sessions, handoffs, approvals, shared knowledge | later |
| Launch | Public docs, self-host guide, B3OS-hosted hub | later |

## Next up, in detail

### v0.3 B3OS look (done 11-24)
- Board rebuilt from 85 vendored b3os-beta console files (`src/board/b3os` at 65e00f860), deployed as Worker version
  64de1c82. It follows the console's design rules: skeleton reveal, no banners, no accent borders, everything
  reachable at 390 px.
- Everything visible says Workmesh; no model or provider names in the UI.

### v0.4 One system (done 11-24)
- Since the split later that day (decision log), the hub and board live in the private workmesh-cloud; this section
  is v0.4 as it landed.
- The hub and board live in this repo under `apps/hub` (`@workmesh/hub`), with bullpen's 13 commits rewritten under
  that prefix (`Imported-From` trailers; `docs/research.html` filtered out, it stays in Linear). The board stays inside
  `apps/hub` rather than `apps/board`: it is built into the Worker's static assets and shares its types.
- npm workspaces with one root lockfile (pnpm gone); one zod for relay, core, protocol and hub.
- One protocol package (`packages/protocol`, `@workmesh/protocol`): pairing, ingest body, sessions, events, share
  levels and limits, strict to send and tolerant to accept, from the same field rules; the copies in core and the hub
  are gone. One SPEC (`docs/SPEC.md`), one CONTRIBUTING, the hub's agent rules in CLAUDE.md.
- Rename: repo `b3-fun/workmesh`, npm `@b3os/workmesh` (the `agentblip` command stays as an alias), `Workmesh.app`,
  and the hub at `workmesh.b3os.org` (the bare workmesh domains are taken) with `bullpen.b3os.org` kept as an alias so
  paired relays keep working. The Worker script stays `bullpen` (its Durable Object holds the pairings).
  CLI, core and protocol at 0.8.0 (not yet published).
- Archive `b3-fun/bullpen` with a pointer here, once this is on `main`.
- One CI: relay, core, protocol and hub tests, every typecheck, site, CLI and board builds.
- **Next:** hub deploys from `main` in CI. Needs a Workers deploy token scoped to the NPC Labs account as its own
  repo secret (the existing `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` pair, from July, is agentblip.com's
  deploy); until then `npm run deploy -w @workmesh/hub` by hand.

### v0.5 Multiplayer menu bar
- The menu bar shows the team, not only me: what needs me (my waiting agents, asks addressed to me), each person
  with their agents and now lines, my sharing level, connect status, and "Open board".
- A device-token read endpoint on the hub (`/relay/team`) feeds the daemon, which serves the menu bar as today.
- Notifications for "needs you", quiet otherwise.
- **Relay (branch `relay-v06`):** wire schemas for `/relay/team` in `@workmesh/protocol` (merged, #3, SPEC §16). The
  daemon polls it (15 s while the menu is open or something needs me, 60 s otherwise, 10 min after a 404, stops on
  401) and serves it on `GET /team` with the hub connection and sharing level. Workmesh.app: needs-me first (local
  waiting sessions merged with the hub's, with its reason), then each teammate with avatar or initials, online dot
  and counts, expanding to their sessions with the agent's mark and now line; the hub connection and sharing level;
  Open board; native notifications for new needs-you items (on unless turned off). Mock daemon + snapshot mode for
  screenshots. **Next:** the hosted hub's `/relay/team` (workmesh-cloud), then roll out.

### v0.6 Structure + tabs
- **Subagents:** each session shows its subagents as a tree, the way Claude Code lists them: type
  (`general-purpose`), status ("waiting on 1 shell", "Polling PR 164 CI checks"), since, duration, tokens; plus
  background tasks (shells) and workflow fan-out. Relay captures SubagentStart/SubagentStop and subagent transcripts.
- **Tabs:** Sessions (today's board) · Messages (cross-agent messages: Claude Code `SendMessage`, Codex agent mail,
  and later Workmesh's own) · Graph (a canvas of people → agents → subagents, with linked Linear tickets, PRs and Slack
  threads as nodes; built on the B3OS canvas) · Activity (the full timeline).
- **Linear:** ticket titles, status and owners on chips and graph nodes (hub-side Linear app).
- **Slack:** threads agents post to show as linked nodes; "needs you" and the daily digest can post to Slack.
- **Relay capture (branch `relay-v06`, SPEC §15):** Claude Code subagents from SubagentStart/SubagentStop and the
  `agent_id` on hooks inside them, as sessions under their parent with type, task (conversation level), model,
  tokens (as Claude Code counts them) and a status line; sent only to a hub that serves `/relay/team`. Codex spawned
  threads name their parent from the rollout's `session_meta`; workflow runs are workflow sessions with their agents'
  tokens. `agent_message` events from SendMessage, peer messages and Codex `send_message`/`spawn_agent` (text at
  conversation level, redacted). Links: Linear ids, PRs and issues on shared repos, Slack messages (conversation
  level). `person.github` from `gh` for avatars. Injected prompts (task notices, peer messages) are no longer sent as
  the person's prompt. Not captured: cost (no agent records it per subagent), Codex inbound agent messages, main
  Claude Code sessions' tokens.

### v1 Coordinate (Linear B3-7167)
- MCP server in every session: `roster`, `send`, `inbox`, `claim`, `lease`, `note`.
- File leases enforced by a PreToolUse deny that names the holder; claims mirrored to Linear as agent sessions under
  one app identity per person (needs a Linear workspace admin).
- "hold" from the board or a Linear comment stops the agent's next tool call.

### v2 Delegate (Linear B3-7168)
- Messages delivered into running and idle sessions (Claude Code session inbox, Codex app-server).
- Handoffs to another person's runner through that person's policy; approval gates at merge, deploy, spend.
- Shared knowledge: rulings and conventions loaded at session start for everyone's agents.

## Decision log

- 11-24 Build our own thin hub beside Linear rather than adopt Multica or fork Codecast (research: Linear document
  "Research: multiplayer agents").
- 11-24 Hub on Cloudflare (NPC Labs), at bullpen.b3os.org behind Cloudflare Access (npclabs.org logins).
- 11-24 Summaries through OpenRouter with a dedicated key; Workers AI when no key.
- 11-24 Max sharing by default: `conversation` level, including sessions started outside a shared repo from the
  moment they touch one. Secrets and home paths are redacted on the machine.
- 11-24 Board design is the B3OS console's, copied exactly from its component library.
- 11-24 agentblip moved to b3-fun; agentblip and Bullpen become one system in one public monorepo.
- 11-24 Name: Workmesh (Sean), to tie in with Workcell. npm `@b3os/workmesh` under the B3OS scope, published by npclabs.
- 11-24 Repo renamed to b3-fun/workmesh; Access apps renamed and cover workmesh.b3os.org + bullpen.b3os.org (same AUD);
  Worker script name stays `bullpen` because its Durable Object holds the pairings.
- 11-24 Relay renamed everywhere (code, docs, `~/.config/workmesh`, `WORKMESH_*`, `Workmesh.app`, site copy). Old names
  are read, never written: the `agentblip` command alias, a one-time copy of config and state from the agentblip dirs,
  `AGENTBLIP_*` env fallbacks, hook repointing. agentblip.com and its Worker, routes and KV keep their names so the
  live site and its Slack device records survive.
- 11-24 One public monorepo now (Sean): hub history imported under `apps/hub` without the research document (it quotes
  teammates' Slack messages); one wire package with a strict reading for relays and a tolerant one for the hub; hub
  served at workmesh.b3os.org and bullpen.b3os.org from the same `bullpen` Worker; hub deploys stay manual until CI
  has an NPC Labs token.
- 11-24 Split (Sean: "separate the UI from the agent/daemon, so that the platform always remains hosted / by us, while
  the piece that gets installed on users machine is open source"): the hub, board, summaries and vendored B3OS kit
  move to the private `b3-fun/workmesh-cloud` with their history; this repo keeps the CLI, core, protocol, menu bar
  app, site, the public SPEC (protocol, sharing levels, privacy rules) and this roadmap. The hub pins this repo as a
  submodule for `@workmesh/protocol`, so a wire change lands here first. The hub's code up to the split stays in this
  repo's history (no rewrite). Launch's self-host guide covers the relay; the hub stays hosted.

- 11-24 v0.6 wire: subagents are sessions with `parent` and `role`, not a nested list; the relay sends them only to a
  hub that serves `/relay/team`, so an older hub never shows each subagent as its own session.
- 11-24 Tokens follow Claude Code's per-agent figure (context now + output so far), checked against its own
  `totalTokens`, rather than a billing sum that runs 1.1–6× larger on cache reads.
- 11-24 Slack links and subagent titles are conversation-level; Linear, PR and issue links are metadata (they repeat
  `issues` and `pr`).

## Links

- Linear (project "B3OS Beta"): B3-7165 (parent), B3-7166 (v0), B3-7167 (v1), B3-7168 (v2).
- Live hub: https://workmesh.b3os.org (also https://bullpen.b3os.org)

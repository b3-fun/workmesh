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
| v0.2 Conversation + summaries | Prompts, agent messages, tool descriptions, turn durations; now lines, turn summaries, waiting reasons, digest (OpenRouter) | **done** (11-24); `@b3os/workmesh` 0.8.0 on npm |
| v0.3 B3OS look | Board rebuilt from the B3OS console component library, exactly | **done** (11-24) |
| v0.4 One system | Rename to Workmesh, shared protocol package; open-source client here, hosted platform private (b3-fun/workmesh-cloud) | **done** (11-24); hub deploys from CI next |
| v0.5 Multiplayer menu bar | The team in the menu bar | **done** (11-24): menu bar 0.5.0, hub `/relay/team` live |
| v0.6 Structure + tabs | Subagent trees, cross-agent messages, graph canvas, Linear + Slack context | **done** (11-24): relay #5, board in workmesh-cloud #1; polish next |
| v0.7 Polish from real use | Subagent names in the feed, hide injected markup, a better home for sessions started outside a repo, graph fit-to-view, Linear titles (needs a key), publish relay 0.9.0 | **done** (11-24): names, markup, orchestrators, graph fit (relay in the next release, 0.9.1); Linear titles live |
| Liveness | Presence from the hub, not the browser; a restart never ends sessions; the daemon as a launchd / systemd service; current client versions; quiet and stalled sessions | **done** (11-25): wire #11, relay (in 0.10.0 with v1, not yet on npm), hub in workmesh-cloud #4 |
| v1 Coordinate | Claims, file leases, hold, messages, notes, Linear agent identities | **in progress** (11-25): wire merged (#10, SPEC §21); relay side built (sync, enforcement in hooks, inbox, MCP, menu bar, SPEC §23), not published; hub and board live (workmesh-cloud #5) |
| Ask | Ask the board about anyone's agents in plain words; it proposes messages, holds and notes that run only on your confirm; agents ask through `/relay/ask` | **done** (11-25) on the board (workmesh-cloud #6, SPEC §29); relay MCP tool `ask` next |
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

### v0.7 Polish from real use (done 11-24)
Found on the live board with real sessions, 11-24 (wire: SPEC §19):
- **Subagent names (done):** the relay sends a `name` for every subagent (its task at conversation level, else its
  type); the board never shows a raw key (name, task, type, a workflow's phase, else tool + short id), and the feed
  and message routes name an agent under the session it works for: "documents-a0 › Build the demo viewer".
- **Injected markup (done):** task notices, wrapped agent messages, provenance markers and `<system-reminder>` blocks
  are nobody's text. One reading of them (`stripInjected` in `@workmesh/protocol`, real-shaped fixtures): the relay
  sends no prompt for a wholly injected one and strips the rest; the hub does the same on ingest as a backstop; the
  board hides what older relays stored.
- **Orchestrators (done):** a session started outside a repo sends `repos` (the shared repos it touched, most recent
  first); the board groups it under the repo it touched last, marks it "Orchestrator" and names the other repos it
  works across. Sessions from older relays group by their newest event's repo, else "Outside a repo".
- **Graph fit (done):** fits the measured nodes on load and when the node set changes, between a readable 0.8 and 1
  (a bigger graph starts at its top), until the reader moves it.
- **Found while checking (done):** the graph hid every node on each live update (blinking); a tool description lost
  the start of a word that began with the tool's name ("Reading" after Read); one-line text dropped a leading "#7".
- **Linear titles (live):** the hub has a read-only `LINEAR_API_KEY`; chips and graph nodes show ticket titles and
  states (one batched query per 30 s at most, cached 10 minutes, ids alone when Linear fails).
- **Publish:** relay 0.9.0 is out; these relay changes ship as 0.9.1. Still to do: the menu bar build as a release
  asset.

### Liveness and persistence (done 11-25)
Sean, 11-25: "I see myself as offline at times, maybe when the daemon is interrupted." Contract: SPEC §24.
- **Found:** the board worked out presence in the browser from a `lastSeenAt` the hub stopped re-sending while a
  machine was busy, so two minutes after the page loaded it showed the person offline with "No open sessions" while
  their events kept streaming in. And a restarted daemon forgot which sessions it shared: its first heartbeat said
  "none", and the hub ended them all.
- **Presence (done):** the hub computes it (online, reconnecting after 90 s, then asleep or offline after 5 min) and
  pushes every change; the board and the menu bar only show it.
- **Restarts (done):** the relay saves its shared sessions, transcript offsets and unsent events and picks them up on
  start; it never sends an empty full heartbeat right after a start; the hub treats a session missing from a
  heartbeat as unconfirmed (it ends after 30 min, or at once on SessionEnd or a dead process).
- **Service (done):** `workmesh setup` runs the daemon under launchd (macOS) or systemd `--user` (Linux): a crash, kill
  or reboot brings it back; `workmesh service` and `doctor` manage and report it.
- **Versions, quiet, lanes (done):** every ingest names its client; Machines shows each device's current version and
  flags old ones; a working row reads "quiet 7m", then "stalled?" after an hour; ended sessions leave the lanes after
  an hour.
- **Next:** publish relay 0.10.0 (npm, two key taps) so teammates get the service and the saved state; the menu bar
  build that shows "asleep"/"reconnecting".

### v1 Coordinate (Linear B3-7167, in progress 11-25)
- MCP server in every session: `roster`, `send`, `inbox`, `claim`, `lease`, `note`.
- File leases enforced by a PreToolUse deny that names the holder; claims mirrored to Linear as agent sessions under
  one app identity per person (needs a Linear workspace admin).
- "hold" from the board or a Linear comment stops the agent's next tool call.
- **Wire (done, #10, SPEC §21):** `POST /relay/leases|claims|messages|notes|inbox/ack`, `GET /relay/sync` (leases,
  holds, inbox, claims, roster, notes, and `edits` for "someone is working there"), lease path globs with covers and
  overlap in `@workmesh/protocol/lease-paths`.
- **Relay (built, SPEC §23, CLI 0.10.0 not published):** the daemon syncs every 5 s while a shared session runs and
  answers hooks from memory (hook latency unchanged: 130-138 ms p50 before and after on the Studio). PreToolUse refuses
  a held session's tool calls and edits to another session's leased files (file tools, `apply_patch`, shell commands
  that plainly write a path) and warns before editing a file another person's agent edited in the last 10 minutes;
  messages reach agents at their next tool boundary and are acked; a five-line note at the start of each shared
  session. `workmesh mcp` with 11 tools, registered by `workmesh setup` for Claude Code (user scope) and Codex;
  `workmesh leases|lease|unlease|claims|claim|send|inbox|note|notes|whoami`; holds and waiting messages in the menu
  bar. Fails open: nothing is refused when the hub or daemon is unreachable, except a known hold (up to 30 min).
  Verified with a real Claude Code session against a stand-in hub (refusal, guidance, MCP tools, a message delivered
  and acked, fail-open timing); Codex output by its 0.164 hook schemas and fixtures.
- **Hub and board (live 11-25, workmesh-cloud #5):** the hosted hub serves every v1 endpoint: exclusive leases with
  expiry and release when a session ends, one claimant per issue, messages routed to an agent, a session or a person's
  newest live session (inbox and acks), notes, and `/relay/sync` with recent edits. Anyone on the team can hold a
  session from the board, and a "hold" or "pause" comment on the Linear issue a session claimed holds it ("resume" or
  "go ahead" releases it; read-only, once a minute). The board shows held sessions in Waiting ("Held by An · reason"),
  claimed issues on chips with the claimant, a Work tab (claims, leased files and the edits they turned away, notes),
  Workmesh messages in Messages with a reply box, and turned-away edits in the feed.
- **Next:** publish 0.10.0 and roll out; Linear agent identities per person (needs An); claims mirrored to Linear (needs
  a key that can write).

### Ask (Linear B3-7165, done on the board 11-25)
- "Ask ⌘K" on the board: questions in plain words ("What are An's agents working on?", "What's waiting on me?", "Who
  touched apps/hub today?") answered by a tool-calling model (OpenRouter) from what the board already holds: sessions,
  turns, activity, claims, leases, notes, Linear tickets. Answers name sessions and people as links.
- Actions: it can draft a message to an agent or a person, a hold or release, or a project note; each is a card with
  exactly what will happen and runs only when you confirm it, as you.
- Agents: `POST /relay/ask` (SPEC §29) answers an agent's question from the same data minus other sessions' prompt and
  message text, and can't act. **Next:** the relay's `ask` MCP tool.

### v2 Delegate (Linear B3-7168)
- Messages delivered into running and idle sessions (Claude Code session inbox, Codex app-server).
- Handoffs to another person's runner through that person's policy; approval gates at merge, deploy, spend.
- Shared knowledge: rulings and conventions loaded at session start for everyone's agents.

## Decision log

- 11-25 Ask: answers come only from tool reads of the hub's own data; actions are proposals a person confirms on a
  card, never run from a model's turn; agents asking get read tools only and no prompt or message text.
- 11-25 Liveness: presence is computed and pushed by the hub, never derived in a client; a heartbeat can no longer end
  a session (missing for 30 min, SessionEnd or a gone process can); the daemon runs as a launchd / systemd service
  that restarts it unless `workmesh stop` asked it to stop; the forwarder's saved state is local only (0600).
- 11-25 v1 board: a held session waits on a person, so it sits in Waiting (with who held it and why) rather than its
  lane; any teammate may hold, only the session's owner or the holder releases. Claims, leased files and notes share
  one Work tab beside Messages.
- 11-25 v1 relay: hooks are answered from the daemon's cached sync, never a network call, and everything fails open
  (a lease counts only while the last sync is under 90 s old; only a hold the daemon already knew about outlives an
  unreachable hub, for 30 minutes), so Workmesh never stops anyone's work because the hub is down. A lease binds the
  same person's other sessions too (agents collide whoever owns them). Shell commands are checked only for paths they
  plainly write; the MCP server is hand-written JSON-RPC (no SDK) and holds no token, the daemon makes every hub call.

- 11-24 v0.7: a subagent's `name` is its task at conversation level and its type at metadata (the hub enforces the
  latter); orchestrators are marked by sending `repos`, and sit with the repo they touched last rather than in a
  separate "Orchestrators" group, so a repo's group shows everything working on it.

- 11-24 Split: the installed client (this repo: CLI, daemon, hooks, menu bar, protocol) stays open source; the hosted platform (hub, board, summaries, integrations) lives in the private b3-fun/workmesh-cloud and is run by us (Sean).

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

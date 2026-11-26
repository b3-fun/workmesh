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
| v0.4 One system | Rename to Workmesh, shared protocol package; open-source client here, hosted platform private (b3-fun/workmesh-cloud) | **done** (11-24); hub deploys from CI on every merge to main (workmesh-cloud #10, 11-25) |
| v0.5 Multiplayer menu bar | The team in the menu bar | **done** (11-24): menu bar 0.5.0, hub `/relay/team` live |
| v0.6 Structure + tabs | Subagent trees, cross-agent messages, graph canvas, Linear + Slack context | **done** (11-24): relay #5, board in workmesh-cloud #1; polish next |
| v0.7 Polish from real use | Subagent names in the feed, hide injected markup, a better home for sessions started outside a repo, graph fit-to-view, Linear titles (needs a key), publish relay 0.9.0 | **done** (11-24): names, markup, orchestrators, graph fit (relay in the next release, 0.9.1); Linear titles live |
| Liveness | Presence from the hub, not the browser; a restart never ends sessions; the daemon as a launchd / systemd service; current client versions; quiet and stalled sessions | **done** (11-25): wire #11, relay in 0.10.0 (npm), hub workmesh-cloud #4 |
| v0.11 Session mirror | The board's session page reads like the person's terminal: title, harness and model; prompts, messages, folded tool runs; background-agent and shell notices; turn lines with what's still running; mode, background tasks and agents in a footer | **done** (11-25): wire #13, relay #14 + #20 (0.10.0), hub and board workmesh-cloud #8 |
| v1 Coordinate | Claims, file leases, hold, messages, notes, Linear agent identities | **done** (11-25): wire #10 (SPEC §21), relay #12 in 0.10.0 (npm), hub and board workmesh-cloud #5; the Workmesh agent in Linear (claims as agent sessions, replies and stop from Linear) workmesh-cloud #11, #13, #14 |
| Ask | Ask the board about anyone's agents in plain words; it proposes messages, holds and notes that run only on your confirm; agents ask through `/relay/ask` | **done** (11-25) on the board (workmesh-cloud #6, SPEC §29); agents' `ask` tool and `workmesh ask` in 0.11.x |
| v2 Delegate | Messages into running sessions, handoffs, approvals, shared knowledge; `workmesh init` | **done** (11-25): wire #22 (SPEC §30), relay #23 + #26 in **0.11.0** (npm, GitHub release v0.11.0), hub and board workmesh-cloud #12; follow-ups (approval → the agent carries on, a live two-person handoff) in 0.11.x |
| Onboarding hardening | First run solid on macOS and Linux: lingering so an SSH box stays online after logout, no half-installed systemd unit, `init` checks the hub heard from the machine, `doctor` names why a machine shows offline, one pairing per machine (the same hub under two addresses, a re-pair retires the old device), "online, no agents running" and "paired, never connected" on the board; a Docker smoke test (Node 20/22/24, with and without systemd, over SSH) | **done** (11-25): relay 0.11.1 (npm), hub workmesh-cloud #22 |
| PR details | PR title, state (open, draft, merged, closed), author, review and checks on the board, from a read-only GitHub App on b3-fun, instead of a bare `repo#n` | **done** (11-25): hub and board workmesh-cloud #24 |
| v3 Memory | The team's shared knowledge base: decisions, conventions, gotchas, rules and facts that agents propose and people accept; search by words and meaning; the relevant ones at every session's start; a Memory tab; proposals from finished sessions | **done** (11-25): wire #32 (SPEC §35–36), relay #35 in 0.12.0 (npm), hub and board workmesh-cloud #28 (live) |
| Keeping current | `workmesh update` (install the newest release the way it was installed, refresh hooks, MCP and the daemon, roll back on failed checks), update notices from the hub, opt-in auto-update, a once-per-session note to sessions on older tools, "Update available" in the menu bar, versions on the board | **done** (11-25): wire #33 (SPEC §40), relay #37 (SPEC §41) and menu bar #36 in 0.12.0 (npm, GitHub release v0.12.0), hub and board workmesh-cloud #25–#27 (live) |
| Codex parity | Everything a Claude Code session gets on the team hub, for Codex, proven live: board session and mirror, MCP tools, lease and hold refusals, wake, gates, handoffs run with `codex exec`, a truthful `doctor` | **done** (11-25): relay #38 (SPEC §42) in 0.12.0 (npm) |
| Private testing | The B3 team (Sean, An, Mitch, David, Gio) on B3's hub; teammate guide in `docs/guide/`, generated CLI and MCP references, maintainer runbook in workmesh-cloud `docs/OPERATIONS.md`; menu bar app unsigned, handed to the team from GitHub releases | **in progress** (11-25) |
| Launch | Public docs, self-host guide, B3OS-hosted hub for other teams | later: not before Sean says (11-25) |

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
- **Slack:** threads agents post to show as linked nodes; "needs you" can post to Slack (the daily digest is dropped: Sean, 11-25).
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
- **Live 11-25:** hub deployed (presence pushed), Sean's Mac on the new relay under launchd; a `workmesh restart` and a
  `kill -9` of his daemon each kept him online with every session working (launchd brought the killed one back in
  1 s, the saved state brought its 9 shared sessions back). The first upgrade from an older relay still starts cold
  (it had no saved state), so its other sessions show as Unconfirmed until they touch a B3 repo again.
- **Next:** publish relay 0.10.0 (npm, two key taps) so teammates get the service and the saved state; the menu bar
  build that shows "asleep"/"reconnecting".

### v0.11 Session mirror (Linear B3-7166, done 11-25)
Sean, 11-25: "better representation of what the users see on their actual codex/claude sessions, ideally synced to
this". Wire: SPEC §26.
- **Wire (done, #13):** a `notice` event kind (background agents, shells, monitors, workflows, compaction, plan) with
  its subject's title in `desc` at the conversation level; `tasks` (running background tasks by kind) on sessions,
  turns and notices; `mode` on sessions; a main session's `title`; Codex `plan` steps.
- **Relay (built):** reads Claude Code's own records from the transcript tail (AI or custom title, permission mode,
  model, compactions, task notices by Claude Code's templates, background launches), the Stop hook's running tasks by
  id, each subagent's own shells and monitors from its transcript (a subagent that stops with background work stays
  open as "waiting on 1 shell, 1 monitor" until its finished notice), and Codex turn context, compactions and plan
  updates. Metadata devices send the counts and states only. Tails are checked every second, so a notice written
  between hooks arrives in about two seconds.
- **Board (live, workmesh-cloud #8):** a Terminal view on the session page, the default for conversation-level
  sessions: Geist Mono on a dark terminal surface, `❯` prompts, `●` messages, folded tool runs, green `●` background
  agent notices, grey `*` turn lines ("Crunched for 4m 19s · done 9:11 AM · 3 shells, 2 monitors still running",
  "Waiting for 1 background agent to finish"), compactions, a live spinner line; a head (title · Claude Code · model)
  and a foot (mode · background tasks · ← agents, then the agent list). Codex reads the Codex way (exec cells, Updated
  Plan, "Worked for" rules). Summary keeps the turn-summary view.
- **Checked live (11-25):** Sean's sessions on the board against their transcripts, structure only: messages, tool
  runs, agent messages, notices and turns line up one for one since the rollout; record-to-board under about 2 s.
  Notices start at the rollout, so older turns that a task notice began show no notice line.
- **Next:** publish the relay (with 0.10.0) so teammates' terminals mirror too; Codex `update_plan` is parsed from its
  documented shape (no recent rollout of Sean's has one); per-subagent background counts come from each agent's own
  transcript.

### v1 Coordinate (Linear B3-7167, done 11-25)
- MCP server in every session: `roster`, `send`, `inbox`, `claim`, `lease`, `note`.
- File leases enforced by a PreToolUse deny that names the holder; claims mirrored to Linear as agent sessions, each
  agent named on the issue as its person's agent.
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
- **The Workmesh agent in Linear (live 11-25, workmesh-cloud #11, #13, #14):** one Linear app, "Workmesh", installed by
  Sean as a workspace admin. A claim opens a thread on its issue in the agent's name ("Sean · Claude", the person's
  GitHub avatar, the team's "(Claude, for Sean)" marker) with Workmesh's agent session on it: progress, holds and
  resumes, PRs for that issue, and a closing note when the claim ends. A reply in that thread, or a mention of
  @Workmesh on a claimed issue, reaches the claiming agent as a Workmesh message, and it can answer there; Linear's
  "stop" holds it. Connect or reconnect from the board's Settings. Checked live on a test issue (B3-7199): claim,
  thread, progress, a reply both ways, release.
- **Next:** publish 0.10.0 and roll out.

### Ask (Linear B3-7165, done on the board 11-25)
- "Ask ⌘K" on the board: questions in plain words ("What are An's agents working on?", "What's waiting on me?", "Who
  touched apps/hub today?") answered by a tool-calling model (OpenRouter) from what the board already holds: sessions,
  turns, activity, claims, leases, notes, Linear tickets. Answers name sessions and people as links.
- Actions: it can draft a message to an agent or a person, a hold or release, or a project note; each is a card with
  exactly what will happen and runs only when you confirm it, as you.
- Agents: `POST /relay/ask` (SPEC §29) answers an agent's question from the same data minus other sessions' prompt and
  message text, and can't act.
- **Agents' `ask` (0.11.x):** the MCP tool `ask { question }` and `workmesh ask <question…>`, answered by the daemon
  through `/relay/ask` (the agent never holds the token): the question redacted on the machine, one at a time per
  session; the hub's no (no Ask, Ask off, its rate limit of 6 a minute per device, the person's 100 a day, the
  project's $1.50 a day of model spend) comes back as a plain "no answer, carry on" and is remembered, so an agent
  doesn't retry into it. Checked live against a local hub: a real Claude Code session asked "what is An's agent
  doing?" and answered from the tool; with Ask off, a second question didn't reach the hub.

### v2 Delegate (Linear B3-7168, done 11-25)
- Messages delivered into running and idle sessions (Claude Code session inbox, Codex app-server).
- Handoffs to another person's runner through that person's policy; approval gates at merge, deploy, spend.
- Shared knowledge: rulings and conventions loaded at session start for everyone's agents.
- **Wire (merged, #22, SPEC §30):** `POST /relay/handoffs` (create, accept, decline, start, done, fail; the first
  `start` wins when no device accepted), `POST /relay/approvals` (request, approve, deny), `POST /relay/gates` (a
  person's own gates), `wake` on messages and inbox items, and optional `handoffs`, `gates`, `approvals` lists on
  `/relay/sync`.
- **Relay (built, SPEC §31, CLI 0.11.0 not published):**
  - `workmesh init <hub-url>`: hooks, MCP tools, the daemon (restarted on the current build) and pairing in one
    command; safe to run again (pairing kept while the hub accepts the token, `--repair` pairs again).
  - Wake: an `asyncRewake` Stop hook long-polls the daemon and wakes an idle Claude Code session with its next
    message (a person's message, an approval decided, a handoff's outcome); Codex threads through `codex queue`.
  - Handoffs: MCP `handoff` / `handoffs`, CLI `handoff`, `handoffs`, `roots`; policy `auto-self` (default: your own
    handoffs run at once, teammates' wait for your Accept), `ask`, `never`; an accepted handoff runs in a new git
    worktree with `claude -p` (or `codex exec`), shared on the board and linked by its session, reporting done/fail.
  - Approval gates: `workmesh gates set merge,deploy`; gated shell commands (a tested table: merges, deploys,
    publishes, force pushes, paid-infra creates, custom patterns) wait for an approval, the decision wakes the agent;
    fails open.
  - Session start: the project's `rule` / `convention` notes and the person's open claims.
  - Menu bar: Handoffs for you (Accept / Decline) and Approvals (Approve / Deny).
- **Checked live (11-25)** with Claude Code 2.1.332 in a throwaway session against a stand-in hub: the SessionStart
  note carried a `rule` note; a person's message woke the idle session about 4 s after the hub had it, and the hook
  re-armed; `gh pr merge` was held with the approval text and the request reached the hub; approving woke the
  session. Haiku then asked its person to confirm before merging (Claude Code shows the wake as "Stop hook
  feedback", which a model won't take as consent), so the texts now say the gate re-checks the approval on the retry;
  that wording isn't re-run live yet (the test account hit its spend limit). Handoff runs, Codex wake and `init` are
  checked with fixtures: a stand-in `claude` binary, `codex queue` per a live probe of codex-cli 0.164, a temp HOME.
- **Shipped 11-25:** hub and board (workmesh-cloud #12: Needs-you cards, Handoffs pane, Settings → Approvals, Ask
  `hand_off`); 0.11.0 on npm; #26 stops a re-run of `setup`/`init` from racing launchd ("Bootstrap failed: 5").
- **Follow-ups (0.11.x, Linear B3-7168):**
  - Approval → the agent carries on. Re-run live (Claude Code 2.1.332, throwaway HOMEs, a stand-in hub, a stand-in
    `gh`; never a real merge or deploy), 3 runs per model per case. With a plain setup, every run carried on, on
    0.11.0's texts and even on the first draft's (Sonnet and Haiku; a custom gate on `echo deploy-test`, a merge, and
    11-25's sequence of a teammate's wake then a gated merge). The stall came back once the person's own CLAUDE.md
    said automated messages are never their approval: Haiku then asked to confirm in the terminal in 6 of 6 runs on
    0.11.0 and 5 of 6 with the new texts; Sonnet carried on in 6 of 6 either way. That rule is the person's to keep. The fix: an approval runs the exact
    command it was asked for, once, within 30 minutes (a rerun asks anew with `renew`); its wake names who decided,
    as whom, and quotes the held command; the session-start note of a person with gates says up front that such an
    approval is their consent for that command; Claude Code shows the wake as "Workmesh", not "Stop hook feedback".
  - A live handoff between two people: a local hub (`wrangler dev`), two relays in temp HOMEs paired by `workmesh
    init` as Sean and An, Sean's real Claude Code session calling `handoff`, An's `workmesh handoffs accept`, An's
    daemon running `claude -p --model haiku` in a new worktree (a one-line commit, $0.003), Sean's session woken with
    the outcome, about 20 s end to end. It found two bugs, both fixed: the wake hook kept a finished `claude -p` open
    (it now skips headless sessions), and `workmesh handoffs` showed a minute-old sync (lists now sync first).
    `handoffs.model` picks the handoff agent's model.
- **Next:** the team onboarded (Mitch, An, David, Gio) on 0.11.x; a live Codex wake from the daemon.

### Onboarding hardening (0.11.1, 11-25)

- **Why:** Mitch paired `b3-box` (0.10.0) over SSH; the hub heard from it once, a second after pairing, and never
  again. Reproduced in Docker: systemd stops a user's services ~10 s after the last logout unless the user lingers, so
  the daemon (a `systemd --user` unit since 0.10.0) stopped as he logged out. A paired machine with no agents was never
  the problem: the relay heartbeats every 30 s with or without sessions. An upgraded from agentblip 0.6.0 (paired at
  bullpen.b3os.org) and `workmesh init https://workmesh.b3os.org` paired a second device for the same machine.
- **Relay (0.11.1):** `init`/`setup`/`service install` turn lingering on (offer `sudo` in a terminal where logind
  refuses; `--no-linger`), never write a unit systemd can't run, find `/run/user/<uid>` for `su` shells, run detached
  without systemd; `init` keeps a pairing made under another address of the same hub and ends by checking the hub heard
  from the machine; `doctor` says since when the hub hasn't heard from the machine and why (daemon down, lingering off,
  no user session, wrong hub address, superseded token), and skips Codex checks where Codex isn't installed;
  `scripts/smoke-linux/smoke.sh` (Docker; CI runs the light version against a stand-in hub).
- **Hub:** pairing a machine name again retires the person's older device for it (401 "superseded", its sessions end
  and leave the board); the board says "online, no agents running" and "paired, never connected" (with `workmesh
  doctor` as the next step).

### PR details (Linear B3-7165, done 11-25)

- **Why:** the board named PRs only as `repo#n` (row chips, tooltips, the detail drawer, a session's links, the graph):
  the hub had no way to read GitHub.
- **What:** a GitHub App on the b3-fun org, "Workmesh (B3)", read-only (pull requests, checks, commit statuses,
  metadata; no webhook), installed on all repositories. The hub reads the PRs the board's sessions name. Open PRs
  refresh every two minutes while someone has the board open, and merged and closed ones once a day. Each PR is shown
  with its title, its state in colour, its author with their avatar, the review decision and the checks (failing ones
  by name). Settings shows the connection. Nothing changes on the relay or the wire, and a PR outside b3-fun keeps
  `repo#n`.
- **Later:** a webhook instead of polling, if two-minute freshness turns out too slow.

### v3 Memory (Linear B3-7203, done 11-25)

Sean's first ask (11-24) was agents working toward a shared goal "with humans in the loop, and potentially shared
knowledge base". v1's notes were the start of it (one-word tags, no search, no review). Memory makes it a knowledge
base people trust. Contract: SPEC §35 (wire) and §36 (relay).
- **Items:** `decision`, `convention`, `gotcha`, `rule`, `fact`; a title, a body up to 2,000 characters, a scope
  (project, a repo, or path globs in it), links (Linear issues, PRs, the sessions it came from), who wrote it (person
  and agent), short ids to cite (`m12`), edit history, and when an agent last used it.
- **People in the loop:** an agent's `remember` is a proposal until a person accepts it (a person may accept their own
  agents' memories without review; off by default); only accepted memories reach agents. `forget` proposes retiring
  one; a newer memory can supersede an older one.
- **Agents:** MCP `remember`, `recall` (search, this repo first) and `forget`, and the CLI's `remember`, `recall`,
  `forget`, `memories`; `note` keeps working as a `fact`. At the start of a shared session the relay puts in the
  accepted memories that matter there: rules and conventions always, decisions, gotchas and facts by repo, path,
  branch and claimed issue, at most 20 lines, each with its id.
- **Relay:** built (0.12.0, not published). The daemon caches the brief (every accepted memory) and refetches it when
  sync's `memory.rev` moves; a session's start note carries the rules and conventions that apply and the decisions,
  gotchas and facts that score for its repo, directory, branch and claimed issues, each with its id, and reports which
  it used. `remember`, `recall`, `forget`, `memories` (MCP and CLI); on a hub with memory `note` proposes a memory and
  `notes` lists them; on an older hub nothing changes.
- **Hub and board (live 11-25, workmesh-cloud #28):** the hosted hub keeps memories with their history and uses,
  decides their status as SPEC §35 says, and searches by words and by meaning (full-text search fused with Workers AI
  embeddings; words alone when the model doesn't answer). On a 20-question eval over 45 team-shaped memories, half of
  the questions paraphrased: words alone found the answer in the top 3 for 95% (first for 80%), meaning alone 100%
  (90%), the two fused 100% (95%, MRR 0.97), which is what ships. The board has a Memory tab (search, In use / Waiting
  / Set aside, kind, repo and person; each memory with where it applies, who wrote and decided it, its links, the
  sessions that used it and its history; write, edit, replace, retire, restore), memory cards under Needs you (Accept,
  Edit, Reject; Retire, Keep), and Settings → Memory (accept my agents' memories; suggest memories from finished
  sessions). Ask searches the memory and can propose one on a confirm card. The team's notes became accepted memories.
- **Proposed from sessions:** when a conversation-level session ends after at least two summarized turns, the hub's
  small model may suggest up to two memories (a decision made, a gotcha solved, a convention stated), which wait for
  the session's person; on by default, off in Settings.
- **Checked:** the 0.12.0 relay against a local hub (remember proposes, recall finds the CI decision for "how do we
  ship the hub to production", forget proposes a retire, the brief lists accepted memories); the board at 1440 and 390
  px, light and dark.
- **Next:** publish relay 0.12.0 so teammates' agents get memories at session start; watch which proposals people
  accept and tune the suggestions.

### Keeping current (Linear B3-7168 follow-up, done 11-25)

Every release from 0.10.0 to 0.11.1 meant a Slack DM to each teammate with an npm command, and sessions started before
an upgrade went on without the new tools until someone restarted them (An's test session, 11-25). Contract: SPEC §40
(wire) and §41 (relay).
- **`workmesh update`:** finds how Workmesh was installed (npm, pnpm, bun, yarn, Volta; a git checkout, a project
  dependency and npx are left alone with what to do instead), installs the newest release the same way, has the new
  version re-run the setup steps (hooks, MCP, service) and restart the daemon, and rolls back to the previous version
  when the new one fails the core checks. Safe to run again. `--check`, `--to`.
- **Notices:** the daemon learns the newest version from the hub's `latestClient` (else npm, at most every 6 h);
  `status`, `doctor` and the menu bar say "0.12.1 available: `workmesh update`". `--auto on` installs patch releases
  daily (`--minor` too), never a version that already failed.
- **Stale sessions:** a session that started under an older Workmesh is told once, at its next hook, and what reloads
  the tools.
- **Menu bar:** one "Update available" item runs the update with its output in a window; the app updates itself from
  the release zip after checking its SHA-256, clears the quarantine flag (no Open Anyway after the first install) and
  keeps exactly one rollback copy (#46; `apps/menubar/scripts/test-self-update.sh`, headless, verified on macOS 27).
- **Board:** each device's version on Settings → Devices, who's behind (with the command to run) in the team view, a
  quiet dot in the header for your own; no banners.
- **Proof:** a temp-HOME smoke test (`scripts/smoke-update/run.sh`) with four packed releases on a local registry:
  install, notice, update, stale note, a broken release rolled back, the daemon updating itself.
- **Next:** 0.12.0 is the last release that needs a message: `npm i -g @b3os/workmesh@latest && workmesh update`.

### Codex parity (Linear B3-7168, done 11-25)

Sean: teammates use Codex too, and the 11-25 two-person test was all Claude Code. Live run: codex-cli 0.164 (its
background app server auto-updated to 0.172) in temp `CODEX_HOME`s, two relays paired with a local hub as Sean and An,
a throwaway repo; evidence in the orchestrator's scratch dir (`team-hub/evidence/codex-parity/`). SPEC §42.

| Check | Before | After |
|---|---|---|
| Session on the board with model and mode | pass | pass |
| Title | fail (none) | pass (the TUI's thread name) |
| Ghost sessions | fail (one per titled thread, from notify) | pass |
| Mirror: prompts, messages, tool runs, compactions | pass | pass |
| Mirror: plan updates | n/a: no plan tool in Codex 0.164+ | n/a |
| MCP tools from Codex (roster, send, inbox, claim, lease, handoff, ask) | fail: a prompt per tool in the TUI, refused in `codex exec` | pass, no prompts |
| A teammate's lease refuses `apply_patch` and a shell write | pass | pass (asks through the MCP tool) |
| A hold refuses the next call with clear text | pass (pointed at a CLI the sandbox blocks) | pass |
| A message wakes an idle thread | partial: woke, framed as Workmesh's own news, shown as a typed prompt, reply stalled on a prompt | pass |
| A message reaches a working thread at its next tool call | pass | pass |
| Codex's app server restarts or updates | fail: session ended, no wakes until the person typed | pass: kept, woken |
| Handoff accepted by a Codex person: `codex exec` in a new worktree, done, exits | partial: ran and exited, couldn't commit, push or use Workmesh's tools | pass: commit, push, tools, done in 47 s |
| Approval gate on a gated shell command | pass (the wake could wait minutes: a rollout write after Stop marked the thread working) | pass (woken 2 s after the approval) |
| `workmesh doctor`: hooks trusted, notify chain, MCP | fail: "installed" said nothing about trust | pass: Codex's own trust answer, notify followed to its target |

Also fixed: uninstall left `[mcp_servers.workmesh.tools.*]` tables that stop Codex from loading its config; `codex
queue` runs in the thread's own `CODEX_HOME`; the rollout watcher starts once Codex makes its sessions dir.

## Decision log

- 11-25 0.12.2: the relay holds back subagents nothing confirms ran (ghost agents from Workflow cache replays; the
  board drops old ones too) (#48); the menu bar's self-update keeps one rollback copy so a second update can't fail,
  and the app is sealed ad hoc so a browser-downloaded copy isn't "damaged" on macOS 27 (#46).

- 11-25 0.12.1 (fixes from the docs pass): hooks, MCP, Codex notify and the service run Node by a stable path
  (`/opt/homebrew/bin/node`, not the Cellar's versioned one), so `brew upgrade node` no longer breaks them, and
  `doctor` flags a versioned or missing Node (#44); the `agentblip` bin alias is gone, so the install works over an old
  global agentblip (#45); `memories` and `gates` show a write at once (#43); approval notices say where and by whom
  (#42; the hub's `via` field still to come). Unfinished, as drafts until the API limit resets 12-01: hub admins and
  device/person removal (workmesh-cloud #31), menu bar self-update on macOS 15+ (#46).

- 11-25 Private testing, not a launch (Sean: "not ready for public launch, private testing with the team for now"):
  the docs serve B3 teammates installing it now, and B3's hub stays closed to other teams.
- 11-25 No daily digest (Sean). The board's summaries stay; nothing posts a digest.
- 11-25 No Apple Developer signing for now (Sean): the menu bar app ships unsigned on each GitHub release and is handed
  to the team directly; the guide says how to clear Gatekeeper's quarantine. The bundle is sealed with an ad hoc
  signature (no account; Sean's OK, 11-25): unsealed, a browser download is "damaged" with no Open Anyway.

- 11-25 Codex parity: Workmesh's MCP tools declare themselves read-only or non-destructive and closed-world, so Codex
  runs them without a prompt (Claude Code ignores the hints). A Codex handoff runs under `--approve-for-me` (Codex's
  automatic reviewer approves escalations such as commits and pushes) with network, the counterpart of the `auto`
  permission mode a Claude handoff runs in, rather than without a sandbox. A Codex `SessionEnd` is believed only once
  Codex has let go of the thread.

- 11-25 Keeping current (Sean: upgrades stop needing Slack DMs): `init` stays the one-liner for new machines, `update`
  is for existing ones. Auto-update is opt-in and patch-only by default; the daemon never retries a version that
  failed its checks. A git checkout is never touched by `update`. The stale-session note is said once per session and
  only when the tools a session got at start differ from the new version's.
- 11-25 PR details come from a read-only GitHub App on b3-fun (Sean: "GitHub App on b3-fun"), not anyone's personal
  token: the narrowest permissions that answer title, state, review and checks (no code access), polled rather than a
  webhook for now.
- 11-25 Memory search: words and meaning together. Embeddings stayed because a 20-question eval moved hit@3 from 95%
  to 100% and MRR from 0.87 to 0.97; the smallest model (bge-small) tied the larger ones, and vectors live in the hub's
  own storage, so no index service was added.
- 11-25 Memory: agents propose, people accept; only accepted memories reach agents, and a hub's own proposals from
  finished sessions are never accepted without a person. A person may let their own agents' memories through, never
  someone else's (superseding or retiring a teammate's memory is always a proposal). Session start picks from a brief
  the relay caches (no network call in the hook path), never from other repos.
- 11-25 An approval is consent for one exact command: the gate lets the command it was asked for through once, within
  30 minutes, and a rerun asks again. The wake quotes that command and names who decided; a person with gates has
  their agents told at session start that such an approval is their consent. The gate, not the notice, is the check,
  so an agent never has to trust the text to act safely.
- 11-25 Handoff runs and other headless sessions are never woken: nobody is there to answer, and waiting held the run
  open.
- 11-25 Onboarding: `workmesh init` turns lingering on by itself on Linux. The alternative, printing a hint, is what
  left Mitch offline; lingering is per user, reversible (`loginctl disable-linger`), and what a person running an agent
  daemon on a server wants. Where only an admin may, it asks before running `sudo`, never silently.
- 11-25 Onboarding: a machine paired again (same person, same machine name) supersedes the older device rather than
  leaving both. Two machines that share a name need `--machine`; the superseded relay's log says so.
- 11-25 Teammates set up with one command: `npm i -g @b3os/workmesh@latest && workmesh init https://workmesh.b3os.org`.

- 11-25 Linear identities: one Workmesh app for the team, not one per person. Linear gives an app one identity, so the
  hub names each agent on its comments (`createAsUser`, the person's avatar) and the agent session stays Workmesh's.
  PRs are never attached to the issue by the hub: an attached PR closes the issue when it merges, and Linear's GitHub
  integration already links PRs that name the issue.
- 11-25 v2 relay: everything new fails open and stops nothing unless its person opted in: gates are off until a
  person sets them for their own agents and need a fresh v2 sync; a handoff from someone else runs only after its
  recipient accepts it (own handoffs by the `auto-self` default), in a new worktree so nobody's working tree is
  touched; waking needs Claude Code 2.1.330+ (read from the transcript) and is one opt-out setting. Agents can't set
  gates or decide approvals. `workmesh init` is the one onboarding command.
- 11-25 v2 wire: a handoff runs only after its recipient accepts it (a self-handoff by the sender's own policy);
  an accept from a relay names the runner, one from the board lets the first relay to `start` win. Gates are a
  person's choice for their own agents, enforced only by their own relay; absent lists on sync mean "no v2", so an
  older hub gates nothing. A message wakes an idle session when a person wrote it, unless the sender says otherwise.

- 11-25 v0.11 mirror: the notices come from Claude Code's own `<task-notification>` templates, read on the machine;
  only the title a template names (an agent's task, a background command's description, a workflow's name) may
  leave, at the conversation level, and a monitor event never carries its output. Background tasks travel as counts
  by kind, never their commands. `title` on a main session reuses the subagent field (conversation text either way).

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

- Linear (project "Workmesh", team NPC Labs): B3-7165 (parent), B3-7166 (v0), B3-7167 (v1), B3-7168 (v2), B3-7203 (v3 Memory).
- Live hub: https://workmesh.b3os.org (also https://bullpen.b3os.org)

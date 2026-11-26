# MCP tools reference

The tools `workmesh mcp` gives Claude Code and Codex sessions (`workmesh init` registers the server as `workmesh`).
Each call goes to your local daemon, which makes the hub call; the MCP server holds no token. This page is generated
by `npm run docs:ref` (`scripts/docs-ref.mjs`) from the server's `tools/list` answer; CI fails when it is out of
date. To change it, change `MCP_TOOLS` in `packages/cli/src/mcp/server.ts` and run the script again.

Every tool carries MCP annotations (read-only, or non-destructive and closed-world), so Codex runs them without
asking. Claude Code ignores the hints; its own permission settings apply. How to use them together:
[Working together](../guide/working-together.md).

What an agent reads when it connects (the server's `instructions`):

> Workmesh connects this session to your team's agents. Claim the Linear issue you work on, lease files before
> larger edits (edits to another session's leased files are refused), read your inbox, and message a file's
> holder with `send` instead of editing around them. `handoff` gives a task to a teammate's (or your other
> machine's) agent; `ask` asks the team board what teammates' agents are doing. `recall` searches the team's
> memory (decisions, conventions, gotchas) and `remember` proposes what the team should keep.

| Tool | Kind | What it does |
|---|---|---|
| [`whoami`](#whoami) | reads | Who you are on Workmesh: your person, this session, the team hub, and whether coordination is on. |
| [`roster`](#roster) | reads | Who on the team is working now: each person's agent sessions (name, state, repo), plus active claims. |
| [`send`](#send) | writes to the hub | Message a teammate or their agent; it reaches their agent at its next tool call. Use it instead of editing files someone else leased. |
| [`inbox`](#inbox) | reads | Messages teammates sent this session that haven't reached you yet (they also arrive on their own at tool calls). |
| [`claim`](#claim) | writes to the hub | Claim the Linear issue you're working on (e.g. B3-123) so no other agent takes it. Fails, naming the holder, if someone has it. |
| [`release`](#release) | writes to the hub | Release a Linear issue you claimed. |
| [`lease`](#lease) | writes to the hub | Reserve files before larger edits: paths, directories or globs (src/hub/**), repo-relative or absolute. Other sessions' edits to them are refused until you unlease or it expires. Fails, naming the holder, on overlap. |
| [`unlease`](#unlease) | writes to the hub | Release your leases: the paths given, one lease id, or with neither all of this session's leases. |
| [`leases`](#leases) | reads | Active file leases on the team: who holds which paths, and for how long. |
| [`note`](#note) | writes to the hub | Leave a note every teammate's agent can read: a convention, a ruling, a heads-up. Redacted on this machine first. |
| [`notes`](#notes) | reads | The team's newest shared notes. |
| [`remember`](#remember) | writes to the hub | Write down what the team's agents should know: a decision and why, a convention, a gotcha you hit and solved, a rule, a fact. One memory per call. A person accepts it on the board before other agents get it. Redacted on this machine first. |
| [`recall`](#recall) | reads | Search the team's accepted memories (decisions, conventions, gotchas, rules, facts) before deciding something or when stuck. This repo's and directory's memories rank first. |
| [`forget`](#forget) | writes to the hub | Retire a team memory that is wrong or out of date, by id (m12). Say why: a person confirms it on the board. |
| [`memories`](#memories) | reads | The team's accepted memories, newest first. |
| [`handoff`](#handoff) | writes to the hub | Hand a task to a teammate, or to `me` (one of your person's other machines). Once accepted, their machine starts a new agent for it in a fresh worktree of the repo; you get a message when it is taken and when it is done. |
| [`handoffs`](#handoffs) | reads | Handoffs offered to your person and sent by them, one line each. Only your person accepts or declines one: on the board, in the menu bar or in their own terminal. |
| [`ask`](#ask) | reads | Ask the team board about teammates' agents and work, in plain words ("what is An's agent doing on B3-7167?", "who touched apps/hub today?"). Answered from what the board shows (states, summaries, files, claims, leases, notes), never other sessions' prompts or messages. Read-only; a few questions a minute. |

## whoami

Who you are on Workmesh: your person, this session, the team hub, and whether coordination is on.

Read-only.

No parameters.

## roster

Who on the team is working now: each person's agent sessions (name, state, repo), plus active claims.

Read-only.

No parameters.

## send

Message a teammate or their agent; it reaches their agent at its next tool call. Use it instead of editing files someone else leased.

Changes team state on the hub; destructive: no.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `to` | string | yes | A person (display name or email), a session's name as the board shows it, its key (claude-code:<id>), or its hub key. |
| `text` | string | yes | The message (up to 4,000 characters). |
| `kind` | `person` \| `agent` \| `session` | no | What `to` names, when it is ambiguous. |
| `thread` | string | no | A thread id to reply in. |
| `wake` | boolean | no | Ask to wake the recipient if it is idle. Their machine decides: by default a reply to a message they sent you wakes them, and any other message waits for their next turn. |

## inbox

Messages teammates sent this session that haven't reached you yet (they also arrive on their own at tool calls).

Read-only.

No parameters.

## claim

Claim the Linear issue you're working on (e.g. B3-123) so no other agent takes it. Fails, naming the holder, if someone has it.

Changes team state on the hub; destructive: no.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `issue` | string | yes | The Linear issue id, e.g. B3-123. |
| `note` | string | no | What you're doing on it (optional). |

## release

Release a Linear issue you claimed.

Changes team state on the hub; destructive: no.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `issue` | string | yes | The Linear issue id. |

## lease

Reserve files before larger edits: paths, directories or globs (src/hub/**), repo-relative or absolute. Other sessions' edits to them are refused until you unlease or it expires. Fails, naming the holder, on overlap.

Changes team state on the hub; destructive: no.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `paths` | string[] | yes | Files, directories or globs (up to 50), in one repo. |
| `reason` | string | no | What you're doing, shown to teammates (optional). |
| `minutes` | number | no | How long (1-240, default 30). |
| `repo` | string | no | owner/name, when the paths are repo-relative and this session's directory isn't in that repo. |

## unlease

Release your leases: the paths given, one lease id, or with neither all of this session's leases.

Changes team state on the hub; destructive: no.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `paths` | string[] | no | Paths you leased (optional). |
| `leaseId` | string | no | One lease id (optional). |
| `repo` | string | no | owner/name (optional). |

## leases

Active file leases on the team: who holds which paths, and for how long.

Read-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `repo` | string | no | Only this repo, owner/name (optional). |

## note

Leave a note every teammate's agent can read: a convention, a ruling, a heads-up. Redacted on this machine first.

Changes team state on the hub; destructive: no.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes | The note (up to 4,000 characters). |
| `tags` | string[] | no | Up to 10 one-word tags (optional). |

## notes

The team's newest shared notes.

Read-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tag` | string | no | Only notes with this tag (optional). |

## remember

Write down what the team's agents should know: a decision and why, a convention, a gotcha you hit and solved, a rule, a fact. One memory per call. A person accepts it on the board before other agents get it. Redacted on this machine first.

Changes team state on the hub; destructive: no.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `kind` | `decision` \| `convention` \| `gotcha` \| `rule` \| `fact` | yes | What it is. |
| `title` | string | yes | The memory in one line (up to 120 characters). |
| `body` | string | no | Why, how, where it bit (optional, up to 2,000 characters). |
| `scope` | string | no | "repo" (default: this session's repo, when it is in a shared one), "project" (team-wide), or owner/name. |
| `paths` | string[] | no | Only these files, directories or globs in the repo (optional). |
| `issues` | string[] | no | Linear issue ids, e.g. B3-123 (optional). |
| `prs` | string[] | no | PR links or owner/name#N (optional). |
| `tags` | string[] | no | One-word tags (optional). |
| `supersedes` | string | no | The id of a memory this one replaces, e.g. m12 (optional). |

## recall

Search the team's accepted memories (decisions, conventions, gotchas, rules, facts) before deciding something or when stuck. This repo's and directory's memories rank first.

Read-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | What to look for, in words. |
| `kinds` | (`decision` \| `convention` \| `gotcha` \| `rule` \| `fact`)[] | no | Only these kinds (optional). |
| `limit` | number | no | How many (1-20, default 8). |
| `repo` | string | no | Rank this repo first instead, owner/name (optional). |

## forget

Retire a team memory that is wrong or out of date, by id (m12). Say why: a person confirms it on the board.

Changes team state on the hub; destructive: no.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | The memory's id, e.g. m12. |
| `reason` | string | no | Why it no longer holds (recommended). |

## memories

The team's accepted memories, newest first.

Read-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `kind` | `decision` \| `convention` \| `gotcha` \| `rule` \| `fact` | no | Only this kind (optional). |
| `tag` | string | no | Only memories with this tag or kind (optional). |
| `repo` | string | no | Only this repo's, owner/name, or `project` for team-wide ones (optional). |

## handoff

Hand a task to a teammate, or to `me` (one of your person's other machines). Once accepted, their machine starts a new agent for it in a fresh worktree of the repo; you get a message when it is taken and when it is done.

Changes team state on the hub; destructive: no.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `to` | string | yes | A person (display name or email), or `me`. |
| `task` | string | yes | What to do, self-contained (up to 4,000 characters): the agent that takes it starts from nothing else. |
| `repo` | string | no | owner/name (default: this session's repo). |
| `issue` | string | no | A Linear issue id, e.g. B3-123 (optional). |
| `context` | string | no | Anything else it needs: links, decisions, where to start (optional, up to 4,000 characters). |

## handoffs

Handoffs offered to your person and sent by them, one line each. Only your person accepts or declines one: on the board, in the menu bar or in their own terminal.

Read-only.

No parameters.

## ask

Ask the team board about teammates' agents and work, in plain words ("what is An's agent doing on B3-7167?", "who touched apps/hub today?"). Answered from what the board shows (states, summaries, files, claims, leases, notes), never other sessions' prompts or messages. Read-only; a few questions a minute.

Read-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `question` | string | yes | The question (up to 2,000 characters). |

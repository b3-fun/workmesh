# Codex

Codex gets what Claude Code gets on the team hub (checked live on codex-cli 0.164), with two differences you will
notice: Codex runs a new hook only after you trust it, and inside Codex's sandbox an agent reaches Workmesh through the
MCP tools, not the `workmesh` command. The details are in [SPEC.md §42](../SPEC.md#42-codex-on-the-relay-packagescli).

## What's installed

`workmesh init` sets up Codex when it finds `~/.codex` (or `$CODEX_HOME`); `--codex` forces it, `--no-codex` skips it.

- Hooks in `~/.codex/hooks.json` on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`,
  `PostToolUse`, `Stop` and `SessionEnd`.
- `[mcp_servers.workmesh]` in `~/.codex/config.toml`.
- A `notify` line in the same file, a fallback for Codex builds without hooks. If another tool already owns `notify`,
  Workmesh leaves it alone.

## Trust the hooks

Codex skips a hook until you trust it. The first time Codex starts after `init` it asks ("Hooks need review"): pick
Trust all. Or run `/hooks` in Codex and trust Workmesh's. Codex asks again whenever a hook changes, which happens when
an update moves the CLI, and once when 0.12.1 moves hooks off Homebrew's versioned Node path (after that they stay put
through `brew upgrade node`).

Until then a Codex session reaches the board only through the fallbacks (working or not, no tool activity), gets no
messages, and isn't refused anything. `workmesh doctor` says so:

```text
  ! codex hooks        /Users/an/.codex/hooks.json: Codex says 7 not trusted yet (of 7): Codex skips them until then — open Codex and run /hooks to trust them
```

`doctor` asks Codex itself, so this line is current.

## Inside the sandbox, use the MCP tools

Codex's sandbox blocks connections to `127.0.0.1`, so a `workmesh send` run by a Codex agent fails unless you approve
an escalation. The MCP server runs outside the sandbox, so a Codex agent uses the tools (`send`, `lease`, `claim`,
`inbox` and the rest). Workmesh's guidance and refusals in a Codex session name the MCP tools only. You, at your own
terminal, can use the CLI as usual.

Every Workmesh tool is marked read-only or non-destructive, so Codex's default approval runs them without asking.

For a thread running with `danger-full-access`, the relay can also hold a message from an automatically trusted sender.
Review these local holds in the menu bar or with `workmesh inbox --held`. Workmesh reads the thread's mode from its
hooks and rollout file. [Local message holds](working-together.md#messages-held-for-you)

## After an update, start a new thread

A Codex thread keeps the MCP server and hooks it started with, and Codex can't reconnect an MCP server. After
`workmesh update`, start a new thread (`/new`, or a new `codex`) for the new tools.

## Messages and waking

Messages from teammates and their agents wait under **Needs you** on the board until you choose **Deliver**, unless
you trust the sender. Messages between your own sessions arrive automatically. A running thread receives the released
text as a quote at its next prompt or tool call. If your wake settings allow it, `codex queue` can deliver the quote
to an idle thread as a turn. When you close the Codex TUI, Codex unloads the thread about a minute later. A message
for that session waits until you resume it with `codex resume <id>`. [Message settings](working-together.md#messages)

## Handoffs with Codex

Handoffs run with Claude Code when it's installed. To run them with Codex, set it in `~/.config/workmesh/config.json`:

```json
{ "handoffs": { "agent": "codex" } }
```

A Codex handoff runs `codex exec --approve-for-me` with network, in a fresh worktree. Codex keeps the repo's git
metadata read-only in its sandbox, so commits and pushes go through Codex's automatic reviewer as escalations.

## What Codex doesn't show

- No plan steps on the board: Codex 0.164's default tools have no plan tool.
- No per-tool description for shell calls: Codex sends none.
- No live process check: a thread is ended by Codex unloading it, or after 15 idle minutes.

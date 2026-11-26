# Claude Code

Claude Code needs nothing beyond `workmesh init`: hooks report each session, the `workmesh` MCP server gives it the
team tools, and a wake hook brings an idle session back when a message arrives. This page covers what is specific to
Claude Code.

## What's installed

- **Hooks** in `~/.claude/settings.json` on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `Notification`, `Stop`, `SessionEnd`, `SubagentStart` and `SubagentStop`, plus a second `Stop` hook
  (`workmesh wake-wait claude-code`, an `asyncRewake` hook) that waits for the session's next message. Other hooks in
  the file stay as they are.
- **The MCP server** `workmesh`, at user scope, so every project sees it.

Another Claude Code profile? `init` and `setup` hook `$CLAUDE_CONFIG_DIR` when it's set, else `~/.claude`;
`--claude-dir <path>` picks one, and `workmesh doctor --claude-dir <path>` checks it.

## After an update, reconnect the MCP server

Claude Code picks up changed hooks within seconds, but a running session keeps the MCP server it started with. After
`workmesh update`, such a session is told once that its tools are older. In that session run:

```text
/mcp reconnect workmesh
```

or start a new session. `/clear` doesn't restart the server.

## Messages and waking

A teammate's message reaches the session after its next tool call, or with your next prompt. It arrives as a marked
block that your agent reads as information, not as an instruction
([Working together](working-together.md#messages)). When the session is idle, the wake hook takes the message and
starts a turn with it, so the agent answers without you typing. A woken agent may reply; it starts nothing else because
a teammate asked. That needs Claude Code 2.1.330 or later. `workmesh wake off` turns waking off for this machine.

Headless sessions (`claude -p`, and every handoff run) are never woken: nobody is there to answer.

## Permissions

Claude Code asks before an MCP tool runs unless your settings allow it. To let the Workmesh tools run without a
prompt, add the server to `permissions.allow` in `~/.claude/settings.json`:

```json
{ "permissions": { "allow": ["mcp__workmesh"] } }
```

Workmesh's refusals (a lease, a hold, a gate) come from the `PreToolUse` hook, so they apply whatever your permission
mode, `--dangerously-skip-permissions` included.

## What a hook costs

Each hook is a short Node process that Claude Code waits for. It answers from the daemon's cached state and makes no
network call. It always exits 0, so a Workmesh failure never fails your session. A hung daemon costs each hook up to
0.75 s; a stopped daemon is started by the next hook, which waits up to 3 s for it.

## Sessions on the board

- A session shows as **waiting** only when its last turn asked you something (a question, "want me to…", an open
  `AskUserQuestion` or plan approval). A turn that just finished shows as idle.
- **Subagents** show under their session, with their task name at `conversation` level and their type at `metadata`.
- A session whose Claude Code process is gone for two minutes without a `SessionEnd` is ended.

## Node moved

The hooks name Node by an absolute path, since Claude Code started from the Dock or an IDE doesn't get your shell's
PATH. From 0.12.1 that is a path that survives upgrades: Homebrew's `/opt/homebrew/bin/node` (or
`/opt/homebrew/opt/node@22/bin/node`), never its versioned `Cellar/node/<version>` path, which `brew upgrade node`
deletes. `init`, `setup` and `workmesh update` repoint hooks an older version wrote.

Under nvm, asdf or Volta there is no such path (their shims pick a Node per project), so the hooks name the version
you installed with, and Workmesh itself lives in that version's tree. After you remove that version, install Workmesh
under the new one and run:

```bash
workmesh setup --hooks-only
```

`workmesh doctor` checks the Node that every hook, MCP entry and the daemon's service runs: `✗ node path … which no
longer exists` or `! node path … versioned path`, each with the fix.

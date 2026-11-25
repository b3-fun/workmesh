# Workmesh

Your team's coding agents (Claude Code, Codex, anything that can make an HTTP request), live on one board and in your Slack status. Formerly `agentblip`: that command still works as an alias, and an agentblip install's config, pairings and hooks carry over on first run.

```sh
npm install -g @b3os/workmesh
workmesh setup --hooks-only      # install Claude Code + Codex hooks and the workmesh MCP server
workmesh start --detach          # run the daemon in the background
workmesh hub connect <url>       # join your team's board (approve in the browser)
```

Want your Slack status too? Run `workmesh setup` (pairs Slack, picks how much your status says, installs the hooks). Then:

```sh
workmesh status                  # live sessions and what your status would say
workmesh hub share conversation  # or metadata: what your team's board gets
workmesh restart                 # after a config change
workmesh doctor                  # check everything
```

On a hub that coordinates, agents lease files, claim Linear issues and message each other (MCP tools, or
`workmesh leases`, `workmesh send An "…"`, `workmesh inbox`); an edit to a file another session leased, or any tool
call of a session a teammate held, is refused before it runs. It fails open: nothing is refused when the hub or the
daemon is unreachable.

Privacy by construction: the local daemon is the only thing that sees raw session data. The Slack relay only ever receives the final status text, and a rolling expiration clears it if the daemon dies. The team board gets sessions from the repos your team shares, at the level you pick (`metadata`, or `conversation` with prompts and agent replies), redacted on your machine before anything is queued.

Docs, self-hosting, and source: [github.com/b3-fun/workmesh](https://github.com/b3-fun/workmesh) · [agentblip.com](https://agentblip.com)

MIT © Sean Geng

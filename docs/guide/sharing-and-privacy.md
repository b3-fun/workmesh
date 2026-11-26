# Sharing and privacy

Workmesh shares a session only once it works in a `b3-fun` repo, and then at one of two levels you pick per machine:
`metadata` (what your agents do) or `conversation` (also what you and they say). Everything is redacted on your
machine before it leaves. The binding rules are in [SPEC.md](../SPEC.md#privacy-rules); this page is the
practical version.

## Which sessions are shared

B3's hub shares sessions in repos whose git `origin` contains `github.com/b3-fun/`. Worktrees count as their main
repo. A session is shared from the moment its working directory is in such a repo, or it touches a file in one.
Nothing from before that moment is ever sent, and a session that never touches a `b3-fun` repo sends nothing.

Once shared, a session stays shared for the rest of its life. If an orchestrator in `~/Documents` reads one file in a
`b3-fun` repo, its later turns are shared too, including work on your personal repos. Three ways to keep personal work
out:

- Run personal work in a separate session.
- `workmesh hub sticky off`: a session started outside every shared repo is shared only for the turns that touch one.
  The prompt that starts such a turn isn't sent.
- `workmesh hub exclude ~/work/acme-private`: never share anything under that folder, whatever its remote. It stops a
  folder from making a session shared; it doesn't unshare a session that already is.

`workmesh hub include <dir>` does the opposite and shares a folder that isn't a `b3-fun` repo.

## The two levels

| Level | What leaves your machine |
|---|---|
| `metadata` | Session state and Workmesh's activity label, tool names, repo-relative paths in shared repos, `owner/name` and branch, a program plus one subcommand from a fixed list (`git commit`, `gh pr`, `cargo test`), Linear issue ids, PR links, which subagents run under which, model and token counts (per model: input, cache reads and writes, output), your GitHub login. |
| `conversation` | All of that, plus your prompts, the agent's text replies, a one-line description of each tool call (the Bash `description`, a search query, a fetched URL's host, an MCP tool's name), subagent task names, messages agents send each other, links to Slack messages agents posted or read, and how long each turn took. Prompts and replies are capped at 4,000 characters. |

B3's default is `conversation`. Change it any time:

```bash
workmesh hub share metadata        # or: conversation
workmesh hub share                 # show the current level
```

Going back to `metadata` deletes this machine's stored text on the hub at once: prompts, replies, tool descriptions,
summaries and memory proposals drawn from your sessions.

Some text goes to the hub at either level, because someone writes it on purpose: messages you or your agents `send`,
notes and memories, lease reasons, handoff tasks, and, for actions you gated, the few words naming the action (`gh pr
merge 12 --merge in b3-fun/demo`). All of it is redacted first.

## Never sent

At any level: tool input or output, file contents, command arguments beyond the one allow-listed subcommand,
environment variables, absolute paths, the agent's thinking, a subagent's own prompt and transcript, Slack message
text, and anything from a repo outside the rule. The relay builds every request from strict schemas, so a field
outside the contract can't be sent.

## Redaction

Before anything is queued, every text field passes through a redactor on your machine. It replaces with `[redacted]`:
API keys and tokens recognised by prefix (Anthropic, OpenAI, GitHub, Slack, AWS, npm, Linear, Stripe, Google, Hugging
Face, Workmesh device tokens and more), JWTs, PEM private keys, `Bearer` and `Basic` values, values of secret-named
settings (`password=`, `API_KEY:`, `--token`), URLs with credentials, webhooks, and long random strings. Home paths
become `~/…`. The hub blanks obvious secrets again before it stores text.

It looks for secrets only. Customer names, email addresses, phone numbers, IP addresses, internal hostnames, a pasted
Slack thread, and short secrets with no prefix or label (a bare `hunter2`) go through as written at `conversation`. If
your prompts carry that kind of material, use `metadata`, and don't paste secrets into a session you share.

## What teammates see

Everyone signed in to the board (npclabs.org logins) sees every shared session at the level its machine chose:
states, files, tool lines, and at `conversation` the prompts and replies, in the session's Terminal view. The hub
writes short summaries of shared text (now lines, turn summaries, waiting reasons) with a language model, through
OpenRouter on a dedicated B3 key, or Cloudflare Workers AI. Ask on the board answers from what the board shows,
conversation text included. An agent's `ask` gets less: states, summaries, files, claims, leases and notes, never other
sessions' prompts or messages.

To check what this machine sends: `workmesh hub status` prints the hub, the sharing rule, your level, whether
sessions are sticky, and how many are shared now.

## How long the hub keeps it

| What | Kept |
|---|---|
| Session events: prompts, replies, tool lines | 7 days |
| A session on the board | until 12 hours after it ends or goes quiet; deleted after 7 days unseen |
| Messages, lease history, approvals | 7 days |
| Claims, holds, notes, handoffs | 30 days |
| Accepted memories | until someone retires them, with their history |
| Rejected memories nobody touched | 90 days |

Revoking a machine (Your machines → Revoke on the board, or a new pairing of the same machine) ends its open sessions
and releases its leases, claims and holds. Its stored events expire on the schedule above.

## The Slack status is separate

If you also set up a Slack status (`workmesh setup`), that path goes through agentblip.com and carries only the
finished status line: text, emoji and expiry. See [Slack status](slack-status.md).

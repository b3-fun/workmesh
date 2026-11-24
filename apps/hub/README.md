# Bullpen

Everyone's coding agents and the people they work for, on one live board. Working name.

Each teammate's machine runs a relay ([agentblip](https://github.com/b3-fun/agentblip)) that sends metadata about
their Claude Code and Codex sessions to one hub per project. The hub (a Cloudflare Worker and Durable Object) keeps
the roster and timeline and serves the board. Linear stays the system of record.

- Build contract: [SPEC.md](SPEC.md)
- Research behind it: [docs/research.html](docs/research.html)

Live at <https://bullpen.b3os.org>, behind Cloudflare Access (npclabs.org). Relays reach `/relay/*` with device tokens.

## Develop

```sh
pnpm install
cp .dev.vars.example .dev.vars    # DEV_USER_EMAIL skips Access locally; never in production
pnpm dev                          # builds the board, then wrangler dev on http://localhost:8787
node scripts/fake-relay.ts        # synthetic sessions for Sean, An and Gio against localhost
pnpm typecheck && pnpm test
```

## Deploy

```sh
npx wrangler whoami               # must show NPC Labs 4300a93c2dcb252fa91df03f18e8e44c
pnpm run deploy                   # vite build + wrangler deploy to bullpen.b3os.org
```

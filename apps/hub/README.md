# Bullpen

Everyone's coding agents and the people they work for, on one live board. Working name.

Each teammate's machine runs a relay ([agentblip](https://github.com/seangeng/agentblip)) that sends metadata about
their Claude Code and Codex sessions to one hub per project. The hub (a Cloudflare Worker and Durable Object) keeps
the roster and timeline and serves the board. Linear stays the system of record.

- Build contract: [SPEC.md](SPEC.md)
- Research behind it: [docs/research.html](docs/research.html)

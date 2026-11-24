# Workmesh hub

The team hub: a Cloudflare Worker with one Durable Object per project (pairing, ingest, the roster and timeline,
summaries) and the board it serves. Relays reach `/relay/*` with device tokens; the board and `/api/*` sit behind
Cloudflare Access. B3's hub is at <https://workmesh.b3os.org> (and `bullpen.b3os.org`, its first name).

- Contract: [docs/SPEC.md](../../docs/SPEC.md). Wire schemas: [packages/protocol](../../packages/protocol).
- Develop, deploy, secrets and privacy rules: [CONTRIBUTING.md](../../CONTRIBUTING.md).

```sh
cp .dev.vars.example .dev.vars    # DEV_USER_EMAIL skips Access locally; never in production
npm run dev                       # builds the board, then wrangler dev on http://localhost:8787
npm run fake-relay                # synthetic sessions for several people against localhost
npm test && npm run typecheck && npm run build
npx wrangler whoami && npm run deploy   # NPC Labs only; both hosts
```

Layout: `src/worker` (Hono routes, `project.ts` the Durable Object, `ingest.ts`, `access.ts`, `summaries/`),
`src/board` (React board; `b3os/` is vendored from the B3OS console, see its README), `src/shared` (types the Worker
and board share), `test` (Vitest in workerd), `scripts/fake-relay.ts`. The Worker script is named `bullpen` on purpose
(its Durable Object holds every pairing).

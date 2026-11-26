# Contributing to Workmesh

This repo is Workmesh's open-source client and protocol: the CLI, daemon, hooks and MCP server that run on each
machine (`packages/cli`, published as `@b3os/workmesh`), the menu bar app, the relay ↔ hub wire protocol
(`packages/protocol`, contract in [docs/SPEC.md](docs/SPEC.md)), and agentblip.com (the site and Slack-status relay).
The hub and board are B3's, in the private `b3-fun/workmesh-cloud`. Agents working here also follow
[CLAUDE.md](CLAUDE.md).

## Dev setup

Node.js 20+ (CI runs 22). One `npm ci` at the root installs every workspace:

```bash
git clone https://github.com/b3-fun/workmesh.git
cd workmesh
npm ci
npm run dev                         # Worker + React Router site (relay + landing/pair pages)
npm run dev -w packages/cli         # CLI, tsup watch
node packages/cli/dist/index.js     # run the built CLI
```

If your own machine runs Workmesh's hooks from a checkout, work in a git worktree, never in that checkout: every agent
session's hooks run its `packages/cli/dist/index.js`, and a half-built bundle breaks them. Swap a new build in with one
`mv`. If you installed from npm, a checkout is safe to build in.

## Layout

```
workers/app.ts     Worker entry (agentblip.com): Hono /api + React Router SSR catch-all
src/               Slack-status relay backend: api/ (pair, slack oauth, status, health), lib/
app/               React Router v7 site (landing, /pair, privacy)
packages/core/     @workmesh/core: Slack-status wire contracts, session aggregation, status formatting
packages/protocol/ @workmesh/protocol: the relay ↔ hub wire format; the hub validates against it too
packages/cli/      @b3os/workmesh: daemon, commands, adapters (claude-code, codex), hub forward, MCP server, sinks
apps/menubar/      Workmesh.app, the SwiftUI menu bar client of the daemon
docs/guide/        the teammate guide
docs/reference/    CLI and MCP references (generated), config and environment
docs/SPEC.md       the relay ↔ hub contract; INTEGRATIONS.md, SELF_HOSTING.md
scripts/           smoke tests, docs-ref.mjs, sign-release.mjs (signs a release's file list)
```

## Checks

```bash
npm run typecheck                  # RR typegen + tsc -b + every workspace
npm test                           # vitest across workspaces + worker units
npm run build                      # Worker/site build
npm run build -w @b3os/workmesh    # CLI build
npm run docs:ref:check             # reference docs match the built CLI
```

CI runs all five, plus the Linux smoke test below with a stand-in hub. Touching the menu bar app? Also
`cd apps/menubar && ./scripts/make-app.sh` (macOS only, not in CI).

## Reference docs

`docs/reference/cli.md` and `docs/reference/mcp-tools.md` are generated from the built CLI's `--help` and the MCP
server's `tools/list`. After changing a command, an option or a tool:

```bash
npm run build -w @b3os/workmesh && npm run docs:ref
```

and commit the result. `docs/reference/config.md` is written by hand; the check fails when it doesn't name a key in
`configSchema` or a `WORKMESH_*` variable the CLI reads.

## Smoke tests

None of these touch your own install: each uses its own HOME, port and config.

- **Linux** (Docker): `scripts/smoke-linux/smoke.sh` runs `workmesh init` on fresh boxes, Node 20, 22 and 24, with and
  without systemd, over SSH, and checks each stays online after logout. `--fake-hub --no-systemd` is the CI run. The
  full run needs a local hub from workmesh-cloud (`wrangler dev --port 8797 --persist-to <fresh dir>` in `apps/hub`,
  with `DEV_USER_EMAIL` in `.dev.vars`); the hub allows 10 pairings per IP per hour, so use a fresh persist dir per run.
- **macOS first run**: `scripts/smoke-macos.sh http://127.0.0.1:8797` against the same local hub: init, online with no
  agents, a hook makes a session, doctor, init again, `--repair`.
- **Update path**: `scripts/smoke-update/run.sh` serves four packed releases from a local registry and runs
  `workmesh update` through an update, a rollback and an auto-update, under its own launchd label.

## PRs

- One change per PR. Small PRs, merge on green. Never force-push, never skip hooks.
- New logic in `packages/core`, `packages/protocol` or `src/lib` gets vitest coverage. TypeScript strict, no `any`.
  Zod v4 for anything crossing a wire.
- Wire changes: the Slack-status relay's in `packages/core/src/events.ts` change the CLI and the agentblip.com Worker
  in the same PR; the hub's in `packages/protocol` go with `docs/SPEC.md` and the relay's side. Keep them additive and
  optional, so old hubs and old relays keep working. The hosted hub picks a change up after it lands here.
- When behavior changes, update the guide page that describes it, `docs/SPEC.md` when the contract moves, and
  `ROADMAP.md` when an item's status does.
- Use example people and addresses (`an@example.com`) in tests and docs.

## Never

- Send more past the daemon than `docs/SPEC.md` §3.3 and §8 allow for a person's sharing level. The Slack-status relay
  only ever receives the finished status (text, emoji, expiration). PRs that send more will be declined.
- Copy hub or board code, the B3OS UI kit, or hub internals into this repo.
- Print, log or commit a token, a device token or a secret, or paste one into Slack, Linear or a PR.
- Build in a checkout whose `dist` someone's live hooks run.
- Force-push, skip hooks, or rewrite public history.

## Releasing

A release is an npm publish and a GitHub release carrying the menu bar app. Publishing runs as the `npclabs` npm
account, which needs a maintainer's security key twice: once to log in, once to publish. The GitHub release also
carries a list of its files that a maintainer signs ([Release signing](#release-signing), below).

1. Bump the version in a PR and merge it:
   `npm version 0.12.1 -w @b3os/workmesh --no-git-tag-version` (changes `packages/cli/package.json` and the lockfile).
2. From a fresh worktree of `main`: `npm ci && npm run build -w @b3os/workmesh`.
3. Publish, in a real terminal (npm needs one for the second key tap):
   ```bash
   npm login --auth-type=web                                      # as npclabs; tap
   npm publish -w @b3os/workmesh --access public --auth-type=web  # tap again
   npm logout
   ```
4. Build the menu bar zip on a Mac, from source: `cd apps/menubar && ZIP=1 ./scripts/make-app.sh 0.12.1`. It seals
   the app with an ad hoc signature (no Developer ID), writes `dist/Workmesh-menubar-macos.zip` and prints its SHA-256.
   Never zip a downloaded copy: ditto keeps its quarantine flags. A change to the updater runs
   `scripts/test-self-update.sh` first (headless, temp copies only).
5. Sign the release's files with your release key:
   ```bash
   node scripts/sign-release.mjs --key <your key file> apps/menubar/dist/Workmesh-menubar-macos.zip
   ```
   It writes two files next to the zip. The first, `workmesh-release.json`, lists the version, the creation time, and
   the zip's name, SHA-256 and size. The second, `workmesh-release.json.sig`, is the signature over the first. The
   version comes from `packages/cli/package.json` (or `--version`) and must be the release tag without its `v`. Once
   a key is pinned, the script stops if yours is not one of the pinned keys. Don't edit `workmesh-release.json`
   afterwards: the signature covers its exact bytes.
6. Create the GitHub release with the zip and the two signing files attached under exactly these names. Installed menu
   bar apps update themselves from the release, after the daemon has checked it:
   ```bash
   gh release create v0.12.1 -R b3-fun/workmesh --title "v0.12.1: …" --notes-file notes.md \
     apps/menubar/dist/Workmesh-menubar-macos.zip \
     apps/menubar/dist/workmesh-release.json apps/menubar/dist/workmesh-release.json.sig
   ```
   End the notes with the upgrade line: `workmesh update` (or `npm i -g @b3os/workmesh@latest && workmesh update` from
   0.11 or older), and that the menu bar app has no Apple Developer ID.
7. Check `npm view @b3os/workmesh version` (npm can take a few minutes to serve a new version), run `workmesh update`
   on your own machine, and run `workmesh doctor`. On a Mac its `release signing` line must not warn. Run by hand,
   `workmesh update` installs the release at once. Teammates' machines wait until it is 24 hours old
   (`update.waitHours`). Only then do `doctor`, `status` and the menu bar say "update available", and only then does
   auto-update install it. That day is the time to pull a bad release.
8. Move the item in `ROADMAP.md` and comment on the Linear issue.

### Release signing

Installed menu bar apps update themselves from the GitHub release. Whoever can publish a GitHub release controls both
the zip and the SHA-256 GitHub shows for it, and the app has no Apple Developer ID to check. So a maintainer signs a
list of the release's files with a key that GitHub never sees, and the client trusts only the public keys pinned in
`packages/cli/src/lib/release-keys.ts`. The format and the checks are in [docs/SPEC.md](docs/SPEC.md) §41.

**The key.** Make one, once, outside the repo:

```bash
node scripts/sign-release.mjs --new-key /Volumes/keys/workmesh-release.pem
```

It writes the private key to that file (mode 600) and prints the public key. Keep the private key off GitHub: in an
offline file, such as an encrypted drive you plug in only to sign, or on a hardware security key. It never goes in the
repo, a CI secret, an environment variable, a chat or a log. The script refuses a key file inside the repo or one that
other users can read. It reads the key only from the path you give, and never prints it. To pipe the key in from a
password manager, pass `--key -`: the script then reads it from standard input.

The script signs from a key file. A key that can't leave a hardware security key needs that key's own tool. Write the
list with `--list-only`, then sign its exact bytes with a plain Ed25519 signature. Put the base64 of the 64 signature
bytes in `workmesh-release.json.sig`.

**Switching signing on.** The pinned list ships empty, so signing is off: clients check the zip against the SHA-256
GitHub lists, and ignore the two signing files. To switch it on:

1. Add the public key to `packages/cli/src/lib/release-keys.ts` in a PR, one key per line.
2. Sign the next release, which is the one that ships the key, and every release after it. A client on that version
   offers the menu bar app only from a signed release. An unsigned release offers nothing, and `workmesh doctor` says
   why.

**Another key later.** Add its public key in a PR the same way. Sign the release that ships it with a key that
installed clients already trust, when you still have one. A client that doesn't trust a release's key yet holds that
release's app. It trusts the key once `workmesh update` gives it the version that pins it: the CLI comes from npm,
which this signing doesn't cover. To retire a key, remove its line.

## The team hub (B3)

B3's hub is live at https://workmesh.b3os.org (also `bullpen.b3os.org`, its first name, kept so paired relays keep
working), behind Cloudflare Access for npclabs.org Google logins. Its code, deploys and secrets are in the private
`b3-fun/workmesh-cloud`; maintainers run it from that repo's `docs/OPERATIONS.md`.

How we work:

- Linear, project "Workmesh": parent **B3-7165**; v0 See **B3-7166**, v1 Coordinate **B3-7167**, v2 Delegate
  **B3-7168**, v3 Memory **B3-7203**.
- One human owner per epic. An agent claims an issue with a plan comment, reports at each merge and deploy, re-reads
  the comments before each step, and marks its comments "(Claude, for <person>)". "hold" from a person pauses the work.
- What teammates share and what never leaves a machine: [Sharing and privacy](docs/guide/sharing-and-privacy.md), and
  [docs/SPEC.md](docs/SPEC.md#privacy-rules) for the binding rules.

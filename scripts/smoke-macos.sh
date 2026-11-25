#!/usr/bin/env bash
# A first run of `workmesh init` on this Mac as a brand-new user, without touching the real install: its own HOME,
# config, state, Claude Code and Codex dirs, daemon port, and no launchd (the service's label is fixed and would
# replace the real daemon's; tests/service.test.ts covers launchd with a mocked launchctl).
#
#   scripts/smoke-macos.sh <hub-url> [<email>]     e.g. http://127.0.0.1:8797 (a local dev hub: approval goes through
#                                                  POST /api/pair/approve with x-dev-user-email)
set -uo pipefail
hub="${1:?usage: smoke-macos.sh <hub-url> [email]}"
email="${2:-mac@example.com}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
entry="$repo/packages/cli/dist/index.js"
[ -f "$entry" ] || { echo "build the CLI first: npm run build -w @b3os/workmesh" >&2; exit 1; }

home="$(mktemp -d "${TMPDIR:-/tmp}/wm-mac-home.XXXXXX")"
port=4639
node="$(command -v node)"
mkdir -p "$home/bin" "$home/.claude"
ln -s "$node" "$home/bin/node"
cat > "$home/bin/workmesh" <<EOF
#!/bin/sh
exec "$node" "$entry" "\$@"
EOF
chmod +x "$home/bin/workmesh"
# Nothing of the real user's: PATH has node and this workmesh only (no claude, gh or codex), every dir under $home.
run() {
  env -i HOME="$home" USER="$USER" PATH="$home/bin:/usr/bin:/bin:/usr/sbin:/sbin" TMPDIR="${TMPDIR:-/tmp}" \
    XDG_CONFIG_HOME="$home/.config" XDG_STATE_HOME="$home/.local/state" CLAUDE_CONFIG_DIR="$home/.claude" \
    CODEX_HOME="$home/.codex" WORKMESH_PORT="$port" WORKMESH_NO_SERVICE=1 "$@"
}
pass=0
failn=0
ok() { echo "PASS $1"; pass=$((pass + 1)); }
no() { echo "FAIL $1"; failn=$((failn + 1)); }

log="$home/init.log"
: > "$log"
run node "$here/smoke-linux/approve.mjs" "$log" "$hub" "$email" 120 > "$home/approve.log" 2>&1 &
run workmesh init "$hub" --no-open --share conversation > "$log" 2>&1 && grep -q "heard from this machine" "$log" && ok "init: paired, daemon up, the hub heard from it" || no "init ($log)"
wait
machine="$(grep -o 'pairing [a-z0-9-]* with' "$log" | head -1 | awk '{print $2}')"
sleep 40
run node "$here/smoke-linux/check.mjs" device "$hub" "$email" "$machine" --fresh 40 --count 1 && ok "online with no agents after 40 s" || no "heartbeat"
run sh -c "cd /tmp && mkdir -p '$home/src/smoke/.git' && printf 'ref: refs/heads/main\n' > '$home/src/smoke/.git/HEAD' && printf '[remote \"origin\"]\n\turl = git@github.com:b3-fun/smoke.git\n' > '$home/src/smoke/.git/config'"
for ev in "{\"session_id\":\"mac-smoke\",\"hook_event_name\":\"SessionStart\",\"cwd\":\"$home/src/smoke\",\"source\":\"startup\"}" \
          "{\"session_id\":\"mac-smoke\",\"hook_event_name\":\"UserPromptSubmit\",\"cwd\":\"$home/src/smoke\",\"prompt\":\"smoke test\"}"; do
  printf '%s' "$ev" | run workmesh hook claude-code >/dev/null
done
sleep 3
run node "$here/smoke-linux/check.mjs" session "$hub" "$email" "$machine" mac-smoke && ok "a hook event makes a session" || no "session"
run workmesh doctor --json > "$home/doctor.json"
# launchd is off on purpose here: its check warns; nothing else may.
run node "$here/smoke-linux/check.mjs" doctor "$home/doctor.json" --allow-warn "daemon service" && ok "doctor" || no "doctor ($home/doctor.json)"
run workmesh init "$hub" --no-open > "$home/reinit.log" 2>&1 && grep -q "already paired" "$home/reinit.log" && ! grep -q "pairing code" "$home/reinit.log" && ok "init again: pairing kept" || no "init again ($home/reinit.log)"
# The same hub under another address (localhost for 127.0.0.1, as bullpen.b3os.org for workmesh.b3os.org): kept.
alias="$(printf '%s' "$hub" | sed -e 's#//127\.0\.0\.1:#//localhost:#' -e 't' -e 's#//localhost:#//127.0.0.1:#')"
run node "$here/smoke-linux/approve.mjs" "$home/alias.log" "$hub" "$email" 20 > /dev/null 2>&1 &
run workmesh init "$alias" --no-open > "$home/alias.log" 2>&1 && grep -q "pairing kept" "$home/alias.log" && ! grep -q "pairing code" "$home/alias.log" && ok "init at another address of the same hub: pairing kept" || no "alias ($home/alias.log)"
wait
run node "$here/smoke-linux/check.mjs" device "$hub" "$email" "$machine" --fresh 40 --count 1 && ok "still one device" || no "device count after alias"
# Paired again (--repair): the hub retires the older device, so the board still shows one machine.
run node "$here/smoke-linux/approve.mjs" "$home/repair.log" "$hub" "$email" 120 > /dev/null 2>&1 &
run workmesh init "$alias" --no-open --repair > "$home/repair.log" 2>&1 && grep -q "heard from this machine" "$home/repair.log" && ok "init --repair: paired again, heard" || no "repair ($home/repair.log)"
wait
run node "$here/smoke-linux/check.mjs" device "$hub" "$email" "$machine" --fresh 40 --count 1 && ok "re-paired: one device on the board (the old one superseded)" || no "device count after repair"
run workmesh stop > /dev/null
echo "macOS temp-HOME smoke: $pass passed, $failn failed (HOME $home)"
[ "$failn" = 0 ]

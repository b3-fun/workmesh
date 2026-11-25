#!/usr/bin/env bash
# Runs inside a smoke-test box as the unprivileged user `dev` (docker exec, or over SSH on the systemd box).
#   box.sh install <tgz>            npm i -g the packed CLI (user prefix), make ~/.claude
#   box.sh init <hub> <email> [..]  workmesh init <hub> --no-open --share conversation [..], approving the pairing
#                                   the way the board does (approve.mjs, local dev hubs only)
#   box.sh hook <session-id>        a fake Claude Code session in a shared repo (SessionStart, prompt, an Edit)
#   box.sh doctor                   workmesh doctor --json
set -euo pipefail
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"
cmd="${1:?usage: box.sh install|init|hook|doctor ...}"
shift

case "$cmd" in
  install)
    npm i -g --no-audit --no-fund --loglevel=error "$1" >/dev/null
    mkdir -p "$HOME/.claude"
    echo "installed $(workmesh --version) on node $(node --version)"
    ;;
  init)
    hub="$1"; email="$2"; shift 2
    log="/tmp/wm-init-$(date +%s%N).log"
    : > "$log"
    node "$here/approve.mjs" "$log" "$hub" "$email" 120 > "$log.approve" 2>&1 &
    approver=$!
    set +e
    workmesh init "$hub" --no-open --share conversation "$@" 2>&1 | tee "$log"
    status=${PIPESTATUS[0]}
    set -e
    # Already paired: no code to approve; the approver gives up on its own.
    if grep -q "pairing code" "$log"; then wait "$approver" || true; cat "$log.approve"; else kill "$approver" 2>/dev/null || true; fi
    exit "$status"
    ;;
  hook)
    sid="$1"
    repo="$HOME/src/smoke"
    mkdir -p "$repo/.git" "$repo/src"
    printf 'ref: refs/heads/main\n' > "$repo/.git/HEAD"
    printf '[remote "origin"]\n\turl = git@github.com:b3-fun/smoke.git\n' > "$repo/.git/config"
    send() { printf '%s' "$1" | workmesh hook claude-code >/dev/null; }
    send "{\"session_id\":\"$sid\",\"hook_event_name\":\"SessionStart\",\"cwd\":\"$repo\",\"source\":\"startup\"}"
    send "{\"session_id\":\"$sid\",\"hook_event_name\":\"UserPromptSubmit\",\"cwd\":\"$repo\",\"prompt\":\"smoke test: say hi\"}"
    send "{\"session_id\":\"$sid\",\"hook_event_name\":\"PreToolUse\",\"cwd\":\"$repo\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$repo/src/a.ts\"}}"
    echo "sent a fake Claude Code session $sid in $repo"
    ;;
  doctor)
    workmesh doctor --json || true
    ;;
  *)
    echo "unknown command $cmd" >&2
    exit 2
    ;;
esac

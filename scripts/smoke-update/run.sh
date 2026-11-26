#!/usr/bin/env bash
# The update path end to end on this Mac, without touching the real install (SPEC §41): its own HOME, npm prefix,
# config, state, Claude Code and Codex dirs, daemon port and launchd label; a local registry serving tarballs packed
# from this checkout (never published) and a local hub. Four releases: 0.12.0 (installed first), 0.12.1 (the update),
# 0.12.2 (a broken build whose daemon won't start: rolled back) and 0.12.3 (installed by the daemon on its own).
#
#   scripts/smoke-update/run.sh [<evidence dir>]
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cli="$repo/packages/cli"
out="${1:-$(mktemp -d "${TMPDIR:-/tmp}/wm-update-evidence.XXXXXX")}"
mkdir -p "$out"
H="$(mktemp -d "${TMPDIR:-/tmp}/wm-update-home.XXXXXX")"
LABEL="org.npclabs.workmesh.daemon.smoke-$(basename "$H" | tr -cd 'A-Za-z0-9')"
REG_PORT=48873
HUB_PORT=48797
PORT=46391
EMAIL="smoke@example.com"
node_bin="$(command -v node)"
npm_bin="$(command -v npm)"
uid="$(id -u)"

# The real daemon's job is per user, not per HOME: this run must never use its label.
[ "$LABEL" != "org.npclabs.workmesh.daemon" ] || { echo "refusing: test label equals the real one" >&2; exit 1; }
real_pid_before="$(launchctl print "gui/$uid/org.npclabs.workmesh.daemon" 2>/dev/null | awk '/^\tpid = /{print $3}')"

pass=0
failn=0
ok() { echo "PASS $1" | tee -a "$out/summary.txt"; pass=$((pass + 1)); }
no() { echo "FAIL $1" | tee -a "$out/summary.txt"; failn=$((failn + 1)); }
step() { printf '\n== %s\n' "$1" | tee -a "$out/summary.txt"; }
: > "$out/summary.txt"

# --- tarballs: one per version, packed from this checkout with only the version changed --------------------------
tarballs="$H/tarballs"
mkdir -p "$tarballs" "$H/bin" "$H/.claude" "$H/.codex" "$H/.config/workmesh"
cp "$cli/package.json" "$H/package.json.orig"
trap 'cp "$H/package.json.orig" "$cli/package.json"' EXIT
for v in 0.12.0 0.12.1 0.12.2 0.12.3; do
  node -e 'const f=process.argv[1],p=require(f);p.version=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$cli/package.json" "$v"
  (cd "$cli" && npm run build >/dev/null 2>&1) || { echo "build $v failed" >&2; exit 1; }
  if [ "$v" != 0.12.0 ]; then
    # Builds of one checkout give sessions the same tools, so the stale-session note would rightly stay quiet: mark
    # each later release's tool fingerprint as different, the way a release that adds a tool or hook would be.
    node -e 'const f=process.argv[1],fs=require("fs"),s=fs.readFileSync(f,"utf8"),w=JSON.stringify("Stop:wake");if(!s.includes(w))process.exit(1);fs.writeFileSync(f,s.replace(w,w+", "+JSON.stringify("smoke:"+process.argv[2])))' "$cli/dist/index.js" "$v" || { echo "surface marker $v failed" >&2; exit 1; }
  fi
  if [ "$v" = 0.12.2 ]; then
    # A bad release: the daemon exits at once. The CLI itself works, so only its checks can catch it.
    node -e 'const f=process.argv[1],s=require("fs").readFileSync(f,"utf8").split("\n");s.splice(1,0,"if (process.argv[2] === \"start\") { console.error(\"0.12.2: broken build, the daemon exits\"); process.exit(1); }");require("fs").writeFileSync(f,s.join("\n"))' "$cli/dist/index.js"
  fi
  (cd "$cli" && npm pack --pack-destination "$tarballs" >/dev/null 2>&1) || { echo "pack $v failed" >&2; exit 1; }
done
cp "$H/package.json.orig" "$cli/package.json"
(cd "$cli" && npm run build >/dev/null 2>&1)
ls "$tarballs" > "$out/tarballs.txt"

# --- the stand-ins ----------------------------------------------------------------------------------------------
node "$here/fake-registry.mjs" "$REG_PORT" "$tarballs"/*.tgz > "$out/registry.log" 2>&1 &
reg_pid=$!
FAKE_HUB_TEAM=1 node "$repo/scripts/smoke-linux/fake-hub.mjs" "$HUB_PORT" > "$out/hub.log" 2>&1 &
hub_pid=$!
sleep 1
hub="http://127.0.0.1:$HUB_PORT"
cleanup() {
  kill "$reg_pid" "$hub_pid" 2>/dev/null
  launchctl bootout "gui/$uid/$LABEL" 2>/dev/null
}
trap 'cleanup; cp "$H/package.json.orig" "$cli/package.json"' EXIT
latest() { curl -s -X POST -H 'content-type: application/json' -d "{\"version\":\"$1\"}" "http://127.0.0.1:$REG_PORT/_latest" >/dev/null; curl -s -X POST -H 'content-type: application/json' -d "{\"version\":\"$1\"}" "$hub/api/latest" >/dev/null; }

ln -s "$node_bin" "$H/bin/node"
ln -s "$npm_bin" "$H/bin/npm"
printf 'registry=http://127.0.0.1:%s/\nprefix=%s/npm-global\ncache=%s/npm-cache\nupdate-notifier=false\nfund=false\naudit=false\n' "$REG_PORT" "$H" "$H" > "$H/.npmrc"
# The daemon reads its port from config.json (launchd carries only the dirs): never the real daemon's 4519.
# The waiting time for new releases is off: every release in this run is minutes old, and the run can't wait a day.
printf '{"port": %s, "update": {"waitHours": 0}}\n' "$PORT" > "$H/.config/workmesh/config.json"

run() {
  env -i HOME="$H" USER="$USER" PATH="$H/npm-global/bin:$H/bin:/usr/bin:/bin:/usr/sbin:/sbin" TMPDIR="${TMPDIR:-/tmp}" \
    XDG_CONFIG_HOME="$H/.config" XDG_STATE_HOME="$H/.local/state" CLAUDE_CONFIG_DIR="$H/.claude" CODEX_HOME="$H/.codex" \
    WORKMESH_LAUNCHD_LABEL="$LABEL" NO_COLOR=1 "$@"
}
health() { curl -s "http://127.0.0.1:$PORT/health"; }
daemon_version() { health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version??"")}catch{console.log("")}})'; }
secret() { cat "$H/.local/state/workmesh/daemon.secret"; }
update_status() { curl -s -H "authorization: Bearer $(secret)" "http://127.0.0.1:$PORT/update"; }
hook() { printf '%s' "$1" | run workmesh hook claude-code; }
wait_version() { for _ in $(seq 1 60); do [ "$(daemon_version)" = "$1" ] && return 0; sleep 1; done; return 1; }

# --- 1. a teammate on 0.12.0 ------------------------------------------------------------------------------------
step "install 0.12.0 and init"
run npm i -g @b3os/workmesh@0.12.0 > "$out/01-npm-install.log" 2>&1
[ "$(run workmesh --version)" = 0.12.0 ] && ok "npm i -g @b3os/workmesh@0.12.0 (temp prefix, local registry)" || no "install 0.12.0"
run node "$repo/scripts/smoke-linux/approve.mjs" "$out/02-init.log" "$hub" "$EMAIL" 120 > "$out/02-approve.log" 2>&1 &
approve_pid=$!
run workmesh init "$hub" --no-open --share metadata > "$out/02-init.log" 2>&1
wait "$approve_pid"
grep -q "heard from this machine" "$out/02-init.log" && ok "init: hooks, MCP, launchd ($LABEL), paired" || no "init ($out/02-init.log)"
launchctl print "gui/$uid/$LABEL" > "$out/02-launchd.txt" 2>&1 && ok "the daemon runs under the test label" || no "launchd job"
[ "$(daemon_version)" = 0.12.0 ] && ok "daemon /health says 0.12.0" || no "daemon version $(daemon_version)"

# A Claude Code session that started under 0.12.0.
mkdir -p "$H/src/smoke"
hook "{\"session_id\":\"s-old\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\",\"cwd\":\"$H/src/smoke\"}" > "$out/03-s-old-start.json"
run workmesh update --check > "$out/03-check-current.log" 2>&1
grep -q "up to date" "$out/03-check-current.log" && ok "update --check: up to date" || no "check current ($out/03-check-current.log)"
run workmesh update > "$out/03-update-noop.log" 2>&1
grep -q "is up to date" "$out/03-update-noop.log" && ok "update with nothing out: changes nothing" || no "noop ($out/03-update-noop.log)"

# --- 2. 0.12.1 is out: notices -----------------------------------------------------------------------------------
step "0.12.1 released"
latest 0.12.1
# The daemon reads the team view every 60 s (15 s with the menu open); restart is not needed: wait for it.
# (Its first look, a minute after start, may already have asked npm: the hub had no latestClient then.)
for _ in $(seq 1 90); do update_status | grep -q '"source":"hub"' && break; sleep 1; done
update_status > "$out/04-get-update.json"
grep -q '"latest":"0.12.1"' "$out/04-get-update.json" && grep -q '"available":true' "$out/04-get-update.json" && ok "GET /update: 0.12.1 available" || no "GET /update ($out/04-get-update.json)"
grep -q '"source":"hub"' "$out/04-get-update.json" && ok "…read from the hub's latestClient" || no "source not the hub ($out/04-get-update.json)"
# Since 0.12.1 came out nothing but the daemon has asked the registry (the CLI's reads came before).
n=$(sed -n '/latest -> 0.12.1/,$p' "$out/registry.log" | grep -c "GET /@b3os")
[ "$n" -le 1 ] && ok "the daemon asked npm at most once ($n read)" || no "the daemon's registry reads: $n"
grep -q '"run":\[' "$out/04-get-update.json" && ok "GET /update carries the argv the menu bar runs" || no "run argv"
run workmesh status > "$out/04-status.log" 2>&1
grep -q "0.12.1 available: \`workmesh update\`" "$out/04-status.log" && ok "status: 0.12.1 available: \`workmesh update\`" || no "status notice ($out/04-status.log)"
run workmesh doctor > "$out/04-doctor.log" 2>&1
grep -q "0.12.1 available" "$out/04-doctor.log" && ok "doctor: the same notice" || no "doctor notice ($out/04-doctor.log)"

# --- 3. workmesh update ------------------------------------------------------------------------------------------
step "workmesh update → 0.12.1"
run workmesh update > "$out/05-update.log" 2>&1
code=$?
[ $code = 0 ] && grep -q "Workmesh 0.12.1 is installed and running" "$out/05-update.log" && ok "update: installed 0.12.1, set up, daemon restarted (exit 0)" || no "update exit $code ($out/05-update.log)"
[ "$(run workmesh --version)" = 0.12.1 ] && ok "workmesh --version: 0.12.1" || no "cli version"
wait_version 0.12.1 && ok "daemon /health: 0.12.1 (under launchd)" || no "daemon after update $(daemon_version)"
cp "$H/.local/state/workmesh/update.json" "$out/05-update-state.json" 2>/dev/null

step "stale sessions"
hook "{\"session_id\":\"s-old\",\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$H/src/smoke/a\"},\"cwd\":\"$H/src/smoke\"}" > "$out/06-s-old-hook1.json"
hook "{\"session_id\":\"s-old\",\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$H/src/smoke/a\"},\"cwd\":\"$H/src/smoke\"}" > "$out/06-s-old-hook2.json"
grep -q "Workmesh was updated to 0.12.1" "$out/06-s-old-hook1.json" && ok "the old session's next hook says it, once" || no "stale note ($out/06-s-old-hook1.json)"
! grep -q "updated to" "$out/06-s-old-hook2.json" && ok "…and not again" || no "note repeated"
hook "{\"session_id\":\"s-new\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\",\"cwd\":\"$H/src/smoke\"}" > "$out/06-s-new-start.json"
hook "{\"session_id\":\"s-new\",\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$H/src/smoke/a\"},\"cwd\":\"$H/src/smoke\"}" > "$out/06-s-new-hook.json"
! grep -q "updated to" "$out/06-s-new-hook.json" && ok "a session started on 0.12.1 hears nothing" || no "new session got a note"

run workmesh update > "$out/07-update-again.log" 2>&1
grep -q "0.12.1 is up to date" "$out/07-update-again.log" && ok "update again: up to date, nothing changed" || no "rerun ($out/07-update-again.log)"

# --- 4. a broken release: rollback ---------------------------------------------------------------------------------
step "0.12.2 (broken) → rollback"
latest 0.12.2
run workmesh update > "$out/08-update-broken.log" 2>&1
code=$?
[ $code = 1 ] && grep -q "Rolled back: Workmesh 0.12.1 is running again" "$out/08-update-broken.log" && ok "0.12.2 failed its checks: rolled back (exit 1)" || no "rollback exit $code ($out/08-update-broken.log)"
[ "$(run workmesh --version)" = 0.12.1 ] && ok "workmesh --version: 0.12.1 again" || no "cli after rollback $(run workmesh --version)"
wait_version 0.12.1 && ok "daemon /health: 0.12.1 again" || no "daemon after rollback $(daemon_version)"
cp "$H/.local/state/workmesh/update.json" "$out/08-update-state.json" 2>/dev/null
grep -q '"rolledBack":true' "$out/08-update-state.json" && ok "update.json records the rollback" || no "rollback record"

# --- 5. auto-update ------------------------------------------------------------------------------------------------
step "auto-update (0.12.3)"
run workmesh update --auto on > "$out/09-auto-on.log" 2>&1
latest 0.12.3
# The daemon's first look comes a minute after it starts; a restart makes that the next minute.
run workmesh restart > "$out/09-restart.log" 2>&1
for _ in $(seq 1 180); do [ "$(daemon_version)" = 0.12.3 ] && break; sleep 2; done
[ "$(daemon_version)" = 0.12.3 ] && ok "the daemon updated itself to 0.12.3 (patch scope) and came back under launchd" || no "auto-update ($(daemon_version))"
cp "$H/.local/state/workmesh/update.log" "$out/09-auto-update.log" 2>/dev/null
cp "$H/.local/state/workmesh/update.json" "$out/09-update-state.json" 2>/dev/null
grep -q '"auto":true' "$out/09-update-state.json" && ok "update.json: the run was the daemon's" || no "auto record"

# --- cleanup -----------------------------------------------------------------------------------------------------
step "cleanup"
run workmesh uninstall > "$out/10-uninstall.log" 2>&1
launchctl print "gui/$uid/$LABEL" > /dev/null 2>&1 && no "test job still loaded" || ok "test launchd job removed"
kill "$reg_pid" "$hub_pid" 2>/dev/null
real_pid_after="$(launchctl print "gui/$uid/org.npclabs.workmesh.daemon" 2>/dev/null | awk '/^\tpid = /{print $3}')"
[ "$real_pid_before" = "$real_pid_after" ] && ok "the real daemon's job was never touched (pid ${real_pid_after:-none})" || no "real daemon pid changed: $real_pid_before -> $real_pid_after"
echo "update smoke: $pass passed, $failn failed (HOME $H, evidence $out)" | tee -a "$out/summary.txt"
[ "$failn" = 0 ]

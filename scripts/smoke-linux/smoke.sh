#!/usr/bin/env bash
# Linux onboarding smoke test: `workmesh init` on fresh Linux boxes in Docker, against a hub.
#
#   scripts/smoke-linux/smoke.sh [--hub-port 8797] [--fake-hub] [--tgz <file>] [--nodes "20 22 24"] [--no-systemd] [--no-plain]
#
# Boxes:
#   plain-<node>   node:<node>-bookworm-slim, no systemd or logind (a container, WSL without systemd, a minimal VM):
#                  the daemon runs detached and must outlive the shell that ran `init`.
#   systemd-22     systemd as PID 1, logind, sshd: every step runs over SSH as on a real server, so logging out is
#                  real. Lingering must keep the daemon (and the board's presence) after logout.
#
# Hub: by default the hub you run on this machine (workmesh-cloud: `wrangler dev --port <hub-port>` with DEV_USER_EMAIL
# in .dev.vars); boxes reach it through a proxy on their own 127.0.0.1, since the CLI takes http:// only for a local
# hub. Pairings are approved the way the board does (POST /api/pair/approve); a run pairs one machine per box, and the
# hub allows 10 pairing starts per IP per hour, so start the dev hub with a fresh `--persist-to` dir between runs.
# `--fake-hub` runs scripts/smoke-linux/
# fake-hub.mjs inside each box instead (CI; no leases or team view, so doctor's coordination checks may warn).
#
# Checks per box: init exits 0 and hears from the hub; the device is online on the hub with no sessions after the
# shell that ran init ended; a fake Claude Code hook event makes a session on the hub; `doctor --json` has no
# failures (no warnings with a real hub); `init` again is clean (no new pairing, one device). systemd box also:
# lingering on, the daemon survives logout, and without lingering it stops at logout (documented, then restored).
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
port=8797
fake=0
tgz=""
nodes="20 22 24"
plain=1
systemd=1
while [ $# -gt 0 ]; do
  case "$1" in
    --hub-port) port="$2"; shift 2 ;;
    --fake-hub) fake=1; shift ;;
    --tgz) tgz="$2"; shift 2 ;;
    --nodes) nodes="$2"; shift 2 ;;
    --no-systemd) systemd=0; shift ;;
    --no-plain) plain=0; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

work="$(mktemp -d "${TMPDIR:-/tmp}/wm-smoke.XXXXXX")"
# People are new each run (the hub keeps devices; a machine paired again by the same person supersedes the old one).
run_id="$(date +%H%M%S)"
results="$work/results"
: > "$results"
echo "smoke: logs in $work"

if [ -z "$tgz" ]; then
  (cd "$repo" && npm run build -w @b3os/workmesh >/dev/null 2>&1) || { echo "build failed" >&2; exit 1; }
  (cd "$repo/packages/cli" && npm pack --silent --pack-destination "$work" >/dev/null) || { echo "npm pack failed" >&2; exit 1; }
  tgz="$(ls "$work"/b3os-workmesh-*.tgz)"
fi
cp "$tgz" "$work/workmesh.tgz"
version="$(tar -xOzf "$work/workmesh.tgz" package/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
echo "smoke: @b3os/workmesh $version"

hub="http://127.0.0.1:$port"
add_host=()
[ "$(uname -s)" = "Linux" ] && add_host=(--add-host=host.docker.internal:host-gateway)
if [ "$fake" = 0 ] && ! curl -s -o /dev/null -X POST "$hub/relay/pair/start" -H 'content-type: application/json' -d '{}'; then
  echo "no hub answers on $hub: start one (wrangler dev --port $port) or pass --fake-hub" >&2
  exit 1
fi

pass() { echo "PASS $1: $2" | tee -a "$results"; }
fail() { echo "FAIL $1: $2" | tee -a "$results"; }

# Runs a check inside the box (node check.mjs …); records it.
check() {
  local box="$1" label="$2"; shift 2
  local out
  if out="$(docker exec "$box" node /smoke/check.mjs "$@" 2>&1)"; then pass "$box" "$label: ${out##*ok   }"; else fail "$box" "$label: $out"; fi
}

# The hub inside the box: a proxy to this machine's hub, or the fake hub.
box_hub() {
  local box="$1"
  if [ "$fake" = 1 ]; then
    docker exec -d "$box" node /smoke/fake-hub.mjs "$port"
  else
    docker exec -d "$box" node /smoke/hub-proxy.mjs "$port" host.docker.internal
  fi
  for _ in $(seq 1 20); do
    docker exec "$box" node -e "fetch('$hub/relay/pair/start',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null && return 0
    sleep 0.5
  done
  return 1
}

doctor_allow=""
[ "$fake" = 1 ] && doctor_allow="coordination,delegation"

plain_box() {
  local node="$1" box="wm-smoke-plain-$1" email="plain$1-$run_id@example.com" log="$work/plain-$1.log"
  {
    docker build -q -f "$here/Dockerfile.plain" --build-arg NODE="$node" -t "wm-smoke-plain:$node" "$here" >/dev/null || { fail "$box" "image build"; return; }
    docker rm -f "$box" >/dev/null 2>&1
    docker run -d --name "$box" --hostname "$box" "${add_host[@]}" -v "$here:/smoke:ro" -v "$work/workmesh.tgz:/pkg/workmesh.tgz:ro" "wm-smoke-plain:$node" >/dev/null
    box_hub "$box" || { fail "$box" "hub not reachable from the box"; return; }
    docker exec -u dev "$box" /smoke/box.sh install /pkg/workmesh.tgz
    if docker exec -u dev "$box" /smoke/box.sh init "$hub" "$email" > "$work/$box-init.txt" 2>&1 && grep -q "heard from this machine" "$work/$box-init.txt"; then
      pass "$box" "init: paired, daemon detached, the hub heard from it"
    else
      fail "$box" "init (see $work/$box-init.txt)"
    fi
    # The shell that ran init is gone; the daemon must keep heartbeating with no agents.
    sleep 45
    check "$box" "online with no agents, 45 s after the init shell ended" device "$hub" "$email" "$box" --fresh 40 --count 1
    docker exec -u dev "$box" /smoke/box.sh hook "smoke-$node" >/dev/null
    sleep 3
    check "$box" "a Claude Code hook event makes a session" session "$hub" "$email" "$box" "smoke-$node"
    docker exec -u dev "$box" /smoke/box.sh doctor > "$work/$box-doctor.json"
    docker cp "$work/$box-doctor.json" "$box:/tmp/doctor.json" >/dev/null
    check "$box" "doctor" doctor /tmp/doctor.json --allow-warn "$doctor_allow"
    if docker exec -u dev "$box" /smoke/box.sh init "$hub" "$email" > "$work/$box-reinit.txt" 2>&1 && grep -q "already paired" "$work/$box-reinit.txt" && ! grep -q "pairing code" "$work/$box-reinit.txt"; then
      pass "$box" "init again: pairing kept, no new code"
    else
      fail "$box" "init again (see $work/$box-reinit.txt)"
    fi
    check "$box" "still one device, online" device "$hub" "$email" "$box" --fresh 40 --count 1
    docker rm -f "$box" >/dev/null 2>&1
  } > "$log" 2>&1
}

ssh_dev() { docker exec "$1" ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o LogLevel=ERROR dev@127.0.0.1 "${@:2}"; }

systemd_box() {
  local box="wm-smoke-systemd" email="systemd-$run_id@example.com" log="$work/systemd.log"
  {
    docker build -q -f "$here/Dockerfile.systemd" --build-arg NODE=22 -t wm-smoke-systemd:22 "$here" >/dev/null || { fail "$box" "image build"; return; }
    docker rm -f "$box" >/dev/null 2>&1
    docker run -d --name "$box" --hostname "$box" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
      --tmpfs /run --tmpfs /run/lock "${add_host[@]}" -v "$here:/smoke:ro" -v "$work/workmesh.tgz:/pkg/workmesh.tgz:ro" wm-smoke-systemd:22 >/dev/null
    for _ in $(seq 1 30); do docker exec "$box" systemctl is-system-running 2>/dev/null | grep -qE "running|degraded" && break; sleep 1; done
    docker exec "$box" bash -c 'ssh-keygen -q -t ed25519 -N "" -f /root/.ssh/id_ed25519 <<<y >/dev/null 2>&1; install -m 600 -o dev -g dev /root/.ssh/id_ed25519.pub /home/dev/.ssh/authorized_keys'
    box_hub "$box" || { fail "$box" "hub not reachable from the box"; return; }
    ssh_dev "$box" /smoke/box.sh install /pkg/workmesh.tgz
    if ssh_dev "$box" /smoke/box.sh init "$hub" "$email" > "$work/$box-init.txt" 2>&1 && grep -q "heard from this machine" "$work/$box-init.txt" && grep -q "lingering: on" "$work/$box-init.txt"; then
      pass "$box" "init over SSH: lingering turned on, systemd --user service, the hub heard from it"
    else
      fail "$box" "init over SSH (see $work/$box-init.txt)"
    fi
    # Logged out (the SSH session ended): systemd keeps the user's services only because of lingering. Nothing here
    # logs in until the hub has been checked (a login would start the user's services again).
    sleep 45
    check "$box" "logged out 45 s ago: still online with no agents" device "$hub" "$email" "$box" --fresh 40 --count 1
    if docker exec "$box" loginctl list-sessions --no-legend | grep -q " dev "; then fail "$box" "dev still has a login session"; fi
    if docker exec "$box" pgrep -u dev -f "index.js start" >/dev/null; then pass "$box" "logged out 45 s ago: the daemon still runs (lingering)"; else fail "$box" "logged out: the daemon is gone"; fi
    ssh_dev "$box" /smoke/box.sh hook smoke-systemd >/dev/null
    sleep 3
    check "$box" "a Claude Code hook event makes a session" session "$hub" "$email" "$box" smoke-systemd
    ssh_dev "$box" /smoke/box.sh doctor > "$work/$box-doctor.json"
    docker cp "$work/$box-doctor.json" "$box:/tmp/doctor.json" >/dev/null
    check "$box" "doctor" doctor /tmp/doctor.json --allow-warn "$doctor_allow"
    if ssh_dev "$box" /smoke/box.sh init "$hub" "$email" > "$work/$box-reinit.txt" 2>&1 && grep -q "already paired" "$work/$box-reinit.txt" && ! grep -q "pairing code" "$work/$box-reinit.txt"; then
      pass "$box" "init again: pairing kept, no new code"
    else
      fail "$box" "init again (see $work/$box-reinit.txt)"
    fi

    # A minimal Debian box (no polkit, lingering off): what 0.10.0 and 0.11.0 left behind on Mitch's b3-box.
    docker exec "$box" bash -c 'loginctl disable-linger dev; systemctl mask --now polkit.service >/dev/null 2>&1'
    ssh_dev "$box" /smoke/box.sh doctor > "$work/$box-doctor-nolinger.json"
    if grep -q '"name": "logout"' "$work/$box-doctor-nolinger.json" && grep -q 'enable-linger' "$work/$box-doctor-nolinger.json"; then
      pass "$box" "doctor without lingering names it with the fix"
    else
      fail "$box" "doctor without lingering (see $work/$box-doctor-nolinger.json)"
    fi
    sleep 20
    if docker exec "$box" pgrep -u dev -f "index.js start" >/dev/null; then
      fail "$box" "without lingering the daemon still runs 20 s after logout (expected systemd to stop it)"
    else
      pass "$box" "without lingering, systemd stopped the daemon at logout (Mitch's offline case)"
    fi
    ssh_dev "$box" /smoke/box.sh init "$hub" "$email" > "$work/$box-nopolkit.txt" 2>&1
    if grep -q "lingering: off" "$work/$box-nopolkit.txt" && grep -q "sudo loginctl enable-linger" "$work/$box-nopolkit.txt" && grep -q "once you log out" "$work/$box-nopolkit.txt"; then
      pass "$box" "init where only an admin may linger: says so, with the sudo fix, twice"
    else
      fail "$box" "init without polkit (see $work/$box-nopolkit.txt)"
    fi
    # The person runs the fix (as root here), then logs in once more and out.
    docker exec "$box" loginctl enable-linger dev
    ssh_dev "$box" /smoke/box.sh doctor > "$work/$box-doctor-fixed.json"
    sleep 45
    check "$box" "after the sudo fix: online 45 s after logout" device "$hub" "$email" "$box" --fresh 40 --count 1
    docker rm -f "$box" >/dev/null 2>&1
  } > "$log" 2>&1
}

pids=()
if [ "$plain" = 1 ]; then
  for n in $nodes; do plain_box "$n" & pids+=($!); done
fi
if [ "$systemd" = 1 ]; then systemd_box & pids+=($!); fi
for p in "${pids[@]}"; do wait "$p"; done

echo
sort "$results"
if grep -q '^FAIL' "$results"; then
  # CI has no shell to look around in: show the failing boxes' logs.
  for box in $(grep '^FAIL' "$results" | sed -E 's/^FAIL ([^:]+):.*/\1/' | sort -u); do
    for f in "$work/$box"-*.txt; do [ -f "$f" ] && { echo "--- $f"; tail -40 "$f"; }; done
    docker logs "$box" 2>/dev/null | tail -20
  done
  echo "smoke: FAILED (logs in $work)"
  exit 1
fi
echo "smoke: all passed ($(grep -c '^PASS' "$results") checks, @b3os/workmesh $version)"

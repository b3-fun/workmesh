#!/usr/bin/env bash
# The menu bar app's self-update against throwaway copies of the app, headless:
# no menu bar item, no window, no app activation, nothing on screen.
#
#   scripts/test-self-update.sh                  # every case
#   scripts/test-self-update.sh clean readonly   # some of them
#   KEEP=1 scripts/test-self-update.sh           # keep the temp folder to look at
#
# It builds the app at 0.0.1 to 0.0.4 under a test bundle id (make-app.sh, ad hoc
# sealed), makes the release zip each case calls for, and for each update serves
# that zip from scripts/mock-daemon.mjs (its own port and XDG folders) and runs
# the older copy's binary with WORKMESH_DEV_SELF_UPDATE_URL/_SHA256/_VERSION.
# That is the menu's own update (AppSelfUpdate.install: download, SHA-256
# check, unpack, quarantine, rollback copy, swap), minus the window and the
# relaunch. Each update then checks that:
#
#   - it exited 0 and the app at the temp path is the new version,
#   - the new app's program starts (`Workmesh --version`, which exits before AppKit),
#   - nothing in the new app carries com.apple.quarantine (Gatekeeper only
#     assesses a quarantined app, so an unflagged one opens without a prompt),
#   - every item keeps the mode it had in the zip (the app folder keeps the old app's),
#   - its ad hoc seal still verifies (codesign --verify --deep --strict), as it does in
#     the zip unpacked with its quarantine flags,
#   - the old app is the one rollback copy, byte for byte, modes and seal intact,
#     with nothing else left in its folder, next to the app or in TemporaryItems.
#
# Cases:
#   clean     make-app.sh ZIP=1 from a local build: no quarantine flag anywhere
#   inner     zipped with ditto from a quarantined copy: the items inside carry the
#             flag (ditto stores theirs, not the .app folder's own)
#   top       only the Workmesh.app folder itself carries the flag (._Workmesh.app)
#   readonly  like inner, with every file and folder read-only; then 0.0.3 and 0.0.4
#             from that app (its read-only items become the rollback copy, then go)
#   twice     clean, then clean again: two updates in a row
#   stale     an update over a rollback folder left in a bad state: a partial copy,
#             a read-only one, a file in its place, and leftovers of a run that stopped
#             halfway (incoming/old folders, a read-only .Workmesh.app.replaced)
# and a first install as getting-started.md says: curl + ditto -x has no flag.
#
# Never touches an installed Workmesh: test bundle id, temp folders, its own mock
# daemon, and it stops only processes it started (by pid). The test bundle id keeps
# its rollback copy in ~/Library/Application Support/org.npclabs.workmesh.menubar.selfupdatetest/,
# removed at the end.
set -euo pipefail

cd "$(dirname "$0")/.."
MENUBAR="$PWD"

[ "$(uname -s)" = "Darwin" ] || { echo "macOS only" >&2; exit 2; }

TEST_ID="org.npclabs.workmesh.menubar.selfupdatetest"
SUPPORT="$HOME/Library/Application Support/$TEST_ID"
PREVIOUS="$SUPPORT/menubar-previous"
CASES=("$@")
[ ${#CASES[@]} -gt 0 ] || CASES=(clean inner top readonly twice stale)
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/workmesh-selfupdate.XXXXXX")"
ROOT="$(cd "$ROOT" && pwd -P)"
TEMPITEMS="$(cd "${TMPDIR:-/tmp}" && pwd -P)/TemporaryItems"
QTN="0081;$(printf %x "$(date +%s)");Chrome;$(uuidgen)" # what Chrome writes on a download
PORT_BASE=$((45300 + RANDOM % 500))
PORT_N=0
FAILS=0
MOCK_PID=""

say() { printf '%s\n' "$*"; }
pass() { say "  ok    $*"; }
fail() { say "  FAIL  $*"; FAILS=$((FAILS + 1)); }
next_port() { PORT_N=$((PORT_N + 1)); printf '%s' $((PORT_BASE + PORT_N)); }

# Stops a process this script started, after checking the pid is still that process.
stop_pid() { # <pid> <text its command line has>
  [ -n "$1" ] || return 0
  if ps -p "$1" -o command= 2>/dev/null | grep -q -F -- "$2"; then kill "$1" 2>/dev/null || true; fi
  wait "$1" 2>/dev/null || true
}
stop_mock() { stop_pid "$MOCK_PID" mock-daemon.mjs; MOCK_PID=""; }
# Read-only folders can't be emptied; make them writable first.
rm_tree() { [ -e "$1" ] || [ -L "$1" ] || return 0; chmod -R u+w "$1" 2>/dev/null || true; rm -rf "$1"; }
cleanup() {
  stop_mock
  rm_tree "$SUPPORT"
  if [ "${KEEP:-}" = "1" ]; then say "kept $ROOT"; else rm_tree "$ROOT"; fi
}
trap cleanup EXIT

# Runs a command in the background with a time limit; its output goes to <log>.
run_limited() { # <seconds> <log> <command...>
  local secs="$1" log="$2"; shift 2
  "$@" >"$log" 2>&1 &
  local pid=$! i=0
  while kill -0 "$pid" 2>/dev/null && [ $i -lt $((secs * 5)) ]; do sleep 0.2; i=$((i + 1)); done
  if kill -0 "$pid" 2>/dev/null; then stop_pid "$pid" "${@: -1}"; echo "(timed out after ${secs}s)" >>"$log"; return 124; fi
  wait "$pid"
}

# Items in an app carrying the quarantine flag, relative to the app.
quarantined() {
  [ -e "$1" ] || return 0
  (cd "$1" && find . -print0 | while IFS= read -r -d '' f; do
    xattr -s -p com.apple.quarantine "$f" >/dev/null 2>&1 && printf '%s\n' "$f"
  done) || true
}
count() { if [ -z "$1" ]; then echo 0; else printf '%s\n' "$1" | wc -l | tr -d ' '; fi; }
# "mode path" for every item, the app folder as ".".
modes() { (cd "$1" && find . -print0 | xargs -0 stat -f '%Lp %N' | sort -k2); }
version_of() { /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$1/Contents/Info.plist" 2>/dev/null || echo "?"; }
binary_hash() { shasum -a 256 "$1/Contents/MacOS/Workmesh" 2>/dev/null | cut -d' ' -f1; }
sealed() { codesign --verify --deep --strict "$1" >/dev/null 2>&1; }
staging_dirs() { find "$TEMPITEMS" -maxdepth 1 -name '*Workmesh*' 2>/dev/null | sort || true; }

# ------------------------------------------------------------------ builds

say "macOS $(sw_vers -productVersion) ($(sw_vers -buildVersion)), Gatekeeper: $(spctl --status 2>&1)"
say "temp folder $ROOT"
say "building 0.0.1 to 0.0.4 as $TEST_ID"
for v in 0.0.1 0.0.2 0.0.3 0.0.4; do
  OUT="$ROOT/build/$v" BUNDLE_ID="$TEST_ID" ZIP=1 ./scripts/make-app.sh "$v" >"$ROOT/build-$v.log" 2>&1 ||
    { cat "$ROOT/build-$v.log"; exit 1; }
done
A2="$ROOT/build/0.0.2/Workmesh.app"
say "codesign -dv: $(codesign -dv "$A2" 2>&1 | grep -E '^(Signature|Info.plist|Sealed Resources)' | tr '\n' ' ')"
sealed "$A2" && pass "the build's seal verifies (codesign --verify --deep --strict)" || fail "the build's seal doesn't verify"
say "spctl --assess --type execute: $(spctl --assess --type execute "$A2" 2>&1 | sed "s|$ROOT|<tmp>|") (ad hoc, not notarized: rejected is expected)"

# ------------------------------------------------------------------ zips

flag_all() { find "$1" -exec xattr -w com.apple.quarantine "$QTN" {} \; ; }
make_zip() { # <case> -> $ROOT/zips/<case>.zip, from 0.0.2
  local c="$1" src="$ROOT/src/$1"
  mkdir -p "$src" "$ROOT/zips"
  ditto "$A2" "$src/Workmesh.app"
  case "$c" in
    clean|twice|stale) cp "$ROOT/build/0.0.2/Workmesh-menubar-macos.zip" "$ROOT/zips/$c.zip"; return ;;
    inner) flag_all "$src/Workmesh.app"
           (cd "$src" && ditto -c -k --keepParent Workmesh.app "$ROOT/zips/inner.zip") ;;
    top)   xattr -w com.apple.quarantine "$QTN" "$src/Workmesh.app"
           (cd "$src" && ditto -c -k . "$ROOT/zips/top.zip") ;;
    readonly)
           flag_all "$src/Workmesh.app"
           find "$src/Workmesh.app" -type f -exec chmod a-w {} \;
           find "$src/Workmesh.app" -depth -type d -exec chmod 555 {} \;
           (cd "$src" && ditto -c -k --keepParent Workmesh.app "$ROOT/zips/readonly.zip") ;;
    *) say "unknown case $c"; exit 2 ;;
  esac
}

start_mock() { # <dir> <port> <version> <zip>
  mkdir -p "$1/xdg/config" "$1/xdg/state"
  XDG_CONFIG_HOME="$1/xdg/config" XDG_STATE_HOME="$1/xdg/state" \
    node "$MENUBAR/scripts/mock-daemon.mjs" --port "$2" --scenario update-menubar \
    --menubar-version "$3" --menubar-zip "$4" >"$1/mock-$2.log" 2>&1 &
  MOCK_PID=$!
  local i=0
  until curl -sf "http://127.0.0.1:$2/health" >/dev/null 2>&1; do
    sleep 0.2; i=$((i + 1)); [ $i -lt 50 ] || { cat "$1/mock-$2.log"; return 1; }
  done
}

# ------------------------------------------------------------------ one update

# The app at <app> replaces itself with <to> from <zip>; then the checks above.
update_once() { # <label> <dir> <app> <to> <zip>
  local label="$1" d="$2" app="$3" to="$4" zip="$5"
  local from; from="$(version_of "$app")"
  local log="$d/update-$from-to-$to.log" port; port="$(next_port)"
  local old_hash old_modes old_root_mode old_sealed=no
  old_hash="$(binary_hash "$app")"; old_modes="$(modes "$app")"; old_root_mode="$(stat -f '%Lp' "$app")"
  sealed "$app" && old_sealed=yes

  # The zip as the updater's `ditto -x -k` unpacks it: the reference for modes.
  local ref="$ROOT/ref/$label-$to"
  rm_tree "$ref"; mkdir -p "$ref"; ditto -x -k "$zip" "$ref"
  local zq; zq="$(quarantined "$ref/Workmesh.app")"
  say "  $from → $to: the zip unpacks with $(count "$zq") of $(find "$ref/Workmesh.app" | wc -l | tr -d ' ') items quarantined"
  sealed "$ref/Workmesh.app" && pass "the zip's app, unpacked with its flags, keeps a valid seal" ||
    fail "the zip's app doesn't verify once unpacked"

  local staged_before; staged_before="$(staging_dirs)"
  start_mock "$d" "$port" "$to" "$zip"
  local rc=0
  run_limited 60 "$log" env XDG_CONFIG_HOME="$d/xdg/config" XDG_STATE_HOME="$d/xdg/state" \
    WORKMESH_DEV_SELF_UPDATE_URL="http://127.0.0.1:$port/mock/Workmesh-menubar-macos.zip" \
    WORKMESH_DEV_SELF_UPDATE_SHA256="$(shasum -a 256 "$zip" | cut -d' ' -f1)" \
    WORKMESH_DEV_SELF_UPDATE_VERSION="$to" "$app/Contents/MacOS/Workmesh" || rc=$?
  stop_mock
  sed "s|$ROOT|<tmp>|g; s|$HOME|~|g; s/^/        | /" "$log"

  if [ "$rc" = 0 ] && grep -q "^Replaced " "$log"; then pass "replaced (exit 0)"; else fail "not replaced (exit $rc)"; fi
  local now; now="$(version_of "$app")"
  [ "$now" = "$to" ] && pass "the app at the temp path is $to" || fail "the app at the temp path is $now, not $to"
  local out; out="$("$app/Contents/MacOS/Workmesh" --version 2>&1 || true)"
  [ "$out" = "$to" ] && pass "its program starts: --version prints $out" || fail "--version printed: $out"

  local q; q="$(quarantined "$app")"
  [ -z "$q" ] && pass "no quarantine flag on any item" || fail "quarantine flag left on: $(echo $q)"

  local want got
  want="$(modes "$ref/Workmesh.app" | sed "s|^[0-7]* \.\$|$old_root_mode .|")"
  got="$(modes "$app")"
  if [ "$want" = "$got" ]; then pass "modes as in the zip ($(echo "$got" | awk '{print $1}' | sort -u | tr '\n' ' '| sed 's/ $//'))"
  else fail "modes differ from the zip:"; diff <(echo "$want") <(echo "$got") | sed 's/^/        /' || true; fi

  sealed "$app" && pass "seal still verifies after the swap" || fail "seal broken after the swap: $(codesign --verify --deep --strict "$app" 2>&1 | tail -1)"

  local prev="$PREVIOUS/Workmesh.app"
  if [ -d "$prev" ] && [ "$(version_of "$prev")" = "$from" ] && [ "$(binary_hash "$prev")" = "$old_hash" ] &&
     [ "$(modes "$prev")" = "$old_modes" ]; then
    pass "rollback copy is $from, same bytes and modes"
  else
    fail "rollback copy isn't the old app (found $(version_of "$prev") in ${prev/#$HOME/~})"
  fi
  if [ "$old_sealed" = yes ]; then
    sealed "$prev" && pass "rollback copy's seal verifies" || fail "rollback copy's seal broken"
  fi
  local extra; extra="$(ls -A "$PREVIOUS" 2>/dev/null | grep -v '^Workmesh.app$' || true; ls -A "$SUPPORT" | grep -v '^menubar-previous$' || true)"
  [ -z "$extra" ] && pass "one rollback copy, nothing else in ${SUPPORT/#$HOME/~}" || fail "left beside it: $(echo $extra)"
  local beside; beside="$(ls -A "$(dirname "$app")" | grep -v '^Workmesh.app$' || true)"
  [ -z "$beside" ] && pass "nothing left next to the app" || fail "left next to the app: $(echo $beside)"
  local staged_after; staged_after="$(staging_dirs)"
  [ "$staged_after" = "$staged_before" ] && pass "staging folder removed" || fail "left in TemporaryItems: $(comm -13 <(echo "$staged_before") <(echo "$staged_after") | tr '\n' ' ')"
}

# A fresh copy of 0.0.1 for a case, with an empty rollback folder.
fresh_case() { # <case> -> prints the app path
  local d="$ROOT/case-$1"
  mkdir -p "$d/app"
  ditto "$ROOT/build/0.0.1/Workmesh.app" "$d/app/Workmesh.app"
  printf '%s' "$d/app/Workmesh.app"
}

# ------------------------------------------------------------------ cases

for c in "${CASES[@]}"; do
  say ""
  say "== $c"
  rm_tree "$SUPPORT"
  make_zip "$c"
  d="$ROOT/case-$c"
  app="$(fresh_case "$c")"
  case "$c" in
    readonly)
      update_once "$c" "$d" "$app" 0.0.2 "$ROOT/zips/readonly.zip"
      update_once "$c" "$d" "$app" 0.0.3 "$ROOT/build/0.0.3/Workmesh-menubar-macos.zip"
      update_once "$c" "$d" "$app" 0.0.4 "$ROOT/build/0.0.4/Workmesh-menubar-macos.zip" ;;
    twice)
      update_once "$c" "$d" "$app" 0.0.2 "$ROOT/zips/twice.zip"
      update_once "$c" "$d" "$app" 0.0.3 "$ROOT/build/0.0.3/Workmesh-menubar-macos.zip" ;;
    stale)
      for kind in partial readonly file leftovers; do
        say "  -- rollback folder: $kind"
        rm_tree "$SUPPORT"; rm_tree "$d/app"; mkdir -p "$d/app"
        ditto "$ROOT/build/0.0.1/Workmesh.app" "$app"
        mkdir -p "$SUPPORT"
        case "$kind" in
          partial)  mkdir -p "$PREVIOUS/Workmesh.app/Contents"
                    cp "$ROOT/build/0.0.3/Workmesh.app/Contents/Info.plist" "$PREVIOUS/Workmesh.app/Contents/" ;;
          readonly) mkdir -p "$PREVIOUS"; ditto "$ROOT/build/0.0.3/Workmesh.app" "$PREVIOUS/Workmesh.app"
                    find "$PREVIOUS" -type f -exec chmod a-w {} \;
                    find "$PREVIOUS" -depth -type d -exec chmod 555 {} \; ;;
          file)     echo "not a folder" >"$PREVIOUS" ;;
          leftovers)
                    mkdir -p "$PREVIOUS" "$SUPPORT/menubar-previous.incoming-dead/Workmesh.app/Contents"
                    ditto "$ROOT/build/0.0.3/Workmesh.app" "$PREVIOUS/Workmesh.app"
                    ditto "$ROOT/build/0.0.3/Workmesh.app" "$SUPPORT/menubar-previous.old-dead/Workmesh.app"
                    ditto "$ROOT/build/0.0.3/Workmesh.app" "$d/app/.Workmesh.app.replaced"
                    find "$SUPPORT/menubar-previous.old-dead" "$d/app/.Workmesh.app.replaced" -depth -type d -exec chmod 555 {} \; ;;
        esac
        update_once "$c-$kind" "$d" "$app" 0.0.2 "$ROOT/zips/stale.zip"
      done ;;
    *)
      update_once "$c" "$d" "$app" 0.0.2 "$ROOT/zips/$c.zip" ;;
  esac
done

# ------------------------------------------------------------------ first install

say ""
say "== first install with curl (getting-started.md)"
d="$ROOT/first-curl"
mkdir -p "$d/Applications"
port="$(next_port)"
start_mock "$d" "$port" 0.0.2 "$ROOT/build/0.0.2/Workmesh-menubar-macos.zip"
curl -sfL -o "$d/Workmesh.zip" "http://127.0.0.1:$port/mock/Workmesh-menubar-macos.zip"
stop_mock
say "  xattrs on curl's download: $(xattr "$d/Workmesh.zip" | tr '\n' ' ')"
ditto -x -k "$d/Workmesh.zip" "$d/Applications"
q="$(quarantined "$d/Applications/Workmesh.app")"
[ -z "$q" ] && pass "curl's download and the unpacked app carry no quarantine flag: nothing to allow" || fail "quarantined after curl: $q"
sealed "$d/Applications/Workmesh.app" && pass "seal verifies" || fail "seal doesn't verify"
out="$("$d/Applications/Workmesh.app/Contents/MacOS/Workmesh" --version 2>&1 || true)"
[ "$out" = "0.0.2" ] && pass "its program starts: --version prints $out" || fail "--version printed: $out"

say ""
if [ "$FAILS" -eq 0 ]; then say "all checks passed"; else say "$FAILS check(s) failed"; fi
[ "$FAILS" -eq 0 ]

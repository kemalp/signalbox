#!/bin/sh
# End-to-end check of notifications and fast status, on SYNTHETIC sessions only:
#
#   apps/macos/scripts/notify-dryrun.sh [path/to/Signalbox.app]   # default: apps/macos/build/Signalbox.app
#   KEEP=1 apps/macos/scripts/notify-dryrun.sh                    # keep the work folder (log, fake homes)
#
# It copies the app (with the bundled CLI) to a temporary folder under its own bundle id, writes a fake
# Claude Code config dir (two registry rows whose pids are `sleep` stand-ins, and a fake `claude` that answers
# `agents --json` from them), and runs the copy in dry-run mode (SIGNALBOX_NOTIFY_DRYRUN=1: one stderr line per
# notification, UNUserNotificationCenter is never touched) with an empty HOME, CODEX_HOME and settings suite.
# Then it flips registry rows and checks the stderr lines:
#   busy → waiting                      one "notify kind=waiting" within 1.5 s
#   waiting → busy → waiting (< 30 s)   no second one (same episode)
#   busy for 10 min → idle              one "notify kind=long-task" within 1.5 s
#   busy for 2 s → idle                 nothing
# It stops only the processes it started and removes the copy's defaults. Your sessions, settings, login items
# and notification permission are never read or changed. The copy's window opens while it runs (~15 s).
set -eu

here="$(cd "$(dirname "$0")/.." && pwd)"   # apps/macos
src="${1:-$here/build/Signalbox.app}"
[ -x "$src/Contents/MacOS/Signalbox" ] || { echo "notify-dryrun.sh: no app at $src; run apps/macos/scripts/build-app.sh first" >&2; exit 2; }
[ -x "$src/Contents/Resources/signalbox" ] || { echo "notify-dryrun.sh: $src has no bundled CLI (built with --no-cli?)" >&2; exit 2; }
command -v perl >/dev/null 2>&1 || { echo "notify-dryrun.sh: needs perl (for millisecond timestamps)" >&2; exit 2; }

work="$(mktemp -d "${TMPDIR:-/tmp}/signalbox-notify-dryrun.XXXXXX")"
tag="$(basename "$work")"
id="dev.signalbox.app.dryrun.$$"
app="$work/Signalbox.app"
cfg="$work/claude"
sessions="$cfg/sessions"
log="$work/app.log"
app_pid=""
stand_ins=""
failures=0

cleanup() {
  [ -n "$app_pid" ] && kill "$app_pid" 2>/dev/null || true
  for p in $stand_ins; do kill "$p" 2>/dev/null || true; done
  # The bundled CLI exits once the app is gone (its stdin closes).
  i=0
  while pgrep -f "$tag/Signalbox.app/Contents/" >/dev/null 2>&1 && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  if pgrep -f "$tag/Signalbox.app/Contents/" >/dev/null 2>&1; then
    echo "LEFTOVER process from the test copy (not stopped):" >&2
    pgrep -fl "$tag/Signalbox.app/Contents/" >&2 || true
  fi
  # AppKit saves window state under the copy's bundle id. Only these test ids are removed, never dev.signalbox.app.
  for domain in "$id" "$id.settings"; do
    defaults delete "$domain" >/dev/null 2>&1 || true
    rm -f "$HOME/Library/Preferences/$domain.plist"
    rm -rf "$HOME/Library/Saved Application State/$domain.savedState"
  done
  if [ "${KEEP:-0}" = 1 ]; then echo "kept $work"; else rm -rf "$work"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }
count() { grep -c -- "$1" "$log" 2>/dev/null || true; }

# wait_for PATTERN COUNT SECONDS: waits until PATTERN occurs COUNT times in the log; prints the wait in ms.
wait_for() {
  start=$(ms)
  deadline=$((start + $3 * 1000))
  while [ "$(count "$1")" -lt "$2" ]; do
    [ "$(ms)" -gt "$deadline" ] && return 1
    sleep 0.05
  done
  echo $(($(ms) - start))
}

check() { # check NAME OK DETAIL
  if [ "$2" = 1 ]; then echo "PASS  $1 ($3)"; else echo "FAIL  $1 ($3)"; failures=$((failures + 1)); fi
}

# row PID SESSION NAME STATUS [WAITING_FOR] [STATUS_AGE_SECONDS]: writes one registry row atomically, like Claude Code.
row() {
  now=$(ms)
  since=$((now - ${6:-0} * 1000))
  wf=""
  [ -n "${5:-}" ] && wf=",\"waitingFor\":\"$5\""
  printf '{"pid":%s,"sessionId":"%s","cwd":"/tmp/signalbox-dryrun/%s","name":"%s","status":"%s","statusUpdatedAt":%s,"kind":"interactive","entrypoint":"cli","version":"2.1.293","startedAt":%s,"updatedAt":%s%s}\n' \
    "$1" "$2" "$2" "$3" "$4" "$since" "$((now - 3600000))" "$now" "$wf" > "$sessions/.row.tmp"
  mv "$sessions/.row.tmp" "$sessions/$1.json"
}

echo "==> Copying the app to $work (bundle id $id)"
ditto "$src" "$app"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $id" "$app/Contents/Info.plist"
codesign --force --sign - "$app" >/dev/null 2>&1

mkdir -p "$sessions" "$work/home" "$work/codex" "$work/bin" "$work/tmp"
# agents --json runs only when the config dir has a global config file, as on a machine that has used Claude Code.
echo '{}' > "$cfg/.claude.json"
cat > "$work/bin/claude" <<'EOF'
#!/bin/sh
# Fake `claude`: --version, and `agents --json` listing the synthetic registry rows.
echo "$*" >> "$(dirname "$0")/calls.log"
case "$1" in
  --version) echo "2.1.293 (Claude Code)" ;;
  agents)
    printf '['; sep=''
    for f in "$CLAUDE_CONFIG_DIR"/sessions/*.json; do [ -f "$f" ] && { printf '%s' "$sep"; cat "$f"; sep=','; }; done
    printf ']\n' ;;
  *) exit 1 ;;
esac
EOF
chmod 755 "$work/bin/claude"

sleep 600 &
pid_a=$!
sleep 600 &
pid_b=$!
stand_ins="$pid_a $pid_b"
row "$pid_a" dryrun-alpha "dry run alpha" busy
row "$pid_b" dryrun-beta "dry run beta" busy "" 600

echo "==> Starting the copy (dry run, synthetic homes)"
env -i HOME="$work/home" PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="$work/tmp/" \
  CLAUDE_CONFIG_DIR="$cfg" SIGNALBOX_CLAUDE_BIN="$work/bin/claude" CODEX_HOME="$work/codex" SIGNALBOX_BIN_DIRS= \
  SIGNALBOX_NOTIFY_DRYRUN=1 SIGNALBOX_DEBUG=1 SIGNALBOX_DEFAULTS_SUITE="$id.settings" \
  "$app/Contents/MacOS/Signalbox" > "$log" 2>&1 &
app_pid=$!

fleet='signalbox-app: fleet '
if ! wait_for "$fleet" 1 30 >/dev/null; then
  echo "FAIL  no fleet line within 30 s; log:" >&2
  cat "$log" >&2
  exit 1
fi
check "first fleet" 1 "$(grep -c 'status pushes: claude-code=fs.watch' "$log" || true) fs.watch line(s)"
sleep 1

row "$pid_a" dryrun-alpha "dry run alpha" waiting "permission prompt"
if t=$(wait_for '^notify kind=waiting ' 1 3); then check "busy → waiting notifies" "$([ "$t" -le 1500 ] && echo 1 || echo 0)" "${t} ms"; else check "busy → waiting notifies" 0 "nothing within 3 s"; fi
sleep 1
check "exactly one waiting notification" "$([ "$(count '^notify kind=waiting ')" = 1 ] && echo 1 || echo 0)" "$(count '^notify kind=waiting ') seen"

n=$(count "$fleet")
row "$pid_a" dryrun-alpha "dry run alpha" busy
wait_for "$fleet" $((n + 1)) 3 >/dev/null || true
row "$pid_a" dryrun-alpha "dry run alpha" waiting "input needed"
wait_for "$fleet" $((n + 2)) 3 >/dev/null || true
sleep 1
check "waiting → busy → waiting is one episode" "$([ "$(count '^notify kind=waiting ')" = 1 ] && echo 1 || echo 0)" "$(($(count "$fleet") - n)) fleet lines, $(count '^notify kind=waiting ') waiting notification(s)"

row "$pid_b" dryrun-beta "dry run beta" idle
if t=$(wait_for '^notify kind=long-task ' 1 3); then check "10 min busy → idle notifies" "$([ "$t" -le 1500 ] && echo 1 || echo 0)" "${t} ms"; else check "10 min busy → idle notifies" 0 "nothing within 3 s"; fi

n=$(count "$fleet")
row "$pid_a" dryrun-alpha "dry run alpha" busy
wait_for "$fleet" $((n + 1)) 3 >/dev/null || true
sleep 1
row "$pid_a" dryrun-alpha "dry run alpha" idle
wait_for "$fleet" $((n + 2)) 3 >/dev/null || true
sleep 1
check "a short busy stint doesn't notify" "$([ "$(count '^notify kind=long-task ')" = 1 ] && echo 1 || echo 0)" "$(count '^notify kind=long-task ') long-task notification(s)"

calls=$(grep -c '^agents' "$work/bin/calls.log" 2>/dev/null || true)
echo "      claude agents --json ran $calls time(s): at start and on 15 s ticks, never per status change"
grep '^notify ' "$log" | sed 's/^/      /'

if [ "$failures" -gt 0 ]; then
  echo "==> $failures check(s) failed; the copy's stderr:" >&2
  cat "$log" >&2
  exit 1
fi
echo "==> All checks passed"

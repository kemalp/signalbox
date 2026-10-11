#!/bin/sh
# Clicks through the sidebar, the session list, the history list and the command list in a real (offscreen-free) app
# window and checks the selection changes, then flips the Claude app list switch off, on and off without waiting and
# checks the CLI ends up as one child with --no-claude-app. Runs a copy of the app with its own bundle id, throwaway settings and log-only
# notifications, so a Signalbox you have open is not touched. Reads your agent data read-only, like the app.
#
#   apps/macos/scripts/click-probe.sh            # builds first
#   apps/macos/scripts/click-probe.sh --no-build
#   apps/macos/scripts/click-probe.sh --no-build path/to/Signalbox.app   # another build (default: build/Signalbox.app)
#   FIXTURE=apps/macos/Fixtures/snapshot.json apps/macos/scripts/click-probe.sh --no-build
#       # synthetic data instead of the CLI (history.json and commands.json beside the fixture are loaded too)
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
build=1
source_app="$here/build/Signalbox.app"
for arg in "$@"; do
  case "$arg" in
    --no-build) build=0 ;;
    *) source_app="$arg" ;;
  esac
done
[ "$build" = 0 ] || (cd "$here" && swift build -c release >/dev/null)
[ -d "$source_app" ] || { echo "$source_app missing: run scripts/build-app.sh first" >&2; exit 2; }

work=$(mktemp -d "${TMPDIR:-/tmp}/signalbox-click-probe.XXXXXX")
work=$(cd "$work" && pwd -P)   # /var -> /private/var, as the process list shows it
pid=""
cleanup() { [ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT INT TERM

app="$work/SignalboxProbe.app"
cp -R "$source_app" "$app"
cp "$here/.build/release/Signalbox" "$app/Contents/MacOS/Signalbox"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier dev.signalbox.app.clickprobe' -c 'Set :CFBundleName SignalboxProbe' "$app/Contents/Info.plist"
codesign --force --sign - "$app" 2>/dev/null

# Launched through LaunchServices (like Finder) so the window can become key; a child of a background shell
# often may not activate, and then clicks only try to bring the window forward.
: >"$work/log"
set -- # the app's own arguments: none, or the fixture
[ -n "${FIXTURE:-}" ] && set -- --args --fixture "$(cd "$(dirname "$FIXTURE")" && pwd)/$(basename "$FIXTURE")"
open -n --env SIGNALBOX_CLICK_PROBE=1 --env SIGNALBOX_NOTIFY_DRYRUN=1 --env SIGNALBOX_DEFAULTS_SUITE=dev.signalbox.app.clickprobe.tmp \
  --stdout "$work/log" --stderr "$work/log" "$app" "$@"
i=0
while [ $i -lt 20 ] && [ -z "$pid" ]; do pid=$(pgrep -f "$(basename "$work")/SignalboxProbe.app/Contents/MacOS/Signalbox" | head -1 || true); sleep 0.5; i=$((i + 1)); done
[ -n "$pid" ] || { echo "FAIL: probe app did not start" >&2; exit 1; }

i=0
# The history click waits up to 30 s for the CLI's first transcript scan, the restart check up to 65 s.
while [ $i -lt 180 ] && ! grep -q '^probe: RESULT' "$work/log"; do sleep 1; i=$((i + 1)); done
grep '^probe:' "$work/log" || true
defaults delete dev.signalbox.app.clickprobe.tmp >/dev/null 2>&1 || true
defaults delete dev.signalbox.app.clickprobe >/dev/null 2>&1 || true
# defaults leaves an empty plist behind; the test copies own these two names, nothing else.
rm -f "$HOME/Library/Preferences/dev.signalbox.app.clickprobe.plist" "$HOME/Library/Preferences/dev.signalbox.app.clickprobe.tmp.plist"

result=$(grep '^probe: RESULT' "$work/log" || true)
# Sessions, history, commands and restart may be skipped (no sessions on this Mac, a CLI without history or the command
# guide, or no live CLI), never fail.
case "$result" in
  "") echo "FAIL: no result within 180 s" >&2; exit 1 ;;
  *"=fail"*) echo "FAIL" >&2; exit 1 ;;
  *"sidebar=ok sessions="*" history="*" commands="*" about=ok restart="*) echo "PASS"; exit 0 ;;
  *) echo "FAIL: unexpected result line" >&2; exit 1 ;;
esac

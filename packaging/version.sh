#!/bin/sh
# The release version lives in VERSION at the repo root. The package.json "version" fields and the workspace
# entries in bun.lock copy it, because those files can't read another file. This script keeps them in step.
#
#   packaging/version.sh                    # print the version
#   packaging/version.sh check              # fail when a package.json or bun.lock disagrees with VERSION
#   packaging/version.sh check --app PATH   # also check PATH (a Signalbox.app): its bundle version and its CLI's --version
#   packaging/version.sh set 0.2.0          # write VERSION and update every copy (no git commands)
#
# Versions are plain X.Y.Z: CFBundleShortVersionString allows nothing else.
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
version_file="$repo/VERSION"
lock="$repo/bun.lock"

die() { echo "version.sh: $*" >&2; exit 1; }

is_version() { printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; }

read_version() {
  [ -f "$version_file" ] || die "$version_file not found"
  v="$(tr -d ' \t\r\n' < "$version_file")"
  is_version "$v" || die "VERSION holds '$v', expected X.Y.Z"
  printf '%s\n' "$v"
}

# The top-level "version" of a package.json (two-space indent, the format this repo uses).
manifest_version() { sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$1" | head -n 1; }

# Calls "$1" with each workspace manifest, matching the "workspaces" globs in package.json.
each_manifest() {
  "$1" "$repo/package.json"
  for f in "$repo"/packages/*/package.json "$repo"/apps/*/package.json; do
    [ -f "$f" ] && "$1" "$f"
  done
  return 0
}

rel() { printf '%s\n' "${1#"$repo"/}"; }

check_manifest() {
  got="$(manifest_version "$1")"
  if [ -z "$got" ]; then
    echo "  $(rel "$1"): no \"version\" field" >&2; bad=1
  elif [ "$got" != "$want" ]; then
    echo "  $(rel "$1"): $got" >&2; bad=1
  fi
}

check_lock() {
  [ -f "$lock" ] || return 0
  sed -n '/^  "workspaces": {/,/^  },/ s/^      "version": *"\([^"]*\)".*/\1/p' "$lock" | sort -u > "$tmp"
  while IFS= read -r got; do
    [ "$got" = "$want" ] || { echo "  bun.lock: a workspace entry says $got" >&2; bad=1; }
  done < "$tmp"
}

check_app() {
  app="$1"
  bad_app=0
  plist="$app/Contents/Info.plist"
  [ -f "$plist" ] || { echo "  $app: no Contents/Info.plist" >&2; bad_app=1; return 0; }
  got="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist" 2>/dev/null || true)"
  [ "$got" = "$want" ] || { echo "  $app: CFBundleShortVersionString is '${got:-missing}'" >&2; bad_app=1; }
  cli="$app/Contents/Resources/signalbox"
  if [ -x "$cli" ]; then
    got="$("$cli" --version 2>/dev/null || true)"
    [ "$got" = "$want" ] || { echo "  $app: bundled CLI reports '${got:-nothing}'" >&2; bad_app=1; }
  else
    echo "  $app: no bundled CLI at Contents/Resources/signalbox" >&2; bad_app=1
  fi
}

set_manifest() {
  if [ -z "$(manifest_version "$1")" ]; then
    echo "version.sh: $(rel "$1") has no top-level \"version\"; left alone" >&2
    return 0
  fi
  sed -i '' "s/^  \"version\": *\"[^\"]*\"/  \"version\": \"$new\"/" "$1"
  echo "  $(rel "$1")"
}

cmd="${1:-get}"
[ $# -gt 0 ] && shift

case "$cmd" in
  get)
    [ $# -eq 0 ] || die "get takes no arguments"
    read_version ;;
  check)
    app=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --app) [ $# -ge 2 ] || die "--app needs a path to Signalbox.app"; app="$2"; shift 2 ;;
        *) die "unknown argument to check: $1" ;;
      esac
    done
    want="$(read_version)"
    bad=0
    bad_app=0
    tmp="$(mktemp "${TMPDIR:-/tmp}/signalbox-version.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT
    each_manifest check_manifest
    check_lock
    [ -n "$app" ] && check_app "$app"
    [ "$bad" = 0 ] || die "these disagree with VERSION ($want); run: packaging/version.sh set $want"
    [ "$bad_app" = 0 ] || die "the app disagrees with VERSION ($want); rebuild it (build-app.sh must read VERSION, see docs/RELEASE.md)"
    echo "version $want: package.json files and bun.lock agree${app:+, and so does $app}" ;;
  set)
    [ $# -eq 1 ] || die "usage: packaging/version.sh set X.Y.Z"
    new="$1"
    is_version "$new" || die "'$new' is not X.Y.Z"
    printf '%s\n' "$new" > "$version_file"
    echo "VERSION = $new; updated:"
    each_manifest set_manifest
    if [ -f "$lock" ]; then
      sed -i '' "/^  \"workspaces\": {/,/^  },/ s/^      \"version\": *\"[^\"]*\"/      \"version\": \"$new\"/" "$lock"
      echo "  bun.lock (workspace entries)"
    fi ;;
  -h|--help|help)
    sed -n '2,9p' "$0" ;;
  *)
    die "unknown command: $cmd (get, check, set)" ;;
esac

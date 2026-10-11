#!/bin/sh
# Packages Signalbox.app for a release. Writes into dist/release/ (or --output DIR):
#   Signalbox-<version>-macos-arm64.zip          the app, CLI included, zipped with ditto
#   Signalbox-<version>-macos-arm64.zip.sha256   its checksum, in the format `shasum -a 256 -c` reads
#   signalbox.rb                                 the Homebrew cask, filled in from packaging/homebrew/
#
#   apps/macos/scripts/release.sh                  # refuses to run when the git tree has changes
#   apps/macos/scripts/release.sh --allow-dirty    # package uncommitted or untracked changes anyway (a test build)
#   apps/macos/scripts/release.sh --output DIR     # write into DIR instead of dist/release
#   apps/macos/scripts/release.sh --url-base URL   # the folder the zip will be downloaded from, for the cask's url
#                                                  # (default: the releases folder of the GitHub repo that `origin` points
#                                                  # to, https://github.com/<owner>/<repo>/releases/download/v#{version})
#   apps/macos/scripts/release.sh --homepage URL   # the cask's homepage (default: that repo's page)
#
# Builds a fresh CLI and the app (build-app.sh, into a temporary folder), checks both, zips the app and checks that
# the zip unpacks to a bundle whose signature verifies. It never uploads, tags, commits or pushes. See docs/RELEASE.md.
set -eu

here="$(cd "$(dirname "$0")/.." && pwd)"   # apps/macos
repo="$(cd "$here/../.." && pwd)"
allow_dirty=0
out_dir=""
url_base=""
homepage=""
arch="arm64"

die() { echo "release.sh: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --allow-dirty) allow_dirty=1; shift ;;
    --output)
      [ $# -ge 2 ] || die "--output needs a directory"
      out_dir="$2"; shift 2 ;;
    --url-base)
      [ $# -ge 2 ] || die "--url-base needs a URL"
      url_base="${2%/}"; shift 2 ;;
    --homepage)
      [ $# -ge 2 ] || die "--homepage needs a URL"
      homepage="${2%/}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "release.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ "$(uname -s)" = Darwin ] || die "this builds a macOS app; run it on a Mac"
[ "$(uname -m)" = "$arch" ] || die "release builds are $arch only and this Mac is $(uname -m)"

# The default URLs come from the origin remote (read-only), so no account name is written into this script.
# Only a plain GitHub remote counts; anything else (another host, a URL with a user name in it) means passing them.
gh_repo=""
origin_url="$(git -C "$repo" remote get-url origin 2>/dev/null || true)"
case "$origin_url" in
  https://github.com/*) gh_repo="${origin_url#https://github.com/}" ;;
  git@github.com:*) gh_repo="${origin_url#git@github.com:}" ;;
  ssh://git@github.com/*) gh_repo="${origin_url#ssh://git@github.com/}" ;;
esac
gh_repo="${gh_repo%/}"
gh_repo="${gh_repo%.git}"
printf '%s' "$gh_repo" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' || gh_repo=""
if [ -z "$url_base" ]; then
  [ -n "$gh_repo" ] || die "origin is not a GitHub repo, so there is no default download folder; pass --url-base URL"
  url_base="https://github.com/$gh_repo/releases/download/v#{version}"
fi
if [ -z "$homepage" ]; then
  [ -n "$gh_repo" ] || die "origin is not a GitHub repo, so there is no default homepage; pass --homepage URL"
  homepage="https://github.com/$gh_repo"
fi

# The cask puts these URLs in Ruby strings, so allow only plain URLs (and Homebrew's own #{version}).
case "$url_base" in https://*|file:///*) ;; *) die "--url-base must start with https:// or file:///" ;; esac
url_rest="$(printf '%s' "$url_base" | sed 's/#{version}//g')"
case "$url_rest" in
  *'"'*|*'\'*|*'#'*|*' '*|*"$(printf '\t')"*) die "--url-base has a character the cask can't hold (quote, backslash, # or space)" ;;
esac
case "$homepage" in https://*) ;; *) die "--homepage must start with https://" ;; esac
case "$homepage" in
  *'"'*|*'\'*|*'#'*|*' '*|*"$(printf '\t')"*) die "--homepage has a character the cask can't hold (quote, backslash, # or space)" ;;
esac

version="$(sh "$repo/packaging/version.sh" get)"
sh "$repo/packaging/version.sh" check

# --- git state (read-only: --no-optional-locks keeps `status` from rewriting the index) ---------------------
commit="unknown"
tree="not a git checkout"
tag_note=""
if git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  commit="$(git -C "$repo" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
  changes="$(git -C "$repo" --no-optional-locks status --porcelain)"
  if [ -z "$changes" ]; then
    tree="clean"
  elif [ "$allow_dirty" = 1 ]; then
    tree="DIRTY: $(printf '%s\n' "$changes" | wc -l | tr -d ' ') changed or untracked paths, packaged with --allow-dirty"
  else
    echo "release.sh: the git tree has uncommitted or untracked changes:" >&2
    printf '%s\n' "$changes" | head -n 20 | sed 's/^/  /' >&2
    n="$(printf '%s\n' "$changes" | wc -l | tr -d ' ')"
    [ "$n" -gt 20 ] && echo "  ... and $((n - 20)) more" >&2
    die "commit or stash them first, or pass --allow-dirty for a test build"
  fi
  if git -C "$repo" tag --points-at HEAD 2>/dev/null | grep -qx "v$version"; then
    tag_note="v$version points at HEAD"
  else
    tag_note="no v$version tag at HEAD yet"
  fi
elif [ "$allow_dirty" = 0 ]; then
  die "$repo is not a git checkout, so its state can't be checked; pass --allow-dirty to package it anyway"
fi

# --- build ----------------------------------------------------------------------------------------------------
out="${out_dir:-$repo/dist/release}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
stage=""
cleanup() { [ -n "$stage" ] && rm -rf "$stage"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
stage="$(mktemp -d "$out/.stage.XXXXXX")"

# build-app.sh decides staleness from file times, which can miss new embedded data; a release always rebuilds.
echo "==> Building the signalbox CLI from the current tree"
sh "$repo/scripts/build-cli.sh"
echo "==> Building Signalbox.app (release) into a temporary folder"
sh "$here/scripts/build-app.sh" --output "$stage"
app="$stage/Signalbox.app"

echo "==> Checking the bundle"
check_bundle() {
  b="$1"
  [ -x "$b/Contents/MacOS/Signalbox" ] || die "$b has no Contents/MacOS/Signalbox"
  [ -x "$b/Contents/Resources/signalbox" ] || die "$b has no bundled CLI (Contents/Resources/signalbox)"
  [ -f "$b/Contents/Resources/AppIcon.icns" ] || die "$b has no AppIcon.icns"
  for bin in "$b/Contents/MacOS/Signalbox" "$b/Contents/Resources/signalbox"; do
    got="$(lipo -archs "$bin" 2>/dev/null || true)"
    [ "$got" = "$arch" ] || die "${bin#"$b"/} is '${got:-unreadable}', expected $arch"
  done
  codesign --verify --strict --deep "$b" || die "$b: the code signature does not verify"
  sh "$repo/packaging/version.sh" check --app "$b" >/dev/null
}
check_bundle "$app"
if codesign -dv "$app" 2>&1 | grep -q '^Signature=adhoc'; then signing="ad-hoc, not notarized"; else signing="signed (not ad-hoc), not notarized by this script"; fi

# --- zip ------------------------------------------------------------------------------------------------------
name="Signalbox-$version-macos-$arch"
zip="$out/$name.zip"
rm -f "$zip" "$zip.sha256" "$out/signalbox.rb"
echo "==> Zipping $name.zip"
# --norsrc leaves out extended attributes (build machines add com.apple.provenance), which otherwise end up as
# AppleDouble entries that tools other than ditto unpack as stray files.
ditto -c -k --norsrc --keepParent "$app" "$zip"

entries="$(zipinfo -1 "$zip")"
printf '%s\n' "$entries" | grep -v '^Signalbox\.app/' >/dev/null && die "$zip has entries outside Signalbox.app/"
printf '%s\n' "$entries" | grep -E '(^|/)(__MACOSX|\._)' >/dev/null && die "$zip has AppleDouble entries"

(cd "$out" && shasum -a 256 "$name.zip") > "$zip.sha256"
sha="$(cut -d ' ' -f 1 < "$zip.sha256")"
(cd "$out" && shasum -a 256 -c "$name.zip.sha256" >/dev/null) || die "the checksum file does not match the zip"

echo "==> Unpacking the zip twice (ditto, as Finder does, and unzip) and checking each copy"
mkdir "$stage/ditto" "$stage/unzip"
ditto -x -k "$zip" "$stage/ditto"
unzip -q "$zip" -d "$stage/unzip"
for dir in "$stage/ditto" "$stage/unzip"; do
  [ "$(ls -A "$dir")" = "Signalbox.app" ] || die "$zip does not unpack to a single Signalbox.app"
  check_bundle "$dir/Signalbox.app"
done

# --- Homebrew cask --------------------------------------------------------------------------------------------
url="$url_base/Signalbox-#{version}-macos-$arch.zip"
awk -v version="$version" -v sha="$sha" -v url="$url" -v homepage="$homepage" '
  function put(s, from, to,   i, r) { r = ""; while ((i = index(s, from)) > 0) { r = r substr(s, 1, i - 1) to; s = substr(s, i + length(from)) } return r s }
  !started && !/^cask / { next }
  { started = 1; print put(put(put(put($0, "@VERSION@", version), "@SHA256@", sha), "@URL@", url), "@HOMEPAGE@", homepage) }
' "$repo/packaging/homebrew/signalbox.rb.template" > "$out/signalbox.rb"
grep -q '@[A-Z0-9]*@' "$out/signalbox.rb" && die "signalbox.rb still has a placeholder"
if command -v ruby >/dev/null 2>&1; then
  ruby -c "$out/signalbox.rb" >/dev/null 2>&1 || die "signalbox.rb is not valid Ruby"
fi

# --- summary --------------------------------------------------------------------------------------------------
download="$(printf '%s' "$url" | sed "s/#{version}/$version/g")"
echo
echo "Signalbox $version for macOS $arch: packaged, nothing uploaded"
echo "  commit    $commit ($tree)"
[ -n "$tag_note" ] && echo "  tag       $tag_note"
echo "  zip       $zip ($(du -h "$zip" | cut -f 1 | tr -d ' '))"
echo "  sha256    $sha"
echo "  checksum  $zip.sha256"
echo "  cask      $out/signalbox.rb"
echo "  url       $download"
echo "  signing   $signing; Gatekeeper blocks the first launch on other Macs"
echo "Next steps (by hand): docs/RELEASE.md"

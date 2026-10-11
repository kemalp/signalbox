#!/bin/sh
# Builds the single-file `signalbox` binary (Bun runtime + CLI + price tables + web page bundle).
#
#   scripts/build-cli.sh                              # dist/signalbox, for this Mac's arch (default bun-darwin-arm64)
#   scripts/build-cli.sh --target bun-darwin-x64      # dist/signalbox-darwin-x64
#   scripts/build-cli.sh --target T --outfile PATH
#
# The binary needs no repo, no Bun install and no network: run it from any directory.
set -eu

cd "$(dirname "$0")/.."

target="bun-darwin-arm64"
outfile=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) target="${2:?--target needs a value, e.g. bun-darwin-x64}"; shift 2 ;;
    --target=*) target="${1#--target=}"; shift ;;
    --outfile) outfile="${2:?--outfile needs a path}"; shift 2 ;;
    --outfile=*) outfile="${1#--outfile=}"; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "build-cli.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$target" in
  bun-darwin-arm64|bun-darwin-x64|bun-darwin-arm64-*|bun-darwin-x64-*) ;;
  bun-*) echo "build-cli.sh: note: $target is not a macOS target; building anyway" >&2 ;;
  *) echo "build-cli.sh: --target must be a Bun compile target such as bun-darwin-arm64 or bun-darwin-x64" >&2; exit 2 ;;
esac

if [ -z "$outfile" ]; then
  case "$target" in
    bun-darwin-arm64*) outfile="dist/signalbox" ;;
    *) outfile="dist/signalbox-${target#bun-}" ;;
  esac
fi

mkdir -p "$(dirname "$outfile")"
bun build --compile --minify --target="$target" apps/cli/src/main.ts --outfile "$outfile"

echo "built $outfile ($target, $(du -h "$outfile" | cut -f1 | tr -d ' '))"

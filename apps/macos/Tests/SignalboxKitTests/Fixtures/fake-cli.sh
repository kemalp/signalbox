#!/bin/sh
# A fake `signalbox watch --ndjson` for the transport tests. Synthetic data only.
#   FAKE_CLI_MODE=exit-after-hello   print hello, then exit 3 (restart/backoff tests)
#   FAKE_CLI_MODE=fail-before-hello  print an error on stderr and exit 1 without a hello (a CLI that can't start)
#   FAKE_CLI_STATE                   a file that gets one line appended per start
# Otherwise it prints hello, fleet, report, a garbage line and an unknown type, then answers
# stdin commands (echoing each one to stderr) until stdin closes.

days=7
while [ $# -gt 0 ]; do
  case "$1" in
    --days) days="$2"; shift 2 ;;
    *) shift ;;
  esac
done

AT="2026-10-09T14:30:00.000Z"
[ -n "$FAKE_CLI_STATE" ] && echo "start days=$days" >> "$FAKE_CLI_STATE"
echo "fake-cli: starting (days=$days)" >&2

fleet() {
  printf '{"type":"fleet","at":"%s","data":{"generatedAt":"%s","sessions":[{"agent":"claude-code","sessionId":"s-1","status":"waiting","statusSince":"2026-10-09T14:25:00Z","source":"fake","futureField":true},{"agent":"codex","sessionId":"s-2","status":"hibernating","source":"fake"}],"limits":[{"agent":"claude-code","kind":"five_hour","usedPercent":42,"observedAt":"%s","source":"fake"}],"compactions":[],"health":[]}}\n' "$AT" "$AT" "$AT"
}

report() {
  printf '{"type":"report","at":"%s","days":%s,"data":{"generatedAt":"%s","range":{"since":"2026-10-03T00:00:00.000Z","until":"%s"},"totals":{"tokens":{"input":1,"output":2,"cacheRead":3,"cacheWrite5m":0,"cacheWrite1h":0},"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite5m":0,"cacheWrite1h":0,"webSearch":0,"total":1.5},"responses":1,"placeholderResponses":0,"unpricedTokens":0,"unpricedModels":[],"processedTokens":6,"freshTokens":3,"cacheHitRatio":0.75,"savedByCachingUsd":0.01},"byAgent":[],"byModel":[],"byProject":[],"byKind":[],"byDay":[],"reconciliation":[],"estimate":{"recordedUsd":1.5,"estimatedLowUsd":1.6,"estimatedHighUsd":1.9,"method":"fake"},"priceTables":[],"notes":[]}}\n' "$AT" "$1" "$AT" "$AT"
}

if [ "$FAKE_CLI_MODE" = "fail-before-hello" ]; then
  echo "fake-cli: cannot read the price tables" >&2
  exit 1
fi

printf '{"type":"hello","v":1,"version":"0.0.0-fake","pid":%d}\n' "$$"

if [ "$FAKE_CLI_MODE" = "exit-after-hello" ]; then
  echo "fake-cli: exiting with status 3" >&2
  exit 3
fi

fleet
report "$days"
printf 'this line is not json\n'
printf '{"type":"from-the-future","x":1}\n'

while IFS= read -r line; do
  echo "fake-cli: got $line" >&2
  case "$line" in
    *'"cmd":"report"'*)
      days=$(printf '%s' "$line" | sed -E 's/.*"days":([0-9]+).*/\1/')
      report "$days"
      ;;
    *'"cmd":"refresh"'*)
      fleet
      report "$days"
      ;;
    *)
      printf '{"type":"error","at":"%s","scope":"protocol","message":"unknown command"}\n' "$AT"
      ;;
  esac
done

echo "fake-cli: stdin closed, exiting" >&2
exit 0

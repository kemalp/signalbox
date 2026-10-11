#!/bin/sh
LOG=/tmp/signalbox-research/verify-control/out/hooks.jsonl
IN=$(cat)
ENVN=$(env | cut -d= -f1 | grep -E '^CLAUDE' | sort | tr '\n' ',')
printf '%s' "$IN" | python3 -I -c 'import sys,json; d=json.load(sys.stdin); d["_env_names"]=sys.argv[1]; d["_compact_summary_len"]=len(d.pop("compact_summary","") or ""); d.pop("last_assistant_message",None); print(json.dumps(d))' "$ENVN" >> "$LOG"
EVT=$(printf '%s' "$IN" | python3 -I -c 'import sys,json; print(json.load(sys.stdin).get("hook_event_name",""))')
if [ "$EVT" = "PreCompact" ] && [ -f /tmp/signalbox-research/verify-control/out/block_flag ]; then echo "{\"decision\":\"block\",\"reason\":\"json-block\"}"; exit 0; fi
exit 0

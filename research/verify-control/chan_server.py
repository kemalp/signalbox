import sys, json, threading, time
LOG = "/tmp/signalbox-research/verify-control/out/chan_server.log"
def log(x):
    with open(LOG, "a") as f: f.write(json.dumps(x) + "\n")
def send(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
def push():
    time.sleep(2)
    for i in range(3):
        send({"jsonrpc": "2.0", "method": "notifications/claude/channel", "params": {"content": "CHANNEL-PING-%d" % i, "meta": {"src": "verify"}}})
        log({"pushed": i}); time.sleep(2)
for line in sys.stdin:
    try: m = json.loads(line)
    except Exception: continue
    log({"recv": m.get("method"), "has_id": "id" in m, "client_caps": (m.get("params") or {}).get("capabilities") if m.get("method") == "initialize" else None})
    meth = m.get("method")
    if meth == "initialize":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"protocolVersion": m["params"].get("protocolVersion", "2025-06-18"),
              "capabilities": {"experimental": {"claude/channel": {}}, "tools": {}}, "serverInfo": {"name": "webhook", "version": "0.0.1"},
              "instructions": "verify channel server"}})
    elif meth == "notifications/initialized":
        threading.Thread(target=push, daemon=True).start()
    elif meth == "tools/list":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"tools": []}})
    elif "id" in m:
        send({"jsonrpc": "2.0", "id": m["id"], "result": {}})

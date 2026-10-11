import subprocess, json, time, sys, os, threading
V=sys.argv[1]; mode=sys.argv[2]
cfg=os.path.join(V,"cfg"); env=dict(os.environ, CLAUDE_CONFIG_DIR=cfg)
mcp=json.dumps({"mcpServers":{"webhook":{"command":"python3","args":["-I",os.path.join(V,"scripts","chan_server.py")]}}})
args=[os.path.join(V,"cc.sh"),"-p","--input-format","stream-json","--output-format","stream-json","--verbose","--replay-user-messages","--no-session-persistence","--mcp-config",mcp,"--debug-file",os.path.join(V,"out",f"chan_debug_{mode}.log")]
if mode=="dev": args+=["--dangerously-load-development-channels","server:webhook"]
if mode=="chan": args+=["--channels","server:webhook"]
p=subprocess.Popen(args,cwd=os.path.join(V,"w6"),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
out=[]; err=[]
threading.Thread(target=lambda:[out.append(l) for l in p.stdout],daemon=True).start()
threading.Thread(target=lambda:[err.append(l) for l in p.stderr],daemon=True).start()
p.stdin.write(json.dumps({"type":"user","message":{"role":"user","content":"/goal"}})+"\n"); p.stdin.flush()
time.sleep(14)
p.stdin.close()
try: p.wait(timeout=15)
except Exception: p.terminate()
ms=[json.loads(l) for l in out if l.startswith("{")]
init=[m for m in ms if m.get("subtype")=="init"]
print(mode, "mcp_servers:", init[0].get("mcp_servers") if init else None)
print(mode, "events:", [(m.get("type"),m.get("subtype")) for m in ms])
print(mode, "channel text seen in stdout:", any("CHANNEL-PING" in l for l in out))
print(mode, "stderr:", "".join(err)[:300].replace("\n"," | "))

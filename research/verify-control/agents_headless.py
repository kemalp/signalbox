import subprocess, json, time, sys, os
V=sys.argv[1]; cfg=os.path.join(V,"cfg"); env=dict(os.environ, CLAUDE_CONFIG_DIR=cfg); cc=os.path.join(V,"cc.sh")
p=subprocess.Popen([cc,"-p","--input-format","stream-json","--output-format","stream-json","--verbose","--no-session-persistence"],cwd=os.path.join(V,"w3"),stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,text=True,env=env)
p.stdin.write(json.dumps({"type":"user","message":{"role":"user","content":"/goal"}})+"\n"); p.stdin.flush()
time.sleep(6)
r=subprocess.run([cc,"agents","--json"],capture_output=True,text=True,env=env,timeout=60)
try:
    for a in json.loads(r.stdout): print({k:a.get(k) for k in ("kind","status","state","name")}, "pid_match", a.get("pid")==p.pid)
except Exception as e: print("agents out:", r.stdout[:200], r.stderr[:200])
p.stdin.close(); p.wait(timeout=15)

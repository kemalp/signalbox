import subprocess, json, time, sys, os, threading, glob
V = sys.argv[1]; cwd = os.path.join(V, "w2"); cfg = os.path.join(V, "cfg")
env = dict(os.environ, CLAUDE_CONFIG_DIR=cfg)
cc = os.path.join(V, "cc.sh")
p = subprocess.Popen([cc, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
                     cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
out = []
threading.Thread(target=lambda: [out.append(l) for l in p.stdout], daemon=True).start()
def send(t):
    p.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": t}}) + "\n"); p.stdin.flush()
def wait_results(n, to=30):
    t0=time.time()
    while time.time()-t0<to:
        rs=[json.loads(l) for l in list(out) if l.startswith('{') and '"type":"result"' in l]
        if len(rs)>=n: return rs
        time.sleep(0.3)
    return []
send("/rename live-original")
rs = wait_results(1)
sid = rs[0]["session_id"] if rs else None
print("live sid captured:", bool(sid), "live pid", p.pid)
reg = os.path.join(cfg, "sessions", f"{p.pid}.json")
print("registry file for live pid exists:", os.path.exists(reg))
if os.path.exists(reg):
    print("registry keys:", sorted(json.load(open(reg)).keys()))
r = subprocess.run([cc, "-p", "--resume", sid, "/rename resumed-while-live", "--output-format", "json"],
                   cwd=cwd, capture_output=True, text=True, timeout=120, env=env, stdin=subprocess.DEVNULL)
try:
    d = json.loads(r.stdout)
    print("resume: same_id =", d.get("session_id") == sid, "| is_error =", d.get("is_error"), "| local_command =", d.get("local_command"), "| result =", (d.get("result") or "")[:200])
    sid2 = d.get("session_id")
except Exception:
    print("resume stdout unparsable:", r.stdout[:300]); sid2=None
print("resume stderr:", r.stderr.strip()[:300])
# now ask the LIVE process its name via a local command to see if in-memory state changed
send("/rename")
rs = wait_results(2)
print("live after resume, '/rename' (no arg) result:", (rs[-1].get("result") or "")[:200] if len(rs)>=2 else None)
files = glob.glob(os.path.join(cfg, "projects", "*", "*.jsonl"))
for f in files:
    n=0; titles=[]
    for line in open(f):
        n+=1
        try: dd=json.loads(line)
        except Exception: continue
        if dd.get("type")=="custom-title": titles.append(dd.get("customTitle"))
    print(os.path.basename(f), "lines", n, "custom-title rows", titles)
p.stdin.close()
try: p.wait(timeout=15)
except Exception: p.terminate()

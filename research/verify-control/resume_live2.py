import subprocess, json, time, sys, os, threading, glob
V = sys.argv[1]; cwd = os.path.join(V, "w2"); cfg = os.path.join(V, "cfg")
env = dict(os.environ, CLAUDE_CONFIG_DIR=cfg)
cc = os.path.join(V, "cc.sh")
p = subprocess.Popen([cc, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "claude-haiku-5-5"],
                     cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
out = []
threading.Thread(target=lambda: [out.append(l) for l in p.stdout], daemon=True).start()
def send(t):
    p.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": t}}) + "\n"); p.stdin.flush()
def results():
    return [json.loads(l) for l in list(out) if l.startswith('{') and '"type":"result"' in l]
def wait_results(n, to=30):
    t0=time.time()
    while time.time()-t0<to:
        rs=results()
        if len(rs)>=n: return rs
        time.sleep(0.3)
    return results()
send("/model"); rs = wait_results(1)
sid = rs[0]["session_id"]
print("live baseline /model:", rs[0].get("result","")[:160].replace("\n"," | "))
r = subprocess.run([cc, "-p", "--resume", sid, "/model sonnet", "--output-format", "json"],
                   cwd=cwd, capture_output=True, text=True, timeout=120, env=env, stdin=subprocess.DEVNULL)
d = json.loads(r.stdout); print("resumed proc:", d.get("session_id")==sid, d.get("result","")[:120])
r = subprocess.run([cc, "-p", "--resume", sid, "/model", "--output-format", "json"],
                   cwd=cwd, capture_output=True, text=True, timeout=120, env=env, stdin=subprocess.DEVNULL)
d = json.loads(r.stdout); print("second resumed proc /model:", d.get("result","")[:160].replace("\n"," | "))
send("/model"); rs = wait_results(2)
print("live after resume /model:", rs[-1].get("result","")[:160].replace("\n"," | "))
send("/compact"); rs = wait_results(3)
print("live /compact:", repr(rs[-1].get("result","")[:160]), rs[-1].get("local_command"))
p.stdin.close()
try: p.wait(timeout=15)
except Exception: p.terminate()
# system messages in stdout
print("stdout types:", sorted({(json.loads(l).get('type'), json.loads(l).get('subtype')) for l in out if l.startswith('{')}, key=str))

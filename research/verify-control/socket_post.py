import subprocess, json, time, sys, os, threading, socket
V = sys.argv[1]; cwd = os.path.join(V, "w3"); cfg = os.path.join(V, "cfg")
env = dict(os.environ, CLAUDE_CONFIG_DIR=cfg)
cc = os.path.join(V, "cc.sh")
p = subprocess.Popen([cc, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"],
                     cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
out = []
threading.Thread(target=lambda: [out.append(l) for l in p.stdout], daemon=True).start()
def send(t):
    p.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": t}}) + "\n"); p.stdin.flush()
def msgs(): return [json.loads(l) for l in list(out) if l.startswith('{')]
# first a local cmd so init is emitted
send("/goal")
t0=time.time()
while time.time()-t0<30 and not any(m.get('type')=='result' for m in msgs()): time.sleep(0.3)
init=[m for m in msgs() if m.get('subtype')=='init'][0]
sp=init.get('messaging_socket_path'); print("init socket:", sp, "exists:", os.path.exists(sp or ''))
reg=os.path.join(cfg,'sessions',f'{p.pid}.json')
if os.path.exists(reg):
    r=json.load(open(reg)); print("registry socket == init:", r.get('messagingSocketPath')==sp, "kind", r.get('kind'), "entrypoint", r.get('entrypoint'), "status", r.get('status'), 'peerFeatures', r.get('peerFeatures'))
def post(text):
    s=socket.socket(socket.AF_UNIX); s.connect(sp)
    s.sendall((json.dumps({'type':'user','message':{'role':'user','content':text}})+'\n').encode())
    s.settimeout(2.0)
    try: resp=s.recv(4096)
    except Exception as e: resp=('<none %s>'%type(e).__name__).encode()
    s.close(); return resp
n0=len(msgs())
print("post1 reply:", post("hello from socket")[:300])
time.sleep(8)
new=msgs()[n0:]
for m in new:
    print(" new:", m.get('type'), m.get('subtype'), 'local_command=',m.get('local_command'), 'num_turns=',m.get('num_turns'), 'is_error=',m.get('is_error'), str(m.get('result') or '')[:100])
    if m.get('type')=='user':
        c=m.get('message',{}).get('content'); print('   user content type:', type(c).__name__, str(c)[:200])
n1=len(msgs())
print("post2 reply:", post("/rename via-socket")[:300])
time.sleep(8)
for m in msgs()[n1:]:
    print(" new:", m.get('type'), m.get('subtype'), 'local_command=',m.get('local_command'), 'num_turns=',m.get('num_turns'), 'is_error=',m.get('is_error'), str(m.get('result') or '')[:100])
    if m.get('type')=='user':
        c=m.get('message',{}).get('content'); print('   user content:', str(c)[:300])
p.stdin.close()
try: p.wait(timeout=15)
except Exception: p.terminate()

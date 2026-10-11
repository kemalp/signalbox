import subprocess, json, time, sys, os, threading, socket, glob
V = sys.argv[1]; cwd = os.path.join(V, "w4"); cfg = os.path.join(V, "cfg")
env = dict(os.environ, CLAUDE_CONFIG_DIR=cfg)
cc = os.path.join(V, "cc.sh")
p = subprocess.Popen([cc, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
                      "--model", "claude-opus-5-5", "--plugin-dir", os.path.join(V, "mods", "vc-probe")],
                     cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
out = []
threading.Thread(target=lambda: [out.append(l) for l in p.stdout], daemon=True).start()
def send(t):
    p.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": t}}) + "\n"); p.stdin.flush()
def msgs(): return [json.loads(l) for l in list(out) if l.startswith('{')]
def nres(): return sum(1 for m in msgs() if m.get('type')=='result')
send("/vc-usage")
t0=time.time()
while time.time()-t0<30 and nres()<1: time.sleep(0.3)
res=[m for m in msgs() if m.get('type')=='result']
print("/vc-usage via stdin:", res[0].get('result','')[:400] if res else None, '| num_turns', res[0].get('num_turns') if res else None)
init=[m for m in msgs() if m.get('subtype')=='init'][0]; sp=init['messaging_socket_path']; sid=init['session_id']
print("plugins in init:", [pl.get('name') for pl in init.get('plugins',[])], "vc-usage in slash_commands:", 'vc-usage' in init.get('slash_commands',[]))
n0=len(msgs())
for text in ["VC: rename from-socket-vc", "VC: model haiku", "VC: compact", "VC: compact-direct", "VC: status", "VC: usage", "plain peer hello"]:
    s=socket.socket(socket.AF_UNIX); s.connect(sp); s.sendall((json.dumps({'type':'user','message':{'role':'user','content':text}})+'\n').encode()); s.close()
    time.sleep(3)
new=msgs()[n0:]
print("stdout events after socket posts:", [(m.get('type'), m.get('subtype')) for m in new])
print("any replayed user msg containing 'VC:':", any('VC:' in json.dumps(m) for m in new if m.get('type')=='user'))
r0=nres(); send("/model")
t0=time.time()
while time.time()-t0<30 and nres()<=r0: time.sleep(0.3)
print("live /model after socket control:", [m for m in msgs() if m.get('type')=='result'][-1].get('result','')[:60].replace('\n',' '))
open(os.path.join(V,"out","mod_socket_stdout.jsonl"),"w").write("".join(out))
p.stdin.close()
try: p.wait(timeout=15)
except Exception: p.terminate()
for f in glob.glob(os.path.join(cfg,'projects','*',sid+'.jsonl')):
    titles=[json.loads(l).get('customTitle') for l in open(f) if '"custom-title"' in l]
    print("transcript custom-title rows:", titles)

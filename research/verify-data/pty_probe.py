# Launch interactive claude in a pty for a few seconds, capture screen text, never send keystrokes except Ctrl-C at the end.
import os, pty, sys, time, select, re, signal
cwd, settings, out = sys.argv[1], sys.argv[2], sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.environ['COLUMNS'] = '120'; os.environ['LINES'] = '40'
    os.execvp('claude', ['claude', '--settings', settings, '--model', 'claude-haiku-5-5'])
buf = b''; end = time.time() + 12
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.5)
    if fd in r:
        try: buf += os.read(fd, 65536)
        except OSError: break
os.kill(pid, signal.SIGTERM); time.sleep(0.5)
try: os.kill(pid, signal.SIGKILL)
except Exception: pass
txt = re.sub(rb'\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]', b'', buf).decode('utf-8', 'replace')
open(out, 'w').write(txt)
print(re.sub(r'[ \t]+', ' ', txt)[-1500:])

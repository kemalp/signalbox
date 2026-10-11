# Aggregates only. From each session's last cost-state, solve for implied cache-write multiplier per model.
import json, os, glob, collections, sys
sys.path.insert(0, sys.argv[1])
from cc_cost import PRICES, canonical
root = os.path.expanduser('~/.claude/projects')
geo = collections.Counter(); speed = collections.Counter(); tier = collections.Counter()
out = []
for f in glob.glob(root + '/*/*.jsonl'):
    cs = None
    for l in open(f, errors='replace'):
        if '"cost-state"' in l:
            try: d = json.loads(l)
            except ValueError: continue
            if d.get('type') == 'cost-state' and d.get('modelUsage'): cs = d
    if not cs: continue
    nsub = len(glob.glob(f[:-6] + '/subagents/**/*.jsonl', recursive=True))
    for k, v in cs['modelUsage'].items():
        m = canonical(k); p = PRICES.get(m)
        if not p: out.append((m, 'unpriced')); continue
        bi, bo, rm = p
        cw = v.get('cacheCreationInputTokens', 0)
        rest = (v.get('inputTokens', 0) * bi + v.get('outputTokens', 0) * bo + v.get('cacheReadInputTokens', 0) * bi * rm) / 1e6
        ws = v.get('webSearchRequests', 0) * 0.01
        implied = (v['costUSD'] - rest - ws) / (cw * bi / 1e6) if cw else None
        out.append((m, nsub, round(v['costUSD'], 4), cw, None if implied is None else round(implied, 3), sorted(v.keys()) if len(out) == 0 else None))
for r in out: print(r)

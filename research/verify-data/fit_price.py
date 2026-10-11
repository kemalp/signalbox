# Aggregates only: fit per-MTok prices for a model from cost-state ledger rows (in, out, cr, cw -> costUSD)
import json, os, glob, sys
model = sys.argv[1]
root = os.path.expanduser('~/.claude/projects')
rows = []
for f in glob.glob(root + '/*/*.jsonl'):
    cs = None
    for l in open(f, errors='replace'):
        if '"cost-state"' in l:
            try: d = json.loads(l)
            except ValueError: continue
            if d.get('type') == 'cost-state' and d.get('modelUsage'): cs = d
    if not cs: continue
    for k, v in cs['modelUsage'].items():
        if k.startswith(model):
            rows.append((k, v.get('inputTokens',0), v.get('outputTokens',0), v.get('cacheReadInputTokens',0), v.get('cacheCreationInputTokens',0), v.get('webSearchRequests',0), v['costUSD']))
for r in rows: print(r)

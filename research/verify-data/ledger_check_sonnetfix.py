# Aggregates only. Per-session ledger (cost-state) vs transcript, restricted to transcript lines up to the cost-state line.
import json, os, glob, collections, sys, datetime as dt
sys.path.insert(0, sys.argv[1])
import cc_cost; cc_cost.PRICES["claude-sonnet-5-5"]=(2.0,10.0,0.10)
from cc_cost import price_response, canonical
root = os.path.expanduser('~/.claude/projects')
def ts(s):
    try: return dt.datetime.fromisoformat(s.replace('Z', '+00:00'))
    except Exception: return None
agg = collections.Counter(); models_only_ledger = collections.Counter(); models_only_tr = collections.Counter()
ledger_model_usd = collections.Counter(); tr_model_usd = collections.Counter()
rows = []
for f in glob.glob(root + '/*/*.jsonl'):
    lines = open(f, errors='replace').read().splitlines()
    cs_i = None; last_ts = None; cs_ts = None
    for i, l in enumerate(lines):
        try: d = json.loads(l)
        except ValueError: continue
        if d.get('timestamp'): last_ts = ts(d['timestamp'])
        if d.get('type') == 'cost-state' and d.get('modelUsage'): cs_i = i; cs = d; cs_ts = last_ts
    if cs_i is None or cs_ts is None: continue
    paths = [f] + glob.glob(f[:-6] + '/subagents/**/*.jsonl', recursive=True)
    best = {}
    for p in paths:
        for l in open(p, errors='replace'):
            try: d = json.loads(l)
            except ValueError: continue
            if d.get('type') != 'assistant': continue
            m = d.get('message') or {}
            if m.get('model') in (None, '<synthetic>'): continue
            t = ts(d.get('timestamp') or '')
            if t is None or t > cs_ts: continue
            u = m.get('usage') or {}
            k = m.get('id'); prev = best.get(k)
            if prev is None or (u.get('output_tokens') or 0) >= (prev[1].get('output_tokens') or 0):
                best[k] = (canonical(m['model']), u)
    tr_models = collections.Counter(); tr_usd = 0; tr_in = collections.Counter()
    for mm, u in best.values():
        usd = price_response(mm, u)[0]; tr_usd += usd; tr_model_usd[mm] += usd; tr_models[mm] += 1
        tr_in['in'] += u.get('input_tokens') or 0; tr_in['cr'] += u.get('cache_read_input_tokens') or 0; tr_in['cw'] += u.get('cache_creation_input_tokens') or 0; tr_in['out'] += u.get('output_tokens') or 0
    lm = {canonical(k): v for k, v in cs['modelUsage'].items()}
    l_in = collections.Counter()
    for k, v in lm.items():
        ledger_model_usd[k] += v.get('costUSD', 0)
        l_in['in'] += v.get('inputTokens', 0); l_in['cr'] += v.get('cacheReadInputTokens', 0); l_in['cw'] += v.get('cacheCreationInputTokens', 0); l_in['out'] += v.get('outputTokens', 0)
        if k not in tr_models: models_only_ledger[k] += 1
    for k in tr_models:
        if k not in lm: models_only_tr[k] += 1
    rows.append((cs['totalCostUSD'], tr_usd, len(paths) - 1, l_in, tr_in))
L = sum(r[0] for r in rows); T = sum(r[1] for r in rows)
print('sessions', len(rows), 'ledger_usd %.2f transcript_usd(up to cs) %.2f ratio %.3f' % (L, T, T / L))
li = sum((r[3] for r in rows), collections.Counter()); ti = sum((r[4] for r in rows), collections.Counter())
for k in ('in', 'cr', 'cw', 'out'): print(' tokens', k, 'ledger', li[k], 'transcript', ti[k], 'ratio %.3f' % (ti[k] / li[k] if li[k] else 0))
print('models in ledger but not in transcripts (sessions count):', dict(models_only_ledger))
print('models in transcripts but not ledger:', dict(models_only_tr))
print('ledger usd by model:', {k: round(v, 2) for k, v in ledger_model_usd.items()})
print('transcript usd by model:', {k: round(v, 2) for k, v in tr_model_usd.items()})
# per-session ratio distribution
rs = sorted(r[1] / r[0] for r in rows if r[0] > 0.5)
print('per-session ratio (sessions > $0.50):', [round(x, 2) for x in rs])

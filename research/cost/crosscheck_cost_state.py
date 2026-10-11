#!/usr/bin/env python3
"""Compare transcript-derived list-price USD (via cc_cost pricing) with Claude Code's own
persisted ledger ('cost-state' lines = what /cost and the status line show). Aggregates only."""
import glob, json, os, sys, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cc_cost import price_response, canonical
root = os.path.expanduser('~/.claude/projects')
rows = []
for f in glob.glob(root + '/*/*.jsonl'):
    last_cs = None; cs_line_idx = None; n_lines = 0
    for i, line in enumerate(open(f, errors='replace')):
        n_lines += 1
        try: d = json.loads(line)
        except ValueError: continue
        if d.get('type') == 'cost-state': last_cs = d; cs_line_idx = i
    if not last_cs or not last_cs.get('modelUsage'): continue
    paths = [f] + glob.glob(f[:-6] + '/subagents/**/*.jsonl', recursive=True)
    best = {}
    for p in paths:
        for line in open(p, errors='replace'):
            try: d = json.loads(line)
            except ValueError: continue
            if d.get('type') != 'assistant': continue
            m = d['message']
            if m.get('model') in (None, '<synthetic>'): continue
            u = m.get('usage') or {}
            k = m.get('id'); prev = best.get(k)
            if prev is None or (u.get('output_tokens') or 0) >= (prev[1].get('output_tokens') or 0):
                best[k] = (canonical(m['model']), u)
    t_usd = sum(price_response(mm, u)[0] for mm, u in best.values())
    t_out = sum(u.get('output_tokens') or 0 for _, u in best.values())
    cs_out = sum(v.get('outputTokens', 0) for v in last_cs['modelUsage'].values())
    cs_out_main_model = {canonical(k): v.get('outputTokens', 0) for k, v in last_cs['modelUsage'].items()}
    rows.append({'cs_usd': last_cs['totalCostUSD'], 't_usd': t_usd, 'cs_out': cs_out, 't_out': t_out,
                 'subfiles': len(paths) - 1, 'cs_at_end': cs_line_idx >= n_lines - 3})
S = lambda k, rs: sum(r[k] for r in rs)
for label, rs in (('all', rows), ('no-subagents', [r for r in rows if r['subfiles'] == 0]), ('with-subagents', [r for r in rows if r['subfiles'] > 0])):
    if not rs: continue
    print(f"{label:15} sessions={len(rs):3}  ledger_usd={S('cs_usd', rs):9.2f}  transcript_usd={S('t_usd', rs):9.2f}  "
          f"ratio={S('t_usd', rs)/S('cs_usd', rs):.2f}  ledger_out={S('cs_out', rs):>10,}  transcript_out={S('t_out', rs):>10,}")

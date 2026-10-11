# Aggregates only: cache-write TTL split by transcript kind and model; inference_geo/speed/service_tier distributions
import json, os, glob, collections
root = os.path.expanduser('~/.claude/projects')
def kind_of(p):
    if p.endswith('journal.jsonl'): return None
    if '/subagents/workflows/' in p: return 'workflow'
    if '/subagents/' in p: return 'subagent'
    return 'main'
seen = set(); c = collections.defaultdict(collections.Counter); geo = collections.Counter(); spd = collections.Counter(); tier = collections.Counter(); fb = collections.Counter()
missing_split = 0
for f in glob.glob(root + '/**/*.jsonl', recursive=True):
    k = kind_of(f)
    if not k: continue
    for l in open(f, errors='replace'):
        if '"assistant"' not in l: continue
        try: d = json.loads(l)
        except ValueError: continue
        if d.get('type') != 'assistant': continue
        m = d.get('message') or {}
        if m.get('model') in (None, '<synthetic>'): continue
        if m.get('id') in seen: continue
        seen.add(m.get('id'))
        u = m.get('usage') or {}; cc = u.get('cache_creation') or {}
        cw = u.get('cache_creation_input_tokens') or 0
        h1 = cc.get('ephemeral_1h_input_tokens') or 0; m5 = cc.get('ephemeral_5m_input_tokens') or 0
        if cw and (h1 + m5) != cw: missing_split += 1
        key = (k, m.get('model'))
        c[key]['cw'] += cw; c[key]['1h'] += h1; c[key]['5m'] += m5; c[key]['n'] += 1
        geo[u.get('inference_geo')] += 1; spd[u.get('speed')] += 1; tier[u.get('service_tier')] += 1; fb[str(u.get('fallback_credit'))[:20]] += 1
for key, v in sorted(c.items()):
    print(key, 'n', v['n'], 'cw', v['cw'], '1h_share %.3f' % (v['1h'] / v['cw'] if v['cw'] else 0))
print('responses with cw where 1h+5m != cw:', missing_split)
print('inference_geo', dict(geo)); print('speed', dict(spd)); print('service_tier', dict(tier)); print('fallback_credit', dict(fb))

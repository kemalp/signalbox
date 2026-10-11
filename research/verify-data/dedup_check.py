# Aggregates only. Checks whether input/cache usage is identical across lines of a message.id
import json, os, glob, collections
root = os.path.expanduser('~/.claude/projects')
files = glob.glob(root + '/**/*.jsonl', recursive=True)
kind_of = lambda p: 'journal' if p.endswith('journal.jsonl') else ('wf' if '/workflows/' in p else ('sub' if '/subagents/' in p else 'main'))
inc = collections.defaultdict(set); outs = collections.defaultdict(list); kinds = {}
stopline_out = {}; maxout = collections.Counter(); lastline_out = {}
order_issue = 0
blocks_per_line = collections.Counter()
for f in files:
    k = kind_of(f)
    for line in open(f, errors='replace'):
        try: d = json.loads(line)
        except Exception: continue
        if d.get('type') != 'assistant': continue
        m = d.get('message') or {}
        if m.get('model') == '<synthetic>': continue
        mid = m.get('id');
        if not mid: continue
        u = m.get('usage') or {}
        blocks_per_line[len(m.get('content') or [])] += 1
        inc[mid].add(json.dumps({x: u.get(x) for x in ('input_tokens','cache_read_input_tokens','cache_creation_input_tokens')}, sort_keys=True))
        outs[mid].append((u.get('output_tokens') or 0, m.get('stop_reason')))
        kinds[mid] = k
diff_in = [m for m, s in inc.items() if len(s) > 1]
print('ids', len(inc), 'ids with differing input/cache across lines', len(diff_in), collections.Counter(kinds[m] for m in diff_in))
# output differs: pattern
diff_out = [m for m, o in outs.items() if len(set(x[0] for x in o)) > 1]
print('ids with differing output across lines', len(diff_out), collections.Counter(kinds[m] for m in diff_out))
# For those, is max on line with stop_reason?
pat = collections.Counter()
for m in diff_out:
    o = outs[m]; mx = max(x[0] for x in o)
    pat[('max_on_stop_line' if any(x[0]==mx and x[1] is not None for x in o) else 'max_not_on_stop', 'last_is_max' if o[-1][0]==mx else 'last_not_max')] += 1
print('pattern', pat)
print('content blocks per line', sorted(blocks_per_line.items()))

#!/usr/bin/env python3
"""cc_cost.py - API-equivalent cost + token totals from local Claude Code transcripts.

Reads ~/.claude/projects/**/*.jsonl (main sessions, subagents, workflow agents), dedups
streamed assistant lines by message.id, prices each API response at Anthropic list price,
and prints AGGREGATES ONLY (no message content is ever printed).

Usage:
  python3 cc_cost.py                 # last 7 days, table
  python3 cc_cost.py --days 30
  python3 cc_cost.py --json          # machine-readable

Pricing: platform.claude.com/docs/en/about-claude/pricing (fetched 2026-10-09). USD per MTok.
"""
import argparse, collections, datetime as dt, glob, json, os, re, sys

# base input, output, cache-read multiplier (x base input)
PRICES = {
    'claude-fable-5-1':  (10.0, 50.0, 0.025),
    'claude-mythos-5-1': (10.0, 50.0, 0.025),
    'claude-fable-5':    (10.0, 50.0, 0.10),
    'claude-mythos-5':   (10.0, 50.0, 0.10),
    'claude-opus-5-5':   (4.0, 20.0, 0.05),
    'claude-opus-5':     (5.0, 25.0, 0.10),
    'claude-opus-4-8':   (5.0, 25.0, 0.10),
    'claude-opus-4-7':   (5.0, 25.0, 0.10),
    'claude-opus-4-6':   (5.0, 25.0, 0.10),
    'claude-opus-4-5':   (5.0, 25.0, 0.10),
    'claude-opus-4-1':   (15.0, 75.0, 0.10),
    'claude-opus-4-0':   (15.0, 75.0, 0.10),
    'claude-sonnet-5-5': (2.0, 10.0, 0.05),
    'claude-sonnet-5':   (2.0, 10.0, 0.10),
    'claude-sonnet-4-6': (3.0, 15.0, 0.10),
    'claude-sonnet-4-5': (3.0, 15.0, 0.10),
    'claude-sonnet-4-0': (3.0, 15.0, 0.10),
    'claude-haiku-5-5':  (0.10, 0.50, 0.10),   # prompts <=100K; see HAIKU55_LONG
    'claude-haiku-4-5':  (1.0, 5.0, 0.10),
}
HAIKU55_LONG = (0.50, 2.50, 0.10)               # prompt (input+cache read+cache write) > 100K
FAST = {'claude-opus-5-5': (8.0, 40.0), 'claude-opus-5': (10.0, 50.0), 'claude-opus-4-8': (10.0, 50.0)}
CACHE_WRITE_5M, CACHE_WRITE_1H = 1.25, 2.0
US_GEO_MULT = 1.1                               # inference_geo == "us", Claude 4.6+ models
WEB_SEARCH_USD = 10.0 / 1000

def canonical(model):
    m = re.sub(r'-\d{8}$', '', model or '')     # strip date snapshot suffix
    m = re.sub(r'\[1m\]$', '', m)
    return m

def kind_of(path):
    if path.endswith('journal.jsonl'): return None   # workflow journal, no API usage
    if '/subagents/workflows/' in path: return 'workflow'
    if '/subagents/' in path: return 'subagent'
    return 'main'

def price_response(model, u):
    """USD for one deduped API response. Returns (usd, unpriced_flag)."""
    p = PRICES.get(model)
    if not p: return 0.0, True
    inp = u.get('input_tokens') or 0
    out = u.get('output_tokens') or 0
    cr = u.get('cache_read_input_tokens') or 0
    cw = u.get('cache_creation_input_tokens') or 0
    cc = u.get('cache_creation') or {}
    cw1h = cc.get('ephemeral_1h_input_tokens') or 0
    cw5m = max(cw - cw1h, 0)                     # remainder (incl. missing split) priced as 5m
    base_in, base_out, read_mult = p
    if model == 'claude-haiku-5-5' and inp + cr + cw > 100_000:
        base_in, base_out, read_mult = HAIKU55_LONG
    if u.get('speed') == 'fast' and model in FAST:
        base_in, base_out = FAST[model]
    usd = (inp * base_in + out * base_out + cr * base_in * read_mult
           + cw5m * base_in * CACHE_WRITE_5M + cw1h * base_in * CACHE_WRITE_1H) / 1e6
    if u.get('inference_geo') == 'us':
        usd *= US_GEO_MULT
    usd += ((u.get('server_tool_use') or {}).get('web_search_requests') or 0) * WEB_SEARCH_USD
    return usd, False

def est_output_from_content(content):
    """Lower-bound output estimate for responses whose recorded output_tokens is the
    message_start placeholder: visible text + tool_use JSON at ~4 chars/token.
    Thinking is not recoverable (omitted from transcripts on current models)."""
    chars = 0
    for b in content or []:
        if not isinstance(b, dict): continue
        if b.get('type') == 'text': chars += len(b.get('text') or '')
        elif b.get('type') == 'tool_use': chars += len(json.dumps(b.get('input') or {}))
    return chars // 4

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=float, default=7)
    ap.add_argument('--root', default=os.path.expanduser('~/.claude/projects'))
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    now = dt.datetime.now(dt.timezone.utc)
    since = now - dt.timedelta(days=a.days)

    # message.id -> merged record (one API response may span several JSONL lines,
    # one per content block; usage repeats on each, output_tokens only final on the
    # line that carries stop_reason, if any)
    resp = {}
    files = [f for f in glob.glob(a.root + '/**/*.jsonl', recursive=True) if kind_of(f)]
    lines_seen = 0
    for f in files:
        if os.path.getmtime(f) < since.timestamp(): continue   # cheap skip of old files
        kind = kind_of(f)
        project = os.path.relpath(f, a.root).split(os.sep)[0]
        with open(f, errors='replace') as fh:
            for line in fh:
                if '"assistant"' not in line: continue
                try: d = json.loads(line)
                except ValueError: continue                       # partial line in a live file
                if d.get('type') != 'assistant' or d.get('isApiErrorMessage'): continue
                m = d.get('message') or {}
                model = m.get('model')
                if not model or model == '<synthetic>': continue
                ts = d.get('timestamp')
                try: t = dt.datetime.fromisoformat(ts.replace('Z', '+00:00'))
                except Exception: continue
                lines_seen += 1
                key = m.get('id') or d.get('requestId') or d.get('uuid')
                u = m.get('usage') or {}
                r = resp.get(key)
                if r is None:
                    r = resp[key] = {'t': t, 'model': canonical(model), 'kind': kind, 'project': project,
                                     'session': d.get('sessionId'), 'usage': u, 'final': False,
                                     'content_est': 0, 'lines': 0}
                r['lines'] += 1
                r['t'] = min(r['t'], t)
                if (u.get('output_tokens') or 0) >= (r['usage'].get('output_tokens') or 0):
                    r['usage'] = u
                if m.get('stop_reason') is not None: r['final'] = True
                r['content_est'] += est_output_from_content(m.get('content'))

    by_model = collections.defaultdict(collections.Counter)
    by_kind = collections.defaultdict(collections.Counter)
    tot = collections.Counter()
    unpriced = collections.Counter()
    for r in resp.values():
        if r['t'] < since: continue
        u = r['usage']
        usd, unp = price_response(r['model'], u)
        if unp: unpriced[r['model']] += 1
        cc = u.get('cache_creation') or {}
        row = {
            'responses': 1,
            'input': u.get('input_tokens') or 0,
            'output_recorded': u.get('output_tokens') or 0,
            'cache_read': u.get('cache_read_input_tokens') or 0,
            'cache_write': u.get('cache_creation_input_tokens') or 0,
            'cache_write_1h': cc.get('ephemeral_1h_input_tokens') or 0,
            'thinking_recorded': (u.get('output_tokens_details') or {}).get('thinking_tokens') or 0,
            'web_search': (u.get('server_tool_use') or {}).get('web_search_requests') or 0,
            'placeholder_output_responses': 0 if r['final'] else 1,
            'usd_micro': round(usd * 1e6),
        }
        if not r['final']:
            extra = max(r['content_est'] - row['output_recorded'], 0)
            row['output_est_missing'] = extra
            p = PRICES.get(r['model'])
            if p: row['usd_micro_est_missing'] = round(extra * p[1])   # $/MTok * tokens = micro-USD
        for bucket in (by_model[r['model']], by_kind[r['kind']], tot):
            bucket.update(row)

    def ratio(c):
        denom = c['input'] + c['cache_read'] + c['cache_write']
        return round(c['cache_read'] / denom, 4) if denom else None

    out = {
        'window': {'since': since.isoformat(timespec='seconds'), 'until': now.isoformat(timespec='seconds'), 'days': a.days},
        'files_scanned': len(files), 'assistant_lines_in_scope': lines_seen,
        'unique_api_responses': tot['responses'],
        'totals': {**{k: v for k, v in tot.items() if k != 'usd_micro' and not k.startswith('usd_micro')},
                   'usd_list_price': round(tot['usd_micro'] / 1e6, 2),
                   'usd_est_missing_output_lower_bound': round(tot['usd_micro_est_missing'] / 1e6, 2),
                   'cache_hit_ratio': ratio(tot),
                   'total_tokens_recorded': tot['input'] + tot['output_recorded'] + tot['cache_read'] + tot['cache_write']},
        'by_model': {m: {'responses': c['responses'], 'input': c['input'], 'output_recorded': c['output_recorded'],
                         'cache_read': c['cache_read'], 'cache_write': c['cache_write'],
                         'cache_write_1h_share': round(c['cache_write_1h'] / c['cache_write'], 3) if c['cache_write'] else None,
                         'usd': round(c['usd_micro'] / 1e6, 2),
                         'usd_est_missing_output': round(c['usd_micro_est_missing'] / 1e6, 2),
                         'placeholder_output_responses': c['placeholder_output_responses'],
                         'cache_hit_ratio': ratio(c)}
                     for m, c in sorted(by_model.items(), key=lambda kv: -kv[1]['usd_micro'])},
        'by_kind': {k: {'responses': c['responses'], 'usd': round(c['usd_micro'] / 1e6, 2),
                        'placeholder_output_share': round(c['placeholder_output_responses'] / c['responses'], 3)}
                    for k, c in by_kind.items()},
        'unpriced_models': dict(unpriced),
    }
    if a.json:
        print(json.dumps(out, indent=2)); return
    M = lambda n: f'{n/1e6:,.2f}M'
    t = out['totals']
    print(f"Window {out['window']['since']} -> {out['window']['until']}  ({len(files)} files, "
          f"{lines_seen} assistant lines -> {tot['responses']} unique API responses)")
    print(f"Tokens: input {M(t['input'])} | output(recorded) {M(t['output_recorded'])} | cache read {M(t['cache_read'])} | "
          f"cache write {M(t['cache_write'])} | total {M(t['total_tokens_recorded'])}")
    print(f"Cache-hit ratio {t['cache_hit_ratio']:.1%}   API-equivalent list price ${t['usd_list_price']:,.2f}"
          f"  (+ >=${t['usd_est_missing_output_lower_bound']:,.2f} est. unrecorded output)")
    print(f"\n{'model':22}{'resp':>7}{'input':>10}{'output':>10}{'c.read':>11}{'c.write':>10}{'hit%':>7}{'USD':>11}")
    for m, c in out['by_model'].items():
        print(f"{m:22}{c['responses']:>7}{M(c['input']):>10}{M(c['output_recorded']):>10}{M(c['cache_read']):>11}"
              f"{M(c['cache_write']):>10}{(c['cache_hit_ratio'] or 0):>7.1%}{c['usd']:>11,.2f}")
    print('\nby kind:', json.dumps(out['by_kind']))
    if unpriced: print('unpriced models (add to PRICES):', dict(unpriced))

if __name__ == '__main__':
    main()

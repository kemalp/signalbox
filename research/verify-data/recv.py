# Minimal independent OTLP/HTTP JSON receiver: logs metric names, log event names, attribute KEYS and a few safe values.
import json, sys, os
from http.server import BaseHTTPRequestHandler, HTTPServer
OUT = sys.argv[2]
SAFE = {'event.name', 'type', 'model', 'query_source', 'cost_usd', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'request_id', 'status_code', 'error', 'decision', 'tool_name', 'success', 'service.name', 'service.version', 'terminal.type', 'plugin.name', 'name'}
def attrs(lst):
    out = {}
    for a in lst or []:
        v = a.get('value', {}); val = next(iter(v.values()), None) if v else None
        out[a['key']] = val if a['key'] in SAFE else '<%s>' % type(val).__name__
    return out
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0) or 0))
        rec = {'path': self.path, 'ctype': self.headers.get('Content-Type'), 'bytes': len(body)}
        try:
            d = json.loads(body)
            ms = []
            for rm in d.get('resourceMetrics', []):
                for sm in rm.get('scopeMetrics', []):
                    for m in sm.get('metrics', []):
                        kind = next((k for k in ('sum', 'gauge', 'histogram') if k in m), None)
                        for dp in (m.get(kind) or {}).get('dataPoints', []):
                            ms.append({'name': m['name'], 'value': dp.get('asDouble', dp.get('asInt')), 'attrs': attrs(dp.get('attributes'))})
            ls = []
            for rl in d.get('resourceLogs', []):
                for sl in rl.get('scopeLogs', []):
                    for lr in sl.get('logRecords', []):
                        ls.append({'body': (lr.get('body') or {}).get('stringValue'), 'attrs': attrs(lr.get('attributes'))})
            rec['metrics'] = ms; rec['logs'] = ls
        except Exception as e:
            rec['parse_error'] = str(e)
        with open(OUT, 'a') as f: f.write(json.dumps(rec) + '\n')
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(b'{}')
HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()

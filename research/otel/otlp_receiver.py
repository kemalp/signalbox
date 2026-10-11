#!/usr/bin/env python3
"""Minimal OTLP/HTTP (JSON) receiver for Claude Code telemetry.
Run:  python3 otlp_receiver.py [port]   (default 4318)
Then start Claude Code with:
  CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp \
  OTEL_EXPORTER_OTLP_PROTOCOL=http/json OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
  OTEL_METRIC_EXPORT_INTERVAL=5000 claude
Appends one normalized JSON line per metric datapoint / log event to otlp_events.jsonl.
Prompt/response content is redacted by Claude Code unless OTEL_LOG_* gates are set; this receiver
additionally drops known content attributes."""
import json, sys, time, os
from http.server import BaseHTTPRequestHandler, HTTPServer
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'otlp_events.jsonl')
DROP = {'prompt', 'prompt_text', 'response', 'tool_input', 'tool_parameters', 'user.email'}
def attrs(lst):
    out = {}
    for a in lst or []:
        v = a.get('value', {})
        val = next(iter(v.values()), None) if v else None
        if a['key'] not in DROP: out[a['key']] = val
    return out
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0) or 0))
        ctype = self.headers.get('Content-Type', '')
        rows = []
        if 'json' in ctype:
            d = json.loads(body or b'{}')
            for rm in d.get('resourceMetrics', []):
                res = attrs(rm.get('resource', {}).get('attributes'))
                for sm in rm.get('scopeMetrics', []):
                    for m in sm.get('metrics', []):
                        kind = next((k for k in ('sum', 'gauge', 'histogram') if k in m), None)
                        for dp in (m.get(kind) or {}).get('dataPoints', []):
                            rows.append({'signal': 'metric', 'name': m['name'], 'unit': m.get('unit'),
                                         'value': dp.get('asDouble', dp.get('asInt')), 't': dp.get('timeUnixNano'),
                                         'temporality': (m.get(kind) or {}).get('aggregationTemporality'),
                                         'attrs': {**res, **attrs(dp.get('attributes'))}})
            for rl in d.get('resourceLogs', []):
                res = attrs(rl.get('resource', {}).get('attributes'))
                for sl in rl.get('scopeLogs', []):
                    for lr in sl.get('logRecords', []):
                        a = attrs(lr.get('attributes'))
                        rows.append({'signal': 'log', 'name': a.get('event.name') or (lr.get('body') or {}).get('stringValue'),
                                     't': lr.get('timeUnixNano'), 'attrs': {**res, **a}})
        else:
            rows.append({'signal': 'unparsed', 'path': self.path, 'content_type': ctype, 'bytes': len(body)})
        with open(OUT, 'a') as f:
            for r in rows: f.write(json.dumps(r) + '\n')
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(b'{}')
if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4318
    print(f'listening on 127.0.0.1:{port}, writing {OUT}', flush=True)
    HTTPServer(('127.0.0.1', port), H).serve_forever()

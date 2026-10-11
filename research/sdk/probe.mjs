// Tiny SDK probe: open a session with no prompt, call control requests, print shapes only (no personal values).
import { query } from '@anthropic-ai/claude-agent-sdk';
const shape = (o, d = 0) => {
  if (o === null) return null;
  if (Array.isArray(o)) return o.length ? [shape(o[0], d + 1)] : [];
  if (typeof o === 'object') { if (d > 3) return '{...}'; const r = {}; for (const k of Object.keys(o)) r[k] = shape(o[k], d + 1); return r; }
  return typeof o;
};
let release; const hold = new Promise(r => (release = r));
async function* prompt() { await hold; }   // never yields a user message
const q = query({ prompt: prompt(), options: { cwd: process.cwd(), model: 'claude-haiku-5-5', persistSession: false } });
const pump = (async () => { for await (const m of q) console.log('MSG', m.type, m.subtype ?? ''); })().catch(e => console.log('PUMP ERR', String(e).slice(0, 200)));
const t = (p, ms = 30000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
try {
  const u = await t(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
  console.log('USAGE shape', JSON.stringify(shape(u)));
  console.log('USAGE values', JSON.stringify({ subscription_type: u.subscription_type, rate_limits_available: u.rate_limits_available, rate_limits_is_null: u.rate_limits === null, five_hour: u.rate_limits?.five_hour ?? null, seven_day: u.rate_limits?.seven_day ?? null, session_cost: u.session?.total_cost_usd }));
} catch (e) { console.log('USAGE ERR', String(e).slice(0, 300)); }
try {
  const c = await t(q.getContextUsage({ detail: 'summary' }));
  console.log('CONTEXT top keys', Object.keys(c), 'totalTokens', c.totalTokens, 'maxTokens', c.maxTokens, 'autoCompactThreshold', c.autoCompactThreshold, 'isAutoCompactEnabled', c.isAutoCompactEnabled);
} catch (e) { console.log('CONTEXT ERR', String(e).slice(0, 300)); }
try { const cmds = await t(q.supportedCommands()); console.log('COMMANDS', cmds.length, cmds.map(c => c.name).filter(n => ['compact','context','usage','cost','autocompact','clear'].includes(n))); } catch (e) { console.log('CMDS ERR', String(e).slice(0, 200)); }
release(); q.close?.(); await Promise.race([pump, new Promise(r => setTimeout(r, 3000))]);
process.exit(0);

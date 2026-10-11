// signalbox-tap: on session start, measure and end, writes this session's usage figures
// (context fill, rate-limit windows, cost) as a TapSpool v1 file. It does nothing else:
// no network, no commands, no prompts, no settings, no UI. A failure is logged to the
// debug log only, and no hook ever throws.
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

type Figures = Partial<Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>>
type TapEvent = 'session.start' | 'session.measure' | 'session.end'

const SPOOL_DIR = 'Library/Application Support/signalbox/spool'
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
// Module state restarts on a hot reload; the first write per session picks the seq up from the file.
const seqs = new Map<string, number>()

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function figures(u: Figures | undefined) {
  const tokens = num(u?.context?.tokens)
  const context = tokens === undefined ? undefined : { tokens, window: num(u?.context?.window), percent: num(u?.context?.percent) }
  const rateLimits = (Array.isArray(u?.rateLimits) ? u.rateLimits : [])
    .filter((r) => typeof r?.kind === 'string' && num(r.percentUsed) !== undefined)
    .map((r) => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: typeof r.resetsAt === 'string' ? r.resetsAt : undefined }))
  const usd = num(u?.cost?.usd)
  const out = { context, rateLimits: rateLimits.length > 0 ? rateLimits : undefined, cost: usd === undefined ? undefined : { usd } }
  return out.context || out.rateLimits || out.cost ? out : undefined
}

async function tap($: EngineInterface, event: TapEvent, sessionId: () => string | Promise<string>, pushed?: Figures) {
  try {
    const home = await $.env.get('HOME')
    const sid = await sessionId()
    if (!home?.startsWith('/') || !SAFE_ID.test(sid)) return
    const path = `${home.replace(/\/+$/, '')}/${SPOOL_DIR}/${sid}.json`
    let seq = seqs.get(sid)
    if (seq === undefined) {
      const prev: unknown = await $.fs.read(path).then((text) => JSON.parse(text), () => undefined).catch(() => undefined)
      seq = num((prev as { seq?: unknown } | undefined)?.seq) ?? 0
    }
    seqs.set(sid, ++seq)
    const usage = figures(pushed ?? (await $.session.usage().catch(() => undefined)))
    const writtenAt = new Date(await $.clock.now()).toISOString()
    const spool = { v: 1, seq, agent: 'claude-code', sessionId: sid, writtenAt, event, usage }
    await $.fs.write(path, JSON.stringify(spool) + '\n')
  } catch (err) {
    try {
      $.ui.log(`signalbox-tap: ${event} not written (${err instanceof Error ? err.name : typeof err})`, { to: 'debug' })
    } catch {}
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await tap($, 'session.start', () => $.session.id())
    return result
  })
  on('session.measure', async ($, e, next) => {
    await tap($, 'session.measure', () => $.session.id(), e)
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    // e.sessionId, not $.session.id(): after a /clear the process already runs under a new id.
    await tap($, 'session.end', () => e.sessionId)
    return next(e)
  })
}

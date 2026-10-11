// spike-probe: Signalbox Day-0 go/no-go checks (docs/SPIKE.md, BRAINSTORM §12).
// Load it only in a NEW throwaway session, next to plugins/signalbox-tap.
//
// Passive, always on: records session.start / session.measure figures (numbers, kinds and key
// names only) and whether signalbox-tap's spool file appears and parses.
// Active, only when you type the command:
//   /spike-check        read-only: $.mcp.call('ccd_session_mgmt', 'list_sessions' | 'get_usage')
//                       and $.http.fetch over the listener.ts Unix socket
//   /spike-rename NAME  $.command.run('rename', NAME): renames this session, nothing else
//   /spike-status       prints the results
// Results: ~/Library/Application Support/signalbox/spool/spike-results-<sessionId>.json
// Nothing here stores message text: MCP replies are reduced to their shape (strings become
// "<string N>"), except the short labels under get_usage's `plan`.
import type { EngineInterface, McpToolResult, Register, SessionRateLimit } from 'claude-code'

type Status = 'pending' | 'pass' | 'fail' | 'not-run'
type McpCheck = {
  status: Status
  at?: string
  ms?: number
  isError?: boolean
  blocks?: number
  textLength?: number
  json?: boolean
  count?: number
  shape?: unknown
  error?: string
}

const BASE = 'Library/Application Support/signalbox'
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const TIMEOUT_MS = 20_000
const MAX_EVENTS = 200

const results = {
  v: 'spike-1' as const,
  sessionId: undefined as string | undefined,
  engine: undefined as { version?: string; base?: string } | undefined,
  surface: undefined as string | null | undefined,
  surfaces: undefined as readonly string[] | undefined,
  isInteractive: undefined as boolean | undefined,
  updatedAt: undefined as string | undefined,
  checks: {
    measureAndSpool: {
      status: 'pending' as Status,
      measures: 0,
      changed: [] as string[],
      lastContextPercent: undefined as number | undefined,
      lastCostUsd: undefined as number | undefined,
      resultsWrite: undefined as string | undefined,
      tapSpool: undefined as Record<string, unknown> | undefined,
    },
    rateLimits: {
      status: 'pending' as Status,
      nonEmptySeen: false,
      kinds: [] as string[],
      latest: undefined as SessionRateLimit[] | undefined,
      from: undefined as string | undefined,
    },
    mcpListSessions: { status: 'not-run' } as McpCheck,
    mcpGetUsage: { status: 'not-run' } as McpCheck & { selfIsThisSession?: boolean },
    httpSocket: { status: 'not-run' } as {
      status: Status
      at?: string
      socketPath?: string
      ms?: number
      httpStatus?: number
      reply?: unknown
      error?: string
    },
    rename: { status: 'not-run' } as { status: Status; at?: string; name?: string; ms?: number; outputHead?: string; error?: string },
    modelGlobalDefault: { status: 'not-run' as Status, note: 'Deferred to Day 5-7 by design: /model can change the global default.' },
  },
  events: [] as Array<{ t: string; ev: string; note?: string }>,
}
let loadedPrior = false

const iso = async ($: EngineInterface) => new Date(await $.clock.now()).toISOString()
const errText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 300)

async function paths($: EngineInterface) {
  const home = await $.env.get('HOME')
  const sid = await $.session.id()
  if (!home?.startsWith('/') || !SAFE_ID.test(sid)) return undefined
  const base = `${home.replace(/\/+$/, '')}/${BASE}`
  results.sessionId = sid
  return { sid, results: `${base}/spool/spike-results-${sid}.json`, tap: `${base}/spool/${sid}.json`, sock: `${base}/spike.sock` }
}

async function event($: EngineInterface, ev: string, note?: string) {
  results.events.push({ t: await iso($), ev, ...(note === undefined ? {} : { note: note.slice(0, 200) }) })
  if (results.events.length > MAX_EVENTS) results.events.splice(0, results.events.length - MAX_EVENTS)
}

function grade() {
  const m = results.checks.measureAndSpool
  const tap = m.tapSpool
  const tapOk = tap?.parseOk === true && tap.v === 1 && tap.sessionMatches === true
  m.status = m.measures > 0 && tapOk ? 'pass' : m.measures > 0 ? 'fail' : 'pending'
  const r = results.checks.rateLimits
  r.status = r.nonEmptySeen ? 'pass' : m.measures > 0 ? 'fail' : 'pending'
}

function summary(): string {
  const c = results.checks
  const s = (x: { status: Status }) => x.status
  return `spike: measure+spool ${s(c.measureAndSpool)} (${c.measureAndSpool.measures}) · rateLimits ${s(c.rateLimits)} · mcp list ${s(c.mcpListSessions)} / usage ${s(c.mcpGetUsage)} · socket ${s(c.httpSocket)} · rename ${s(c.rename)}`
}

async function save($: EngineInterface) {
  grade()
  try {
    const p = await paths($)
    if (!p) throw new Error('no absolute HOME or no safe session id')
    if (!loadedPrior) {
      loadedPrior = true
      await carryForward($, p.results)
    }
    results.updatedAt = await iso($)
    await $.fs.write(p.results, JSON.stringify(results, null, 2) + '\n')
    results.checks.measureAndSpool.resultsWrite = 'ok'
  } catch (err) {
    results.checks.measureAndSpool.resultsWrite = errText(err)
    try {
      $.ui.toast(`spike-probe: results not written: ${errText(err)}`)
    } catch {}
  }
  try {
    $.ui.status(summary())
  } catch {}
}

/**
 * A hot reload (or a respawned hooks worker) restarts module state and fires session.start again.
 * Take each check from this session's earlier results file unless this load has already run it.
 */
async function carryForward($: EngineInterface, path: string) {
  const prior = await $.fs.read(path).then((t) => JSON.parse(t) as Partial<typeof results>, () => undefined).catch(() => undefined)
  if (prior?.v !== 'spike-1' || !prior.checks) return
  const checks = results.checks as Record<string, { status: Status }>
  for (const [name, check] of Object.entries(prior.checks as Record<string, { status: Status }>)) {
    const current = checks[name]
    if (current && (current.status === 'not-run' || current.status === 'pending')) checks[name] = check
  }
  results.events = [...(prior.events ?? []), ...results.events].slice(-MAX_EVENTS)
  grade()
}

function noteRateLimits(list: unknown, from: string) {
  if (!Array.isArray(list)) return
  const r = results.checks.rateLimits
  const rows = list.filter((x): x is SessionRateLimit => typeof x?.kind === 'string' && typeof x?.percentUsed === 'number')
  r.latest = rows.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, ...(resetsAt ? { resetsAt } : {}) }))
  if (rows.length > 0) {
    r.nonEmptySeen = true
    r.from = r.from ?? from
  }
  for (const row of rows) if (!r.kinds.includes(row.kind)) r.kinds.push(row.kind)
}

async function checkTapSpool($: EngineInterface) {
  const p = await paths($).catch(() => undefined)
  if (!p) return
  const text = await $.fs.read(p.tap).catch(() => undefined)
  if (text === undefined) {
    results.checks.measureAndSpool.tapSpool = { found: false, path: p.tap }
    return
  }
  try {
    const j = JSON.parse(text) as Record<string, unknown>
    const usage = (j.usage ?? {}) as Record<string, unknown>
    results.checks.measureAndSpool.tapSpool = {
      found: true,
      parseOk: true,
      path: p.tap,
      v: j.v,
      seq: j.seq,
      event: j.event,
      sessionMatches: j.sessionId === p.sid,
      usageKeys: Object.keys(usage),
    }
  } catch {
    results.checks.measureAndSpool.tapSpool = { found: true, parseOk: false, path: p.tap, length: text.length }
  }
}

/** The structure of a value with its text removed: strings become "<string N>" unless `keepShort`. */
function shape(v: unknown, keepShort: boolean, depth = 0): unknown {
  if (depth > 6) return '<deeper>'
  if (v === null || typeof v === 'boolean' || typeof v === 'number') return v
  if (typeof v === 'string') return keepShort && v.length <= 64 && !/[\r\n]/.test(v) ? v : `<string ${v.length}>`
  if (Array.isArray(v)) return { length: v.length, first: v.length > 0 ? shape(v[0], keepShort, depth + 1) : undefined }
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, keepShort, depth + 1)]))
  return typeof v
}

function within<T>($: EngineInterface, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = $.clock.after(TIMEOUT_MS, () => reject(new Error(`timed out after ${TIMEOUT_MS} ms`)))
    p.then(
      (v) => (timer.cancel(), resolve(v)),
      (e: unknown) => (timer.cancel(), reject(e)),
    )
  })
}

async function mcpCheck($: EngineInterface, tool: 'list_sessions' | 'get_usage', args: Record<string, unknown>): Promise<McpCheck & { parsed?: unknown }> {
  const t0 = await $.clock.now()
  try {
    const r: McpToolResult = await within($, $.mcp.call('ccd_session_mgmt', tool, args))
    const text = (r.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {}
    return {
      status: r.isError ? 'fail' : 'pass',
      at: await iso($),
      ms: (await $.clock.now()) - t0,
      isError: r.isError,
      blocks: r.content?.length,
      textLength: text.length,
      json: parsed !== undefined,
      ...(r.isError ? { error: text.slice(0, 200) } : {}),
      parsed,
    }
  } catch (err) {
    return { status: 'fail', at: await iso($), ms: (await $.clock.now()) - t0, error: errText(err) }
  }
}

async function runChecks($: EngineInterface) {
  const sid = await $.session.id()

  const { parsed: list, ...listCheck } = await mcpCheck($, 'list_sessions', { limit: 5 })
  const rows = Array.isArray(list) ? list : (list as { sessions?: unknown } | undefined)?.sessions
  results.checks.mcpListSessions = { ...listCheck, count: Array.isArray(rows) ? rows.length : undefined, shape: shape(list, false) }
  await event($, 'mcp.list_sessions', listCheck.status)

  const { parsed: usage, ...usageCheck } = await mcpCheck($, 'get_usage', {})
  const u = (usage ?? {}) as Record<string, unknown>
  const { plan, ...rest } = u
  const ctx = u.context as { session_id?: unknown } | undefined
  results.checks.mcpGetUsage = {
    ...usageCheck,
    shape: usage === undefined ? undefined : { ...(shape(rest, false) as object), plan: shape(plan, true) },
    selfIsThisSession: typeof ctx?.session_id === 'string' ? ctx.session_id === sid : undefined,
  }
  await event($, 'mcp.get_usage', usageCheck.status)

  const p = await paths($)
  const t0 = await $.clock.now()
  const h = results.checks.httpSocket
  h.socketPath = p?.sock
  try {
    if (!p) throw new Error('no socket path')
    const r = await within($, $.http.fetch('http://signalbox-spike/ping', { method: 'GET', socketPath: p.sock }))
    let reply: unknown
    try {
      reply = JSON.parse(r.text)
    } catch {
      reply = `<non-JSON, ${r.text.length} chars>`
    }
    Object.assign(h, { status: r.ok ? 'pass' : 'fail', httpStatus: r.status, reply, error: undefined })
  } catch (err) {
    Object.assign(h, { status: 'fail', httpStatus: undefined, reply: undefined, error: errText(err) })
  }
  h.at = await iso($)
  h.ms = (await $.clock.now()) - t0
  await event($, 'http.socket', h.status)
  await checkTapSpool($)
  await save($)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      results.surface = e.surface
      results.isInteractive = e.isInteractive
      results.surfaces = await $.session.surfaces().catch(() => undefined)
      const v = await $.session.version().catch(() => undefined)
      results.engine = v && { version: v.version, base: v.base }
      noteRateLimits((await $.session.usage().catch(() => undefined))?.rateLimits, 'usage() at start')
      await $.command.register({ name: 'spike-status', description: 'Signalbox spike: show results' })
      await $.command.register({ name: 'spike-check', description: 'Signalbox spike: read-only MCP and socket checks' })
      await $.command.register({ name: 'spike-rename', description: 'Signalbox spike: /rename this session via $.command.run', argumentHint: '[name]' })
      await event($, 'session.start', `surface=${String(e.surface)}`)
      await save($)
      $.ui.toast('spike-probe loaded: /spike-check, /spike-rename, /spike-status')
    } catch (err) {
      $.ui.toast(`spike-probe start failed: ${errText(err)}`)
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    try {
      const m = results.checks.measureAndSpool
      m.measures += 1
      for (const unit of e.changed ?? []) if (!m.changed.includes(unit)) m.changed.push(unit)
      m.lastContextPercent = e.context?.percent
      m.lastCostUsd = e.cost?.usd
      noteRateLimits(e.rateLimits, 'session.measure')
      await event($, 'session.measure', (e.changed ?? []).join(','))
      await save($)
      // Let signalbox-tap's own measure hook finish its write before we look for the file.
      $.clock.after(1500, async () => {
        try {
          await checkTapSpool($)
          await save($)
        } catch {}
      })
    } catch {}
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      await event($, 'session.end', e.reason)
      await save($)
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'spike-status' }, async ($) => {
    await checkTapSpool($).catch(() => undefined)
    await save($)
    const where = `session ${results.sessionId} · engine ${results.engine?.version} · surface ${String(results.surface)} · surfaces ${(results.surfaces ?? []).join(',') || 'none'}`
    return { text: `${summary()}\n${where}\n\n${JSON.stringify(results.checks, null, 2)}` }
  })

  on('command.run', { command: 'spike-check' }, async ($) => {
    await runChecks($)
    return { text: `${summary()}\n\n${JSON.stringify({ mcpListSessions: results.checks.mcpListSessions, mcpGetUsage: results.checks.mcpGetUsage, httpSocket: results.checks.httpSocket }, null, 2)}` }
  })

  on('command.run', { command: 'spike-rename' }, async ($, e) => {
    const name = (e.args.replace(/[\r\n]+/g, ' ').trim() || `signalbox-spike-${(await iso($)).slice(11, 19).replace(/:/g, '')}`).slice(0, 60)
    const r = results.checks.rename
    Object.assign(r, { status: 'pending', name, outputHead: undefined, error: undefined })
    // $.command.run rejects inside a hook the turn waits on, so it runs from a timer once this command is done.
    $.clock.after(50, async () => {
      const t0 = await $.clock.now()
      try {
        const out = await within($, $.command.run({ command: 'rename', args: name }))
        Object.assign(r, { status: 'pass', outputHead: (out.text ?? '').slice(0, 160) })
      } catch (err) {
        Object.assign(r, { status: 'fail', error: errText(err) })
      }
      r.at = await iso($)
      r.ms = (await $.clock.now()) - t0
      await event($, 'rename', r.status)
      await save($)
      $.ui.toast(`spike-rename: ${r.status}${r.error ? ` (${r.error})` : ''}`)
    })
    return { text: `Queued /rename ${name}. Check that the session title changed, then run /spike-status.` }
  })
}

import { expect, mock, test } from 'claude-code/testing'

const HOME = '/Users/synthetic'
const PATH = `${HOME}/Library/Application Support/signalbox/spool/sess-engine.json`
const NOW = Date.parse('2026-10-09T12:00:00.000Z')
const USAGE = {
  startedAt: NOW - 1000,
  context: { tokens: 48000, window: 1000000, percent: 5 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-09T15:00:00.000Z' }],
  cost: { usd: 1.25 },
}

test('start, measure and end write v1 spools through the real host', async ($, on) => {
  const writes: Array<{ path: string; text: string }> = []
  const reads: string[] = []
  const calls: string[] = []
  mock.env(on, { HOME })
  mock.clock(on, { now: NOW })
  on('session.id', () => { calls.push('session.id'); return { value: 'sess-engine' } })
  on('session.usage', () => { calls.push('session.usage'); return { value: USAGE } })
  on('fs.read', ($, e) => { reads.push(e.path); return { value: JSON.stringify({ v: 1, seq: 5 }) } })
  const logs: string[] = []
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('fs.write', ($, e) => { writes.push({ path: e.path, text: e.text }); return { value: undefined } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))

  expect(await $.session.start({ cwd: '/tmp/scratch', surface: 'desktop', isInteractive: true })).toEqual({ cwd: '/tmp/scratch' })
  const measure = {
    context: { tokens: 90000, window: 1000000, percent: 9 },
    rateLimits: [{ kind: 'seven_day_fable', percentUsed: 7 }],
    cost: { usd: 2 },
    changed: ['context', 'cost'] as Array<'context' | 'cost'>,
  }
  expect(await $.session.measure(measure)).toEqual({ changed: ['context', 'cost'] })
  expect(await $.session.end({ reason: 'clear', sessionId: 'sess-engine', resume: { id: 'sess-engine' } })).toEqual({ sessionId: 'sess-engine' })

  const spools = writes.map((w) => ({ path: w.path, ...JSON.parse(w.text) }))
  const ours = spools.filter((s) => s.path === PATH)
  expect(ours.map((s) => [s.event, s.seq])).toEqual([
    ...(ours.length === 4 ? [['session.start', 6]] : []),
    ...[['session.start', ours.length === 4 ? 7 : 6], ['session.measure', ours.length === 4 ? 8 : 7], ['session.end', ours.length === 4 ? 9 : 8]],
  ] as never)
  const last3 = ours.slice(-3)
  expect(last3[0]).toMatchObject({ v: 1, agent: 'claude-code', sessionId: 'sess-engine', writtenAt: '2026-10-09T12:00:00.000Z', usage: { context: USAGE.context, rateLimits: USAGE.rateLimits, cost: USAGE.cost } })
  expect(last3[1].usage).toEqual({ context: measure.context, rateLimits: measure.rateLimits, cost: measure.cost })
  expect(reads).toEqual([PATH])
  expect(writes.length).toBe(ours.length)
  expect(logs).toEqual([])
  expect(calls.filter((c) => c === 'session.usage').length).toBe(ours.length - 1)
})

test('exactly three writes: loading does not fire session.start by itself', async ($, on) => {
  const writes: string[] = []
  mock.env(on, { HOME })
  mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'sess-engine' }))
  on('session.usage', () => ({ value: USAGE }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.write', ($, e) => { writes.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: '/tmp/scratch', surface: null, isInteractive: false })
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })
  await $.session.end({ reason: 'other', sessionId: 'sess-engine', resume: { id: 'sess-engine' } })
  const parsed = writes.map((t) => JSON.parse(t))
  expect(parsed.map((p) => [p.event, p.seq])).toEqual([['session.start', 1], ['session.measure', 2], ['session.end', 3]])
  expect('usage' in parsed[1]).toBe(false)
})

test('a refused write is swallowed and the engine result still comes back', async ($, on) => {
  const logs: string[] = []
  mock.env(on, { HOME })
  mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'sess-engine' }))
  on('session.usage', () => ({ value: USAGE }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.write', () => ({ deny: 'EACCES' }))
  on('ui.log', ($, e) => { logs.push(`${e.to}:${e.text}`); return { value: undefined } })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  expect(await $.session.measure({ context: { window: 1 }, rateLimits: [], changed: ['context'] })).toEqual({ changed: ['context'] })
  expect(logs.length).toBe(1)
  expect(logs[0]?.startsWith('debug:signalbox-tap: session.measure not written')).toBe(true)
})

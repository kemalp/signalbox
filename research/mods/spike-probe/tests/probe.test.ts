import { expect, mock, test } from 'claude-code/testing'

const HOME = '/Users/synthetic'
const BASE = `${HOME}/Library/Application Support/signalbox`
const SID = 'sess-probe'
const NOW = Date.parse('2026-10-09T12:00:00.000Z')

test('measure, check and rename record shapes and verdicts', async ($, on) => {
  const files = new Map<string, string>()
  const registered: string[] = []
  const mcpCalls: string[] = []
  const fetches: Array<{ url: string; socketPath?: string }> = []
  const ran: string[] = []
  const toasts: string[] = []
  const statuses: string[] = []
  mock.env(on, { HOME })
  const clock = mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: SID }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1000000 }, rateLimits: [] } }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('session.version', () => ({ value: { version: '2.1.293', base: '2.1.293' } }))
  on('command.register', ($, e) => { registered.push(e.name); return { value: { command: e.name } } })
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path)! } : { deny: 'ENOENT' }))
  on('fs.write', ($, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { statuses.push(String(e.text)); return { value: undefined } })
  on('mcp.call', ($, e) => {
    mcpCalls.push(`${e.server}/${e.tool}`)
    const body = e.tool === 'list_sessions'
      ? [{ sessionId: 's1', title: 'secret project title', cwd: '/Users/x/secret' }, { sessionId: 's2', title: 'another' }]
      : { plan: { status: 'ok', limits: [{ label: 'Weekly (Fable)', percent: 12, resets_at: '2026-10-12T00:00:00Z' }] }, context: { session_id: SID, tokens: 1234, categories: [{ name: 'Messages: about my secret plan', tokens: 99 }] } }
    return { value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false } }
  })
  on('http.fetch', ($, e) => {
    fetches.push({ url: e.url, socketPath: e.init?.socketPath })
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, nonce: 'abc12345' }) } }
  })
  on('command.run', ($, e) => { ran.push(`${e.command} ${e.args}`); return { text: `Session renamed to: ${e.args}` } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))

  await $.session.start({ cwd: '/tmp/scratch', surface: 'desktop', isInteractive: true })
  expect(registered.sort()).toEqual(['spike-check', 'spike-rename', 'spike-status'])
  const resultsPath = `${BASE}/spool/spike-results-${SID}.json`
  expect(files.has(resultsPath)).toBe(true)

  // the tap's file, as signalbox-tap would have written it
  files.set(`${BASE}/spool/${SID}.json`, JSON.stringify({ v: 1, seq: 2, agent: 'claude-code', sessionId: SID, event: 'session.measure', usage: { cost: { usd: 1 } } }))
  await $.session.measure({ context: { tokens: 5000, window: 1000000, percent: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 3 }, { kind: 'seven_day_fable', percentUsed: 9 }], cost: { usd: 1 }, changed: ['context', 'rateLimits', 'cost'] })
  await clock.advance(2000)
  let r = JSON.parse(files.get(resultsPath)!)
  expect(r.checks.measureAndSpool.status).toBe('pass')
  expect(r.checks.measureAndSpool.tapSpool).toMatchObject({ found: true, parseOk: true, v: 1, seq: 2, sessionMatches: true })
  expect(r.checks.rateLimits).toMatchObject({ status: 'pass', kinds: ['five_hour', 'seven_day_fable'] })

  const check = await $.command.run({ command: 'spike-check' })
  expect(check.text).toContain('mcp list pass')
  expect(mcpCalls).toEqual(['ccd_session_mgmt/list_sessions', 'ccd_session_mgmt/get_usage'])
  expect(fetches).toEqual([{ url: 'http://signalbox-spike/ping', socketPath: `${BASE}/spike.sock` }])
  r = JSON.parse(files.get(resultsPath)!)
  expect(r.checks.mcpListSessions).toMatchObject({ status: 'pass', count: 2, json: true })
  expect(r.checks.mcpGetUsage).toMatchObject({ status: 'pass', selfIsThisSession: true })
  expect(r.checks.mcpGetUsage.shape.plan.limits.first.label).toBe('Weekly (Fable)')
  expect(r.checks.httpSocket).toMatchObject({ status: 'pass', httpStatus: 200, reply: { ok: true, nonce: 'abc12345' } })
  const dump = files.get(resultsPath)!
  for (const secret of ['secret project title', '/Users/x/secret', 'about my secret plan', 'another']) expect(dump.includes(secret)).toBe(false)

  const rename = await $.command.run({ command: 'spike-rename', args: 'sb spike' })
  expect(rename.text).toContain('Queued /rename sb spike')
  await clock.advance(100)
  expect(ran).toEqual(['rename sb spike'])
  r = JSON.parse(files.get(resultsPath)!)
  expect(r.checks.rename).toMatchObject({ status: 'pass', name: 'sb spike', outputHead: 'Session renamed to: sb spike' })
  expect(r.checks.modelGlobalDefault.status).toBe('not-run')
  expect(statuses.at(-1)).toContain('rename pass')
})

test('every active check fails soft: refused MCP, refused socket, rejected rename', async ($, on) => {
  const files = new Map<string, string>()
  mock.env(on, { HOME })
  const clock = mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: SID }))
  on('session.usage', () => ({ deny: 'no usage' }))
  on('session.surfaces', () => ({ value: [] }))
  on('session.version', () => ({ value: { version: '2.1.293' } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path)! } : { deny: 'ENOENT' }))
  on('fs.write', ($, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('mcp.call', () => ({ deny: 'no server named ccd_session_mgmt' }))
  on('http.fetch', () => ({ deny: 'ECONNREFUSED' }))
  on('command.run', ($, e) => { throw new Error(`no command named /${e.command}`) })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/tmp/scratch', surface: null, isInteractive: false })
  await $.session.measure({ context: { window: 1 }, rateLimits: [], changed: ['context'] })
  await clock.advance(2000)
  const check = await $.command.run({ command: 'spike-check' })
  expect(check.text).toContain('mcp list fail')
  await $.command.run({ command: 'spike-rename', args: '' })
  await clock.advance(100)
  const r = JSON.parse(files.get(`${BASE}/spool/spike-results-${SID}.json`)!)
  expect(r.checks.measureAndSpool).toMatchObject({ status: 'fail', measures: 1, tapSpool: { found: false } })
  expect(r.checks.rateLimits.status).toBe('fail')
  expect(r.checks.mcpListSessions.status).toBe('fail')
  expect(r.checks.mcpGetUsage.status).toBe('fail')
  expect(r.checks.httpSocket.status).toBe('fail')
  expect(r.checks.rename.status).toBe('fail')
  expect(r.checks.rename.name).toMatch(/^signalbox-spike-\d{6}$/)
})

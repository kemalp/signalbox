const LOG = "/tmp/signalbox-research/ext-control/mods/probe-log.jsonl"
const lines = []
async function log($, obj) {
  lines.push(JSON.stringify({ t: await $.clock.now(), ...obj }))
  await $.fs.write(LOG, lines.join("\n") + "\n")
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  on("session.start", async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: "cm-usage", description: "Print usage snapshot as JSON" })
    const usage = await $.session.usage()
    const cmds = await $.command.list()
    await log($, { ev: "session.start", usage, commandCount: cmds.length,
      bySource: cmds.reduce((a, c) => (a[c.source] = (a[c.source] || 0) + 1, a), {}),
      builtins: cmds.filter(c => c.source === "builtin").map(c => c.name) })
    return started
  })
  on("command.run", { command: "cm-usage" }, async ($) => {
    const u = await $.session.usage({ breakdown: "summary" })
    return { text: JSON.stringify({ startedAt: u.startedAt, context: { tokens: u.context.tokens, window: u.context.window, percent: u.context.percent, categories: (u.context.breakdown?.categories ?? []).map(c => c.name) }, rateLimits: u.rateLimits, cost: u.cost }) }
  })
  on("session.receive", async ($, e, next) => {
    await log($, { ev: "session.receive", origin: e.origin, text: e.text.slice(0, 200) })
    if (e.text.startsWith("CM:")) {
      const cmd = e.text.slice(3).trim()
      const [name, ...rest] = cmd.split(" ")
      $.clock.after(50, async () => {
        try {
          const r = await $.command.run({ command: name, args: rest.join(" ") })
          await log($, { ev: "command.run.result", name, text: (r.text ?? "").slice(0, 300) })
        } catch (err) {
          await log($, { ev: "command.run.error", name, err: String(err) })
        }
      })
      return { consumed: "cm-probe control message" }
    }
    return next(e)
  })
}

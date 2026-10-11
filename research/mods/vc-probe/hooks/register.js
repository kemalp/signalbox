const LOG = "/tmp/signalbox-research/verify-control/out/vc-log.jsonl"
const lines = []
async function log($, obj) {
  lines.push(JSON.stringify({ t: await $.clock.now(), ...obj }))
  await $.fs.write(LOG, lines.join("\n") + "\n")
}
export const register = (on) => {
  on("session.start", async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: "vc-usage", description: "usage json" })
    await log($, { ev: "session.start", usage: await $.session.usage() })
    return r
  })
  on("command.run", { command: "vc-usage" }, async ($) => {
    const u = await $.session.usage({ breakdown: "summary" })
    return { text: JSON.stringify({ keys: Object.keys(u), ctxKeys: Object.keys(u.context||{}), tokens: u.context.tokens, window: u.context.window, percent: u.context.percent, nCats: (u.context.breakdown?.categories||[]).length, rateLimits: u.rateLimits, cost: u.cost }) }
  })
  on("session.receive", async ($, e, next) => {
    await log($, { ev: "session.receive", origin: e.origin, text: String(e.text).slice(0, 80) })
    if (String(e.text).startsWith("VC:")) {
      const cmd = e.text.slice(3).trim()
      const [name, ...rest] = cmd.split(" ")
      $.clock.after(50, async () => {
        try {
          if (name === "compact-direct") {
            const r = await $.session.compact({ instructions: "x" })
            await log($, { ev: "session.compact.result", r })
          } else if (name === "usage") {
            await log($, { ev: "usage", u: await $.session.usage() })
          } else {
            const r = await $.command.run({ command: name, args: rest.join(" ") })
            await log($, { ev: "command.run.result", name, text: String(r.text ?? JSON.stringify(r)).slice(0, 200) })
          }
        } catch (err) { await log($, { ev: "error", name, err: String(err).slice(0, 300) }) }
      })
      return { consumed: "vc-probe" }
    }
    return next(e)
  })
}

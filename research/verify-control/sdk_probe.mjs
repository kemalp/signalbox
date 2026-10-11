import { query } from "/tmp/signalbox-research/verify-control/sdk/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
let release; const hold = new Promise(r => release = r);
async function* input() { await hold; }
const q = query({ prompt: input(), options: { cwd: "/tmp/signalbox-research/verify-control/w8", pathToClaudeCodeExecutable: "claude", settingSources: [], persistSession: false, env: { ...process.env } } });
const out = {};
try { const cmds = await q.supportedCommands(); out.supportedCommands_n = cmds.length; out.has_context = cmds.some(c => c.name === "context"); } catch (e) { out.supportedCommands_err = String(e).slice(0, 200); }
try { const c = await q.getContextUsage(); out.contextUsage_keys = Object.keys(c||{}); out.ctx = { totalTokens: c?.totalTokens, maxTokens: c?.maxTokens, percentage: c?.percentage, autoCompactThreshold: c?.autoCompactThreshold, isAutoCompactEnabled: c?.isAutoCompactEnabled }; } catch (e) { out.contextUsage_err = String(e).slice(0, 200); }
try { const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }); out.usage_keys = Object.keys(u||{}); out.usage = { subscription_type: u?.subscription_type, rate_limits_available: u?.rate_limits_available, rate_limits: u?.rate_limits, session_cost: u?.session?.total_cost_usd }; } catch (e) { out.usage_err = String(e).slice(0, 200); }
try { const s = await q.getStatus(); out.status_sections = (s?.sections||[]).map(x => x.title); } catch (e) { out.status_err = String(e).slice(0, 200); }
try { await q.setModel("haiku"); out.setModel = "ok"; } catch (e) { out.setModel_err = String(e).slice(0, 200); }
console.log(JSON.stringify(out, null, 1));
release(); q.close?.(); process.exit(0);

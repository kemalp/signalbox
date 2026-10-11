// Transcript-derived session details: the last main-thread response of a session.
import { findFromEnd } from "./lines.ts";
import { tokensOf } from "./usage.ts";
import { isObj, str, toIso } from "./util.ts";

export interface LastResponse {
  ts: string;
  model: string;
  /** input + cacheRead + cacheWrite5m + cacheWrite1h of that response: the prompt size it sent. */
  contextTokens: number;
  effort?: string;
  version?: string;
}

export function lastResponseFromLine(line: string): LastResponse | undefined {
  if (!line.includes('"assistant"')) return undefined;
  let d: unknown;
  try {
    d = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObj(d) || d.type !== "assistant" || d.isSidechain === true || d.isApiErrorMessage === true) return undefined;
  const m = isObj(d.message) ? d.message : undefined;
  const model = str(m?.model);
  if (!m || !model || model === "<synthetic>" || !isObj(m.usage)) return undefined;
  const ts = toIso(d.timestamp);
  if (!ts) return undefined;
  const t = tokensOf(m.usage, "main");
  const out: LastResponse = { ts, model, contextTokens: t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h };
  const effort = str(d.effort);
  if (effort) out.effort = effort;
  const version = str(d.version);
  if (version) out.version = version;
  return out;
}

/** Last main-thread assistant response in a main transcript, reading only the file's tail. */
export async function lastMainResponse(path: string): Promise<LastResponse | undefined> {
  try {
    return await findFromEnd(path, lastResponseFromLine);
  } catch {
    return undefined; // vanished or unreadable
  }
}

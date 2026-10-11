// Model metadata (context window, max output) and what agents were seen doing with it, embedded like
// the price tables. Pure: lookups and the context-window fill, no I/O.
import { fileURLToPath } from "node:url";
import anthropicModels from "../../../models/anthropic.json" with { type: "json" };
import { matchModelKey } from "./pricing.ts";
import type { AgentId, AgentModelNotes, ContextSnapshot, ModelSpec, ModelTable } from "./types.ts";

/** The repo's `models/` directory, resolved relative to this source file. It does not exist inside a compiled binary. */
export const DEFAULT_MODELS_DIR: string = fileURLToPath(new URL("../../../models/", import.meta.url));

/** Bundled at build time, like the price files. A new `models/*.json` file must be added here too (a test checks). */
const EMBEDDED_MODELS: Readonly<Record<string, unknown>> = {
  "anthropic.json": anthropicModels,
};

export const EMBEDDED_MODEL_FILES: readonly string[] = Object.keys(EMBEDDED_MODELS).sort();

/** The embedded copies of the repo's `models/*.json`, validated, sorted by file name. Each call returns fresh objects. */
export function embeddedModelTables(): ModelTable[] {
  return EMBEDDED_MODEL_FILES.map((name) => parseModelTable(structuredClone(EMBEDDED_MODELS[name]), `models/${name} (embedded)`));
}

export interface ModelSpecMatch {
  /** The table key that matched: an exact id or a `prefix*` key. */
  key: string;
  spec: ModelSpec;
  table: ModelTable;
}

/** The documented limits of a model id, matched like prices (exact, canonical, longest prefix). */
export function findModelSpec(model: string, tables: readonly ModelTable[]): ModelSpecMatch | undefined {
  const m = matchModelKey(model, tables);
  return m ? { key: m.key, spec: m.row, table: m.table } : undefined;
}

/** What `agent` was seen doing with these models, from the first table that has notes for it. */
export function agentNotes(agent: AgentId, tables: readonly ModelTable[]): AgentModelNotes | undefined {
  for (const t of tables) {
    const n = t.agents && Object.hasOwn(t.agents, agent) ? t.agents[agent] : undefined;
    if (n) return n;
  }
  return undefined;
}

export interface WindowMatch {
  window: number;
  /** The table key, or the id suffix (e.g. "[1m]") that set the window. */
  key: string;
}

/**
 * The context window for a model id as `agent` runs it: an agent id suffix such as Claude Code's
 * "[1m]" first, then the documented size. Undefined when neither is known (never guessed).
 */
export function contextWindowFor(model: string, tables: readonly ModelTable[], agent?: AgentId): WindowMatch | undefined {
  const id = model.trim();
  if (!id) return undefined;
  const tags = agent ? agentNotes(agent, tables)?.idTags : undefined;
  if (tags) {
    const lower = id.toLowerCase();
    for (const [tag, window] of Object.entries(tags)) if (lower.endsWith(tag.toLowerCase())) return { window, key: tag };
  }
  const m = findModelSpec(id, tables);
  return m ? { window: m.spec.contextWindow, key: m.key } : undefined;
}

/** Where `agent` auto-compacts on a `window`-token context, as a percent, when that window was observed. */
export function autoCompactPercent(agent: AgentId, window: number, tables: readonly ModelTable[]): number | undefined {
  const seen = agentNotes(agent, tables)?.autoCompact?.find((a) => a.contextWindow === window);
  return seen ? Math.round(((seen.thresholdTokens * 100) / window) * 100) / 100 : undefined;
}

/**
 * Completes a context reading: a missing window from the first candidate model id that resolves
 * (`windowSource: "model-table"`), the percent when it is missing, and the agent's observed
 * auto-compact point for that window. A window the agent reported always wins.
 */
export function fillContextWindow(
  snap: ContextSnapshot,
  models: ReadonlyArray<string | undefined>,
  tables: readonly ModelTable[],
): ContextSnapshot {
  const out: ContextSnapshot = { ...snap };
  if (!(out.window !== undefined && out.window > 0)) {
    delete out.window;
    for (const model of models) {
      const found = model ? contextWindowFor(model, tables, snap.agent) : undefined;
      if (!found) continue;
      // A prompt bigger than the documented window means the session runs a larger one (e.g. a 1M
      // variant its model id doesn't show), so the table is wrong for it: leave the window unknown.
      if (snap.tokens <= found.window) {
        out.window = found.window;
        out.windowSource = "model-table";
      }
      break;
    }
  }
  if (out.window !== undefined) {
    if (out.percent === undefined) out.percent = Math.round((out.tokens / out.window) * 1000) / 10;
    if (out.autoCompactAtPercent === undefined) {
      const at = autoCompactPercent(snap.agent, out.window, tables);
      if (at !== undefined) out.autoCompactAtPercent = at;
    }
  }
  return out;
}

// ---------- Validation ----------

const STABILITIES = new Set(["documented", "preview", "internal"]);

/** Validates an already-parsed model table. Unknown keys are kept. */
export function parseModelTable(json: unknown, source = "model table"): ModelTable {
  const fail = (msg: string): never => {
    throw new Error(`${source}: ${msg}`);
  };
  if (!isObject(json)) return fail("not an object");
  for (const field of ["provider", "asOf", "sourceUrl"] as const) {
    if (!isText(json[field])) fail(`"${field}" must be a non-empty string`);
  }
  if (!isObject(json.models)) return fail(`"models" must be an object`);
  for (const [key, row] of Object.entries(json.models)) {
    const where = `models["${key}"]`;
    if (key === "" || key === "*" || key.slice(0, -1).includes("*")) fail(`${where}: bad key ("*" only as a suffix of a non-empty prefix)`);
    if (!isObject(row)) return fail(`${where} must be an object`);
    if (!isCount(row.contextWindow)) fail(`${where}.contextWindow must be a positive whole number`);
    if (row.maxOutput !== undefined && !isCount(row.maxOutput)) fail(`${where}.maxOutput must be a positive whole number`);
    if (!isText(row.asOf) || !isText(row.sourceUrl)) fail(`${where}: "asOf" and "sourceUrl" must be non-empty strings`);
  }
  if (json.agents !== undefined) {
    if (!isObject(json.agents)) return fail(`"agents" must be an object`);
    for (const [agent, n] of Object.entries(json.agents)) {
      const where = `agents["${agent}"]`;
      if (!isObject(n)) return fail(`${where} must be an object`);
      if (typeof n.stability !== "string" || !STABILITIES.has(n.stability)) fail(`${where}.stability must be documented, preview or internal`);
      for (const field of ["observedIn", "asOf", "source"] as const) if (!isText(n[field])) fail(`${where}.${field} must be a non-empty string`);
      if (n.idTags !== undefined) {
        if (!isObject(n.idTags)) return fail(`${where}.idTags must be an object`);
        for (const [tag, w] of Object.entries(n.idTags)) {
          if (!/^\[[^\]]+\]$/.test(tag)) fail(`${where}.idTags: "${tag}" must look like "[1m]"`);
          if (!isCount(w)) fail(`${where}.idTags["${tag}"] must be a positive whole number`);
        }
      }
      if (n.autoCompact !== undefined) {
        if (!Array.isArray(n.autoCompact)) return fail(`${where}.autoCompact must be an array`);
        for (const [i, a] of n.autoCompact.entries()) {
          if (!isObject(a) || !isCount(a.contextWindow) || !isCount(a.thresholdTokens) || a.thresholdTokens > a.contextWindow) {
            fail(`${where}.autoCompact[${i}] needs contextWindow and a thresholdTokens no larger than it (positive whole numbers)`);
          }
        }
      }
      if (n.notes !== undefined && !isTextList(n.notes)) fail(`${where}.notes must be an array of strings`);
    }
  }
  if (json.notes !== undefined && !isTextList(json.notes)) fail(`"notes" must be an array of strings`);
  return json as unknown as ModelTable;
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function isText(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

function isTextList(v: unknown): boolean {
  return Array.isArray(v) && v.every((n) => typeof n === "string");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

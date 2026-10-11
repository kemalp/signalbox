// Turns a Report's byDay rows into stacked series for the daily chart. Pure; no DOM.
import type { CostBreakdown, DayTotals, Report } from "@signalbox/core";
import { dayToDate } from "./format.ts";

export type StackMode = "model" | "kind" | "type";

/** A `byDay` row; its per-day model/kind splits are optional, so older servers still chart by type. */
export type DayRow = DayTotals;

export interface StackSeries {
  key: string;
  label: string;
  /** CSS custom property holding the colour, e.g. "--series-1". */
  color: string;
  values: number[];
  total: number;
}

export interface StackData {
  days: string[];
  xs: number[];
  series: StackSeries[];
  totals: number[];
}

const SLOTS = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5", "--series-6", "--series-7"];
const OTHER = "--series-other";
const OTHER_KEY = "__other__";

const TYPE_SERIES: Array<{ key: keyof CostBreakdown; label: string }> = [
  { key: "cacheRead", label: "Cache reads" },
  { key: "cacheWrite5m", label: "Cache writes (5m)" },
  { key: "cacheWrite1h", label: "Cache writes (1h)" },
  { key: "output", label: "Output" },
  { key: "input", label: "Input (uncached)" },
  { key: "webSearch", label: "Web search" },
];

const KIND_ORDER = ["main", "subagent", "workflow", "auxiliary", "other"];
const KIND_LABEL: Record<string, string> = {
  main: "Main thread",
  subagent: "Subagents",
  workflow: "Workflow agents",
  auxiliary: "Auxiliary",
  other: "Other",
};

// Colour follows the entity, not its rank: a model keeps its slot for the life of the page,
// so changing the range or agent filter never repaints the survivors.
const modelSlots = new Map<string, number>();

function slotForModel(model: string): number | undefined {
  const known = modelSlots.get(model);
  if (known !== undefined) return known;
  if (modelSlots.size >= SLOTS.length) return undefined; // the tail folds into a grey "Other"
  const slot = modelSlots.size;
  modelSlots.set(model, slot);
  return slot;
}

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

export function buildStack(report: Report, mode: StackMode): StackData {
  const rows = report.byDay
    .map((d) => ({ d, date: dayToDate(d.key) }))
    .filter((r): r is { d: DayRow; date: Date } => r.date !== undefined);
  const days = rows.map((r) => r.d.key);
  const xs = rows.map((r) => r.date.getTime() / 1000);
  const series: StackSeries[] = [];

  const push = (key: string, label: string, color: string, values: number[]) => {
    series.push({ key, label, color, values, total: values.reduce((a, b) => a + b, 0) });
  };

  if (mode === "type") {
    TYPE_SERIES.forEach((t, i) => {
      const values = rows.map((r) => r.d.cost[t.key] ?? 0);
      if (t.key === "webSearch" && !values.some((v) => v > 0)) return;
      push(t.key, t.label, SLOTS[i]!, values);
    });
  } else {
    const field = mode === "model" ? "byModel" : "byKind";
    const totals = new Map<string, number>();
    for (const { d } of rows) {
      for (const g of d[field] ?? []) totals.set(g.key, (totals.get(g.key) ?? 0) + g.cost.total);
    }
    let keys = [...totals.keys()];
    const assigned = new Map<string, string>();
    if (mode === "kind") {
      keys.sort((a, b) => {
        const ia = KIND_ORDER.indexOf(a);
        const ib = KIND_ORDER.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
      });
      let extra = KIND_ORDER.length;
      for (const k of keys) {
        const i = KIND_ORDER.indexOf(k);
        const slot = i !== -1 ? i : extra++;
        assigned.set(k, slot < SLOTS.length ? SLOTS[slot]! : OTHER);
      }
    } else {
      keys.sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b));
      for (const k of keys) {
        const slot = slotForModel(k);
        assigned.set(k, slot === undefined ? OTHER : SLOTS[slot]!);
      }
      keys.sort((a, b) => SLOTS.indexOf(assigned.get(a)!) - SLOTS.indexOf(assigned.get(b)!));
      keys = keys.filter((k) => assigned.get(k) !== OTHER).concat(keys.filter((k) => assigned.get(k) === OTHER));
    }
    const other = keys.filter((k) => assigned.get(k) === OTHER);
    for (const k of keys) {
      if (assigned.get(k) === OTHER) continue;
      const values = rows.map((r) => r.d[field]?.find((g) => g.key === k)?.cost.total ?? 0);
      push(k, mode === "kind" ? kindLabel(k) : k, assigned.get(k)!, values);
    }
    if (other.length) {
      const values = rows.map((r) =>
        (r.d[field] ?? []).filter((g) => other.includes(g.key)).reduce((a, g) => a + g.cost.total, 0),
      );
      push(OTHER_KEY, other.length === 1 ? other[0]! : `Other (${other.length})`, OTHER, values);
    }
  }

  const totals = rows.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  return { days, xs, series, totals };
}

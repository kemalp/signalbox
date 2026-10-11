// Daily spend as stacked columns. uPlot owns scales, axes, grid and the cursor; the columns are
// drawn in a `draw` hook so they get the 2px surface gap and a 4px rounded data-end.
import uPlot from "uplot";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Report } from "@signalbox/core";
import { clipId, fmtDayLong, fmtDayShort, fmtUsd, fmtUsdTick, niceCeil } from "./format.ts";
import { buildStack, type DayRow, type StackData, type StackMode } from "./stack.ts";
import { LIST_PRICE_NOTE, Segmented, Usd } from "./ui.tsx";

function useColorScheme(): "light" | "dark" {
  const query = "(prefers-color-scheme: dark)";
  const [scheme, setScheme] = useState<"light" | "dark">(() => (matchMedia(query).matches ? "dark" : "light"));
  useEffect(() => {
    const mq = matchMedia(query);
    const onChange = () => setScheme(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return scheme;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const HEIGHT = 240;
const DAY_S = 86_400;

function StackChart({ data, onFocusDay }: { data: StackData; onFocusDay(text: string): void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const kbIdx = useRef<number | null>(null);
  const scheme = useColorScheme();

  useEffect(() => {
    const box = boxRef.current;
    const tip = tipRef.current;
    if (!box || !tip) return;
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const colors = data.series.map((s) => v(s.color));
    const ink2 = v("--ink-2");
    const muted = v("--muted");
    const font = `11px ${v("--font") || "system-ui, sans-serif"}`;
    const n = data.xs.length;
    const first = data.xs[0]!;
    const last = data.xs[n - 1]!;
    const yMax = niceCeil(Math.max(0, ...data.totals) * 1.08);
    const width = Math.max(240, box.clientWidth);
    const labelled = data.series.length <= 4 && width >= 560;
    const band = el("div", "hover-band");
    band.hidden = true;

    const slotPx = (u: uPlot, canvas: boolean) =>
      n > 1
        ? Math.abs(u.valToPos(data.xs[1]!, "x", canvas) - u.valToPos(data.xs[0]!, "x", canvas))
        : u.bbox.width / (canvas ? 1 : uPlot.pxRatio);

    const draw = (u: uPlot) => {
      const ctx = u.ctx;
      const dpr = uPlot.pxRatio;
      const { left, top, width: bw, height: bh } = u.bbox;
      const barW = Math.max(2 * dpr, Math.min(24 * dpr, slotPx(u, true) * 0.62));
      const gap = 2 * dpr;
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, bw, bh);
      ctx.clip();
      const labelSpots: Array<{ y: number; text: string }> = [];
      for (let i = 0; i < n; i++) {
        const x0 = Math.round(u.valToPos(data.xs[i]!, "x", true) - barW / 2);
        const vals = data.series.map((s) => s.values[i] ?? 0);
        let topJ = -1;
        vals.forEach((val, j) => {
          if (val > 0) topJ = j;
        });
        let acc = 0;
        let below = false;
        for (let j = 0; j < vals.length; j++) {
          const val = vals[j]!;
          if (!(val > 0)) continue;
          const yBase = u.valToPos(acc, "y", true);
          acc += val;
          const yTop = u.valToPos(acc, "y", true);
          const bottom = below ? yBase - gap : yBase;
          const h = bottom - yTop;
          if (h < 1) continue; // too thin to see; still in the tooltip and the table
          ctx.fillStyle = colors[j]!;
          ctx.beginPath();
          if (j === topJ) {
            const r = Math.min(4 * dpr, h, barW / 2);
            ctx.roundRect(x0, yTop, barW, h, [r, r, 0, 0]);
          } else {
            ctx.rect(x0, yTop, barW, h);
          }
          ctx.fill();
          below = true;
          if (labelled && i === n - 1 && h >= 14 * dpr) labelSpots.push({ y: yTop + h / 2, text: data.series[j]!.label });
        }
      }
      ctx.restore();
      if (labelSpots.length && u.width >= 560) {
        const x = u.valToPos(last, "x", true) + barW / 2 + 6 * dpr;
        const maxW = u.width * dpr - x - 4 * dpr;
        ctx.save();
        ctx.font = `${11 * dpr}px ${v("--font") || "system-ui, sans-serif"}`;
        ctx.fillStyle = ink2;
        ctx.textAlign = "left"; // uPlot leaves the axes' alignment on the context
        ctx.textBaseline = "middle";
        for (const s of labelSpots) {
          let t = s.text;
          while (t.length > 3 && ctx.measureText(t).width > maxW) t = `${t.slice(0, -2)}…`;
          ctx.fillText(t, x, s.y);
        }
        ctx.restore();
      }
    };

    const showTip = (u: uPlot, idx: number) => {
      const dpr = uPlot.pxRatio;
      const slot = slotPx(u, false);
      const cx = u.valToPos(data.xs[idx]!, "x");
      band.hidden = false;
      band.style.left = `${cx - slot / 2}px`;
      band.style.width = `${slot}px`;

      tip.replaceChildren();
      tip.appendChild(el("div", "tip-head", fmtDayLong(data.days[idx]!)));
      let any = false;
      for (let j = data.series.length - 1; j >= 0; j--) {
        const s = data.series[j]!;
        const val = s.values[idx] ?? 0;
        if (!(val > 0)) continue;
        any = true;
        const row = el("div", "tip-row");
        const key = el("span", "tip-key");
        key.style.background = colors[j]!;
        row.append(key, el("span", "tip-val", fmtUsd(val)), el("span", "tip-name", s.label));
        tip.appendChild(row);
      }
      const total = el("div", "tip-row tip-total");
      total.append(el("span"), el("span", "tip-val", fmtUsd(data.totals[idx])), el("span", "tip-name", any ? "Total" : "No spend recorded"));
      tip.appendChild(total);
      tip.hidden = false;

      const plotLeft = u.bbox.left / dpr;
      const plotTop = u.bbox.top / dpr;
      const boxW = box.clientWidth;
      const tw = tip.offsetWidth;
      let x = plotLeft + cx + slot / 2 + 8;
      if (x + tw > boxW) x = plotLeft + cx - slot / 2 - 8 - tw;
      tip.style.left = `${Math.max(0, x)}px`;
      tip.style.top = `${plotTop + 4}px`;
    };

    const hideTip = () => {
      band.hidden = true;
      tip.hidden = true;
    };

    const opts: uPlot.Options = {
      width,
      height: HEIGHT,
      padding: [10, labelled ? 108 : 8, 0, 0],
      legend: { show: false },
      cursor: { x: false, y: false, points: { show: false }, drag: { x: false, y: false, setScale: false } },
      scales: {
        x: { time: true, range: () => [first - DAY_S / 2, last + DAY_S / 2] },
        y: { range: () => [0, yMax] },
      },
      axes: [
        {
          stroke: muted,
          font,
          grid: { show: false },
          ticks: { show: false },
          gap: 6,
          size: 26,
          space: 46,
          incrs: [DAY_S, 2 * DAY_S, 7 * DAY_S, 14 * DAY_S, 28 * DAY_S],
          values: (_u, splits) => splits.map((s) => fmtDayShort(new Date(s * 1000))),
        },
        {
          stroke: muted,
          font,
          grid: { stroke: v("--grid"), width: 1 },
          ticks: { show: false },
          gap: 6,
          size: 58,
          space: 34,
          values: (_u, splits) => splits.map((s) => fmtUsdTick(s)),
        },
      ],
      series: [{}, ...data.series.map((s) => ({ label: s.label, paths: () => null, points: { show: false } }))],
      hooks: {
        draw: [draw],
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            if (idx === null || idx === undefined || (u.cursor.left ?? -1) < 0) hideTip();
            else showTip(u, idx);
          },
        ],
      },
    };

    const u = new uPlot(opts, [data.xs, ...data.series.map((s) => s.values)], box);
    u.under.appendChild(band);
    plotRef.current = u;
    kbIdx.current = null;

    const ro = new ResizeObserver(() => {
      const w = box.clientWidth;
      if (w && Math.abs(w - u.width) > 1) u.setSize({ width: Math.max(240, w), height: HEIGHT });
    });
    ro.observe(box);
    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
      hideTip();
    };
  }, [data, scheme]);

  const onKeyDown = (e: KeyboardEvent) => {
    const u = plotRef.current;
    const n = data.xs.length;
    if (!u || !n) return;
    let idx = kbIdx.current ?? n - 1;
    if (e.key === "ArrowLeft") idx = Math.max(0, (kbIdx.current ?? n) - 1);
    else if (e.key === "ArrowRight") idx = Math.min(n - 1, (kbIdx.current ?? -1) + 1);
    else if (e.key === "Home") idx = 0;
    else if (e.key === "End") idx = n - 1;
    else if (e.key === "Escape") {
      kbIdx.current = null;
      u.setCursor({ left: -10, top: -10 });
      return;
    } else return;
    e.preventDefault();
    kbIdx.current = idx;
    u.setCursor({ left: u.valToPos(data.xs[idx]!, "x"), top: u.bbox.height / uPlot.pxRatio / 2 });
    onFocusDay(`${fmtDayLong(data.days[idx]!)}: ${fmtUsd(data.totals[idx])} total`);
  };

  const onBlur = () => {
    kbIdx.current = null;
    plotRef.current?.setCursor({ left: -10, top: -10 });
  };

  return (
    <div
      ref={boxRef}
      class="chart-box"
      tabIndex={0}
      role="group"
      aria-label="Daily spend chart. Use the left and right arrow keys to read each day."
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <div ref={tipRef} class="tip" hidden />
    </div>
  );
}

function CompositionBar({ data }: { data: StackData }) {
  const total = data.totals[0] ?? 0;
  if (!(total > 0)) return <p class="empty">No spend recorded for this day yet.</p>;
  const parts = data.series.filter((s) => (s.values[0] ?? 0) > 0);
  return (
    <div>
      <div class="comp" role="img" aria-label={`Today's spend split: ${parts.map((s) => `${s.label} ${fmtUsd(s.values[0])}`).join(", ")}`}>
        {parts.map((s) => (
          <span
            key={s.key}
            title={`${s.label}: ${fmtUsd(s.values[0])}`}
            style={{ flexGrow: s.values[0], flexBasis: 0, background: `var(${s.color})` }}
          />
        ))}
      </div>
      <p class="chart-note">One day selected: showing how today's spend splits. Pick 7d or 30d for the daily trend.</p>
    </div>
  );
}

function DayTable({ data }: { data: StackData }) {
  return (
    <div class="table-wrap day-table">
      <table>
        <caption class="sr-only">Daily spend by series, {LIST_PRICE_NOTE.toLowerCase()}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {data.series.map((s) => (
              <th scope="col" class="num" key={s.key}>
                {s.label}
              </th>
            ))}
            <th scope="col" class="num">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {data.days.map((d, i) => (
            <tr key={d}>
              <th scope="row" class="row-head">
                {fmtDayLong(d)}
              </th>
              {data.series.map((s) => (
                <td class="num" key={s.key}>
                  {fmtUsd(s.values[i])}
                </td>
              ))}
              <td class="num">
                <strong>{fmtUsd(data.totals[i])}</strong>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function readMode(): StackMode {
  try {
    const m = localStorage.getItem("signalbox.stack");
    if (m === "model" || m === "kind" || m === "type") return m;
  } catch {
    // ignore
  }
  return "model";
}

export function DailyChart({ report }: { report: Report }) {
  const byDay: DayRow[] = report.byDay;
  const hasModel = byDay.some((d) => (d.byModel?.length ?? 0) > 0);
  const hasKind = byDay.some((d) => (d.byKind?.length ?? 0) > 0);
  const [mode, setMode] = useState<StackMode>(readMode);
  const [showTable, setShowTable] = useState(false);
  const [announce, setAnnounce] = useState("");
  const effective: StackMode =
    mode === "model" && !hasModel ? (hasKind ? "kind" : "type") : mode === "kind" && !hasKind ? "type" : mode;
  const data = useMemo(() => buildStack(report, effective), [report, effective]);
  const unpriced = new Set(report.totals.unpricedModels);

  const choose = (m: StackMode) => {
    setMode(m);
    try {
      localStorage.setItem("signalbox.stack", m);
    } catch {
      // ignore
    }
  };

  const missing = "This server doesn't send a per-day split for this yet";
  const anySpend = data.totals.some((t) => t > 0);
  return (
    <figure class="card chart-card" aria-labelledby="daily-title">
      <div class="chart-head">
        <h3 class="chart-title" id="daily-title">
          Daily spend <span class="eq">· list-price equivalent, not a bill</span>
        </h3>
        <div class="controls">
          <Segmented<StackMode>
            label="Stack daily spend by"
            value={effective}
            onChange={choose}
            options={[
              { value: "model", label: "Model", disabled: !hasModel, ...(hasModel ? {} : { title: missing }) },
              { value: "kind", label: "Kind", disabled: !hasKind, ...(hasKind ? {} : { title: missing }) },
              { value: "type", label: "Token type" },
            ]}
          />
          <button type="button" class="btn-link" aria-expanded={showTable} onClick={() => setShowTable(!showTable)}>
            {showTable ? "Hide table" : "Show table"}
          </button>
        </div>
      </div>
      {data.series.length && anySpend ? (
        <ul class="legend" aria-label="Series">
          {data.series.map((s) => (
            <li key={s.key}>
              <span class="sw" style={{ background: `var(${s.color})` }} />
              <span title={s.label}>{clipId(s.label, 48)}</span>
              <span class="num">
                <Usd value={s.total} />
              </span>
              {effective === "model" && unpriced.has(s.key) ? (
                <span class="badge amber" title="No price row; counted as $0">
                  unpriced
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {data.days.length === 0 || !anySpend ? (
        <p class="empty">No spend recorded in this range.</p>
      ) : data.days.length === 1 ? (
        <CompositionBar data={data} />
      ) : (
        <StackChart data={data} onFocusDay={setAnnounce} />
      )}
      <p class="sr-only" aria-live="polite">
        {announce}
      </p>
      {showTable ? <DayTable data={data} /> : null}
    </figure>
  );
}

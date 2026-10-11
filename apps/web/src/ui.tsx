import type { ComponentChildren } from "preact";
import type { AgentId, SessionStatus, Stability } from "@signalbox/core";
import { agentLabel, fmtUsd, type Severity } from "./format.ts";

export const LIST_PRICE_NOTE = "List-price equivalent, not a bill";

type IconName = "busy" | "waiting" | "idle" | "unknown" | "ended" | "alert" | "check" | "chevron" | "info";

const ICON_PATHS: Record<IconName, ComponentChildren> = {
  busy: <circle class="pulse" cx="8" cy="8" r="4" fill="currentColor" />,
  waiting: (
    <>
      <path d="M8 2.5 14 13H2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
      <path d="M8 6.5v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <circle cx="8" cy="11.4" r=".9" fill="currentColor" />
    </>
  ),
  idle: <circle cx="8" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.6" />,
  unknown: (
    <>
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4" />
      <path d="M6.4 6.5a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.5-.7 1v.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      <circle cx="8" cy="11.3" r=".8" fill="currentColor" />
    </>
  ),
  ended: <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" />,
  alert: (
    <>
      <path d="M8 2.5 14 13H2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
      <path d="M8 6.5v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <circle cx="8" cy="11.4" r=".9" fill="currentColor" />
    </>
  ),
  check: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="m5.4 8.2 1.8 1.8 3.5-3.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </>
  ),
  chevron: <path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />,
  info: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M8 7.2v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <circle cx="8" cy="5" r=".9" fill="currentColor" />
    </>
  ),
};

export function Icon({ name, size = 14, class: cls }: { name: IconName; size?: number; class?: string }) {
  return (
    <svg class={cls} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {ICON_PATHS[name]}
    </svg>
  );
}

export function BrandMark() {
  return (
    <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="28" height="28" rx="7" fill="#17212e" />
      <rect x="8" y="9" width="16" height="3" rx="1.5" fill="#2cc5b5" />
      <rect x="8" y="14.5" width="11" height="3" rx="1.5" fill="#2cc5b5" opacity=".7" />
      <rect x="8" y="20" width="6" height="3" rx="1.5" fill="#f2b843" />
    </svg>
  );
}

export function AgentBadge({ agent }: { agent: AgentId }) {
  return <span class="agent">{agentLabel(agent)}</span>;
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  busy: "Busy",
  waiting: "Needs you",
  idle: "Idle",
  ended: "Ended",
  unknown: "Unknown",
};

export function StatusPill({ status, since }: { status: SessionStatus; since?: string | undefined }) {
  const label = STATUS_LABEL[status] ?? status;
  return (
    <span class={`pill st-${status in STATUS_LABEL ? status : "unknown"}`}>
      <Icon name={(status in STATUS_LABEL ? status : "unknown") as IconName} size={12} />
      {label}
      {since ? <span class="tabular"> · {since}</span> : null}
    </span>
  );
}

const STABILITY_CLASS: Record<Stability, string> = {
  documented: "teal",
  preview: "amber",
  internal: "",
};

const STABILITY_TITLE: Record<Stability, string> = {
  documented: "Documented by the vendor; expected to stay stable",
  preview: "Preview feature; may change between releases",
  internal: "Undocumented internal format; may break on any release",
};

export function StabilityBadge({ stability }: { stability: Stability }) {
  return (
    <span class={`badge ${STABILITY_CLASS[stability] ?? ""}`} title={STABILITY_TITLE[stability] ?? stability}>
      {stability}
    </span>
  );
}

export function Meter(props: {
  value: number | undefined;
  label: string;
  valueText: string;
  severity: Severity;
  stale?: boolean;
  tick?: number | undefined;
  tickLabel?: string;
}) {
  const v = props.value === undefined ? 0 : Math.max(0, Math.min(100, props.value));
  const cls = props.stale ? "stale" : props.severity === "ok" ? "" : props.severity;
  return (
    <div
      class={`meter ${cls}`}
      role="meter"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={props.value === undefined ? undefined : Math.round(v)}
      aria-valuetext={props.valueText}
    >
      {props.value !== undefined ? <div class="meter-fill" style={{ width: `${v}%` }} /> : null}
      {props.tick !== undefined ? (
        <div class="meter-tick" style={{ left: `${Math.max(0, Math.min(100, props.tick))}%` }} title={props.tickLabel} />
      ) : null}
    </div>
  );
}

/** A dollar figure that always carries the list-price caveat for screen readers and on hover. */
export function Usd({ value, class: cls }: { value: number | undefined; class?: string }) {
  return (
    <span class={cls} title={LIST_PRICE_NOTE}>
      {fmtUsd(value)}
      <span class="sr-only"> ({LIST_PRICE_NOTE.toLowerCase()})</span>
    </span>
  );
}

export function Section(props: {
  id: string;
  title: string;
  count?: number | undefined;
  note?: ComponentChildren;
  actions?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <section class="section" aria-labelledby={`${props.id}-h`}>
      <div class="section-head">
        <h2 id={`${props.id}-h`}>
          {props.title}
          {props.count !== undefined ? <span class="count">{props.count}</span> : null}
        </h2>
        {props.note ? <span class="section-note">{props.note}</span> : null}
        {props.actions}
      </div>
      {props.children}
    </section>
  );
}

export function Segmented<T extends string | number>(props: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean; title?: string }>;
  onChange(v: T): void;
}) {
  return (
    <div class="seg" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          type="button"
          key={String(o.value)}
          aria-pressed={o.value === props.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

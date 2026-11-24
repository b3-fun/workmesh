// Number tickers and deltas (LIBRARY.md "numbers"). A live value rolls digit by digit to its new value with NumberFlow
// (@number-flow/react, MIT, already a dependency: the ported pie chart's centre uses it), the torph idea Sean asked for
// three times, for numbers: tabular figures, so nothing beside it moves; the first render shows the value at once; reduced
// motion swaps it without the roll; a screen reader reads the plain number. A value the console does not have is an em
// dash, never a 0 (the console's rule: lib/format.ts NOT_MEASURED). A delta is a +/- % change against a named period,
// hidden within ±0.05% ("we should not show it if +/- 0.05%"), its colour saying good or bad in the quiet status inks.

import type { Format } from "@number-flow/react";
import { type ReactNode, useEffect, useState } from "react";
import { Icon, type IconName } from "../../ui/Icon";
import { IconTile } from "../layout/node-icon-tile";
import { cn } from "../lib/utils";
import { InFigureTrend } from "./charts/frame";
import { whenLanded } from "./landed";
import { KitLink } from "./link";
import { BrandLogo, type BrandName } from "./logos";
import { tenthsParts } from "./tenths";
import "./css/lite.css";
import "./kit.css";

export { tenthsParts, tenthsText } from "./tenths";

export type TickerFormat = "int" | "compact" | "usd" | "percent" | "ms" | "bytes" | "tenths";

const FORMATS: Record<Exclude<TickerFormat, "ms" | "bytes" | "tenths">, Format> = {
  int: { maximumFractionDigits: 0 },
  compact: { notation: "compact", maximumFractionDigits: 1 },
  usd: { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 },
  percent: { style: "percent", maximumFractionDigits: 1 },
};

/** A duration in ms as the console writes it: 940 ms, 2.4 s, 3.1 min. */
/**
 * A duration under a minute as one rolling number, as durationParts writes it (0.4 ms, 57 ms, 1.84 s, 12.3 s); from
 * 59.95 s the Ticker writes durationParts' words instead ("3 min 6 s", never "3.1 min": the sweep's ask 8).
 */
export function msParts(ms: number): { value: number; suffix: string; format: Format } {
  const fixed = (d: number): Format => ({ minimumFractionDigits: d, maximumFractionDigits: d });
  if (ms < 1) return { value: ms, suffix: " ms", format: fixed(1) };
  if (ms < 1000) return { value: Math.round(ms), suffix: " ms", format: fixed(0) };
  if (ms < 9_995) return { value: ms / 1000, suffix: " s", format: fixed(2) };
  return { value: ms / 1000, suffix: " s", format: fixed(1) };
}

/** From here a duration is words ("3 min 6 s"), not one rolling number. */
const MS_AS_WORDS = 59_950;

/** Bytes in binary units: 512 B, 3.2 MiB. */
export function byteParts(n: number): { value: number; suffix: string; format: Format } {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return { value: v, suffix: ` ${units[i]}`, format: { maximumFractionDigits: i === 0 ? 0 : 1 } };
}

export interface TickerProps {
  /** null or undefined: the read failed or has not come (an em dash, `missing` says why on hover). */
  value: number | null | undefined;
  format?: TickerFormat;
  prefix?: string;
  suffix?: string;
  /** Why there is no value, on hover and to a screen reader: "Did not load". */
  missing?: string;
  /** Roll the digits on a change (default). False for a value that changes every second and must not shimmer. */
  animated?: boolean;
  className?: string;
}

// NumberFlow (5.5 KiB gz) loads once the page has landed (landed.ts), never with it: a figure draws its number as plain text first, in
// NumberFlow's own box (inline-block, one character high, no wrap), and rolls from the next change on (perf round 2).
type Flow = typeof import("@number-flow/react").default;
let flowIn: Flow | null = null;
let flowLoad: Promise<Flow> | null = null;
const loadFlow = () => {
  flowLoad ??= import("@number-flow/react").then((m) => {
    flowIn = m.default;
    return flowIn;
  });
  return flowLoad;
};
function useFlow(want: boolean): Flow | null {
  const [flow, setFlow] = useState<Flow | null>(() => flowIn);
  useEffect(() => {
    if (!want || flow) return;
    let live = true;
    void whenLanded()
      .then(loadFlow)
      .then((f) => {
        if (live) setFlow(() => f);
      });
    return () => {
      live = false;
    };
  }, [want, flow]);
  return flow;
}
// NumberFlow's box: one character high, with its masks' room above the digits (0.4 of a character, measured on Home's
// and Requests' figures alike: 33.6 px over 24), so the roll replaces the plain number without moving the figure's line
// (a plain 24 px box under a 33.6 px roll moved it 9 px when the roll arrived: kit-check, round 3).
const PLAIN = {
  display: "inline-block",
  whiteSpace: "nowrap",
  lineHeight: "var(--number-flow-char-height, 1em)",
  paddingTop: "calc(var(--number-flow-char-height, 1em) * 0.4)",
  // Its height fixed as the roll's: a unit's thin space set in a fallback face grew the line 5 px (Requests' figures).
  boxSizing: "border-box",
  height: "calc(var(--number-flow-char-height, 1em) * 1.4)",
} as const;

export function Ticker({
  value,
  format = "int",
  prefix,
  suffix,
  missing = "Not measured",
  animated = true,
  className,
}: TickerProps) {
  // A number that never changes (`animated` false) stays plain text.
  const NumberFlow = useFlow(animated);
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return (
      <span className={cn("kit-ticker font-sans text-ink-3", className)} title={missing}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">{missing}</span>
      </span>
    );
  }
  if (format === "ms" && value >= MS_AS_WORDS)
    return (
      <span className={cn("kit-ticker", className)}>
        {prefix}
        <Duration ms={value} />
        {suffix}
      </span>
    );
  const parts: { value: number; suffix: string; format: Format; prefix?: string } =
    format === "ms"
      ? msParts(value)
      : format === "bytes"
        ? byteParts(value)
        : format === "tenths"
          ? { ...tenthsParts(value), suffix: "" }
          : { value, suffix: "", format: FORMATS[format] };
  // "<0.1" is drawn before the caller's own prefix ("<$0.01"), and said as "under".
  const lead = `${parts.prefix ?? ""}${prefix ?? ""}`;
  const rest = `${new Intl.NumberFormat("en-US", parts.format).format(parts.value)}${parts.suffix}${suffix ?? ""}`;
  const shown = `${lead}${rest}`;
  // The number's words for a screen reader, NumberFlow's own element hidden (it is an image, "image 42": a11y audit
  // 11-23, M9); the text sits out of flow, so the figure's layout is the roll's alone.
  const spoken = `${parts.prefix === "<" ? "under " : ""}${prefix ?? ""}${rest}`;
  return (
    <>
      {NumberFlow ? (
        <NumberFlow
          aria-hidden="true"
          className={cn("kit-ticker", className)}
          value={parts.value}
          format={parts.format}
          locales="en-US"
          prefix={lead || undefined}
          suffix={`${parts.suffix}${suffix ?? ""}` || undefined}
          animated={animated}
          respectMotionPreference
          willChange={false}
          transformTiming={{ duration: 520, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }}
          spinTiming={{ duration: 520, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }}
          opacityTiming={{ duration: 260, easing: "ease-out" }}
        />
      ) : (
        <span aria-hidden="true" className={cn("kit-ticker", className)} style={PLAIN}>
          {shown}
        </span>
      )}
      {/* The words as generated content (kit.css .kit-said): a reader hears them; the text the page holds stays the
          visible number alone. */}
      <span className="sr-only kit-said" data-said={spoken} />
    </>
  );
}

/** Changes smaller than this (a fraction: 0.0005 is 0.05%) are not shown. */
export const DELTA_FLOOR = 0.0005;

export interface DeltaProps {
  /** The change as a fraction (0.124 is +12.4%); null when the earlier period has nothing to compare against. */
  value: number | null | undefined;
  /** Which direction is good: errors going up is bad (`down`), requests going up is good (`up`), `none` stays grey. */
  good?: "up" | "down" | "none";
  /** The period it compares against, said after the number: "vs last 7 days". */
  period?: string;
  className?: string;
}

/** The delta's words and tone, without markup (tests and tooltips read it). */
export function deltaParts(value: number, good: DeltaProps["good"] = "up") {
  const pct = Math.abs(value) * 100;
  const text = `${pct >= 100 ? Math.round(pct) : pct.toFixed(1)}%`;
  const dir: "up" | "down" = value > 0 ? "up" : "down";
  const tone = good === "none" ? "flat" : dir === good ? "good" : "bad";
  return { text, dir, tone } as const;
}

/** The change from `before` to `now` as a fraction (0.124 for +12.4%), null when there is no base to compare with. */
export function change(now: number | null | undefined, before: number | null | undefined): number | null {
  if (now == null || before == null || before === 0) return null;
  return (now - before) / before;
}

/**
 * A number with its unit: a thin space, the unit in the quieter ink ("57 ms", "1.84 s", "2.4 GB"), so a column of
 * durations reads by its digits. `value` is already formatted.
 */
export function Qty({ value, unit, className }: { value: ReactNode; unit: string; className?: string }) {
  // A percent sign sits on its number ("40% CPU"); every other unit gets the thin space ("57 ms").
  const tight = unit.startsWith("%");
  return (
    <span className={cn("tabular-nums", className)}>
      {value}
      <span className="kit-unit">
        {tight ? "" : "\u2009"}
        {unit}
      </span>
    </span>
  );
}

/**
 * A duration's parts as the console writes it: 0.4 ms, 57 ms, 1.84 s, then whole minutes and seconds past one minute
 * (21 min 27 s, not 1287.06 s) and hours and minutes past one hour (1 h 5 min). Rounded to the second before it is
 * split, so 119.7 s is 2 min, never "1 min 60 s".
 */
export function durationParts(ms: number): { value: string; unit: string }[] {
  if (ms < 1) return [{ value: ms.toFixed(1), unit: "ms" }];
  if (ms < 1000) return [{ value: String(Math.round(ms)), unit: "ms" }];
  // Three significant figures: 1.84 s, then 12.3 s (the Waterfall's scale too).
  if (ms < 9_995) return [{ value: (ms / 1000).toFixed(2), unit: "s" }];
  if (ms < 59_950) return [{ value: (ms / 1000).toFixed(1), unit: "s" }];
  const s = Math.round(ms / 1000);
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return s % 60
      ? [
          { value: String(m), unit: "min" },
          { value: String(s % 60), unit: "s" },
        ]
      : [{ value: String(m), unit: "min" }];
  }
  const min = Math.round(s / 60);
  const h = Math.floor(min / 60);
  return min % 60
    ? [
        { value: String(h), unit: "h" },
        { value: String(min % 60), unit: "min" },
      ]
    : [{ value: String(h), unit: "h" }];
}

/** A duration as a Qty: 0.4 ms, 57 ms, 1.84 s, 21 min 27 s, 1 h 5 min (durationParts). */
export function Duration({ ms, className }: { ms: number; className?: string }) {
  const parts = durationParts(ms);
  if (parts.length === 1) return <Qty value={parts[0]?.value} unit={parts[0]?.unit ?? ""} className={className} />;
  return (
    <span className={className}>
      {parts.map((p, i) => (
        <span key={p.unit}>
          {i ? " " : null}
          <Qty value={p.value} unit={p.unit} />
        </span>
      ))}
    </span>
  );
}

export function Delta({ value, good = "up", period, className }: DeltaProps) {
  if (value === null || value === undefined || !Number.isFinite(value) || Math.abs(value) < DELTA_FLOOR) return null;
  const { text, dir, tone } = deltaParts(value, good);
  return (
    <span className={cn("kit-delta", className)} data-tone={tone}>
      <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" data-dir={dir}>
        <path d={dir === "up" ? "M5 1.5 9 7.5H1z" : "M5 8.5 1 2.5h8z"} fill="currentColor" />
      </svg>
      <span className="sr-only">{dir === "up" ? "Up" : "Down"} </span>
      {text}
      {period ? <span className="kit-delta__period"> {period}</span> : null}
    </span>
  );
}

export interface FigureProps {
  label: ReactNode;
  value: ReactNode;
  /** The line under the value: a delta, a split ("306 4xx · 76 5xx"), a limit. Kept to one line. */
  sub?: ReactNode;
  /** A trend at the figure's right (a Sparkline), when one helps. */
  trend?: ReactNode;
  /** The figure's glyph on the original's embossed plate (its custats card's icon). */
  icon?: IconName;
  /** A maker's mark on the same plate, in place of `icon` (Firecrawl's figure: its flame, not drawn in the label). */
  brand?: BrandName;
  /**
   * The read the value comes from ("/v1/limits"; several, space-separated): drawn as `data-kit-source`, so kit-check's
   * failreads knows the figure must show its missing state ("—") when that read fails.
   */
  source?: string;
  /** Seven (or so) mini bars under the value: the last days, the last one in brand (the custats card's bars). */
  bars?: readonly number[];
  /** A thin line at the foot, 0 to 100: use against a limit (amber from 80, red at 100), or with `progressOf: "done"`
   * completion (steps done: brand while under way, green when all are done). */
  progress?: number;
  /** What `progress` measures: "use" against a limit (the default), or "done", how much of a whole is finished. */
  progressOf?: "use" | "done";
  /** The whole figure links to where the number comes from. */
  href?: string;
  className?: string;
}

function MiniBars({ values }: { values: readonly number[] }) {
  const max = Math.max(1, ...values);
  return (
    <span className="kit-figure__bars" aria-hidden="true">
      {values.map((v, i) => (
        <span
          key={i}
          className="kit-figure__bar"
          data-last={i === values.length - 1 ? "" : undefined}
          style={{ height: `${Math.max(8, (v / max) * 100)}%` }}
        />
      ))}
    </span>
  );
}

/** One figure of a strip: an optional tile, a label, the value large, one quiet line under it. */
export function Figure({
  label,
  value,
  sub,
  trend,
  icon,
  brand,
  source,
  bars,
  progress,
  progressOf = "use",
  href,
  className,
}: FigureProps) {
  const p = progress === undefined ? undefined : Math.max(0, Math.min(100, progress));
  const tone =
    p === undefined
      ? undefined
      : progressOf === "done"
        ? p >= 100
          ? "complete"
          : "ok"
        : p >= 100
          ? "full"
          : p >= 80
            ? "warn"
            : "ok";
  const body = (
    <>
      <span className="kit-figure__head">
        {brand ? (
          <IconTile size="xs" className="kit-figure__tile">
            <BrandLogo name={brand} size={15} decorative />
          </IconTile>
        ) : icon ? (
          <IconTile size="xs" className="kit-figure__tile">
            <Icon name={icon} size={15} />
          </IconTile>
        ) : null}
        <span className="kit-figure__label">{label}</span>
      </span>
      <span className="kit-figure__row">
        <span className="kit-figure__value">{value}</span>
        {/* Sized by the figure's own width, never by what its value leaves (a ticker settles a frame after it
            mounts), and not a Tab stop: the figure's value says the number. */}
        {trend ? (
          <span className="kit-figure__trend">
            <InFigureTrend.Provider value={true}>{trend}</InFigureTrend.Provider>
          </span>
        ) : bars ? (
          <MiniBars values={bars} />
        ) : null}
      </span>
      {sub ? <span className="kit-figure__sub">{sub}</span> : null}
      {p !== undefined ? (
        <span className="kit-figure__progress" data-of={progressOf} data-tone={tone} aria-hidden="true">
          <span style={{ ["--kit-meter" as string]: p }} />
        </span>
      ) : null}
    </>
  );
  return href ? (
    <KitLink href={href} className={cn("kit-figure kit-figure--link", className)} data-kit-source={source}>
      {body}
    </KitLink>
  ) : (
    <div className={cn("kit-figure", className)} data-kit-source={source}>
      {body}
    </div>
  );
}

// The strip lives in figure-strip.tsx (perf audit 11-23: a skeleton that draws a strip loaded NumberFlow and the logos
// through this module); its names stay exported from here too.
export { FIGURE_MIN, FigureStrip, figureCols } from "./figure-strip";

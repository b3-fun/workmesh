// The chart kit's arithmetic (LIBRARY.md "charts"), pure so it is tested apart from the drawing. Honest scales
// (PHILOSOPHY P11): counts start at zero; the top is a round number just above the largest value; a flat series sits
// in the middle rather than on the floor ("why does it go down to 0? makes it look weird"); a minimum top keeps one
// stray call from filling the plot.

/** The next round number at or above n: 1, 2, 2.5, 5 or 10 times a power of ten (never below `floor`). */
export function niceMax(n: number, floor = 1): number {
  const v = Math.max(n, floor, Number.MIN_VALUE);
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * p;
}

/** `count` evenly spaced ticks from 0 to max, the top included (0, max/2, max for count 3). */
export function ticks(max: number, count = 3): number[] {
  if (count < 2) return [max];
  return Array.from({ length: count }, (_, i) => (max * i) / (count - 1));
}

export interface Domain {
  min: number;
  max: number;
}

/**
 * The y domain for a set of values. Counts (`zero`, the default) run from 0 to niceMax; a series that never changes
 * is centred (the line drawn mid-plot, area under it); otherwise a measured value (latency) gets 15% room each side.
 */
export function yDomain(
  values: readonly (number | null | undefined)[],
  opts: { zero?: boolean; floor?: number } = {},
): Domain {
  const { zero = true, floor = 1 } = opts;
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (v.length === 0) return { min: 0, max: niceMax(floor, floor) };
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  if (zero) {
    if (hi === lo && hi > 0) return { min: 0, max: hi * 2 };
    return { min: 0, max: niceMax(hi, floor) };
  }
  if (hi === lo) return { min: lo - Math.max(Math.abs(lo) * 0.5, 1), max: hi + Math.max(Math.abs(hi) * 0.5, 1) };
  const pad = (hi - lo) * 0.15;
  return { min: lo - pad, max: hi + pad };
}

/** A fixed domain ([0, 100] for a share), widened to take any reading outside it, so nothing is clipped. */
export function fixedDomain(values: readonly (number | null | undefined)[], domain: readonly [number, number]): Domain {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  const min = Math.min(domain[0], ...v);
  const max = Math.max(domain[1], ...v);
  return max > min ? { min, max } : { min, max: min + 1 };
}

/** The data index under a pointer: `band` for bars (each owns a slot), `point` for lines (nearest point). */
export function indexAt(x: number, width: number, n: number, mode: "band" | "point"): number {
  if (n <= 0 || width <= 0) return 0;
  const clamp = (i: number) => Math.max(0, Math.min(n - 1, i));
  if (mode === "band") return clamp(Math.floor((x / width) * n));
  if (n === 1) return 0;
  return clamp(Math.round((x / width) * (n - 1)));
}

/** Where a tooltip of `tip` px goes beside a point at `x` in a plot `width` wide: right of it, or left near the end. */
export function tipLeft(x: number, width: number, tip: number, gap = 12): number {
  if (x + gap + tip <= width) return x + gap;
  return Math.max(0, x - gap - tip);
}

/** 1234 -> "1.2k", 1200000 -> "1.2M": an axis label's few characters. */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(n / 1e3).toFixed(a < 1e4 ? 2 : 1)}k`;
  return `${+n.toFixed(a < 10 && a % 1 ? 1 : 0)}`;
}

/** Sum of the given keys of one row (a stacked bar's total). */
export function rowTotal(row: Record<string, unknown>, keys: readonly string[]): number {
  return keys.reduce((n, k) => n + (typeof row[k] === "number" ? (row[k] as number) : 0), 0);
}

/** A round step for a raw one: 1, 2 or 5 times a power of ten. */
export function niceStep(raw: number): number {
  const v = Math.max(raw, Number.MIN_VALUE);
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/**
 * Round ticks from 0 to just above `max`, about `count` of them (count 3 on 2,297 gives 0, 1k, 2k, 3k; on 1,800 it
 * gives 0, 1k, 2k): the top of the scale is the last one. `floor` keeps one stray call from filling the plot.
 */
export function niceTicks(max: number, count = 3, floor = 1): number[] {
  const m = Math.max(max, floor);
  // The smallest round step (1, 2 or 5 times a power of ten) that covers the max in at most `count` intervals, so the
  // top tick sits just above the data (2,650 gives 0, 1k, 2k, 3k, not 0, 2k, 4k).
  let step = niceStep(m / Math.max(1, count));
  while (Math.ceil(m / step - 1e-9) > count) step = niceStep(step * 1.01);
  const top = Math.ceil(m / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 1e6; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/**
 * Resamples a series to `n` points (linear between neighbours), so two series of different lengths can be tweened
 * point for point (a chart's range changing from 24 to 12 points).
 */
export function resample(values: readonly number[], n: number): number[] {
  if (values.length === 0) return Array.from({ length: n }, () => 0);
  if (values.length === 1 || n === 1) return Array.from({ length: n }, () => values[0] as number);
  return Array.from({ length: n }, (_, i) => {
    const f = (i / (n - 1)) * (values.length - 1);
    const lo = Math.floor(f);
    const hi = Math.min(values.length - 1, lo + 1);
    const t = f - lo;
    return (values[lo] as number) * (1 - t) + (values[hi] as number) * t;
  });
}

const KIB = 1024;

/**
 * Round y ticks for bytes: a step of a power of two in KiB, MiB or GiB (0, 512 MiB, 1 GiB), the smallest that covers
 * the max in at most `count` intervals.
 */
export function byteTicks(max: number, count = 3): number[] {
  const m = Math.max(max, KIB);
  let step = KIB;
  while (Math.ceil(m / step - 1e-9) > count) step *= 2;
  const top = Math.ceil(m / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 1e6; v += step) out.push(v);
  return out;
}

/** Bytes as a y label: "0", "512 KiB", "683 MiB", "1.5 GiB". */
export function bytesTick(n: number): string {
  if (n <= 0) return "0";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= KIB && i < units.length - 1) {
    v /= KIB;
    i++;
  }
  const r = v >= 100 || Number.isInteger(v) ? Math.round(v) : Math.round(v * 10) / 10;
  return `${r} ${units[i]}`;
}

/** The y labels' gutter at the plot's left: each label sits beside its gridline, never on the series. */
export const Y_GUTTER = 32;

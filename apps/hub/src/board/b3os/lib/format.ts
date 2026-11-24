/** Formatting helpers. Every number keeps its precision; nothing here rounds a measurement up. */

/**
 * The console's one mark for a value it does not have: not measured, did not load, or does not apply. An em dash.
 * In a page, print it with the Dash primitive (app/ui/primitives.tsx), which draws it in the sans face: Geist Mono
 * draws an em dash one character wide, so a mono cell's dash read as an en dash beside a sans cell's (11-08 review,
 * the Infer table's Kokoro row). Before 11-09 this was an en dash, and 46 other places typed an em dash.
 */
export const NOT_MEASURED = "—";

const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Milliseconds with sensible precision: 0.42 ms, 3.26 ms, 41.2 ms, 812 ms, 2.31 s. */
export function formatMs(ms: number): { value: string; unit: string } {
  if (!Number.isFinite(ms)) return { value: NOT_MEASURED, unit: "" };
  if (ms === 0) return { value: "0", unit: "ms" };
  const abs = Math.abs(ms);
  if (abs >= 60_000) return { value: (ms / 60_000).toFixed(1), unit: "min" };
  if (abs >= 10_000) return { value: (ms / 1000).toFixed(1), unit: "s" };
  if (abs >= 1000) return { value: (ms / 1000).toFixed(2), unit: "s" };
  if (abs >= 100) return { value: nf0.format(ms), unit: "ms" };
  if (abs >= 10) return { value: ms.toFixed(1), unit: "ms" };
  if (abs >= 1) return { value: ms.toFixed(2), unit: "ms" };
  if (abs >= 0.01) return { value: ms.toFixed(2), unit: "ms" };
  return { value: (ms * 1000).toFixed(1), unit: "µs" };
}

export function msText(ms: number): string {
  const f = formatMs(ms);
  return `${f.value} ${f.unit}`;
}

/**
 * Formats a published value exactly as the board gives it, in its own unit: thousands separators only, no
 * rounding (the six-decimal cap only hides binary float noise such as 0.30000000000000004).
 */
export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return NOT_MEASURED;
  return value.toLocaleString("en-US", { maximumFractionDigits: 6, minimumFractionDigits: 0 });
}

export function formatInt(n: number): string {
  return Number.isFinite(n) ? nf0.format(n) : NOT_MEASURED;
}

/** Compact counts for usage tiles: 18,204 · 170,000 · 4.41M · 9.12B (never "0.17M"). */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return NOT_MEASURED;
  const abs = Math.abs(n);
  if (abs < 1_000_000) return nf0.format(n);
  if (abs < 1e9) return `${(n / 1e6).toFixed(abs < 1e7 ? 2 : 1)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}

/** Bytes in B, KB, MB, GB and TB with three significant figures: "136 KB", "3.81 GB", "58.2 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return NOT_MEASURED;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (Math.abs(v) >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}

/**
 * Bytes in binary units, B, KiB, MiB, GiB and TiB, with three significant figures: "178 MiB", "1.50 GiB". For a
 * row that already gives a size in MiB or GiB (a sandbox's memory), so the row reads in one unit system.
 */
export function formatBinaryBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return NOT_MEASURED;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = bytes;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}

export function formatUsd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

const dateFmt = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

const dateTimeSecFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

/**
 * "Nov 10, 17:23:44", in UTC, for a column whose heading says so: a run's 23 calls in one minute read apart (console
 * review 2026-11-10: they all read "Nov 10, 17:23 UTC").
 */
export function formatDateTimeSeconds(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTimeSecFmt.format(d);
}

/** "17:23:44" in UTC. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 19);
}

/** "Oct 26, 2026" (UTC, so prerendered pages and browsers agree). */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateFmt.format(d);
}

/** "Oct 26, 14:05 UTC". */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${dateTimeFmt.format(d)} UTC`;
}

/** "3 min ago", "2 h ago", "4 d ago"; future times read "in 5 min". */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Math.round((now - t) / 1000);
  const future = diff < 0;
  const s = Math.abs(diff);
  let text: string;
  if (s < 45) text = `${s} s`;
  else if (s < 3600) text = `${Math.round(s / 60)} min`;
  else if (s < 86_400) text = `${Math.round(s / 3600)} h`;
  else text = `${Math.round(s / 86_400)} d`;
  return future ? `in ${text}` : `${text} ago`;
}

/**
 * The console's one duration formatter (console audit finding 10), for whole seconds: "45 s", "1 min 15 s", "15 min",
 * "1 h 30 min", "24 h", and days from 48 h on: "30 d", "2 d 6 h".
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return NOT_MEASURED;
  if (seconds < 60) return `${seconds} s`;
  const whole = Math.round(seconds);
  if (whole < 3600) {
    const m = Math.floor(whole / 60);
    const s = whole % 60;
    return s ? `${m} min ${s} s` : `${m} min`;
  }
  if (whole < 2 * 86_400) {
    const h = Math.floor(whole / 3600);
    const m = Math.round((whole % 3600) / 60);
    return m === 60 ? `${h + 1} h` : m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(whole / 86_400);
  const h = Math.round((whole % 86_400) / 3600);
  return h === 24 ? `${d + 1} d` : h ? `${d} d ${h} h` : `${d} d`;
}

/** Wall time in milliseconds, in formatDuration's words. Under a second it is "<1 s", so a trace never reads 0. */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) return NOT_MEASURED;
  if (ms === 0) return "0 s";
  if (ms < 1000) return "<1 s";
  return formatDuration(Math.round(ms / 1000));
}

/**
 * How long a run or a step took, from whole milliseconds: "0 ms", "1 ms", "812 ms", "2.31 s", "41.2 s", then
 * formatDuration ("1 min 5 s"). msText keeps two decimals for timings that have them; a step's 1 ms never reads
 * "1.00 ms" beside another step's "0 ms" (console audit finding 10).
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms)) return NOT_MEASURED;
  if (ms < 1000) return ms > 0 && ms < 1 ? "<1 ms" : `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return formatDuration(Math.round(ms / 1000));
}

const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "Dec 1" (UTC): the day a monthly window resets. */
export function formatDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dayFmt.format(d);
}

/** Hours to 3 decimals under 10 ("0.082"), 1 above ("12.0"), "<0.001" for a trace and "0" for none. */
export const formatHours = (h: number) => (h === 0 ? "0" : h < 0.001 ? "<0.001" : h < 10 ? h.toFixed(3) : h.toFixed(1));

/**
 * vCPU or GiB time, metered in milliseconds, as people count it: hours ("0.019 GiB-hours"), or seconds below
 * 0.01 h, where hours would print "<0.001" on every row ("4.91 GiB-seconds").
 */
export function formatResourceTime(ms: number, resource: "vCPU" | "GiB"): { value: string; unit: string } {
  if (ms === 0 || ms >= 36_000) return { value: formatHours(ms / 3_600_000), unit: `${resource}-hours` };
  const s = ms / 1000;
  return { value: s >= 10 ? s.toFixed(1) : s >= 0.01 ? s.toFixed(2) : "<0.01", unit: `${resource}-seconds` };
}

/**
 * A metered quantity as people read it (console audit finding 10): vCPU and GiB time in hours, wall time as a
 * duration, bytes in KB, MB and GB, counts as counts. `exact` is the figure in the meter's own unit, for a tooltip
 * ("66,615 GiB milliseconds"). `compact` shortens big counts (4.41M) for the usage tiles.
 */
export function formatMeter(
  unit: string,
  qty: number,
  counts: string,
  compact = false,
): { value: string; unit: string; exact: string } {
  const exact = `${qty.toLocaleString("en-US")} ${counts}`;
  if (unit === "sandboxes.vcpu_ms") return { ...formatResourceTime(qty, "vCPU"), exact };
  if (unit === "sandboxes.gib_ms") return { ...formatResourceTime(qty, "GiB"), exact };
  if (unit.endsWith("_ms")) return { value: formatDurationMs(qty), unit: "", exact };
  if (unit.endsWith("_s")) return { value: formatDuration(qty), unit: "", exact };
  if (unit.endsWith(".bytes")) {
    const [value = "", u = ""] = formatBytes(qty).split(" ");
    return { value, unit: u, exact };
  }
  // The catalog's count words are plurals ("pages", "steps"): one of them is a page, a step.
  const word = qty === 1 && counts.endsWith("s") ? counts.slice(0, -1) : counts;
  return { value: compact ? formatCompact(qty) : formatInt(qty), unit: word, exact };
}

/** formatMeter as one string: "0.019 GiB-hours", "12 min 28 s", "3.81 GB", "17,236 pages". */
export function meterText(unit: string, qty: number, counts: string, compact = false): string {
  const m = formatMeter(unit, qty, counts, compact);
  return m.unit ? `${m.value} ${m.unit}` : m.value;
}

/** Shortens long IDs for tables without losing the prefix: sbx_01m5t6…zkk. */
export function shortId(id: string): string {
  const us = id.indexOf("_");
  if (us < 0 || id.length <= us + 12) return id;
  return `${id.slice(0, us + 7)}…${id.slice(-4)}`;
}

/**
 * A commit's title: the first line of its message. A squash merge's message carries the pull request's body and a
 * "Co-authored-by:" trailer under it (the proof of 2026-11-16: the deploy row's heading was all of it). Null for none.
 */
export function commitTitle(message: string | null | undefined): string | null {
  return (
    message
      ?.split("\n")
      .find((l) => l.trim())
      ?.trim() || null
  );
}

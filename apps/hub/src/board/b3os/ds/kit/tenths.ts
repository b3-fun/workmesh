// Ticker's "tenths" format and the Sandboxes pages' CPU text, kept apart from ticker.tsx (which loads NumberFlow and the
// logos) so a page that only writes the text does not load it.

import type { Format } from "@number-flow/react";

/**
 * A quantity that is often a small fraction, such as vCPUs busy: one decimal under 10 (0.4, 2.0), whole from 10, and
 * "<0.1" for anything above 0 and under 0.1, so a little use never reads as none (an idle service used 0.002 vCPU,
 * which "compact" wrote as "0 vCPU" beside it running: release 1123c's signed-in check). Only 0 itself is "0".
 */
export function tenthsParts(n: number): { value: number; prefix: string; format: Format } {
  const fixed = (d: number): Format => ({ minimumFractionDigits: d, maximumFractionDigits: d });
  if (n === 0) return { value: 0, prefix: "", format: fixed(0) };
  if (n > 0 && n < 0.1) return { value: 0.1, prefix: "<", format: fixed(1) };
  // 9.95 and up round to 10.0: from there, whole numbers.
  return { value: n, prefix: "", format: fixed(Math.abs(n) < 9.95 ? 1 : 0) };
}

/** tenthsParts as text: "0", "<0.1", "0.4", "2.0", "12". */
export function tenthsText(n: number): string {
  const p = tenthsParts(n);
  return `${p.prefix}${new Intl.NumberFormat("en-US", p.format).format(p.value)}`;
}

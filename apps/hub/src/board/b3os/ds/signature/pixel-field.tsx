// from b3-mono apps/b3os-web/components/ui/pixel-field.tsx @ f50f3ba3b97e
// Beta addition (console elegance, area 4 fix, P6): an empty `aria-label` makes the field decorative (no status role,
// hidden from assistive tech), as the empty state's field is; the original always announced a status.

import { type CSSProperties, useEffect, useMemo, useRef } from "react";
import { cn } from "../lib/utils";
import type { PixelGridColor } from "./pixel-grid";

/**
 * NxN pixel field — larger sibling of `PixelGrid` (which is fixed 3×3).
 *
 * Reuses the shared `pixel-grid` / `pixel-grid__cell` CSS (palette, glow,
 * transitions) so visual language stays consistent.
 *
 * Two animation modes:
 *   - "cycle": all cells fade-on with per-cell `DelayFn`, hold, fade-off,
 *     repeat. Cells whose delay returns `null` render empty (used by
 *     `orbit` to carve out the interior so only the perimeter chases).
 *   - "independent": each cell runs its own on/off loop with a per-cell
 *     phase, period, and on-duration. Produces matrix-noise twinkle
 *     where the whole grid stays alive instead of breathing together.
 */

export type PixelFieldPatternName =
  | "orbit"
  | "heartbeat"
  | "center-out"
  | "wave-lr"
  | "rain"
  | "twinkle"
  | "matrix-rain"
  | "ripple"
  | "scanline";

type DelayFn = (row: number, col: number, rows: number, cols: number) => number | null;

type CellCycle = { phase: number; period: number; on: number };
type CellCycleFn = (row: number, col: number, rows: number, cols: number) => CellCycle | null;

type PatternSpec =
  | {
      mode: "cycle";
      delays: DelayFn;
      duration: number;
      color: PixelGridColor;
    }
  | {
      mode: "independent";
      cell: CellCycleFn;
      color: PixelGridColor;
    };

// Deterministic pseudo-random in [0, 1) from (r, c) — stable across renders
// so SSR and client agree, and cells keep identity across cycles.
const hash01 = (r: number, c: number) => {
  const s = Math.sin(r * 12.9898 + c * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

const PIXEL_FIELD_PATTERNS: Record<PixelFieldPatternName, PatternSpec> = {
  orbit: {
    mode: "cycle",
    duration: 140,
    color: "blue",
    delays: (r, c, rows, cols) => {
      const onTop = r === 0;
      const onBottom = r === rows - 1;
      const onLeft = c === 0;
      const onRight = c === cols - 1;
      if (!(onTop || onBottom || onLeft || onRight)) return null;
      let step = 0;
      if (onTop) step = c;
      else if (onRight) step = cols - 1 + r;
      else if (onBottom) step = cols - 1 + (rows - 1) + (cols - 1 - c);
      else step = cols - 1 + (rows - 1) + (cols - 1) + (rows - 1 - r);
      return step * 25;
    },
  },
  heartbeat: {
    mode: "cycle",
    duration: 180,
    color: "blue",
    delays: (r, c, rows, cols) => {
      const cy = (rows - 1) / 2;
      const cx = (cols - 1) / 2;
      const d = Math.abs(r - cy) + Math.abs(c - cx);
      return Math.round(d * 40);
    },
  },
  "center-out": {
    mode: "cycle",
    duration: 200,
    color: "blue",
    delays: (r, c, rows, cols) => {
      const cy = (rows - 1) / 2;
      const cx = (cols - 1) / 2;
      const d = Math.max(Math.abs(r - cy), Math.abs(c - cx));
      return Math.round(d * 50);
    },
  },
  "wave-lr": {
    mode: "cycle",
    duration: 180,
    color: "blue",
    delays: (_r, c) => c * 40,
  },
  rain: {
    mode: "cycle",
    duration: 160,
    color: "blue",
    delays: (r, c, rows) => r * 50 + ((c * 37) % rows) * 15,
  },
  // Matrix noise: every cell runs its own on/off cycle with a pseudo-random
  // phase offset. Reads as an alive grid instead of a coordinated breath.
  twinkle: {
    mode: "independent",
    color: "blue",
    cell: (r, c) => {
      const h = hash01(r, c);
      const period = 1400 + Math.round(hash01(r + 7, c + 11) * 900); // 1400–2300ms
      const on = 280 + Math.round(hash01(r + 3, c + 5) * 260); // 280–540ms
      return { phase: Math.round(h * period), period, on };
    },
  },
  // Matrix rain: delay drops cells top→bottom within each column; columns
  // themselves are offset pseudo-randomly so streams don't line up.
  "matrix-rain": {
    mode: "cycle",
    duration: 160,
    color: "blue",
    delays: (r, c, _rows, cols) => {
      const colOffset = Math.round(hash01(0, c) * 400);
      return colOffset + r * 55 + ((c * 17) % cols) * 4;
    },
  },
  // Full-grid expanding ring from center — like heartbeat but with a harder
  // edge and slightly longer hold, reads as a "pulse".
  ripple: {
    mode: "cycle",
    duration: 220,
    color: "blue",
    delays: (r, c, rows, cols) => {
      const cy = (rows - 1) / 2;
      const cx = (cols - 1) / 2;
      const d = Math.round(Math.sqrt((r - cy) ** 2 + (c - cx) ** 2) * 55);
      return d;
    },
  },
  // Horizontal sweep across the full grid, with a subtle vertical offset so
  // the leading edge tilts (feels less mechanical than pure wave-lr).
  scanline: {
    mode: "cycle",
    duration: 200,
    color: "blue",
    delays: (r, c, rows) => c * 45 + Math.round((r / Math.max(rows - 1, 1)) * 60),
  },
};

export interface PixelFieldProps {
  /** Grid rows. Default 9. */
  rows?: number;
  /** Grid cols. Default 9. */
  cols?: number;
  /** Motion pattern. Default "orbit". */
  pattern?: PixelFieldPatternName;
  /** Override palette. Default pattern's color. */
  color?: PixelGridColor;
  /** Per-cell side length in px. Default 6. */
  cell?: number;
  /** Gap between cells in px. Default 1. */
  gap?: number;
  /** Loop the animation. */
  autoplay?: boolean;
  className?: string;
  /** SR label. Default "Loading". Empty: a decorative field, no status role. */
  "aria-label"?: string;
}

export function PixelField({
  rows = 9,
  cols = 9,
  pattern = "orbit",
  color,
  cell = 6,
  gap = 1,
  autoplay = false,
  className,
  "aria-label": ariaLabel = "Loading",
}: PixelFieldProps) {
  const spec = PIXEL_FIELD_PATTERNS[pattern];

  // For cycle mode we need a flat delay array to both render empty cells and
  // drive the cycle. For independent mode we only need to know which cells
  // are active (never null in current patterns, but keep the contract).
  const delays = useMemo(() => {
    if (spec.mode !== "cycle") return null;
    const arr: (number | null)[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) arr.push(spec.delays(r, c, rows, cols));
    return arr;
  }, [rows, cols, spec]);

  const cellRefs = useRef<Array<HTMLSpanElement | null>>([]);
  if (cellRefs.current.length !== rows * cols) {
    cellRefs.current = Array(rows * cols).fill(null);
  }

  // Twinkle mode is driven entirely by CSS (see .pixel-grid__cell--twinkle in
  // globals.css). Skip the JS scheduler so 24×24 = 576 cells don't each own a
  // nested setTimeout loop; the compositor animates each cell via its inline
  // --twinkle-delay / --twinkle-duration instead.
  const isCssTwinkle = pattern === "twinkle";

  useEffect(() => {
    if (!autoplay) return;
    if (isCssTwinkle) return;
    if (typeof window === "undefined") return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (spec.mode === "cycle") {
      if (!delays) return;
      if (prefersReducedMotion) {
        cellRefs.current.forEach((el, i) => {
          if (delays[i] !== null) el?.classList.add("is-on");
        });
        return () => cellRefs.current.forEach((el) => el?.classList.remove("is-on"));
      }

      let running = true;
      let timers: number[] = [];
      let cycleTimer: number | null = null;

      const active: Array<{ i: number; d: number }> = [];
      for (let i = 0; i < delays.length; i++) {
        const d = delays[i];
        if (d != null) active.push({ i, d });
      }
      const maxDelay = active.length ? Math.max(...active.map((x) => x.d)) : 0;

      const fade = (on: boolean, next: () => void) => {
        for (const { i, d } of active) {
          timers.push(
            window.setTimeout(() => {
              cellRefs.current[i]?.classList.toggle("is-on", on);
            }, d),
          );
        }
        const hold = maxDelay + spec.duration + (on ? 0 : 60);
        cycleTimer = window.setTimeout(next, hold);
      };

      const cycle = () => {
        if (!running) return;
        fade(true, () => {
          if (!running) return;
          fade(false, cycle);
        });
      };

      cycle();

      return () => {
        running = false;
        timers.forEach((t) => window.clearTimeout(t));
        timers = [];
        if (cycleTimer) window.clearTimeout(cycleTimer);
        cellRefs.current.forEach((el) => el?.classList.remove("is-on"));
      };
    }

    // Independent per-cell cycles (matrix / twinkle).
    if (prefersReducedMotion) {
      cellRefs.current.forEach((el) => el?.classList.add("is-on"));
      return () => cellRefs.current.forEach((el) => el?.classList.remove("is-on"));
    }

    let running = true;
    const timers: number[] = [];

    const schedule = (fn: () => void, ms: number) => {
      const id = window.setTimeout(fn, ms);
      timers.push(id);
      return id;
    };

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const conf = spec.cell(r, c, rows, cols);
        if (!conf) continue;
        const index = r * cols + c;

        const loop = () => {
          if (!running) return;
          cellRefs.current[index]?.classList.add("is-on");
          schedule(() => {
            if (!running) return;
            cellRefs.current[index]?.classList.remove("is-on");
            schedule(loop, Math.max(conf.period - conf.on, 60));
          }, conf.on);
        };
        schedule(loop, conf.phase);
      }
    }

    return () => {
      running = false;
      timers.forEach((t) => window.clearTimeout(t));
      cellRefs.current.forEach((el) => el?.classList.remove("is-on"));
    };
  }, [autoplay, delays, rows, cols, spec, isCssTwinkle]);

  // Pre-compute per-cell delay/duration for CSS twinkle mode.
  const twinkleStyles = useMemo(() => {
    if (!isCssTwinkle || spec.mode !== "independent") return null;
    const arr: Array<{ delay: number; duration: number } | null> = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const conf = spec.cell(r, c, rows, cols);
        arr.push(conf ? { delay: conf.phase, duration: conf.period } : null);
      }
    }
    return arr;
  }, [isCssTwinkle, rows, cols, spec]);

  const resolvedColor = color ?? spec.color;
  const cellCount = rows * cols;

  return (
    <span
      role={ariaLabel ? "status" : undefined}
      aria-label={ariaLabel || undefined}
      aria-hidden={ariaLabel ? undefined : true}
      className={cn("pixel-grid inline-grid", resolvedColor ? `pixel-grid--${resolvedColor}` : null, className)}
      data-pattern={pattern}
      data-color={resolvedColor}
      style={{
        gridTemplateColumns: `repeat(${cols}, ${cell}px)`,
        gridTemplateRows: `repeat(${rows}, ${cell}px)`,
        gap: `${gap}px`,
      }}
    >
      {Array.from({ length: cellCount }).map((_, i) => {
        const isEmpty = spec.mode === "cycle" && delays && delays[i] === null;
        const twinkle = twinkleStyles?.[i] ?? null;
        return (
          <span
            key={i}
            ref={(el) => {
              cellRefs.current[i] = el;
            }}
            className={cn(!isEmpty && "pixel-grid__cell", twinkle && autoplay && "pixel-grid__cell--twinkle")}
            style={
              twinkle && autoplay
                ? ({
                    "--twinkle-delay": `${twinkle.delay}ms`,
                    "--twinkle-duration": `${twinkle.duration}ms`,
                  } as CSSProperties)
                : undefined
            }
          />
        );
      })}
    </span>
  );
}

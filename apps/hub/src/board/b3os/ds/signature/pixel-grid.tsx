// from b3-mono apps/b3os-web/components/ui/pixel-grid.tsx @ f50f3ba3b97e

import { useEffect, useMemo, useRef } from "react";
import { cn } from "../lib/utils";

/**
 * 3×3 animated pixel grid — port of 3pxgrid.com (MetaHeavies/3-pixel-grid)
 * adapted for React + Tailwind.
 *
 * Animations are driven by simple delay arrays: each cell toggles an `is-on`
 * class on a timer derived from its position in the pattern's delay array.
 * The CSS transition handles the smooth in/out so the markup stays tiny.
 *
 * Two consumer modes:
 *   - `autoplay`      — loops forever (use for loaders / ambient indicators)
 *   - controlled      — pass `autoplay={hovered}` and flip it from the parent
 *                       component's `onMouseEnter`/`onMouseLeave`
 *
 * Colors map to named presets from the original library. Each preset sets
 * the `--pixel-on` / `--pixel-off` / `--pixel-glow` CSS variables via a
 * `.pixel-grid--<name>` class; see `app/globals.css`.
 */

// ─── Pattern presets ────────────────────────────────────────────────────
// Delays index row-major top-left → bottom-right. Duration is the in/out
// transition duration (ms). `color` (single) or `colors[9]` (per-cell)
// provide the default palette mapping; consumers may override via the
// `color` / `colors` props.

export type PixelGridPatternName =
  // single-color motion
  | "wave-lr"
  | "wave-rl"
  | "wave-tb"
  | "wave-bt"
  | "spiral-cw"
  | "spiral-ccw"
  | "corners-first"
  | "center-out"
  | "diagonal-tl"
  | "diagonal-br"
  | "snake"
  | "cross"
  | "checkerboard"
  | "rain"
  | "pinwheel"
  | "orbit"
  | "converge"
  | "zigzag"
  | "flash"
  | "meteor"
  | "heartbeat"
  | "scatter"
  | "expand"
  | "columns"
  // multi-color motion
  | "aurora"
  | "ember"
  | "prism"
  | "neon-cross"
  | "tide"
  | "sunset"
  | "toxic"
  | "frost"
  | "fire"
  | "lightning"
  | "ocean"
  | "lava"
  | "storm"
  | "galaxy"
  | "plasma"
  | "sunrise"
  | "voltage"
  | "matrix"
  | "forest"
  | "coral"
  | "candy"
  | "cloud"
  | "pacman"
  | "christmas";

export type PixelGridColor =
  | "magenta"
  | "yellow"
  | "green"
  | "orange"
  | "blue"
  | "red"
  | "purple"
  | "white"
  | "teal"
  | "pink"
  | "lime";

export interface PixelGridPattern {
  name: PixelGridPatternName;
  delays: readonly [number, number, number, number, number, number, number, number, number];
  duration: number;
  color?: PixelGridColor;
  colors?: readonly [
    PixelGridColor,
    PixelGridColor,
    PixelGridColor,
    PixelGridColor,
    PixelGridColor,
    PixelGridColor,
    PixelGridColor,
    PixelGridColor,
    PixelGridColor,
  ];
}

export const PIXEL_GRID_PATTERNS: Readonly<Record<PixelGridPatternName, PixelGridPattern>> = {
  "wave-lr": { name: "wave-lr", delays: [0, 120, 240, 0, 120, 240, 0, 120, 240], duration: 200, color: "blue" },
  "wave-rl": { name: "wave-rl", delays: [240, 120, 0, 240, 120, 0, 240, 120, 0], duration: 200, color: "magenta" },
  "wave-tb": { name: "wave-tb", delays: [0, 0, 0, 120, 120, 120, 240, 240, 240], duration: 200, color: "yellow" },
  "wave-bt": { name: "wave-bt", delays: [240, 240, 240, 120, 120, 120, 0, 0, 0], duration: 200, color: "green" },
  "spiral-cw": {
    name: "spiral-cw",
    delays: [0, 80, 160, 560, 640, 240, 480, 400, 320],
    duration: 180,
    color: "orange",
  },
  "spiral-ccw": {
    name: "spiral-ccw",
    delays: [0, 560, 480, 80, 640, 400, 160, 240, 320],
    duration: 180,
    color: "magenta",
  },
  "corners-first": {
    name: "corners-first",
    delays: [0, 200, 0, 200, 400, 200, 0, 200, 0],
    duration: 200,
    color: "blue",
  },
  "center-out": {
    name: "center-out",
    delays: [240, 120, 240, 120, 0, 120, 240, 120, 240],
    duration: 200,
    color: "red",
  },
  "diagonal-tl": {
    name: "diagonal-tl",
    delays: [0, 100, 200, 100, 200, 300, 200, 300, 400],
    duration: 180,
    color: "purple",
  },
  "diagonal-br": {
    name: "diagonal-br",
    delays: [400, 300, 200, 300, 200, 100, 200, 100, 0],
    duration: 180,
    color: "green",
  },
  snake: { name: "snake", delays: [0, 80, 160, 400, 320, 240, 480, 560, 640], duration: 160, color: "white" },
  cross: { name: "cross", delays: [300, 0, 300, 0, 0, 0, 300, 0, 300], duration: 250, color: "teal" },
  checkerboard: { name: "checkerboard", delays: [0, 250, 0, 250, 0, 250, 0, 250, 0], duration: 220, color: "pink" },
  rain: { name: "rain", delays: [0, 180, 60, 120, 300, 240, 360, 80, 420], duration: 170, color: "lime" },
  pinwheel: { name: "pinwheel", delays: [0, 160, 480, 320, 640, 160, 480, 320, 0], duration: 150, color: "orange" },
  orbit: { name: "orbit", delays: [0, 80, 160, 480, 640, 240, 400, 320, 560], duration: 120, color: "red" },
  converge: { name: "converge", delays: [0, 200, 0, 200, 400, 200, 0, 200, 0], duration: 260, color: "magenta" },
  zigzag: { name: "zigzag", delays: [0, 160, 320, 400, 240, 80, 480, 560, 640], duration: 140, color: "blue" },
  flash: { name: "flash", delays: [0, 0, 0, 0, 0, 0, 0, 0, 0], duration: 400, color: "white" },
  meteor: { name: "meteor", delays: [160, 80, 0, 240, 160, 80, 320, 240, 160], duration: 120, color: "orange" },
  heartbeat: { name: "heartbeat", delays: [180, 60, 180, 120, 0, 120, 180, 60, 180], duration: 140, color: "red" },
  scatter: { name: "scatter", delays: [200, 480, 40, 360, 120, 560, 80, 440, 280], duration: 130, color: "yellow" },
  expand: { name: "expand", delays: [240, 280, 320, 0, 40, 80, 240, 280, 320], duration: 200, color: "blue" },
  columns: { name: "columns", delays: [80, 280, 480, 40, 240, 440, 0, 200, 400], duration: 150, color: "teal" },
  aurora: {
    name: "aurora",
    delays: [0, 100, 200, 100, 200, 300, 200, 300, 400],
    duration: 220,
    colors: ["blue", "blue", "teal", "teal", "blue", "blue", "purple", "purple", "magenta"],
  },
  ember: {
    name: "ember",
    delays: [0, 80, 160, 560, 640, 240, 480, 400, 320],
    duration: 200,
    colors: ["yellow", "orange", "orange", "orange", "red", "red", "red", "magenta", "magenta"],
  },
  prism: {
    name: "prism",
    delays: [0, 80, 160, 240, 320, 400, 480, 560, 640],
    duration: 160,
    colors: ["red", "orange", "yellow", "green", "blue", "blue", "purple", "magenta", "pink"],
  },
  "neon-cross": {
    name: "neon-cross",
    delays: [300, 0, 300, 0, 0, 0, 300, 0, 300],
    duration: 250,
    colors: ["magenta", "blue", "magenta", "blue", "white", "blue", "magenta", "blue", "magenta"],
  },
  tide: {
    name: "tide",
    delays: [0, 0, 0, 120, 120, 120, 240, 240, 240],
    duration: 220,
    colors: ["teal", "blue", "teal", "blue", "teal", "blue", "purple", "blue", "purple"],
  },
  sunset: {
    name: "sunset",
    delays: [240, 240, 240, 120, 120, 120, 0, 0, 0],
    duration: 240,
    colors: ["purple", "blue", "purple", "magenta", "red", "magenta", "orange", "yellow", "orange"],
  },
  toxic: {
    name: "toxic",
    delays: [0, 200, 0, 200, 400, 200, 0, 200, 0],
    duration: 200,
    colors: ["lime", "green", "lime", "green", "yellow", "green", "lime", "green", "lime"],
  },
  frost: {
    name: "frost",
    delays: [240, 120, 240, 120, 0, 120, 240, 120, 240],
    duration: 200,
    colors: ["blue", "blue", "blue", "blue", "white", "blue", "blue", "blue", "blue"],
  },
  fire: {
    name: "fire",
    delays: [320, 240, 360, 120, 80, 160, 40, 0, 60],
    duration: 160,
    colors: ["red", "red", "red", "orange", "yellow", "orange", "yellow", "yellow", "yellow"],
  },
  lightning: {
    name: "lightning",
    delays: [80, 40, 100, 40, 0, 60, 100, 40, 80],
    duration: 100,
    colors: ["purple", "blue", "purple", "blue", "white", "blue", "purple", "blue", "purple"],
  },
  ocean: {
    name: "ocean",
    delays: [0, 120, 240, 40, 160, 280, 80, 200, 320],
    duration: 220,
    colors: ["teal", "blue", "blue", "blue", "teal", "blue", "blue", "blue", "teal"],
  },
  lava: {
    name: "lava",
    delays: [200, 480, 40, 360, 120, 560, 80, 440, 280],
    duration: 180,
    colors: ["red", "orange", "yellow", "orange", "red", "yellow", "red", "orange", "yellow"],
  },
  storm: {
    name: "storm",
    delays: [200, 480, 40, 360, 120, 560, 80, 440, 280],
    duration: 160,
    colors: ["blue", "purple", "blue", "purple", "blue", "blue", "purple", "blue", "purple"],
  },
  galaxy: {
    name: "galaxy",
    delays: [0, 80, 160, 560, 640, 240, 480, 400, 320],
    duration: 180,
    colors: ["purple", "blue", "magenta", "blue", "white", "blue", "magenta", "purple", "blue"],
  },
  plasma: {
    name: "plasma",
    delays: [0, 100, 200, 300, 400, 300, 200, 100, 0],
    duration: 160,
    colors: ["blue", "magenta", "yellow", "magenta", "white", "magenta", "yellow", "magenta", "blue"],
  },
  sunrise: {
    name: "sunrise",
    delays: [400, 400, 400, 200, 200, 200, 0, 0, 0],
    duration: 240,
    colors: ["magenta", "purple", "magenta", "red", "orange", "red", "yellow", "orange", "yellow"],
  },
  voltage: {
    name: "voltage",
    delays: [120, 0, 80, 300, 60, 240, 160, 340, 40],
    duration: 110,
    colors: ["yellow", "white", "yellow", "orange", "white", "orange", "yellow", "orange", "white"],
  },
  matrix: {
    name: "matrix",
    delays: [0, 200, 100, 80, 280, 180, 160, 360, 260],
    duration: 140,
    colors: ["lime", "green", "lime", "green", "lime", "green", "lime", "green", "lime"],
  },
  forest: {
    name: "forest",
    delays: [400, 200, 400, 200, 0, 200, 400, 200, 400],
    duration: 220,
    colors: ["green", "lime", "green", "teal", "lime", "teal", "green", "lime", "green"],
  },
  coral: {
    name: "coral",
    delays: [300, 150, 300, 150, 0, 150, 300, 150, 300],
    duration: 200,
    colors: ["orange", "pink", "orange", "pink", "red", "pink", "orange", "pink", "orange"],
  },
  candy: {
    name: "candy",
    delays: [0, 120, 240, 120, 240, 360, 240, 360, 480],
    duration: 180,
    colors: ["pink", "magenta", "pink", "magenta", "white", "magenta", "pink", "magenta", "pink"],
  },
  cloud: {
    name: "cloud",
    delays: [200, 80, 240, 100, 0, 140, 240, 120, 280],
    duration: 280,
    colors: ["blue", "white", "blue", "white", "white", "white", "blue", "white", "blue"],
  },
  pacman: { name: "pacman", delays: [0, 80, 160, 0, 80, 320, 0, 80, 160], duration: 140, color: "yellow" },
  christmas: {
    name: "christmas",
    delays: [0, 200, 0, 200, 400, 200, 0, 200, 0],
    duration: 220,
    colors: ["red", "green", "red", "green", "yellow", "green", "red", "green", "red"],
  },
};

export const PIXEL_GRID_PATTERN_NAMES: readonly PixelGridPatternName[] = Object.keys(
  PIXEL_GRID_PATTERNS,
) as PixelGridPatternName[];

// Curated subset used when auto-seeding from a string (pills etc). Picks
// patterns that read well at tiny sizes without demanding too much attention.
const SEED_PATTERNS: readonly PixelGridPatternName[] = [
  "wave-lr",
  "wave-rl",
  "wave-tb",
  "wave-bt",
  "spiral-cw",
  "spiral-ccw",
  "center-out",
  "corners-first",
  "diagonal-tl",
  "diagonal-br",
  "orbit",
  "pinwheel",
  "rain",
  "converge",
  "heartbeat",
];

const SEED_COLORS: readonly PixelGridColor[] = ["blue", "green", "orange", "purple", "pink"];

/** djb2 — deterministic + cheap. */
function hashString(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

export interface PixelGridSeed {
  pattern: PixelGridPatternName;
  color: PixelGridColor;
}

export function pickPixelGridSeed(input: string): PixelGridSeed {
  const h = hashString(input);
  return {
    pattern: SEED_PATTERNS[h % SEED_PATTERNS.length] as PixelGridPatternName,
    color: SEED_COLORS[Math.floor(h / SEED_PATTERNS.length) % SEED_COLORS.length] as PixelGridColor,
  };
}

// ─── Sizing ─────────────────────────────────────────────────────────────

export type PixelGridSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl";

const SIZE_MAP: Record<PixelGridSize, { cell: number; gap: number }> = {
  xs: { cell: 2, gap: 1 }, // 8×8 total — fits inside h-3 / 12px
  sm: { cell: 3, gap: 1 }, // 11×11 — fits inside h-4 / 16px
  md: { cell: 4, gap: 1 }, // 14×14 — fits inside h-5 / 20px
  lg: { cell: 6, gap: 2 }, // 22×22 — for prominent inline indicators
  xl: { cell: 10, gap: 3 }, // 36×36 — card-level empty-state loader
  "2xl": { cell: 14, gap: 4 }, // 50×50 — page/overlay loader, LumaSpin replacement
};

// ─── Component ──────────────────────────────────────────────────────────

export interface PixelGridProps {
  /** Pattern name or custom pattern object. Default: "center-out" (a true bloom). */
  pattern?: PixelGridPatternName | PixelGridPattern;
  /** Override the preset's default color. */
  color?: PixelGridColor;
  /** Override every cell's color. Length must be 9 if provided. */
  colors?: readonly PixelGridColor[];
  /** Size preset. Default: "sm". */
  size?: PixelGridSize;
  /** Apply the SVG bloom glow filter (see `<PixelGridBloomFilter />` in _app). */
  bloom?: boolean;
  /** Start + loop the animation. Toggle false to stop on next cycle boundary. */
  autoplay?: boolean;
  className?: string;
  /** Accessible label for screen readers (defaults to "Loading"). */
  "aria-label"?: string;
}

function resolvePattern(pattern: PixelGridProps["pattern"]): PixelGridPattern {
  if (!pattern) return PIXEL_GRID_PATTERNS["center-out"];
  if (typeof pattern === "string") return PIXEL_GRID_PATTERNS[pattern] ?? PIXEL_GRID_PATTERNS["center-out"];
  return pattern;
}

export function PixelGrid({
  pattern,
  color,
  colors,
  size = "sm",
  bloom = false,
  autoplay = false,
  className,
  "aria-label": ariaLabel = "Loading",
}: PixelGridProps) {
  const config = useMemo(() => resolvePattern(pattern), [pattern]);
  const cellRefs = useRef<Array<HTMLSpanElement | null>>(Array(9).fill(null));

  useEffect(() => {
    if (!autoplay) return;
    if (typeof window === "undefined") return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      cellRefs.current.forEach((el) => el?.classList.add("is-on"));
      return () => cellRefs.current.forEach((el) => el?.classList.remove("is-on"));
    }

    let running = true;
    let timers: number[] = [];
    let cycleTimer: number | null = null;

    const maxDelay = Math.max(...config.delays);

    const fade = (on: boolean, next: () => void) => {
      for (let i = 0; i < 9; i++) {
        timers.push(
          window.setTimeout(() => {
            cellRefs.current[i]?.classList.toggle("is-on", on);
          }, config.delays[i]),
        );
      }
      const holdTime = maxDelay + config.duration + (on ? 0 : 50);
      cycleTimer = window.setTimeout(next, holdTime);
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
  }, [autoplay, config]);

  const resolvedColor = color ?? config.color;
  const resolvedCellColors = colors ?? config.colors;
  const { cell, gap } = SIZE_MAP[size];

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={cn("pixel-grid inline-grid", resolvedColor ? `pixel-grid--${resolvedColor}` : null, className)}
      data-pattern={config.name}
      data-color={resolvedColor}
      style={{
        gridTemplateColumns: `repeat(3, ${cell}px)`,
        gridTemplateRows: `repeat(3, ${cell}px)`,
        gap: `${gap}px`,
        filter: bloom ? "url(#pixel-grid-bloom)" : undefined,
      }}
    >
      {Array.from({ length: 9 }).map((_, i) => (
        <span
          key={i}
          ref={(el) => {
            cellRefs.current[i] = el;
          }}
          className={cn(
            "pixel-grid__cell",
            resolvedCellColors?.[i] ? `pixel-grid__cell--${resolvedCellColors[i]}` : null,
          )}
        />
      ))}
    </span>
  );
}

/**
 * Reusable bloom SVG filter definition. Render once at the app root so every
 * `<PixelGrid bloom />` can reference it via `filter: url(#pixel-grid-bloom)`.
 */
export function PixelGridBloomFilter() {
  return (
    <svg aria-hidden className="pointer-events-none absolute size-0 overflow-hidden">
      <defs>
        <filter id="pixel-grid-bloom" x="-100%" y="-100%" width="300%" height="300%">
          <feColorMatrix
            in="SourceGraphic"
            type="matrix"
            values="2 0 0 0 -0.5  0 2 0 0 -0.5  0 0 2 0 -0.5  0 0 0 1 0"
            result="bright"
          />
          <feGaussianBlur in="bright" stdDeviation="4" result="glow" />
          <feBlend in="SourceGraphic" in2="glow" mode="screen" />
        </filter>
      </defs>
    </svg>
  );
}

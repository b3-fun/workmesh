// from b3-mono apps/b3os-web/components/ui/pixel-loader.tsx @ f50f3ba3b97e

import { cn } from "../lib/utils";
import { PixelGrid, type PixelGridColor, type PixelGridPatternName, type PixelGridSize } from "./pixel-grid";

/**
 * Drop-in replacement for `<Loader2 className="animate-spin" />` — renders a
 * 3x3 animated pixel grid instead of a spinning chevron. Ships with a
 * calm default pattern; callers can override for flavour per surface.
 *
 * Rough sizing map vs. lucide-style spinners:
 *   xs  → h-3 / w-3 (12px)   — inline in dense chips
 *   sm  → h-4 / w-4 (16px)   — inline in buttons, the common case
 *   md  → h-5 / w-5 (20px)   — standalone inline indicators
 *   lg  → h-7 / w-7 (28px+)  — empty-state / overlay indicators
 */

export interface PixelLoaderProps {
  /** Pattern preset name. Default: "wave-lr". */
  pattern?: PixelGridPatternName;
  /** Override the preset's default colour. Default: "blue". */
  color?: PixelGridColor;
  /** Visual size. Default: "sm" (drop-in for h-4 w-4 Loader2). */
  size?: PixelGridSize;
  /** Screen-reader label. Default: "Loading". */
  "aria-label"?: string;
  className?: string;
}

export function PixelLoader({
  pattern = "wave-lr",
  color = "blue",
  size = "sm",
  "aria-label": ariaLabel = "Loading",
  className,
}: PixelLoaderProps) {
  return (
    <PixelGrid
      autoplay
      pattern={pattern}
      color={color}
      size={size}
      aria-label={ariaLabel}
      className={cn("shrink-0", className)}
    />
  );
}

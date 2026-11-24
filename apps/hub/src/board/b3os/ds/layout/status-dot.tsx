// Beta addition (console elegance, area 1 fix, F9; DIRECTION.md 1.2 and 4): a status as a 7 px dot and a word in ink,
// the one way the console says a state. The original has status badges (filled chips) and the uptime StatusBadge, no
// plain dot with a word. Anything running now (a deploy rolling out, a run under way) shows the original's 3 by 3
// pixel grid, playing, in the dot's place (DIRECTION 2), and the plain dot again once it settles. The colour is the
// dot's alone: every word, a failure's too, stays in the secondary ink, so the brand blue stays the loudest colour (the
// orchestrator's ruling after console area 3: "Crashed" and "Failed" were red text beside a red dot).
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { PixelGrid } from "../signature/pixel-grid";

/** ok (green), live (blue: under way), warn (yellow), failed (red), off (grey), unknown (a ring): the dot's colour. */
export type StatusDotTone = "ok" | "live" | "warn" | "failed" | "off" | "unknown";

const DOT: Record<StatusDotTone, string> = {
  ok: "bg-ds-green-500",
  live: "bg-ds-brand-500",
  warn: "bg-yellow-500",
  failed: "bg-ds-red-500",
  off: "bg-ds-text-disabled",
  unknown: "bg-transparent shadow-[inset_0_0_0_1.5px_var(--ds-text-disabled)]",
};

export interface StatusDotProps {
  tone: StatusDotTone;
  /**
   * The word (or words) the dot stands beside; it carries the meaning, the colour only repeats it. None where the word
   * stands elsewhere in the row (a deploy rail's marker, a graph node's mark): the dot is then decoration.
   */
  children?: ReactNode;
  /** Running now: the pixel grid, playing, in place of the dot (its label is the word's, for a screen reader). */
  running?: boolean;
  /** The grid's accessible name while running (default "In progress"). */
  runningLabel?: string;
  /** The grid's size while running: `xs` (8 px, the dot's) or `sm` (11 px, a canvas node's, which draws scaled down). */
  runningSize?: "xs" | "sm";
  /**
   * `lg`: an 11 px dot and the 11 px grid, a timeline's marker (an application's deploy rail; console area 2 fix, F5:
   * it was drawn by hand, pulsing in CSS while a deploy ran).
   */
  size?: "md" | "lg";
  className?: string;
}

export function StatusDot({
  tone,
  children,
  running = false,
  runningLabel = "In progress",
  runningSize = "xs",
  size = "md",
  className,
}: StatusDotProps) {
  return (
    <span
      className={cn(
        "app-status inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-ds-text-subtle",
        className,
      )}
      data-tone={tone}
      data-running={running ? "" : undefined}
    >
      {running ? (
        <PixelGrid
          size={size === "lg" ? "sm" : runningSize}
          color="blue"
          autoplay
          pattern="center-out"
          aria-label={runningLabel}
        />
      ) : (
        <span
          className={cn(
            "app-status__dot shrink-0 rounded-full",
            size === "lg" ? "size-[11px]" : "size-[7px]",
            DOT[tone],
          )}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}

export default StatusDot;

// Working waits (LIBRARY.md "skeletons"; Sean: "skeleton loaders when appropriate for layout loading, and pixelfield for
// cases like this with the AI prompt"). Layout waits are skeletons; a wait on work (an agent thinking, a build running,
// a step waiting on a person) is the original's pixel loaders: `Working` inline beside its words (the 3x3 pixel grid,
// playing), `WaitPanel` for a region with nothing to show yet (`LumaPixels`, the original's luma wait, over the dot grid).
// Both still under reduced motion; the words carry the meaning and are read once.
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { PixelField } from "../signature/pixel-field";
import { PixelLoader } from "../signature/pixel-loader";
import { useReducedMotion } from "./motion";
import "./css/lite.css";

export function Working({
  children,
  counter,
  tone = "brand",
  className,
}: {
  children: ReactNode;
  /**
   * What ticks beside the words (an elapsed "· 12 s"): shown, never spoken, so the status is said when its words change,
   * not each second (a11y audit 11-23, S5).
   */
  counter?: ReactNode;
  tone?: "brand" | "muted";
  className?: string;
}) {
  return (
    <span className={cn("kit-working", className)} data-tone={tone} role="status">
      <PixelLoader size="xs" color={tone === "brand" ? "blue" : "white"} aria-label="" />
      <span>
        {children}
        {counter !== undefined && counter !== null ? <span aria-hidden="true">{counter}</span> : null}
      </span>
    </span>
  );
}

/**
 * The original's luma wait (a 9x9 ripple from the centre, ds/signature/luma-wait), 48 px, in its own colours: lavender
 * at rest, the brand only on the travelling wave, no glow. With reduced motion it rests lavender (the original lights
 * every cell, a solid blue block), and the words beside it carry the wait.
 */
export function LumaPixels() {
  const reduce = useReducedMotion();
  return (
    <span className="kit-luma" aria-hidden="true">
      <PixelField autoplay={!reduce} pattern="ripple" color="blue" rows={9} cols={9} cell={4} gap={1.5} aria-label="" />
    </span>
  );
}

export function WaitPanel({
  title,
  body,
  height = 200,
  className,
}: {
  title: ReactNode;
  body?: ReactNode;
  height?: number;
  className?: string;
}) {
  return (
    <div className={cn("kit-waitpanel", className)} style={{ minHeight: height }} role="status">
      <LumaPixels />
      <p className="kit-waitpanel__title">{title}</p>
      {body ? <p className="kit-waitpanel__body">{body}</p> : null}
    </div>
  );
}

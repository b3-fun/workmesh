// A skeleton's bone and words drawn as a bone (skeleton.tsx re-exports both), in a module every skeleton shares.
import type { CSSProperties } from "react";
import { cn } from "../lib/utils";
import "./css/lite.css";

export function Bone({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span className={cn("kit-bone", className)} style={style} aria-hidden="true" />;
}

/**
 * Words drawn as their own bone: the text itself, invisible, on the bone's fill, so it is the text's own line box and
 * wraps exactly where the words will (Routines' look.tsx TextBone, made the kit's). In a part's own frame it takes
 * that part's font: a figure's label, an Attention item's count.
 */
export function TextBone({ children }: { children: string }) {
  return (
    <span className="kit-bone kit-text-bone" aria-hidden="true">
      {children}
    </span>
  );
}

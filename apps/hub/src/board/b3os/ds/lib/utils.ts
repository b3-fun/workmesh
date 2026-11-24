// from b3-mono apps/b3os-web/lib/utils.ts @ f50f3ba3b97e (cn only: the file's chain, address and USD helpers are the
// old product's and are not applicable)
import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The radius, leading and font classes the port renamed (NOTES/ds-extraction.md, "Class translation"): the original
 * wrote rounded-md, leading-relaxed and font-mono, which tailwind-merge knows, so a later one replaced an earlier one
 * (a story's rounded-xl over a Skeleton's rounded-md). Under their ds names it would keep both and let the
 * stylesheet's order decide; these groups keep the original's merge.
 *
 * X3 (ruling 2): the radius groups also hold the original's own `ds-*` radii (`ds-sm`, `ds-xl`, `ds-pill` and the
 * rest of its config). In the original, tailwind-merge kept a Button's `rounded-ds-sm` beside a caller's
 * `rounded-lg`, and Tailwind 3 printed `rounded-lg` after every `rounded-ds-*`, so the caller's corner won. Here the
 * caller's `rounded-lg` is `rounded-ds-8`, which Tailwind 4 prints before `rounded-ds-sm`: both kept, the Button's
 * 10 px won (the layout diff's option-list presets, 10 px against 8). One group: the later class wins, as the caller
 * meant and as the original drew it.
 */
const RADII = [
  "ds-4",
  "ds-xs",
  "ds-8",
  "ds-md",
  "ds-lg",
  "ds-2xl",
  "ds-1",
  "ds-2xs",
  "ds-3",
  "ds-5",
  "ds-7",
  "ds-9",
  "ds-14",
  "ds-18",
  "ds-22",
  "ds-26",
  "ds-30",
  "ds-34",
  "ds-40",
  "ds-50",
  "ds-sm",
  "ds-xl",
  "ds-3xl",
  "ds-4xl",
  "ds-pill",
];
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      rounded: [{ rounded: RADII }],
      "rounded-t": [{ "rounded-t": RADII }],
      "rounded-r": [{ "rounded-r": RADII }],
      "rounded-b": [{ "rounded-b": RADII }],
      "rounded-l": [{ "rounded-l": RADII }],
      leading: [{ leading: ["ds-relaxed"] }],
      // X5: the beta's own type scale (theme-vars.css), which the console's callers pass to the components it adopted.
      // Unknown to tailwind-merge, `text-ui` read as a colour and a following `text-ink-3` dropped it.
      "font-size": [
        {
          text: ["hero", "display", "h1", "h2", "h3", "h4", "lead", "body", "ui", "small", "caption", "micro", "stat"],
        },
      ],
      "font-family": [{ font: ["ds-mono"] }],
    },
  },
});

/**
 * The original's class joiner: clsx, then tailwind-merge so a later class of the same group wins. The original runs
 * tailwind-merge 2.6 (Tailwind 3); the beta runs 3.x, which knows the Tailwind 4 names the ported files use
 * (NOTES/ds-extraction.md, "Dependencies").
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type { VariantProps } from "class-variance-authority";
export { cva } from "class-variance-authority";

// X5: the formatters the original lib/utils exported beside cn (ds/lib/format.ts holds them).
export { capitalizeWords, formatAddress, formatDuration, formatRelativeTime, formatUsername } from "./format";

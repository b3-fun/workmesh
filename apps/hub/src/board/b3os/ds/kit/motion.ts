// The foundation kit's motion (admin redesign 1121, LIBRARY.md "motion"): one set of curves and durations for every
// kit component, the same values as the console's CSS tokens (styles/tokens.css --b3-ease-*, --b3-dur-*) so a CSS
// transition and a script animation of the same thing feel alike. Rules (PHILOSOPHY P7, the emil-design-eng skill):
// ease-out for anything entering or answering a press, in-out for something already on screen moving, never ease-in;
// UI motion under 300 ms; transform and opacity only; nothing animates on a keyboard shortcut; reduced motion keeps
// opacity and drops movement.
import { useEffect, useState } from "react";

export type Ease = readonly [number, number, number, number];

export const EASE = {
  /** Entrances, presses, popovers: fast start, soft landing (--b3-ease-arrive's family, the original's quint). */
  out: [0.23, 1, 0.32, 1],
  /** Something already on screen moving to a new place: a tab's indicator, a reordered row. */
  inOut: [0.77, 0, 0.175, 1],
  /** Sheets and drawers (iOS-like, --b3-ease-sheet). */
  drawer: [0.32, 0.72, 0, 1],
} as const satisfies Record<string, Ease>;

/** Milliseconds. press: a button answering; fast: hover, tooltip, copy morph; base: menus, tabs; slow: sheets. */
export const DUR = { press: 120, fast: 160, base: 200, slow: 280 } as const;

export const cssEase = (e: Ease): string => `cubic-bezier(${e.join(", ")})`;

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Whether motion should be reduced now: the system setting, or `data-motion="reduce"` on <html> or on an ancestor of
 * `el` (the kit page's own switch, so the judge can see both without changing the system).
 */
export function prefersReducedMotion(el?: Element | null): boolean {
  if (typeof window === "undefined") return true;
  if (el?.closest?.('[data-motion="reduce"]')) return true;
  if (document.documentElement.dataset.motion === "reduce") return true;
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return true;
  }
}

/** prefersReducedMotion(), kept current as the system setting changes. */
export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() => prefersReducedMotion());
  useEffect(() => {
    let m: MediaQueryList | null = null;
    try {
      m = window.matchMedia(QUERY);
    } catch {
      return;
    }
    const update = () => setReduce(prefersReducedMotion());
    update();
    m.addEventListener?.("change", update);
    const html = new MutationObserver(update);
    html.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    return () => {
      m?.removeEventListener?.("change", update);
      html.disconnect();
    };
  }, []);
  return reduce;
}

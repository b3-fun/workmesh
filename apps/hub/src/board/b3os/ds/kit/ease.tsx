// EaseHeight and Reveal (skeleton.tsx re-exports both), in a module of their own (perf audit 11-23): a page that swaps a
// part for its content (sign-in's card) needs neither the page's bones nor the figure strip's.
import { createContext, type ReactNode, useContext, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { cssEase, EASE, prefersReducedMotion } from "./motion";
import "./css/lite.css";

/**
 * True for content a Reveal is swapping in for its skeleton: one motion at a time, and the crossfade is the motion, so
 * the content's own entrances (a chart's growth or wipe, Attention's height) stay still. Read it once, at mount.
 */
export const RevealEntering = createContext(false);
export const useRevealEntering = () => useContext(RevealEntering);

/** True for a height animation the kit started (EaseHeight, Reveal, a mount grow), so an outer EaseHeight lets it run. */
function easingInside(el: HTMLElement): boolean {
  if (typeof el.getAnimations !== "function") return false;
  return el.getAnimations({ subtree: true }).some((a) => a.playState === "running" && a.id === "kit-ease");
}

/**
 * Every mounted EaseHeight's check, run again in a frame whose ResizeObserver delivery the browser cut short. When an
 * observer's callback changes the page synchronously (a Tabs refit in flushSync, any DOM write in a callback), the
 * observations no deeper than its target are skipped that frame and delivered in the next: an EaseHeight above it
 * would paint the new height unclipped for one frame, then its old height, then ease (the judges' "1593 for one frame,
 * then 833"). The browser reports the skipped delivery as a window error ("ResizeObserver loop completed with
 * undelivered notifications") before that frame paints, so each EaseHeight checks itself then and the ease starts in
 * the frame that would have shown the cut.
 */
const easeChecks = new Set<() => void>();
let skippedWatch = false;
function watchSkippedDelivery() {
  if (skippedWatch || typeof window === "undefined") return;
  skippedWatch = true;
  window.addEventListener("error", (e) => {
    if (!/ResizeObserver loop/.test(e.message ?? "")) return;
    for (const check of easeChecks) check();
  });
}

/**
 * A region whose height eases (200 ms, in-out) whenever its content's height changes: a state switch, a skeleton
 * swapped for its content, rows arriving, an error line, a row that appears. The box clips only while it eases
 * (overflow: clip, which keeps sticky headers working), so nothing below it moves in one frame. The new height is read after
 * layout and before paint (ResizeObserver, and the browser's report of a delivery it put off to the next frame), so the
 * first frame is already the old height. An EaseHeight inside another one that is already easing lets the inner one
 * run. Reduced motion: the height changes at once.
 */
export function EaseHeight({ children, className }: { children: ReactNode; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i || typeof ResizeObserver === "undefined") return;
    // The observer's first call (on observe) is the baseline: what settles in the frame the box mounts in (a figure
    // strip finding its two columns on a phone) is where it starts, never an ease. Nothing is read at mount: the
    // observer reads the box after the frame's own layout, where a read here forced one (a page's landing paid a
    // whole-page style and layout for it at each EaseHeight, perf round 3).
    let first = true;
    let last = 0;
    let lastWidth = 0;
    let anim: Animation | undefined;
    // Where the running ease is going: a late observation of a change already eased (from a skipped delivery) keeps
    // its curve instead of starting it again.
    let target = 0;
    const check = (observed: boolean) => {
      if (first && !observed) return;
      const box = i.getBoundingClientRect();
      const to = box.height;
      if (first) {
        first = false;
        last = to;
        lastWidth = box.width;
        return;
      }
      // A new width is a new layout (the window resized; a capture sized it to 4 px for a frame), not a content swap:
      // its height is simply there. Easing it would clip the content for 200 ms (a capture caught a chart cut away).
      if (Math.abs(box.width - lastWidth) > 0.5) {
        lastWidth = box.width;
        last = to;
        anim?.cancel();
        return;
      }
      const running = anim?.playState === "running";
      if (running && Math.abs(to - target) < 1) return;
      const shown = running ? o.getBoundingClientRect().height : last;
      last = to;
      if (Math.abs(to - shown) < 1 || typeof o.animate !== "function" || prefersReducedMotion(o)) return;
      // Content already easing its own height (a nested EaseHeight, Attention arriving): follow it.
      if (!running && easingInside(i)) return;
      anim?.cancel();
      target = to;
      anim = o.animate(
        [
          { height: `${shown}px`, overflow: "clip" },
          { height: `${to}px`, overflow: "clip" },
        ],
        {
          duration: 200,
          easing: cssEase(EASE.inOut),
          id: "kit-ease",
        },
      );
    };
    const ro = new ResizeObserver(() => check(true));
    const skipped = () => check(false);
    watchSkippedDelivery();
    easeChecks.add(skipped);
    ro.observe(i);
    return () => {
      ro.disconnect();
      easeChecks.delete(skipped);
      anim?.cancel();
    };
  }, []);
  return (
    <div ref={outer} className={cn("kit-ease", className)}>
      <div ref={inner} className="kit-ease__inner">
        {children}
      </div>
    </div>
  );
}

/**
 * The skeleton while `loading` (at once: it holds the layout from the first paint), then the content. The kit's one
 * way to swap a skeleton for what it stands for: inside an EaseHeight, the height eases from the skeleton's to the
 * content's (200 ms, in-out; nothing when they match, as they do for the kit's own skeletons) while the skeleton fades
 * out under the content (120 ms; the content is at full strength from its first frame), so nothing overlaps what
 * follows and nothing jumps. Reduced motion swaps at once.
 */
export function Reveal({
  loading,
  skeleton,
  children,
  ghost = true,
  className,
}: {
  loading: boolean;
  skeleton: ReactNode;
  children: ReactNode;
  /** The skeleton fades out under the content (default); false when they do not line up (PageReveal decides). */
  ghost?: boolean;
  className?: string;
}) {
  const [was, setWas] = useState(loading);
  const [leaving, setLeaving] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Set while rendering, not in an effect, so the content and the fading skeleton mount in ONE commit: from an effect,
  // the ghost (a second copy of the page's bones) mounted in a second pass after the content's, and the landing paid
  // a second whole-page style and layout for it (perf round 3). Reduced motion swaps at once (the effect below).
  if (loading && (!was || leaving)) {
    setWas(true);
    setLeaving(false);
  } else if (!loading && was && !leaving && !(box.current && prefersReducedMotion(box.current))) {
    setLeaving(true);
  }
  useLayoutEffect(() => {
    if (!loading && was && !leaving) setWas(false);
  }, [loading, was, leaving]);
  useLayoutEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => {
      setWas(false);
      setLeaving(false);
    }, 200);
    return () => clearTimeout(t);
  }, [leaving]);
  return (
    <EaseHeight className={className}>
      <div ref={box} className="kit-reveal">
        {loading ? (
          skeleton
        ) : (
          <>
            <div className="kit-reveal__content" data-entering={leaving ? "" : undefined}>
              <RevealEntering.Provider value={was}>{children}</RevealEntering.Provider>
            </div>
            {leaving && ghost ? (
              // The skeleton drawn again under the page as it fades: nothing in it grows in (an Attention bone is there at
              // full size, as it was), so it sits exactly where the skeleton was.
              <div className="kit-reveal__ghost" aria-hidden="true">
                <RevealEntering.Provider value={true}>{skeleton}</RevealEntering.Provider>
              </div>
            ) : null}
          </>
        )}
      </div>
    </EaseHeight>
  );
}

// Skeletons shaped like their page (LIBRARY.md "skeletons"; PHILOSOPHY P10: "it should look the loaded version
// skeleton"). Each shape is the loaded component's own frame (the same classes, paddings and heights: a FigureStrip's
// skeleton is a FigureStrip with bones in it), so content replaces it without a jump; skull-style bones in the
// original's neutral-100 with a slow, quiet pulse (still with reduced motion). Reveal crossfades the skeleton to the
// content in 160 ms, so nothing flashes. A pixel loader is for AI and agent waits, not for layout (Sean: "skeleton
// loaders when appropriate for layout loading, and pixelfield for cases like this with the AI prompt").
import { type ReactNode, useContext, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { Bone } from "./bone";
import { RevealEntering } from "./ease";
import { cssEase, EASE, prefersReducedMotion } from "./motion";
import "./css/lite.css";
import "./kit.css";

// Bone and TextBone live in bone.tsx, SkeletonFigures in figure-bones.tsx (perf audit 11-23: a page that draws only
// a header's bones loaded the figure strip and the glyph plates); all three stay exported from here.
export { Bone, TextBone } from "./bone";
export { EaseHeight, Reveal, RevealEntering, useRevealEntering } from "./ease";
export { type FigureShape, SkeletonFigures } from "./figure-bones";

/** A region that is loading: aria-busy, one "Loading" for a screen reader, the shape for the eye. */
function Busy({ label = "Loading", children, className }: { label?: string; children: ReactNode; className?: string }) {
  return (
    <div aria-busy="true" data-kit-skeleton="">
      <span className="sr-only" role="status">
        {label}
      </span>
      {/* The shape is the loaded component's own frame, so its first-child and nth-child rules hold. */}
      <div className={className}>{children}</div>
    </div>
  );
}

/**
 * A page header's shape, part for part with PageHeaderView (its own classes, each bone in its part's line height, so it
 * is the header's height and nothing moves when the page lands): the back link, the tile, the 20 px title, its line,
 * the meta line, the actions at the right, and the underline tabs.
 */
export interface SkeletonHeaderProps {
  /**
   * The header's buttons: how many, or their widths in px (`[101, 138]`: Docs, then Create key), so the tabs and the
   * line under them land on their bones. With widths, a phone keeps each at its width but the last, which takes the
   * rest of the row (as the page's primary does).
   */
  actions?: number | readonly number[];
  tile?: boolean;
  line?: boolean;
  /** The back link above the title (a detail page). */
  back?: boolean;
  /**
   * The meta line under the title (a template, a time); "id" when it holds an id to copy, drawn at CopyText's height
   * (24 px, 44 on a phone).
   */
  meta?: boolean | "id";
  /** Underline tabs under the header: how many. */
  tabs?: number;
  className?: string;
}

export function SkeletonHeader({
  actions = 1,
  tile = false,
  line = true,
  back = false,
  meta = false,
  tabs = 0,
  className,
}: SkeletonHeaderProps) {
  const widths = typeof actions === "number" ? null : actions;
  const count = widths ? widths.length : (actions as number);
  return (
    <div aria-busy="true" data-kit-skeleton="">
      <span className="sr-only" role="status">
        Loading the page
      </span>
      {/* The console's mono, asked for while the skeleton shows: met first on the landed page, its swap moved a phone's
          line 5 px (Products r0). */}
      <span className="kit-font-warm" aria-hidden="true">
        0123456789 req_ ms
      </span>
      <div className={cn("kit-page-header-wrap", className)} aria-hidden="true" data-page-slot="header">
        {back ? (
          <span className="kit-back">
            <Bone className="kit-bone--inline w-24" />
          </span>
        ) : null}
        <div className="kit-page-header">
          <div className="kit-page-header__main">
            {tile ? <Bone className="kit-bone--page-tile" /> : null}
            <div className="min-w-0">
              <div className="kit-page-header__title-row">
                <span className="kit-page-title">
                  <Bone className="kit-bone--inline kit-bone--title-inline w-48" />
                </span>
              </div>
              {line ? (
                <p className="kit-page-line">
                  <Bone className="kit-bone--inline w-72 max-w-full" />
                </p>
              ) : null}
              {meta ? (
                <p className="kit-skel-metaline" data-id={meta === "id" ? "" : undefined}>
                  <Bone className="kit-bone--inline w-56 max-w-full" />
                </p>
              ) : null}
            </div>
          </div>
          {count ? (
            <div className="kit-page-header__actions">
              {Array.from({ length: count }, (_, i) => (
                // A Button's height: 40 px from 768 px, 44 on a phone (the tabs under them land on their bones).
                <Bone
                  key={i}
                  className={cn(
                    "h-10 rounded-ds-md max-md:h-11",
                    widths ? "kit-bone--action" : i === count - 1 ? "w-28" : "w-20",
                    widths && i < count - 1 && "kit-bone--fixed",
                  )}
                  style={widths ? { width: widths[i] } : undefined}
                />
              ))}
            </div>
          ) : null}
        </div>
        {tabs ? (
          <div className="kit-page-header__tabs" data-page-slot="tabs">
            <div className="kit-skel-tabs">
              {Array.from({ length: tabs }, (_, i) => (
                <Bone key={i} className="kit-bone--inline" style={{ width: [64, 52, 40, 60, 48, 72, 44][i % 7] }} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A chart's shape: bars (or a fading band for an area chart) the chart's own height, and its axis. */
export function SkeletonChart({
  height = 160,
  bars = 24,
  variant = "bars",
}: {
  height?: number;
  bars?: number;
  variant?: "bars" | "area";
}) {
  return (
    <Busy className="kit-chart" label="Loading the chart">
      <div className="kit-chart__plot" style={{ height }}>
        {variant === "bars" ? (
          <div className="kit-chart-skeleton kit-chart-skeleton--bars">
            {Array.from({ length: bars }, (_, i) => (
              <Bone key={i} className="kit-chart-skeleton__bar" style={{ height: `${30 + ((i * 37) % 55)}%` }} />
            ))}
          </div>
        ) : (
          <div className="kit-chart-skeleton">
            <Bone className="kit-chart-skeleton__band" />
          </div>
        )}
      </div>
      <div className="kit-chart-axis">
        <Bone className="kit-bone--text w-14" />
        <Bone className="kit-bone--text w-10" />
        <Bone className="kit-bone--text w-8" />
      </div>
    </Busy>
  );
}

/** A list of rows (the console's 40 px row lists, two lines with a value at the right). */
export function SkeletonRows({ rows = 5, meta = true }: { rows?: number; meta?: boolean }) {
  return (
    <Busy className="kit-rows" label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="kit-rows__row">
          <div className="grid min-w-0 flex-1 gap-1.5">
            <Bone className="kit-bone--line" style={{ width: `${48 + ((i * 17) % 30)}%` }} />
            {meta ? <Bone className="kit-bone--text" style={{ width: `${28 + ((i * 11) % 20)}%` }} /> : null}
          </div>
          <Bone className="kit-bone--line w-12" />
        </div>
      ))}
    </Busy>
  );
}

/** A DataTable's shape: its sticky header and rows, column for column (pass the table's column widths). */
export function SkeletonTable({
  rows = 6,
  columns = ["32%", "18%", "14%", "16%", "12%"],
}: {
  rows?: number;
  columns?: readonly string[];
}) {
  return (
    <Busy className="kit-table-wrap" label="Loading the table">
      <table className="kit-table">
        <thead>
          <tr>
            {columns.map((w, i) => (
              <th key={i} style={{ width: w }}>
                <Bone className="kit-bone--text w-16" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {columns.map((_, c) => (
                <td key={c}>
                  <Bone
                    className="kit-bone--line"
                    style={{ width: `${c === 0 ? 60 + ((r * 13) % 30) : 40 + ((r * 7 + c * 11) % 40)}%` }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Busy>
  );
}

/**
 * A cold link's one quiet block (Sandboxes and Requests): where a page's skeleton cannot be its shape (a sandbox opened
 * from a link may be running, ended or gone; a request may be found or not), the skeleton stops where the shape is
 * certain (the header's parts) and this block stands under it, down to the page's least height. `leaving` fades it
 * out (useBonesOut) before the page fades in, so two layouts never show at once. `height`: a px number or any CSS
 * length (320 px, 240 px on a phone, by default); `children`: anything the page wants laid out under it unseen (a font
 * to warm).
 */
export function QuietBlock({
  leaving = false,
  height,
  children,
  className,
}: {
  leaving?: boolean;
  height?: number | string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("kit-skel-quiet", className)}
      data-leaving={leaving ? "" : undefined}
      style={height === undefined ? undefined : { height }}
      aria-hidden="true"
      data-kit-skeleton=""
    >
      <Bone className="kit-skel-quiet__bone" />
      {children}
    </div>
  );
}

/** How long a quiet block fades before the page fades in. */
export const BONES_OUT_MS = 120;

/**
 * Holds a skeleton for `ms` once its read lands, with `leaving` set, so a quiet block fades out before the page fades
 * in; reduced motion lets go at once. `held` is what to treat as loading: `loading={held}`, `<QuietBlock leaving={leaving}>`.
 */
export function useBonesOut(loading: boolean, ms = BONES_OUT_MS): { held: boolean; leaving: boolean } {
  const [held, setHeld] = useState(loading);
  const [leaving, setLeaving] = useState(false);
  useLayoutEffect(() => {
    if (loading) {
      setHeld(true);
      setLeaving(false);
      return;
    }
    if (!held) return;
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setHeld(false);
      return;
    }
    setLeaving(true);
    const t = setTimeout(() => {
      setHeld(false);
      setLeaving(false);
    }, ms);
    return () => clearTimeout(t);
  }, [loading, held, ms]);
  return { held, leaving };
}

const bootAt = typeof performance !== "undefined" ? performance.now() : 0;

/**
 * Grows a box from 0 to its height when it mounts after the page's first paint (an Attention line arriving with the
 * data), so what follows slides down over 200 ms instead of jumping. At the page's first paint, and under reduced
 * motion, it is simply there.
 */

/**
 * `evenAtBoot`: grow in the page's first 1.2 s too (a line that arrives with a cold link's first read would otherwise
 * appear at full size: a bone jump, #58).
 */
export function useMountGrow(ref: React.RefObject<HTMLElement | null>, enabled = true, evenAtBoot = false) {
  // Arriving through a Reveal, the block is in place when the page lands: no grow (the crossfade is the motion).
  const revealing = useContext(RevealEntering);
  const viaReveal = useRef(revealing);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof el.animate !== "function" || prefersReducedMotion(el) || viaReveal.current) return;
    if (!evenAtBoot && typeof performance !== "undefined" && performance.now() - bootAt < 1200) return;
    const h = el.getBoundingClientRect().height;
    if (h < 1) return;
    const cs = getComputedStyle(el);
    const pad = { top: cs.paddingTop, bottom: cs.paddingBottom };
    const px = (v: string) => Number.parseFloat(v) || 0;
    const frame = px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    const grow = (from: Keyframe, to: number, ms: number) =>
      el.animate(
        [from, { height: `${to}px`, paddingTop: pad.top, paddingBottom: pad.bottom, opacity: 1, overflow: "clip" }],
        { duration: ms, easing: cssEase(EASE.inOut), id: "kit-ease" },
      );
    const start = performance.now();
    let target = h;
    let anim = grow({ height: "0px", paddingTop: "0px", paddingBottom: "0px", opacity: 0, overflow: "clip" }, h, 200);
    // What grows inside while the box grows in (an Attention bone's rows as the reads add them) is followed to its new
    // height: the box would clip it at the height read at mount, then snap to it when the grow ended (Home's bone at 390,
    // 89 px in one frame).
    const inner = el.firstElementChild;
    if (!inner || typeof ResizeObserver === "undefined") return () => anim.cancel();
    const ro = new ResizeObserver(() => {
      if (anim.playState !== "running") return;
      const now = getComputedStyle(el);
      const natural =
        el.scrollHeight - px(now.paddingTop) - px(now.paddingBottom) + px(pad.top) + px(pad.bottom) + frame;
      if (Math.abs(natural - target) < 1) return;
      const at = el.getBoundingClientRect().height;
      const from: Keyframe = {
        height: `${at}px`,
        paddingTop: now.paddingTop,
        paddingBottom: now.paddingBottom,
        opacity: now.opacity,
        overflow: "clip",
      };
      anim.cancel();
      target = natural;
      anim = grow(from, natural, Math.max(80, 200 - (performance.now() - start)));
    });
    ro.observe(inner);
    return () => {
      ro.disconnect();
      anim.cancel();
    };
  }, [ref]);
}

/**
 * A bone added after its skeleton mounted grows in from nothing: height, min-height, padding and opacity together (a
 * phone's Attention row has a 44 px least height, so a height-only grow was a 44 px jump). For a skeleton's row that a
 * read adds while the page loads (an Attention item, a failed read's line): the bones under it slide. Not EaseHeight's
 * id, so an EaseHeight around the page eases its own height; the fading copy of a skeleton (the Reveal's ghost) never
 * grows. Home's and Actions' useGrowIn, made the kit's.
 */
export function useBoneGrow(ref: React.RefObject<HTMLElement | null>, grow = true) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!grow || !el || typeof el.animate !== "function" || prefersReducedMotion(el)) return;
    if (el.closest(".kit-reveal__ghost")) return;
    const h = el.getBoundingClientRect().height;
    if (h < 1) return;
    const cs = getComputedStyle(el);
    const anim = el.animate(
      [
        { height: "0px", minHeight: "0px", paddingTop: "0px", paddingBottom: "0px", opacity: 0, overflow: "clip" },
        {
          height: `${h}px`,
          minHeight: cs.minHeight,
          paddingTop: cs.paddingTop,
          paddingBottom: cs.paddingBottom,
          opacity: 1,
          overflow: "clip",
        },
      ],
      { duration: 200, easing: cssEase(EASE.inOut), id: "kit-bone-grow" },
    );
    return () => anim.cancel();
  }, [ref, grow]);
}

/**
 * Bones whose place the page cannot know before its first read (a section under a list of endpoints, under the
 * project's keys): they hold the layout while loading, then go with the skeleton without fading over the page (the
 * ghost leaves them out), and the landing checks (PageReveal's slots, kit-check reveal and swap) do not hold them to a
 * place. Wrap the lower sections' bones in it; the first section stays boned exactly (Access round 1 ask 4).
 */
export function UnplacedBones({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("kit-unplaced", className)} data-kit-unplaced="">
      {children}
    </div>
  );
}

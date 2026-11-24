// A page that loads (LIBRARY.md "skeletons"; both area judges caught pages that showed a skeleton not their shape and
// then cut to the page, 48 to 150 px jumps). PageReveal is the one way a page swaps its skeleton for itself: through
// Reveal inside EaseHeight, so a height that differs eases over 200 ms instead of cutting, and the skeleton fades out
// over the page. The page's blocks carry slots (`data-page-slot`: the header, its tabs, the figure strip, the first
// panel); the kit's pieces set theirs (PageHeaderView and SkeletonHeader, FigureStrip and SkeletonFigures,
// SkeletonPanel) and a page marks its own first panel. A slot must sit where its skeleton sat:
// - in development, PageReveal warns in the console when one moves more than 2 px at the swap;
// - kit-check's `reveal` check holds a route's reads, captures, releases, and fails when anything below the header
//   moves more than 2 px in one frame (scripts/kit-check.mjs; an area lists its routes in a reveal-routes.json).
// - Everything that draws the page lands at once. An Attention line renders inside PageReveal's content from the data
//   present at the reveal, so it is in place when the page lands (it does not grow in, and the slots under it are read
//   less its room). When it comes from a read of its own, hold the page for that read too:
//   `loading={!runs.data || !failing.data}`. Never drop Attention to pass the check.
// - A chart inside the content lands as it is (no entrance of its own: the crossfade is the one motion).
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { cn } from "../lib/utils";
import { cssEase, EASE, prefersReducedMotion } from "./motion";
import {
  type FigureShape,
  Reveal,
  SkeletonChart,
  SkeletonFigures,
  SkeletonHeader,
  type SkeletonHeaderProps,
  SkeletonRows,
  SkeletonTable,
  useBonesOut,
} from "./skeleton";
import "./css/lite.css";
import "./kit.css";

/** The slots a page's blocks carry, in page order (attention: an Attention line, which has no bone). */
export const PAGE_SLOTS = ["header", "attention", "tabs", "figures", "panel"] as const;

/** The room a block takes in the flow: to the next block's top, or its own height and margins when it is last. */
export function blockRoom(el: HTMLElement): number {
  const next = el.nextElementSibling as HTMLElement | null;
  const r = el.getBoundingClientRect();
  if (next) return next.getBoundingClientRect().top - r.top;
  const cs = getComputedStyle(el);
  return r.height + Number.parseFloat(cs.marginTop || "0") + Number.parseFloat(cs.marginBottom || "0");
}

/**
 * Each slot's top under `root` (the first of each name, outside a skeleton fading out), in px from root's top. An
 * Attention line has no bone (the skeleton cannot know there will be one): it lands with the page, so the slots under
 * it are read as if it were not there, less the room it takes.
 */
export function slotTops(root: Element): Map<string, number> {
  const top = root.getBoundingClientRect().top;
  // Unplaced bones (UnplacedBones) are not held to a place.
  const live = [...root.querySelectorAll<HTMLElement>("[data-page-slot]")].filter(
    (el) => !el.closest(".kit-reveal__ghost, [data-kit-unplaced]"),
  );
  const attn = live.filter((el) => el.dataset.pageSlot === "attention");
  const out = new Map<string, number>();
  for (const el of live) {
    const name = el.dataset.pageSlot ?? "";
    if (name === "attention" || out.has(name)) continue;
    const y = el.getBoundingClientRect().top;
    const above = attn.filter((a) => a.getBoundingClientRect().top < y).reduce((t, a) => t + blockRoom(a), 0);
    out.set(name, y - top - above);
  }
  return out;
}

/** Each slot's top under `root`, as drawn (no Attention allowance): where the eye sees it. */
export function rawSlotTops(root: Element): Map<string, number> {
  const top = root.getBoundingClientRect().top;
  const out = new Map<string, number>();
  for (const el of root.querySelectorAll<HTMLElement>("[data-page-slot]")) {
    if (el.closest(".kit-reveal__ghost, [data-kit-unplaced]")) continue;
    const name = el.dataset.pageSlot ?? "";
    if (!out.has(name)) out.set(name, el.getBoundingClientRect().top - top);
  }
  return out;
}

/** The slots that moved more than `px` between two readings: "panel moved 48 px". */
export function slotMoves(before: Map<string, number>, after: Map<string, number>, px = 2): string[] {
  const out: string[] = [];
  for (const [name, y] of before) {
    const now = after.get(name);
    if (now !== undefined && Math.abs(now - y) > px) out.push(`${name} moved ${Math.round(now - y)} px`);
  }
  return out;
}

export interface PageRevealProps {
  /**
   * True until every read that draws the page has landed (an error or an empty page is content, not loading): the page's
   * own and its Attention's, `loading={!runs.data || !failing.data}`, so they land together.
   */
  loading: boolean;
  /** The page's own shape: a SkeletonPage, or SkeletonHeader, SkeletonFigures and SkeletonPanel in the page's frame. */
  skeleton: ReactNode;
  /** The page: PageHeaderView, a FigureStrip, its panels (mark the first `data-page-slot="panel"`). */
  children: ReactNode;
  /**
   * The skeleton is the first read's only: once the page has landed, `loading` again (a filter, a tab, a range: a new
   * query key) keeps the page on screen (`data-refreshing`, `aria-busy`), never the skeleton, so nothing flashes and
   * no field the reader is typing in unmounts. A new path (another object: /sandboxes/A to /sandboxes/B) or a new
   * `resetKey` (another object without a path of its own) makes the next read a first read again.
   */
  resetKey?: unknown;
  /**
   * The page landed on its object's failure, not its shape: a cold link whose read failed (no routine, no run to
   * draw), `failed={!r && routine.isError}` with `loading` false and the failure as the children (the page's header and
   * an EmptyState). The header lands on its bone; the skeleton's other parts (its tabs, figures, panels) fade out first
   * (BONES_OUT_MS), then the failure fades in under the header, so two shapes never show at once (sweep r3, need 11).
   * kit-check's reveal lets a part the page lacks go only so: faded out, on a page marked failed.
   */
  failed?: boolean;
  /**
   * The page's header when it needs no read (its title, static actions, tabs whose labels need no data): drawn at once,
   * before the reads, above the part that reveals, and never part of the swap (perf round 3, header first). Leave its
   * bones out of `skeleton`: the skeleton starts under it, and so does the page.
   */
  header?: ReactNode;
  className?: string;
}

/**
 * The key a first read is judged by: the route's path (another object, another page) and the caller's own key. A
 * filter, a range or a tab in the query string keeps it; /sandboxes/A to /sandboxes/B does not.
 */
export function useReadKey(resetKey?: unknown): readonly [string, unknown] {
  const [path] = useLocation();
  return [path, resetKey];
}

const sameKey = (a: readonly [string, unknown], b: readonly [string, unknown]) =>
  a[0] === b[0] && Object.is(a[1], b[1]);

/**
 * Whether a region has landed since its read key (`useReadKey`) last changed: the skeleton belongs to the first read
 * only. True from the first render where `loading` is false.
 */
export function useLanded(loading: boolean, resetKey?: unknown): boolean {
  const key = useReadKey(resetKey);
  const [landed, setLanded] = useState<{ key: readonly [string, unknown]; done: boolean }>(() => ({
    key,
    done: !loading,
  }));
  const done = sameKey(landed.key, key) ? landed.done || !loading : !loading;
  useLayoutEffect(() => {
    if (!sameKey(landed.key, key) || landed.done !== done) setLanded({ key, done });
  });
  return done;
}

/** A react-query result's parts a page needs (structurally typed, so the kit takes no dependency on it). */
export interface ReadLike<T> {
  data: T | undefined;
  isPending: boolean;
  isFetching: boolean;
}

/**
 * A read whose earlier data stays while a new key's read is in flight (a filter, a range, a tab): `data` is the latest
 * that landed, `loading` is true only until the first read lands (since `resetKey` changed), `refreshing` while a later
 * read is in flight. The same as react-query's `placeholderData: keepPreviousData`, for a query whose options the page
 * does not own (a shared hook). Pass `loading` to PageReveal and DataTable; dim nothing else.
 */
export function useKeptRead<T>(
  q: ReadLike<T>,
  resetKey?: unknown,
): { data: T | undefined; loading: boolean; refreshing: boolean } {
  const key = useReadKey(resetKey);
  const kept = useRef<{ key: readonly [string, unknown]; data: T | undefined }>({ key, data: undefined });
  if (!sameKey(kept.current.key, key)) kept.current = { key, data: undefined };
  if (q.data !== undefined) kept.current.data = q.data;
  const data = q.data !== undefined ? q.data : kept.current.data;
  return {
    data,
    loading: data === undefined && q.isPending,
    refreshing: data !== undefined && q.isFetching && (q.data === undefined || q.isPending),
  };
}

/**
 * The skeleton belongs to the page's first read (filters never return to it): true while that read is in flight, false
 * from the frame it lands and for every later read (a tab's, a filter's). `useLanded` judges the first read.
 */
export function useFirstRead(loading: boolean, resetKey?: unknown): boolean {
  const landed = useLanded(loading, resetKey);
  return loading && !landed;
}

/**
 * The box around a tab's panels eases from the height it had when the panel on screen changes (`key`). The ease starts
 * in the layout effect of the commit that swapped the panel, before the next frame's layout is read, so no frame shows
 * the new panel at its own height first (EaseHeight starts in a ResizeObserver, after a frame's first reads). Pair it with useTabHold. Its id is
 * EaseHeight's, so an EaseHeight around it follows it. Heights count the page's empty floor under the panel (the
 * nearest `.kit-page-floor` box), so the ease runs its whole curve where it shows instead of stopping halfway when the
 * page meets its floor. (Vision's and Infer's copies, made one.)
 */
export function useSwapEase<T>(key: T): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  /** The box's height and the page's empty floor under it. */
  const seen = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const page = el.closest(".kit-page-floor");
    return r.height + (page ? Math.max(0, page.getBoundingClientRect().bottom - r.bottom) : 0);
  };
  const last = useRef<{ key: T; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const easing = el.getAnimations?.().some((x) => x.playState === "running");
      if (last.current && !easing) last.current.h = seen(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = last.current;
    // Only a swap reads layout (perf audit 11-23: this ran on every render of the page, a forced layout each time); the
    // observer above keeps the height current between swaps.
    if (prev && Object.is(prev.key, key)) return;
    const h = seen(el);
    last.current = { key, h };
    if (!prev || Math.abs(prev.h - h) < 1 || typeof el.animate !== "function" || prefersReducedMotion(el)) return;
    const anim = el.animate(
      [
        { height: `${prev.h}px`, overflow: "clip" },
        { height: `${h}px`, overflow: "clip" },
      ],
      { duration: 200, easing: cssEase(EASE.inOut), id: "kit-ease" },
    );
    // The new panel may still settle while it eases (a figure strip finding its columns): the ease aims at where it
    // settles, so it does not land a few px short and step there after.
    const panel = el.firstElementChild;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (anim.playState !== "running" || !(anim.effect instanceof KeyframeEffect)) return;
      const to = Math.max(h, panel.getBoundingClientRect().height);
      anim.effect.setKeyframes([
        { height: `${prev.h}px`, overflow: "clip" },
        { height: `${to}px`, overflow: "clip" },
      ]);
    });
    ro.observe(panel);
    anim.finished.then(
      () => ro.disconnect(),
      () => ro.disconnect(),
    );
  });
  return ref;
}

/** Whether an animation runs on an element around `box` (the reveal's own EaseHeight, or one outside it). */
function aroundBox(a: Animation, box: Element | null): boolean {
  const target = typeof KeyframeEffect !== "undefined" && a.effect instanceof KeyframeEffect ? a.effect.target : null;
  return !!box && target instanceof Element && target.contains(box);
}

export function PageReveal({
  loading: reading,
  skeleton,
  children,
  resetKey,
  failed = false,
  header,
  className,
}: PageRevealProps) {
  // The skeleton is the first read's: after the page lands, a later read keeps it on screen (refreshing).
  const landed = useLanded(reading, resetKey);
  const first = reading && !landed;
  // A failed landing holds the skeleton while its parts below the header fade out (`leaving`), then lets it go.
  const out = useBonesOut(first);
  const region = useRef<HTMLDivElement>(null);
  // The skeleton reaches its final height before the page lands: a bone row the reads added that is still growing
  // (useBoneGrow, a mount grow, an ease) holds the swap until it ends, 400 ms at most; else the page landed on a bone
  // half grown and what followed moved (Home's figures, 5 to 96 px on seven swap routes: sweep need 12).
  const [prevFirst, setPrevFirst] = useState(first);
  const [growing, setGrowing] = useState<readonly Animation[] | null>(null);
  if (prevFirst !== first) {
    setPrevFirst(first);
    if (prevFirst && !first && region.current && typeof region.current.getAnimations === "function") {
      // Not the reveal's own height ease (its EaseHeight, around the whole box): that ease moves nothing inside the box,
      // so the page lands on every bone during it and the ease runs on to the page's height. Home waited 150 to 180 ms
      // for it on a phone (perf round 3).
      const box = region.current.querySelector(":scope > .kit-ease > .kit-ease__inner > .kit-reveal");
      const anims = region.current
        .getAnimations({ subtree: true })
        .filter(
          (a) => a.playState === "running" && (a.id === "kit-bone-grow" || (a.id === "kit-ease" && !aroundBox(a, box))),
        );
      if (anims.length) setGrowing(anims);
    }
  }
  useEffect(() => {
    if (!growing) return;
    let live = true;
    const done = () => {
      if (live) setGrowing(null);
    };
    const t = window.setTimeout(done, 400);
    void Promise.all(growing.map((a) => a.finished.catch(() => undefined))).then(done);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [growing]);
  const loading = (failed ? out.held : first) || growing !== null;
  const leaving = failed && out.leaving;
  const refreshing = reading && landed;
  const shape = useRef<Map<string, number> | null>(null);
  // Where the skeleton's slots were drawn, read on each render while loading; at the swap, a slot drawn elsewhere (an
  // Attention line the skeleton had no bone for pushes the page down) gets no cross-fade: the fading skeleton would sit
  // off its block, a doubled page. The page is then simply there and only the height eases.
  const drawn = useRef<Map<string, number> | null>(null);
  const [fade, setFade] = useState(true);
  // The ease the page lands with (EaseHeight's 200 ms), marked: the shell keeps its footer out of sight while the page
  // reads and through this ease, then fades it in where it ends up (it sat at the window's foot and left it in one
  // frame as a detail page grew; Requests judges r2 and r3).
  const [landing, setLanding] = useState(false);
  const wasLoading = useRef(loading);
  useLayoutEffect(() => {
    const was = wasLoading.current;
    wasLoading.current = loading;
    if (!was || loading) return;
    setLanding(true);
    const t = window.setTimeout(() => setLanding(false), 260);
    return () => window.clearTimeout(t);
  }, [loading]);
  // While loading, the skeleton's slots are read whenever the region changes size (an Attention bone easing in, a
  // font arriving), so the reading at the swap is of the skeleton as last drawn.
  useLayoutEffect(() => {
    const el = region.current;
    if (!el || !loading) return;
    const read = () => {
      drawn.current = rawSlotTops(el);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);
  useLayoutEffect(() => {
    const el = region.current;
    if (!el) return;
    if (loading) {
      if (!fade) setFade(true);
      return;
    }
    const was = drawn.current;
    drawn.current = null;
    if (!was) return;
    // A failure is judged by its header alone (the rest of the skeleton has faded out, and stays out in the ghost).
    const now = rawSlotTops(el);
    if (failed) for (const k of [...was.keys()]) if (k !== "header") was.delete(k);
    const offset = slotMoves(was, now).length > 0;
    if (offset === fade) setFade(!offset);
  }, [loading, fade, failed]);
  // A failed landing: the skeleton's parts other than the header fade out (kit.css [data-kit-fade-out]), held and in
  // the ghost that fades over the failure. Marked here, not by a :has() rule (every layout under the reveal paid for
  // one); the ghost mounts in Reveal's own render, so an observer marks it before it paints.
  useLayoutEffect(() => {
    const box = region.current?.querySelector(".kit-reveal");
    if (!failed || !box) return;
    markFadeOut(box);
    if (typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(() => markFadeOut(box));
    mo.observe(box, { childList: true });
    return () => mo.disconnect();
  }, [failed]);
  // Development only: where the skeleton's slots sat (read on every render while loading), then where the page's do.
  useLayoutEffect(() => {
    if (!import.meta.env.DEV || !region.current) return;
    if (loading) {
      shape.current = slotTops(region.current);
      return;
    }
    const was = shape.current;
    shape.current = null;
    if (!was) return;
    const moved = slotMoves(was, slotTops(region.current));
    if (moved.length)
      console.warn(`PageReveal: the skeleton is not the page's shape (${moved.join(", ")}). Fix the skeleton.`);
  });
  return (
    <div
      ref={region}
      className={cn("kit-page-reveal", className)}
      data-page-reveal=""
      data-loading={loading ? "" : undefined}
      data-refreshing={refreshing ? "" : undefined}
      data-landing={landing ? "" : undefined}
      data-failed={failed && !reading ? "" : undefined}
      data-leaving={leaving ? "" : undefined}
      aria-busy={reading || undefined}
    >
      {header}
      <Reveal loading={loading} skeleton={skeleton} ghost={fade}>
        {children}
      </Reveal>
    </div>
  );
}

/**
 * Marks the top-most parts of a skeleton (under a Reveal's box, or its ghost) that hold no header, and every slot inside
 * the header (its tabs), `data-kit-fade-out`; the page's own content is left alone.
 */
function markFadeOut(root: Element) {
  for (const child of root.children) {
    if (child.classList.contains("kit-reveal__content") || child.classList.contains("sr-only")) continue;
    if (child.matches('[data-page-slot="header"]')) {
      for (const s of child.querySelectorAll("[data-page-slot]")) s.setAttribute("data-kit-fade-out", "");
    } else if (child.querySelector('[data-page-slot="header"]')) markFadeOut(child);
    else child.setAttribute("data-kit-fade-out", "");
  }
}

export interface SkeletonPanelProps {
  /** The first panel's shape: a table, rows, a chart; or its own bones. */
  kind?: "table" | "rows" | "chart";
  rows?: number;
  columns?: readonly string[];
  /** A chart's height. */
  height?: number;
  children?: ReactNode;
  className?: string;
}

/** A page's first panel loading, in the panel slot. */
export function SkeletonPanel({ kind = "rows", rows, columns, height, children, className }: SkeletonPanelProps) {
  return (
    <div className={className} data-page-slot="panel">
      {children ??
        (kind === "table" ? (
          <SkeletonTable rows={rows} columns={columns} />
        ) : kind === "chart" ? (
          <SkeletonChart height={height} />
        ) : (
          <SkeletonRows rows={rows} />
        ))}
    </div>
  );
}

export interface SkeletonPageProps {
  /** SkeletonHeader's parts, as the page's header has them (false: the page draws its header outside). */
  header?: SkeletonHeaderProps | false;
  /** The figure strip's shapes, figure for figure. */
  figures?: readonly FigureShape[];
  /** The first panel (false: none). */
  panel?: SkeletonPanelProps | false;
  /** The page body's own frame class (its gaps), the same one the page's body uses. */
  bodyClassName?: string;
}

/** A page's skeleton from the kit's pieces: its header, its figure strip, its first panel, in the page's frame. */
export function SkeletonPage({ header = {}, figures, panel = {}, bodyClassName }: SkeletonPageProps) {
  return (
    <>
      {header ? <SkeletonHeader {...header} /> : null}
      {figures?.length || panel ? (
        <div className={bodyClassName}>
          {figures?.length ? <SkeletonFigures shapes={figures} /> : null}
          {panel ? <SkeletonPanel {...panel} /> : null}
        </div>
      ) : null}
    </>
  );
}

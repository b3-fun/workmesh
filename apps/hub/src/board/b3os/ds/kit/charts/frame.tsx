// What every kit chart shares: its measured width, the point under the pointer or the keyboard, and the tooltip card
// (the original's: the throughput chart's card in BillingClient, shadow-ds-elev-2, tabular numbers), which tracks the
// pointer and moves to the left of the point near the plot's end, so it never clips (PHILOSOPHY P11: "tooltip not
// showing (cut off), should remain tracked with the cursor on hover"). A chart is one tab stop: arrows step through the
// points, Home and End jump, Escape lets go; a polite live region reads the point, so the tooltip is not mouse-only.
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/utils";
import { announce } from "../announce";
import { CopyText } from "../copy";
import { useCountdown } from "../countdown";
import { indexAt } from "./scale";
import "../css/lite.css";
import "../kit.css";

/**
 * Colours a series can take: the brand blue first, then a lighter brand and a mid grey (a ramp, so a stacked chart reads
 * as one family and its third band never vanishes on white), red for failures. Few on purpose (P14).
 */
/** Inside a Figure's trend slot: a sparkline there is a picture of the figure's value, so it is not a Tab stop. */
export const InFigureTrend = createContext(false);

export type Tone = "brand" | "brand-2" | "neutral" | "danger" | "warning" | "success" | "muted";

export const TONE_VAR: Record<Tone, string> = {
  brand: "var(--kit-chart-brand)",
  "brand-2": "var(--kit-chart-brand-2)",
  neutral: "var(--kit-chart-neutral)",
  danger: "var(--kit-chart-danger)",
  warning: "var(--kit-chart-warning)",
  success: "var(--kit-chart-success)",
  muted: "var(--kit-chart-muted)",
};

/** The element's content width, kept current (0 until measured: a chart draws nothing at 0, so no layout jump). */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  // Measured in a layout effect, before the first paint: in a passive one it read the box before its FigureStrip
  // settled, and the sparkline's last dot moved 40 px a frame after the page landed (#58).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    // A degenerate box for a frame (some full-page captures size the window to 4 x 4) keeps the last real width.
    const ro = new ResizeObserver(([e]) => {
      if (!e) return;
      const w = Math.round(e.contentRect.width);
      setWidth((prev) => (w < 10 && prev >= 10 ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** The active point: set by the pointer (hover, touch) and the keyboard; null when nothing is picked. */
export function usePointer(n: number, width: number, mode: "band" | "point") {
  const [active, setActive] = useState<number | null>(null);
  const pick = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setActive(indexAt(clientX - r.left, r.width || width, n, mode));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (n === 0) return;
    const from = active ?? n - 1;
    const next =
      e.key === "ArrowRight"
        ? Math.min(n - 1, from + (active === null ? 0 : 1))
        : e.key === "ArrowLeft"
          ? Math.max(0, from - (active === null ? 0 : 1))
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : e.key === "Escape"
                ? null
                : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
  };
  return {
    active,
    setActive,
    plotProps: {
      tabIndex: n > 0 ? 0 : -1,
      onPointerMove: (e: React.PointerEvent<HTMLElement>) => pick(e.clientX, e.currentTarget),
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => pick(e.clientX, e.currentTarget),
      onPointerLeave: () => setActive(null),
      onBlur: () => setActive(null),
      onKeyDown,
    },
  };
}

/**
 * A chart's values in words, for its description (a11y audit 11-23, S8: a chart carried a title only, and its values
 * came only from arrow keys a screen reader in browse mode never sends): the latest, the peak with when, the total.
 */
export function chartSummary(
  values: readonly (number | null)[],
  when: (i: number) => string,
  words: (n: number) => string,
  total = true,
): string {
  const known = values.map((v, i) => [v, i] as const).filter((x): x is readonly [number, number] => x[0] !== null);
  if (!known.length) return "No data.";
  const [last, li] = known[known.length - 1] as readonly [number, number];
  const [peak, pi] = known.reduce((a, b) => (b[0] > a[0] ? b : a));
  const sum = known.reduce((a, b) => a + b[0], 0);
  return `${when(li)}: ${words(last)}. Peak ${words(peak)}, ${when(pi)}.${total ? ` Total ${words(sum)}.` : ""}`;
}

/** The keys a scrubbable chart answers, said after its summary. */
export const CHART_KEYS = "Left and right arrows read each point.";

/** What the keyboard user hears for the active point, through the kit's one announcer (no live region a chart). */
export function ChartLive({ text }: { text: string | null }) {
  useEffect(() => {
    if (text) announce(text);
  }, [text]);
  return null;
}

/** The x axis under a chart: the first, middle and last labels (or the ones given), 11 px, never more. */
/**
 * The x axis under a plot. When its labels change (a new range), the new ones fade in over the morph's 240 ms, with the
 * y labels, never at first paint.
 */
export function ChartAxis({ labels, className }: { labels: readonly ReactNode[]; className?: string }) {
  const sig = labels.map((l) => (typeof l === "string" ? l : "·")).join("|");
  const first = useRef(sig);
  const changed = first.current !== sig;
  return (
    <div
      className={cn("kit-chart-axis", className)}
      aria-hidden="true"
      data-changed={changed ? "" : undefined}
      key={sig}
    >
      {labels.map((l, i) => (
        <span key={i}>{l}</span>
      ))}
    </div>
  );
}

/** A chart's empty plot: the baseline and one quiet line, the plot's own height, so nothing jumps when data comes. */
export function ChartEmpty({ height, children }: { height: number; children: ReactNode }) {
  return (
    <div className="kit-chart-empty" style={{ height }}>
      <span>{children}</span>
    </div>
  );
}

/** A chart's legend: a swatch, the series and its total over the range, on one line that wraps between items. */
export function ChartLegend({
  items,
}: {
  items: readonly { label: string; tone: Tone; value?: string; swatch?: string }[];
}) {
  return (
    <ul className="kit-legend" aria-label="Legend">
      {items.map((it) => (
        <li key={it.label} className="kit-legend__item">
          <i
            className="kit-legend__swatch"
            style={
              it.swatch
                ? { background: it.swatch, boxShadow: `inset 0 0 0 1.5px ${TONE_VAR[it.tone]}` }
                : { background: TONE_VAR[it.tone] }
            }
            aria-hidden="true"
          />
          <span>{it.label}</span>
          {it.value ? <span className="kit-legend__value">{it.value}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * A chart's failed read, said as the page's own failure lines say it (BarChart and AreaChart `error`): its words ("Calls
 * did not load"), the failed call's request id to copy, and the answer's Retry-After, counted down where Retry will be.
 */
export interface ChartFailure {
  words?: ReactNode;
  requestId?: string | null;
  /** Seconds (the failure's Retry-After). */
  retryAfter?: number | null;
  /** A new failure with the same wait (its error object): the count starts again. */
  retryKey?: unknown;
}

/** A chart's error prop: true says "Did not load"; a failure says its own words, id and wait. */
export function chartFailure(error: boolean | ChartFailure | null | undefined): ChartFailure | null {
  if (!error) return null;
  return error === true ? {} : error;
}

/** One quiet line where the series would be, the plot's own height: the read failed, and Retry. */

export function ChartError({
  height,
  onRetry,
  retrying = false,
  retryAfter,
  retryKey,
  requestId,
  align = "center",
  children = "Did not load",
}: {
  height?: number;
  onRetry?: () => void;
  /**
   * The retry is in flight (useRetryAction's busy): Retry stays in place and keeps the focus, busy and not pressable
   * (aria-busy, aria-disabled), so a second press never starts a second read (sweep need 14).
   */
  retrying?: boolean;
  /**
   * Seconds before a retry can work (the failure's Retry-After): "Retry in 4 s" counts down where Retry will be, so the
   * line never offers a Retry that would fail again. Leave "Try again in 5 s." out of the words.
   */
  retryAfter?: number;
  /** A new failure with the same wait (its error object): the count starts again. */
  retryKey?: unknown;
  /** The failed call's request id, to copy (as a page's error gives it). */
  requestId?: string;
  /** "start" in a list's body, under its title (centred reads as a chart's empty plot). */
  align?: "center" | "start";
  children?: ReactNode;
}) {
  const left = useCountdown(onRetry ? retryAfter : 0, retryKey);
  // The request id the line shows is the first failure's until Retry is pressed: a read that fails again on its own
  // retry brings a new id, and the alert holding it was said again each time (a11y audit 11-23). The countdown's
  // seconds are hidden from a screen reader too, so the alert changes only when Retry is there to press.
  // `after`: the id current when Retry was pressed; the next different one is the new failure's to show.
  const [held, setHeld] = useState<{ id: string | undefined; after: string | undefined | null }>({
    id: requestId,
    after: null,
  });
  const fresh = held.after !== null && requestId !== held.after;
  if ((held.id === undefined || fresh) && requestId !== undefined && requestId !== held.id)
    setHeld({ id: requestId, after: null });
  const shownId = held.id ?? requestId;
  const retry = onRetry
    ? () => {
        setHeld((h) => ({ ...h, after: requestId }));
        onRetry();
      }
    : undefined;
  // A part whose next part starts the next line ends its line: its "·" is not drawn there (Home judge r1: "request req_…
  // ·", then Retry under it). Hidden, not removed, so the parts keep their widths and the wrap holds.
  const line = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = line.current;
    if (!el) return;
    const mark = () => {
      const parts = [...el.children] as HTMLElement[];
      parts.forEach((part, k) => {
        const next = parts[k + 1];
        const ends = !!next && next.getBoundingClientRect().top >= part.getBoundingClientRect().bottom - 1;
        if (ends) part.setAttribute("data-ends-line", "");
        else part.removeAttribute("data-ends-line");
      });
    };
    mark();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(mark);
    ro.observe(el);
    return () => ro.disconnect();
  });
  return (
    <div
      className={cn("kit-chart-empty kit-chart-error", height === undefined && "kit-inline-error")}
      style={{ height }}
      role="alert"
      data-align={align === "start" ? "start" : undefined}
    >
      {/* One line that wraps (never wider than its row): the request id cut in the middle (the whole id copies), and
          Retry on the next line when the row is narrow, always in the window (a phone pushed it out at 390). */}
      <span ref={line} className="kit-chart-error__line">
        {/* Each part's separator ends it, so a wrapped line never opens with "·"; nor ends with one (data-ends-line). */}
        <span className="kit-chart-error__words">
          <i className="kit-chart-error__dot" aria-hidden="true" />
          {children}
          {shownId || onRetry ? (
            <span className="kit-chart-error__sep" aria-hidden="true">
              ·
            </span>
          ) : null}
        </span>
        {shownId ? (
          <span className="kit-chart-error__id">
            request
            <CopyText value={shownId} display={cutId(shownId)} label={`Copy request id ${shownId}`} />
            {onRetry ? (
              <span className="kit-chart-error__sep" aria-hidden="true">
                ·
              </span>
            ) : null}
          </span>
        ) : null}
        {onRetry && left > 0 ? (
          // The count is not read out each second (the line is an alert): once, as a whole.
          <span className="kit-chart-error__retry kit-chart-error__wait" data-retry-in={left}>
            <span aria-hidden="true">Retry in {left} s</span>
            <span className="sr-only">Retry in {Math.max(0, Math.ceil(retryAfter ?? 0))} seconds</span>
          </span>
        ) : onRetry ? (
          <span className="kit-chart-error__retry">
            <button
              type="button"
              className="kit-link"
              onClick={retrying ? undefined : retry}
              aria-busy={retrying || undefined}
              aria-disabled={retrying || undefined}
              data-busy={retrying ? "" : undefined}
            >
              Retry
            </button>
          </span>
        ) : null}
      </span>
    </div>
  );
}

export { useCountdown };

/** An id cut in the middle for a line that must fit (req_01jf8k…8s9t0u); the whole id still copies. */
export function cutId(id: string, head = 10, tail = 6): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/** The same one line ("Did not load · Retry") for any region that failed: a figure strip, a card grid, a list. */
export { ChartError as InlineError };

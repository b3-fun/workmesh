// A row of figures as one object (ticker.tsx's Figure is its cell), in a module of its own (perf audit 11-23): the
// strip and its skeleton need neither NumberFlow nor the logos, so a page that draws only bones (sign-in, a skeleton)
// loads none of them.
import { Children, type ReactNode, useRef } from "react";
import { cn } from "../lib/utils";
import "./css/lite.css";
import "./kit.css";

/**
 * A row of figures as ONE object (sean-design-polish: "a row of stat tiles is ONE object, not N cards"): a 1 px gap
 * over the line colour draws the dividers; on a phone two per row, an odd last one across the row.
 */
/** The strip's columns: every figure in one row while each gets FIGURE_MIN px, else two a row (never 3+1). */
export const FIGURE_MIN = 200;
export function figureCols(width: number, n: number): number {
  if (n <= 1) return 1;
  if (width <= 0) return n;
  if (width / n >= FIGURE_MIN) return n;
  // Three a row when three fit and no figure is left alone (five are 3 + 2, six 3 + 3, eight 3 + 3 + 2; four never
  // 3 + 1); else two a row with an odd last one across. The strip's CSS draws the same rule as container queries
  // (kit.css "Figures"), so it knows its columns at its first layout: this function states the rule for tests and pages.
  if (width >= 3 * FIGURE_MIN && n % 3 !== 1) return 3;
  return 2;
}

export function FigureStrip({
  children,
  label,
  failed,
  onRetry,
  className,
}: {
  children: ReactNode;
  label?: string;
  /** The read failed: the figures show their dashes and one line across the strip says so, with Retry. */
  failed?: boolean | string;
  onRetry?: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const n = Children.toArray(children).filter(Boolean).length || 1;
  return (
    <>
      {/* The columns are the strip's CSS (container queries on this box, by the figure count), so the first layout is
          already the right one: a measuring render drew four across at 1024 for a frame and PageReveal read it
          (Requests r2). */}
      <div className="kit-figures-box">
        <section
          ref={ref}
          className={cn("kit-figures", className)}
          data-page-slot="figures"
          aria-label={label}
          data-n={n}
        >
          {children}
        </section>
      </div>
      {failed ? (
        <p className="kit-figures__error" role="alert">
          <i className="kit-chart-error__dot" aria-hidden="true" />
          {typeof failed === "string" ? failed : "These figures did not load"}
          {onRetry ? (
            <>
              <span aria-hidden="true">·</span>
              <button type="button" className="kit-link" onClick={onRetry}>
                Retry
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

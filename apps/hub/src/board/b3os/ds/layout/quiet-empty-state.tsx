// Beta addition (console elegance, area 2; AUDIT 2.5, DIRECTION.md 2 and 3): the empty state as two centred lines,
// which the original does not have (its InteractiveEmptyState is a dotted box with a lifting icon tile, the audit's
// S14: three frames around one icon). No box, no tile: a title, one line under it, the page's one action if the
// header does not already have it, and one quiet pixel field above the words (DIRECTION 2: an empty state's one pixel
// element, twinkle at low contrast). The field is still at rest and plays only while the pointer is on the empty
// state; with reduced motion it never moves. Lit pixels are the brand blue, unlit ones the hairline grey, no glow.
// No motion library: it draws with the page, with nothing to load first.
import { type ReactNode, useState } from "react";
import { cn } from "../lib/utils";
import { PixelField } from "../signature/pixel-field";

export interface QuietEmptyStateProps {
  /** What is empty, in a few words ("No sandboxes yet"). */
  title: ReactNode;
  /** One line under it: what to do, or why (may hold a link). */
  description?: ReactNode;
  /** The one action, only where the page header does not already have it. */
  action?: ReactNode;
  /** The pixel field above the words; off for an empty state inside a small panel. */
  field?: boolean;
  className?: string;
}

/**
 * The field's colours: the hairline for an unlit pixel, the brand blue for a lit one, no glow. Classes on the field
 * itself, one class heavier than the palette pixel-grid.css sets there (`.pixel-grid--blue`, later in the sheet),
 * which an inherited value from a wrapper does not reach.
 */
const FIELD_COLOURS =
  "[&.pixel-grid]:[--pixel-off:var(--ds-border-default)] [&.pixel-grid]:[--pixel-on:var(--ds-brand-500)] [&.pixel-grid]:[--pixel-glow:transparent]";

export function QuietEmptyState({ title, description, action, field = true, className }: QuietEmptyStateProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      className={cn("flex flex-col items-center px-4 py-14 text-center", className)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-empty-state=""
    >
      {field ? (
        <span aria-hidden="true" className="mb-4 inline-flex">
          <PixelField
            rows={3}
            cols={7}
            cell={4}
            gap={2}
            pattern="twinkle"
            autoplay={hovered}
            aria-label=""
            className={FIELD_COLOURS}
          />
        </span>
      ) : null}
      <p className="text-ink text-ui font-medium text-balance">{title}</p>
      {description ? <p className="text-ink-3 text-small mt-1 max-w-[36rem] text-pretty">{description}</p> : null}
      {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

export default QuietEmptyState;

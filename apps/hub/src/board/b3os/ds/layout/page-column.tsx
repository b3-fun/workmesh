// Beta addition (console elegance, area 2; DIRECTION.md 1.4 and 4): the page column, which the original does not have
// (its PageLayout draws a card around the page). Pages with text and tables sit in one column of at most 1200 px,
// centred in the room the navigation leaves; a canvas, a log or a trace page takes the full width (`full`). Nothing
// changes until the room is wider than the column (from about 1540 px of window beside the console's sidebar).
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/** The column's widest, in px. */
export const PAGE_COLUMN_MAX = 1200;

export interface PageColumnProps {
  children: ReactNode;
  /** A canvas, log or trace page: the full width the frame gives. */
  full?: boolean;
  className?: string;
}

export function PageColumn({ children, full = false, className }: PageColumnProps) {
  return (
    <div
      className={cn("mx-auto w-full min-w-0", !full && "max-w-[1200px]", className)}
      data-page-column={full ? "full" : ""}
    >
      {children}
    </div>
  );
}

export default PageColumn;

// The page header (LIBRARY.md "page header"; DESIGN.md 5's list and detail templates). One 20 px semibold title, at
// most one short line under it (PHILOSOPHY 5.12: "a page title plus at most one short line"), the page's actions at the
// right with at most one brand button. A detail page adds a back link above, the object's tile at the left (the
// original's embossed plate), its status inline after the name, and a meta line whose items are parted by the B3OS pixel
// square (MetaDot: "make sure you use metapixel like we do on dot separators"). A tabs row can sit under it, its hairline
// running the stage's width. Presentational: the console's own PageHeader (Shell.tsx) names the browser tab around it.
import type { ReactNode } from "react";
import { isValidElement, type ReactElement } from "react";
import { Icon, type IconName } from "../../ui/Icon";
import { cn } from "../lib/utils";
import { MetaDot } from "../signature/meta-dot";
import { KitLink } from "./link";
import { BrandLogo, type BrandName } from "./logos";
import "./css/lite.css";
import "./kit.css";

/**
 * Items parted by the pixel square, on one line that wraps between items, never inside one. Every item carries its
 * square in front, and the line is pulled left by one square's width and clipped there, so the square of whichever item
 * starts a line (the first, or one that wrapped) falls outside the box: no line ever begins with a separator.
 */
export function MetaLine({ items, id, className }: { items: readonly ReactNode[]; id?: string; className?: string }) {
  const shown = items.filter((x) => x !== null && x !== undefined && x !== false && x !== "");
  if (shown.length === 0) return null;
  return (
    <p id={id} className={cn("kit-meta", className)}>
      {shown.map((it, i) => (
        <span key={i} className="kit-meta__item">
          <MetaDot className="kit-meta__dot" />
          {it}
        </span>
      ))}
    </p>
  );
}

export interface PageHeaderViewProps {
  title: ReactNode;
  /** The one short line under the title. */
  line?: ReactNode;
  back?: { href: string; label: string };
  /** A detail page's object, on the original's embossed plate: a console glyph, or a brand's logo (a routine's GitHub or
   * Stripe trigger). */
  /** The object's tile: a console glyph, a brand's logo, or a node of the caller's own (a pack's glyph). */
  tile?: IconName | { brand: BrandName } | ReactElement;
  /** The object's state, inline after its name (a kit Status). */
  status?: ReactNode;
  /** A detail page's facts, parted by the pixel square: an id, a source, when. */
  meta?: readonly ReactNode[];
  actions?: ReactNode;
  /** A Tabs row under the header (the detail template's tabs). */
  tabs?: ReactNode;
  /** Between the header and its tabs (a request's failure above its tabs), so the tabs keep their place. */
  beforeTabs?: ReactNode;
  className?: string;
}

export function PageHeaderView({
  title,
  line,
  back,
  tile,
  status,
  meta,
  actions,
  tabs,
  beforeTabs,
  className,
}: PageHeaderViewProps) {
  return (
    <header className={cn("kit-page-header-wrap", className)} data-page-header="" data-page-slot="header">
      {back ? (
        <KitLink href={back.href} className="kit-back">
          <Icon name="arrowLeft" size={14} />
          {back.label}
        </KitLink>
      ) : null}
      <div className="kit-page-header">
        <div className="kit-page-header__main">
          {tile ? (
            <span
              className="kit-page-tile"
              aria-hidden="true"
              data-brand={typeof tile === "string" || isValidElement(tile) ? undefined : ""}
            >
              {isValidElement(tile) ? (
                tile
              ) : typeof tile === "string" ? (
                <Icon name={tile} size={20} />
              ) : (
                <BrandLogo name={tile.brand} size={20} decorative />
              )}
            </span>
          ) : null}
          <div className="min-w-0">
            <div className="kit-page-header__title-row">
              <h1 className="kit-page-title">{title}</h1>
              {status ? <span className="kit-page-header__status">{status}</span> : null}
            </div>
            {line ? <p className="kit-page-line">{line}</p> : null}
            {meta ? <MetaLine items={meta} className="mt-1.5" /> : null}
          </div>
        </div>
        {actions ? (
          <div className="kit-page-header__actions" data-page-actions="">
            {actions}
          </div>
        ) : null}
      </div>
      {beforeTabs ? <div className="kit-page-header__before-tabs">{beforeTabs}</div> : null}
      {tabs ? (
        <div className="kit-page-header__tabs" data-page-slot="tabs">
          {tabs}
        </div>
      ) : null}
    </header>
  );
}

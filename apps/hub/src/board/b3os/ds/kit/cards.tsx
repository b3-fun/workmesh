// Cards for list pages (LIBRARY.md "cards"), so Applications, Sandboxes and Routines have something better than a table
// to build from.
// - ResourceCard is the original's workflow card (WorkflowCardView): the raised white module (the card surface, a
//   hairline, the soft shadow), a sunken preview inset holding the resource's parts as embossed tiles (IconTile) joined
//   by a dashed rule, the status pill in its corner, then the name, one line and a meta line parted by pixel squares. On
//   hover it lifts 2 px (200 ms, the original's ease-out-quart) and the inset's dots light under the pointer: the
//   original's pointer halftone (ds/signature/PointerHalftone), the "pixel cursor effects" Sean asked for, drawn under
//   the tiles and their labels (each label sits on the well's tint) and at half strength in dark. The well is a tint
//   with the dot grid and no border of its own, so it reads as media, not a card in a card. Reduced motion keeps it
//   still. Loading: SkeletonResourceCards; empty: FirstRun; failed: one InlineError line in the grid's frame.
// - RowCard is "each machine as its own row card" (b3iq): an embossed tile, the name in mono with its status inline, a
//   meta line, a trend and a value at the right, its actions sliding up 6 px into view on hover or focus (160 ms). A
//   row that opens lights a field of the B3OS pixel squares at its right edge on hover (fading in over 160 ms).
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Icon, type IconName } from "../../ui/Icon";
import { IconTile } from "../layout/node-icon-tile";
import { cn } from "../lib/utils";
import { PointerHalftone } from "../signature/PointerHalftone";
import { KitLink } from "./link";
import { BrandLogo, type BrandName } from "./logos";
import { MetaLine } from "./page-header";
import { Bone } from "./skeleton";
import "./css/lite.css";
import "./kit.css";

export interface CardPart {
  /** A console glyph, or a brand's logo. */
  icon?: IconName;
  brand?: BrandName;
  label: string;
}

function PartTile({ part }: { part: CardPart }) {
  return (
    <span className="kit-card-part">
      <IconTile size="xs">
        {part.brand ? (
          <BrandLogo name={part.brand} size={16} decorative />
        ) : (
          <Icon name={part.icon ?? "layers"} size={16} />
        )}
      </IconTile>
      <span className="kit-card-part__label">{part.label}</span>
    </span>
  );
}

export interface ResourceCardProps {
  title: string;
  description?: string;
  /** The parts drawn in the preview: services, routines, tools (four at most are shown). */
  parts: readonly CardPart[];
  /** The status pill in the preview's corner (a kit Status with look="pill"). */
  status?: ReactNode;
  /** Facts under the description, parted by the pixel square. */
  meta?: readonly ReactNode[];
  /** Where the card goes (a console route), or what it does. */
  href?: string;
  onOpen?: () => void;
  className?: string;
}

export function ResourceCard({ title, description, parts, status, meta, href, onOpen, className }: ResourceCardProps) {
  const body = (
    <>
      <span className="kit-rcard__preview">
        <span className="kit-rcard__halftone" aria-hidden="true">
          <PointerHalftone scene="hero" />
        </span>
        <span className="kit-rcard__parts" aria-hidden="true">
          {parts.slice(0, 4).map((p, i) => (
            <span key={`${p.label}-${i}`} className="kit-rcard__part">
              {i > 0 ? <span className="kit-rcard__rule" /> : null}
              <PartTile part={p} />
            </span>
          ))}
        </span>
        {status ? <span className="kit-rcard__status">{status}</span> : null}
      </span>
      <span className="kit-rcard__body">
        <span className="kit-rcard__title">{title}</span>
        {description ? <span className="kit-rcard__desc kit-rcard__desc--clamp">{description}</span> : null}
        {meta?.length ? <MetaLine items={meta} className="kit-rcard__meta" /> : null}
      </span>
    </>
  );
  if (href)
    return (
      <KitLink href={href} className={cn("kit-rcard", className)}>
        {body}
      </KitLink>
    );
  return (
    <button type="button" className={cn("kit-rcard", className)} onClick={onOpen}>
      {body}
    </button>
  );
}

export interface RowCardProps {
  /** A console glyph or a brand's logo, on the embossed plate. */
  icon?: IconName;
  brand?: BrandName;
  /** The brand in the text's colour (a model's maker, as ModelMark draws it), not its own. */
  brandMono?: boolean;
  /** The name, in mono (an id-like name: market-brief, sbx_01m5…). */
  title: string;
  /** Inline after the name (a kit Status). */
  status?: ReactNode;
  meta?: readonly ReactNode[];
  /** A trend at the right (a Sparkline). */
  trend?: ReactNode;
  /** A figure at the far right ("2,605 today"). */
  value?: ReactNode;
  /** Actions that slide into view on hover or focus (kit icon buttons). */
  actions?: ReactNode;
  href?: string;
  /** What the row does when opened, when it is not a link (opens its drawer). */
  onOpen?: () => void;
  /** The chosen card (a selected endpoint): aria-current and the table's selected tint. */
  selected?: boolean;
  className?: string;
}

export function RowCard({
  icon,
  brand,
  brandMono = false,
  title,
  status,
  meta,
  trend,
  value,
  actions,
  href,
  onOpen,
  selected = false,
  className,
}: RowCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [inside, setInside] = useState(false);
  // The link is named by the title alone; its status and facts describe it (read after the name, not as it).
  const uid = useId().replace(/:/g, "");
  const describedBy = [status ? `${uid}-s` : null, meta?.length ? `${uid}-m` : null].filter(Boolean).join(" ");
  const named = { "aria-labelledby": `${uid}-t`, "aria-describedby": describedBy || undefined };
  // One tab stop a card (the table's roving model): the trend never takes the focus, and the actions join the tab
  // order only while the focus is inside the card; → and ← move between the card and its actions.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    for (const t of el.querySelectorAll<HTMLElement>(".kit-row-card__trend [tabindex]")) t.tabIndex = -1;
    for (const a of el.querySelectorAll<HTMLElement>(".kit-row-card__actions :is(a, button, [tabindex])"))
      a.tabIndex = inside ? 0 : -1;
  });
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const el = ref.current;
    if (!el) return;
    const stops = [
      el.querySelector<HTMLElement>(".kit-row-card__link"),
      ...el.querySelectorAll<HTMLElement>(".kit-row-card__actions :is(a, button)"),
    ].filter((x): x is HTMLElement => !!x && x.tagName !== "SPAN");
    const i = stops.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const next = stops[e.key === "ArrowRight" ? Math.min(stops.length - 1, i + 1) : Math.max(0, i - 1)];
    if (next && next !== stops[i]) {
      e.preventDefault();
      next.focus();
    }
  };
  const head = (
    <>
      <IconTile size="sm" className="kit-row-card__tile">
        {brand ? (
          <BrandLogo name={brand} size={20} mono={brandMono} decorative />
        ) : (
          <Icon name={icon ?? "layers"} size={18} />
        )}
      </IconTile>
      <span className="kit-row-card__main">
        <span className="kit-row-card__title-row">
          <span className="kit-row-card__title" id={`${uid}-t`}>
            {title}
          </span>
          {status ? (
            <span id={`${uid}-s`} className="contents">
              {status}
            </span>
          ) : null}
        </span>
        {meta?.length ? <MetaLine id={`${uid}-m`} items={meta} className="kit-row-card__meta" /> : null}
      </span>
    </>
  );
  return (
    <div
      ref={ref}
      className={cn("kit-row-card", className)}
      data-link={href || onOpen ? "" : undefined}
      aria-current={selected ? "true" : undefined}
      onFocus={() => setInside(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setInside(false);
      }}
      onKeyDown={onKeyDown}
    >
      <span className="kit-row-card__pixels" aria-hidden="true" />
      {href ? (
        <KitLink href={href} className="kit-row-card__link" {...named}>
          {head}
        </KitLink>
      ) : onOpen ? (
        <button type="button" className="kit-row-card__link" onClick={onOpen} {...named}>
          {head}
        </button>
      ) : (
        <span className="kit-row-card__link">{head}</span>
      )}
      {trend ? <span className="kit-row-card__trend">{trend}</span> : null}
      {/* Only with a value: an empty 64 px column cut In use now's titles beside nothing (Home r1, ask 5). A list whose
          rows carry values keeps them on one edge (each row's value column is 64 px at least). */}
      {value === undefined || value === null || value === false ? null : (
        <span className="kit-row-card__value">{value}</span>
      )}
      {/* Only with actions: an empty 76 px column cut Home's titles beside nothing (Home+shell). */}
      {actions ? <span className="kit-row-card__actions">{actions}</span> : null}
    </div>
  );
}

/** A resource card loading: the card's own frame, a preview well with three bone tiles on the dashed rule, two text
 * bones and a meta bone, so the grid keeps its shape when the cards land. */
export function SkeletonResourceCards({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={className} aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="kit-rcard kit-rcard--bone" aria-hidden="true">
          <span className="kit-rcard__preview">
            <span className="kit-rcard__parts">
              {[0, 1, 2].map((j) => (
                <span key={j} className="kit-rcard__part">
                  {j > 0 ? <span className="kit-rcard__rule" /> : null}
                  <span className="kit-card-part">
                    <Bone className="kit-bone--tile" />
                    <Bone className="kit-bone--text w-10" />
                  </span>
                </span>
              ))}
            </span>
          </span>
          {/* Each bone in the card's own text line (title 22, line 18, meta 20 after 4), so the card is its height. */}
          <span className="kit-rcard__body">
            <span className="kit-rcard__title">
              <Bone className="kit-bone--inline w-32" />
            </span>
            <span className="kit-rcard__desc kit-rcard__desc--clamp">
              <Bone className="kit-bone--inline w-48 max-w-full" />
              <Bone className="kit-bone--inline w-32 max-w-full" />
            </span>
            <span className="kit-rcard__desc kit-rcard__meta kit-skel-meta">
              <Bone className="kit-bone--inline w-36" />
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Row cards loading: a tile bone, two line bones, a trend bone and a value bone in the row's own frame. */
export function SkeletonRowCards({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={className} aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="kit-row-card" aria-hidden="true">
          <span className="kit-row-card__link">
            <Bone className="kit-bone--tile-sm" />
            <span className="kit-row-card__main">
              <Bone className="kit-bone--line" style={{ width: `${120 + ((i * 37) % 60)}px` }} />
              <Bone className="kit-bone--text" style={{ width: `${180 + ((i * 53) % 80)}px` }} />
            </span>
          </span>
          <span className="kit-row-card__trend">
            <Bone className="block h-6 w-full" />
          </span>
          <span className="kit-row-card__value">
            <Bone className="kit-bone--line ml-auto w-12" />
          </span>
          <span className="kit-row-card__actions" />
        </div>
      ))}
    </div>
  );
}

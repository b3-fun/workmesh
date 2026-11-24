// Empty states (LIBRARY.md "empty states"; PHILOSOPHY P10: "empty means onboarding"). The original's glass icon on a
// quiet pixel field, at most eight words, one line under them, one action. Four kinds, one look: `start` (nothing made
// yet: the one way in), `none` (filters or a search matched nothing: clear them), `error` (a read failed: try again, in
// the system's own style, with the request id to quote), `done` (a queue is empty because everything is handled). The
// field is still at rest and plays only while the pointer is on the state; reduced motion never moves it; on a phone the
// field shrinks to a strip (ornament dropped where space is short).
import { type ReactNode, useState } from "react";
import { Icon, type IconName } from "../../ui/Icon";
import { cn } from "../lib/utils";
import { type GlassIconColor, GlassSurface } from "../signature/glass-icon";
import { PixelField, type PixelFieldPatternName } from "../signature/pixel-field";
import "./css/lite.css";
import "./kit.css";

export type EmptyKind = "start" | "none" | "error" | "done";

const KIND: Record<EmptyKind, { color: GlassIconColor; icon: IconName; pattern: PixelFieldPatternName }> = {
  start: { color: "blue", icon: "plus", pattern: "twinkle" },
  none: { color: "zinc", icon: "search", pattern: "twinkle" },
  error: { color: "red", icon: "alert", pattern: "twinkle" },
  done: { color: "green", icon: "check", pattern: "twinkle" },
};

export interface EmptyStateProps {
  kind?: EmptyKind;
  /** At most eight words: "No sandboxes yet". */
  title: ReactNode;
  /** One line: what to do, or why. */
  body?: ReactNode;
  /** The one action (a kit Button). */
  action?: ReactNode;
  /** A quieter second way (a link), beside the action. */
  secondary?: ReactNode;
  /** The glass tile's glyph (the product's own icon for a start state). */
  icon?: IconName;
  /** A request id under an error, in mono, to quote to support. */
  requestId?: string;
  /** `page`: a whole page's empty (taller); `panel`: inside a section; `inline`: a table's body, no field. */
  size?: "page" | "panel" | "inline";
  className?: string;
  /** What ticks after the body ("Retry in 4 s"): shown, never spoken, so an error's alert is said once (a11y S5). */
  counter?: ReactNode;
}

export function EmptyState({
  kind = "start",
  title,
  body,
  action,
  secondary,
  icon,
  requestId,
  counter,
  size = "panel",
  className,
}: EmptyStateProps) {
  const [hovered, setHovered] = useState(false);
  const k = KIND[kind];
  return (
    <div
      className={cn("kit-empty", className)}
      data-kind={kind}
      data-size={size}
      role={kind === "error" ? "alert" : undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      data-empty-state=""
    >
      <div className="kit-empty__art" aria-hidden="true">
        {size !== "inline" ? (
          <PixelField
            rows={size === "page" ? 9 : 7}
            cols={size === "page" ? 25 : 19}
            cell={4}
            gap={5}
            pattern={k.pattern}
            autoplay={hovered}
            aria-label=""
            className="kit-empty__field"
          />
        ) : null}
        <GlassSurface color={k.color} size={size === "inline" ? "md" : "lg"} className="kit-empty__tile">
          <Icon name={icon ?? k.icon} size={size === "inline" ? 18 : 22} className="kit-empty__glyph" />
        </GlassSurface>
      </div>
      <p className="kit-empty__title">{title}</p>
      {body || counter ? (
        <p className="kit-empty__body">
          {body}
          {counter !== undefined && counter !== null ? <span aria-hidden="true">{counter}</span> : null}
        </p>
      ) : null}
      {action || secondary ? (
        <div className="kit-empty__actions">
          {action}
          {secondary}
        </div>
      ) : null}
      {requestId ? <p className="kit-empty__id">request {requestId}</p> : null}
    </div>
  );
}

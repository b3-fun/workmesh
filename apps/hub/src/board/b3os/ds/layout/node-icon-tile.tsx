// from b3-mono apps/b3os-web/components/ui/node-icon-tile.tsx @ f50f3ba3b97e
// Beta addition (console area 1 fix round): `IconTile`, the same inner plate around a glyph (a console icon), where
// NodeIconTile draws a NodeIcon (a logo or a generated picture).

import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/utils";
import { IconShell } from "../signature/glass-icon";
import { NodeIcon } from "./node-icon";

type NodeIconProps = ComponentProps<typeof NodeIcon>;

export type NodeIconTileSize = "xs" | "sm" | "md" | "lg" | "xl";

/**
 * Consolidated 3-layer tile used everywhere a workflow app/action/trigger icon
 * is represented in lists, modals, headers, and detail pages:
 *
 *   outer glass wrap (border + backdrop-blur)
 *     └── IconShell (shadow plate — the b3os-app-flat chrome)
 *           └── NodeIcon (the actual logo / AI-generated art)
 *
 * Sizes match the workflow/template card system so visual rhythm is consistent.
 * Pass `outerWrap={false}` when the icon is inline next to text and the glass
 * chrome would look heavy (e.g. dense list rows, small inline badges).
 */
const SIZE_MAP: Record<NodeIconTileSize, { inner: string; radius: string; outerRadius: string; outerPad: string }> = {
  xs: { inner: "size-8", radius: "rounded-ds-sm", outerRadius: "rounded-ds-sm", outerPad: "p-[3px]" },
  sm: { inner: "size-10", radius: "rounded-ds-sm", outerRadius: "rounded-ds-md", outerPad: "p-[4px]" },
  md: { inner: "size-12", radius: "rounded-ds-sm", outerRadius: "rounded-ds-14", outerPad: "p-[5px]" },
  lg: { inner: "size-20", radius: "rounded-ds-lg", outerRadius: "rounded-ds-22", outerPad: "p-[6px]" },
  xl: { inner: "size-24", radius: "rounded-ds-xl", outerRadius: "rounded-ds-26", outerPad: "p-[7px]" },
};

const INNER_SHADOW = "shadow-ds-b3-card";

export interface NodeIconTileProps extends NodeIconProps {
  /** Tile size preset. Controls inner plate + outer wrap dimensions. Default: `md`. */
  size?: NodeIconTileSize;
  /** Render the outer glass border wrap. Default: `true`. Set `false` for inline/dense contexts. */
  outerWrap?: boolean;
  /** Override outer wrap class (replaces size-preset wrap). */
  wrapClassName?: string;
  /** Override inner plate class (replaces size-preset inner). */
  innerClassName?: string;
  /** Class applied to the NodeIcon element. */
  iconClassName?: string;
}

export function NodeIconTile({
  size = "md",
  outerWrap = true,
  wrapClassName,
  innerClassName,
  iconClassName,
  ...nodeIconProps
}: NodeIconTileProps) {
  const s = SIZE_MAP[size];

  const inner = (
    <IconShell className={cn("bg-ds-surface-secondary", s.inner, s.radius, INNER_SHADOW, innerClassName)}>
      <NodeIcon {...nodeIconProps} className={cn("h-full w-full object-contain", iconClassName)} />
    </IconShell>
  );

  if (!outerWrap) return inner;

  return (
    <div
      className={cn(
        // bg-ds-alpha-white-40 is not a colour of the original's config (it has 5, 15, 35 and 50): no fill there, none here.
        "border-ds-alpha-shadow-10 bg-ds-alpha-white-40 relative inline-flex w-fit items-center border backdrop-blur-md",
        s.outerRadius,
        s.outerPad,
        wrapClassName,
      )}
    >
      {inner}
    </div>
  );
}

export interface IconTileProps {
  /** The plate's size preset (`xs` 32 px, `sm` 40 px; a caller's size class overrides it, as `size-9` for 36 px). */
  size?: NodeIconTileSize;
  className?: string;
  /** The glyph, centred (a 16 to 18 px icon). */
  children: ReactNode;
}

/** NodeIconTile's raised inner plate (IconShell: its edge ring, top highlight and bottom line, the card shadow) around a glyph. */
export function IconTile({ size = "xs", className, children }: IconTileProps) {
  const s = SIZE_MAP[size];
  return (
    <IconShell className={cn("bg-ds-surface-primary text-ds-text-subtle", s.inner, s.radius, INNER_SHADOW, className)}>
      {children}
    </IconShell>
  );
}

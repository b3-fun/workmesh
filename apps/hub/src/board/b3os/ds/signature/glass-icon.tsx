// from b3-mono apps/b3os-web/components/ui/glass-icon.tsx @ f50f3ba3b97e

import type { ComponentType, ReactNode } from "react";
import { cn } from "../lib/utils";

export type GlassIconColor = "amber" | "blue" | "green" | "red" | "purple" | "zinc";

const colorMap: Record<GlassIconColor, { bg: string; icon: string; ring: string }> = {
  amber: {
    bg: "bg-amber-50 dark:bg-amber-900/20",
    icon: "text-amber-600 dark:text-amber-400",
    ring: "border-amber-200/60 dark:border-amber-500/20",
  },
  blue: {
    bg: "bg-blue-50 dark:bg-blue-900/20",
    icon: "text-blue-600 dark:text-blue-400",
    ring: "border-blue-200/60 dark:border-blue-500/20",
  },
  green: {
    bg: "bg-green-50 dark:bg-green-900/20",
    icon: "text-green-600 dark:text-green-400",
    ring: "border-green-200/60 dark:border-green-500/20",
  },
  red: {
    bg: "bg-red-50 dark:bg-red-900/20",
    icon: "text-red-600 dark:text-red-400",
    ring: "border-red-200/60 dark:border-red-500/20",
  },
  purple: {
    bg: "bg-purple-50 dark:bg-purple-900/20",
    icon: "text-purple-600 dark:text-purple-400",
    ring: "border-purple-200/60 dark:border-purple-500/20",
  },
  zinc: {
    bg: "bg-ds-neutral-100 dark:bg-ds-neutral-800",
    icon: "text-ds-text-subtle dark:text-ds-text-disabled",
    // The original wrote border-ds-neutral-200/60, an opacity on a var() colour that Tailwind 3 printed no CSS for:
    // its light ring is the border's default colour, currentColor (a dark ring, as the May build draws it).
    ring: "dark:border-zinc-600/30",
  },
};

const sizeMap = {
  sm: { container: "h-8 w-8", icon: "h-4 w-4", rounded: "rounded-ds-8" },
  md: { container: "h-10 w-10", icon: "h-5 w-5", rounded: "rounded-ds-md" },
  lg: { container: "h-12 w-12", icon: "h-6 w-6", rounded: "rounded-ds-md" },
  xl: { container: "h-16 w-16", icon: "h-8 w-8", rounded: "rounded-ds-lg" },
};

interface GlassSurfaceProps {
  color?: GlassIconColor;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  children: ReactNode;
}

export function GlassSurface({ color = "blue", size = "md", className, children }: GlassSurfaceProps) {
  const colors = colorMap[color];
  const sizes = sizeMap[size];

  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden",
        sizes.container,
        sizes.rounded,
        colors.bg,
        className,
      )}
    >
      {children}
      {/* Glassmorphic border layers */}
      <div className={cn("absolute inset-0 border", sizes.rounded, colors.ring)} />
      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 top-[1px] border-t border-white/40 dark:border-white/10",
          sizes.rounded,
        )}
      />
      <div
        className={cn(
          "absolute bottom-[1px] left-0 right-0 top-0 border-b border-black/5 dark:border-black/20",
          sizes.rounded,
        )}
      />
    </div>
  );
}

interface GlassIconProps {
  icon: ComponentType<{
    className?: string;
  }>;
  color?: GlassIconColor;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

export function GlassIcon({ icon: Icon, color = "blue", size = "md", className }: GlassIconProps) {
  const colors = colorMap[color];
  const sizes = sizeMap[size];

  return (
    <GlassSurface color={color} size={size} className={className}>
      <Icon className={cn(sizes.icon, colors.icon)} />
    </GlassSurface>
  );
}

interface IconShellProps {
  /** Tailwind classes for sizing + radius (e.g. "h-12 w-12 rounded-ds-md"). Required — sizing is caller-controlled. */
  className: string;
  children: ReactNode;
}

/**
 * Chrome wrapper for AI-generated `b3os-app-flat` icons.
 *
 * The b3os-app-flat PNG is full-bleed gradient with NO rounded corners, NO border,
 * NO drop shadow — by design. This component supplies the consistent shell:
 * rounded clipping + a thin neutral edge ring + a soft top highlight + a soft
 * bottom shadow line, mirroring the macOS/iOS app-tile gloss treatment.
 *
 * Pair with NodeIcon: <IconShell className="h-12 w-12 rounded-ds-md"><NodeIcon ... className="h-full w-full" /></IconShell>
 *
 * Do NOT wrap a second time — if a parent already provides rounded + overflow-hidden,
 * use this in place of that wrapper, not in addition to it.
 */
export function IconShell({ className, children }: IconShellProps) {
  return (
    <div className={cn("relative flex shrink-0 items-center justify-center overflow-hidden", className)}>
      {children}
      {/* Neutral edge ring */}
      <div className={cn("rounded-inherit border-ds-border pointer-events-none absolute inset-0 border")} />
      {/* Top highlight */}
      <div
        className={cn(
          "rounded-inherit pointer-events-none absolute bottom-0 left-0 right-0 top-[1px] border-t border-white/40 dark:border-white/15",
        )}
      />
      {/* Bottom depth line */}
      <div
        className={cn(
          "rounded-inherit pointer-events-none absolute bottom-[1px] left-0 right-0 top-0 border-b border-black/10 dark:border-black/30",
        )}
      />
    </div>
  );
}

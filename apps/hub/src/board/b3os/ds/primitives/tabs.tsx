// from b3-mono apps/b3os-web/components/ui/tabs.tsx @ f50f3ba3b97e
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/utils";

type TabsVariant = "ghost" | "default" | "secondary" | "underline";
type TabsSize = "sm" | "md" | "lg";

interface TabsContextValue {
  variant: TabsVariant;
  size: TabsSize;
}

const TabsContext = React.createContext<TabsContextValue>({ variant: "default", size: "md" });

const tabsListVariants = cva("inline-flex items-center", {
  variants: {
    variant: {
      ghost: "gap-1 bg-transparent p-0",
      // Figma (node 2905:30572): bg-tertiary #f4f4f5 / border-secondary #e4e4e7
      // / 10px radius / 4px padding. No inset shadow.
      default: "bg-ds-surface-sunken gap-1 rounded-ds-sm border border-ds-border-default p-1",
      // Flush button-group: no inner padding, triggers share borders via
      // [&:not(:first-child)]:border-l on the trigger variant. Outer border
      // wraps the group; child corners clipped by overflow-hidden.
      secondary: "overflow-hidden rounded-ds-sm border border-ds-border-default bg-ds-surface-card",
      // Figma (nodes 5390:64793 / 5396:81513): bare underline strip — no
      // background/border/padding, just a 12px gap between triggers.
      underline: "gap-3 bg-transparent p-0",
    },
  },
  defaultVariants: { variant: "default" },
});

const tabsTriggerVariants = cva(
  [
    "group relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium outline-offset-2",
    "transition-[color,background-color,box-shadow] duration-150 ease-[ease]",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70",
    "disabled:pointer-events-none disabled:opacity-50",
  ],
  {
    variants: {
      variant: {
        ghost: [
          "rounded-ds-xs text-ds-text-muted hover:bg-ds-surface-hover hover:text-ds-text-primary",
          "data-[state=active]:bg-[color:var(--ds-info-surface)] data-[state=active]:text-[color:var(--ds-brand-500)]",
          "dark:text-ds-text-muted dark:hover:bg-ds-neutral-800 dark:hover:text-zinc-100",
          "dark:data-[state=active]:bg-blue-500/15 dark:data-[state=active]:text-blue-300",
        ],
        // Figma-based active: white bg + shadow-sm drop shadow, plus the
        // `inset 0 -2px 0` bottom bezel the user wants preserved from the
        // previous design-system pressed-ring token.
        default: [
          "rounded-ds-xs text-ds-text-muted hover:text-ds-text-primary",
          "data-[state=active]:bg-ds-surface-card data-[state=active]:text-ds-text-primary data-[state=active]:shadow-ds-soft-pressed",
          // Bottom inset bezel (-2px) makes content read low; nudge children up to optically center.
          // (Tailwind 3 stacked these variants right to left, so the original compiled to `.x > *[data-state=active]`
          // and the nudge never applied. Written in Tailwind 4's order, it selects the same nothing.)
          "[&>*]:data-[state=active]:-translate-y-px",
        ],
        // Button-group: flush dividers via border-l on each non-first trigger;
        // active = slightly darker neutral fill. The `inset 0 -2px 0` bottom
        // bezel applies to every trigger (not just active) so the whole row
        // carries a consistent pressed feel.
        secondary: [
          "rounded-none text-ds-text-muted hover:bg-ds-surface-hover hover:text-ds-text-primary",
          "[&:not(:first-child)]:border-l [&:not(:first-child)]:border-ds-neutral-200 dark:[&:not(:first-child)]:border-ds-neutral-800",
          "shadow-ds-tab-edge",
          "data-[state=active]:bg-ds-neutral-100 data-[state=active]:text-ds-text-secondary",
          // The original's dark:hover:bg-ds-neutral-900/60 puts an opacity on a var() colour, which Tailwind 3 cannot: no CSS.
          "dark:text-ds-text-muted dark:hover:text-zinc-100",
          "dark:data-[state=active]:bg-ds-neutral-800 dark:data-[state=active]:text-white",
        ],
        // Figma (nodes 5390:64793 / 5396:81513): underline tab strip — no
        // bg/radius/shadow/left-divider. Inactive border is transparent (not
        // omitted) so selection doesn't change box height.
        underline: [
          "rounded-none pb-3 text-ds-text-subtle hover:text-ds-text-primary",
          "border-b-[1.5px] border-transparent",
          "data-[state=active]:border-[color:var(--ds-brand-600)] data-[state=active]:text-[color:var(--ds-brand-500)]",
        ],
      },
      size: {
        sm: "h-7 px-2.5 text-xs",
        md: "h-9 px-2.5 text-sm",
        lg: "h-10 px-3 text-sm",
      },
    },
    compoundVariants: [
      // Secondary (button-group) triggers get more breathing room — dividers
      // are tighter visually than a standalone pill, so padding compensates.
      { variant: "secondary", size: "sm", className: "px-4" },
      { variant: "secondary", size: "md", className: "px-5" },
      { variant: "secondary", size: "lg", className: "px-6" },
      // `underline` bakes its own 32px height / 14px text regardless of
      // `size` — reasserted here (after the `size` classes in cva's output
      // order) so it wins the tailwind-merge conflict instead of losing to
      // whichever size was passed.
      { variant: "underline", size: ["sm", "md", "lg"], className: "h-8 px-0.5 text-sm" },
    ],
    defaultVariants: { variant: "default", size: "md" },
  },
);

// Count badge — Figma spec (node 2905:30577/...): bordered white pill, 6px
// radius, px-1.5 py-0.5, shadow-xs, text-secondary-700 12px medium. Same
// treatment across variants for consistency.
const countBadgeClass =
  "inline-flex min-w-[20px] items-center justify-center rounded-ds-xs border border-ds-border-default bg-ds-surface-card px-1.5 py-0.5 text-xs font-medium tabular-nums text-ds-text-secondary shadow-ds-soft";

const indicatorDotVariants = cva("h-1.5 w-1.5 shrink-0 rounded-full", {
  variants: {
    indicator: {
      live: "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]",
      dot: "bg-zinc-400",
    },
  },
});

interface TabsProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>, Partial<TabsContextValue> {}

const Tabs = React.forwardRef<React.ElementRef<typeof TabsPrimitive.Root>, TabsProps>(
  ({ variant = "default", size = "md", ...props }, ref) => {
    const value = React.useMemo<TabsContextValue>(() => ({ variant, size }), [variant, size]);
    return (
      <TabsContext.Provider value={value}>
        <TabsPrimitive.Root ref={ref} {...props} />
      </TabsContext.Provider>
    );
  },
);
Tabs.displayName = TabsPrimitive.Root.displayName;

interface TabsListProps
  extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>,
    VariantProps<typeof tabsListVariants> {}

const TabsList = React.forwardRef<React.ElementRef<typeof TabsPrimitive.List>, TabsListProps>(
  ({ className, variant, ...props }, ref) => {
    const ctx = React.useContext(TabsContext);
    return (
      <TabsPrimitive.List
        ref={ref}
        className={cn(tabsListVariants({ variant: variant ?? ctx.variant }), className)}
        {...props}
      />
    );
  },
);
TabsList.displayName = TabsPrimitive.List.displayName;

interface TabsTriggerProps
  extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>,
    VariantProps<typeof tabsTriggerVariants> {
  icon?: React.ReactNode;
  count?: number | string;
  indicator?: "live" | "dot";
  asChild?: boolean;
}

function renderDecorated(
  label: React.ReactNode,
  icon: React.ReactNode,
  count: React.ReactNode,
  indicator: "live" | "dot" | undefined,
) {
  return (
    <>
      {indicator != null ? <span aria-hidden className={indicatorDotVariants({ indicator })} /> : null}
      {icon != null ? <span className="inline-flex shrink-0 items-center">{icon}</span> : null}
      <span>{label}</span>
      {count != null ? <span className={countBadgeClass}>{count}</span> : null}
    </>
  );
}

const TabsTrigger = React.forwardRef<React.ElementRef<typeof TabsPrimitive.Trigger>, TabsTriggerProps>(
  ({ className, variant, size, icon, count, indicator, asChild, children, ...props }, ref) => {
    const ctx = React.useContext(TabsContext);
    const resolvedVariant = variant ?? ctx.variant;
    const resolvedSize = size ?? ctx.size;
    const hasDecoration = icon != null || indicator != null || count != null;
    const mergedClassName = cn(tabsTriggerVariants({ variant: resolvedVariant, size: resolvedSize }), className);

    // Radix Slot (asChild) requires exactly one child. When decorations are
    // present alongside asChild, we have to inject them INTO the child's
    // children rather than alongside — otherwise Radix throws on render.
    if (asChild && hasDecoration) {
      const child = React.Children.only(children) as React.ReactElement<{ children?: React.ReactNode }>;
      const decorated = renderDecorated(child.props.children, icon, count, indicator);
      return (
        <TabsPrimitive.Trigger ref={ref} asChild className={mergedClassName} {...props}>
          {React.cloneElement(child, {}, decorated)}
        </TabsPrimitive.Trigger>
      );
    }

    const content = hasDecoration ? renderDecorated(children, icon, count, indicator) : children;

    return (
      <TabsPrimitive.Trigger ref={ref} asChild={asChild} className={mergedClassName} {...props}>
        {content}
      </TabsPrimitive.Trigger>
    );
  },
);
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "focus-visible:outline-ring/70 mt-2 outline-offset-2 focus-visible:outline focus-visible:outline-2",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export type { TabsSize, TabsVariant };
export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants, tabsTriggerVariants };

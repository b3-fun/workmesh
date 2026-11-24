// from b3-mono apps/b3os-web/components/ui/radio-group.tsx @ f50f3ba3b97e

import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import * as React from "react";

import { cn } from "../lib/utils";

const RadioGroup = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => {
  return <RadioGroupPrimitive.Root className={cn("grid gap-2", className)} {...props} ref={ref} />;
});
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName;

const RadioGroupItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => {
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      className={cn(
        // ring-ds-brand-500/25 and bg-ds-brand-500/10 (/15 in dark) put an opacity on a var() colour, which Tailwind 3
        // cannot: no CSS. Its focus ring therefore took Tailwind 3's default ring colour, rgb(59 130 246 / 0.5).
        "text-ds-brand-500 focus-visible:ring-[rgb(59_130_246/0.5)] data-[state=checked]:border-ds-brand-500 h-4.5 w-4.5 dark:data-[state=checked]:border-ds-brand-500 border-ds-neutral-300 bg-ds-surface-card shadow-ds-soft aspect-square rounded-full border transition-[border-color,box-shadow,background-color] duration-150 ease-[ease] hover:border-zinc-400 focus:outline-hidden focus-visible:ring-4 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:hover:border-zinc-500",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
        <span className="bg-ds-brand-500 shadow-ds-brand-glow-ring block h-2.5 w-2.5 rounded-full" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
});
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName;

export { RadioGroup, RadioGroupItem };

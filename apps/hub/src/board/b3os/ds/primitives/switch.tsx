// from b3-mono apps/b3os-web/components/ui/switch.tsx @ f50f3ba3b97e
import * as SwitchPrimitives from "@radix-ui/react-switch";
import * as React from "react";

import { cn } from "../lib/utils";

export interface SwitchProps extends React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> {
  size?: "default" | "sm";
}

const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitives.Root>, SwitchProps>(
  ({ className, size = "default", ...props }, ref) => {
    const sizeClasses = {
      default: "h-6 w-11",
      sm: "h-4 w-8",
    };

    const thumbSizeClasses = {
      default: "h-5 w-5 data-[state=checked]:translate-x-5",
      sm: "h-3 w-3 data-[state=checked]:translate-x-4",
    };

    return (
      <SwitchPrimitives.Root
        className={cn(
          "data-[state=unchecked]:bg-ds-neutral-200 peer inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors duration-200 ease-[ease] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-blue-600 dark:focus-visible:ring-offset-zinc-950 dark:data-[state=unchecked]:bg-zinc-500",
          "shadow-ds-input-inset-strong",
          sizeClasses[size],
          className,
        )}
        {...props}
        ref={ref}
      >
        <SwitchPrimitives.Thumb
          className={cn(
            "pointer-events-none block rounded-full bg-linear-to-b/srgb from-white to-zinc-50 ring-0 transition-transform duration-200 ease-[ease] data-[state=unchecked]:translate-x-0",
            "shadow-[0_1px_3px_rgba(0,0,0,0.12),0_1px_1px_rgba(0,0,0,0.08),-1px_1px_2px_rgba(0,0,0,0.06)]",
            thumbSizeClasses[size],
          )}
        />
      </SwitchPrimitives.Root>
    );
  },
);
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };

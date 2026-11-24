// from b3-mono apps/b3os-web/components/ui/input.tsx @ f50f3ba3b97e
import * as React from "react";

import { cn } from "../lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "border-ds-border-default bg-ds-surface-sunken text-ds-text-primary placeholder:text-ds-text-muted shadow-ds-input-inset file:text-ds-text-primary focus-visible:border-ds-focus-brand flex h-10 w-full rounded-ds-xs border px-3 py-2 text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:outline-hidden focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };

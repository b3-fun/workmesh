// from b3-mono apps/b3os-web/components/ui/textarea.tsx @ f50f3ba3b97e
import * as React from "react";

import { cn } from "../lib/utils";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "border-ds-border-default bg-ds-surface-sunken text-ds-text-primary placeholder:text-ds-text-muted shadow-ds-input-inset focus-visible:border-ds-focus-brand flex min-h-[60px] w-full rounded-ds-xs border px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };

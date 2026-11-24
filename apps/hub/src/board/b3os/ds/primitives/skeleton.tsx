// from b3-mono apps/b3os-web/components/ui/skeleton.tsx @ f50f3ba3b97e
import { cn } from "../lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("bg-ds-neutral-100 dark:bg-ds-neutral-800 animate-pulse rounded-ds-xs", className)} {...props} />
  );
}

export { Skeleton };

// from b3-mono apps/b3os-web/components/ui/meta-dot.tsx @ f50f3ba3b97e
import { cn } from "../lib/utils";

/**
 * Tiny square separator between meta labels (e.g. "DRAFT · PRIVATE", "Created · Updated").
 * Matches the hard-edged pixel aesthetic from `PixelLoader`/`PixelGrid`. Replaces
 * the prior `IconRecord` usage that only served as a decorative dot.
 */
export function MetaDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("bg-ds-neutral-300 inline-block size-[3px] shrink-0 dark:bg-zinc-600", className)}
    />
  );
}

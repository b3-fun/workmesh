// from b3-mono apps/b3os-web/components/auth/AuthCard.tsx @ f50f3ba3b97e
// The entrance and exit classes (auth-card-entry, auth-card-animating-out) are in ./A4-inputs.css. The close tile's
// dark:bg-ds-surface-card/80 is dropped (Tailwind 3 printed nothing for it); ROUTES.HOME is "/".
// Beta additions (console elegance, area 4: the console's sign-in, device and onboarding pages draw this card):
// `reach="container"` stops the horizontal guides at the edges of the nearest inline-size container (the page's
// stage) instead of running a window's width past each side, so no box is wider than a 390 px window (AUDIT 4.7;
// NEEDS 16); `size="lg"`, a 560 px card for a wider body (the first API key).
import type { ReactNode } from "react";
import { Link } from "wouter";
import { IconXmarkOutline18 } from "../lib/icons";
import { cn } from "../lib/utils";

function CornerDot({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "border-ds-neutral-300 bg-ds-surface-card dark:border-ds-neutral-700 absolute z-10 h-[11px] w-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border",
        className,
      )}
    />
  );
}

// Decorative dashed divider: a full-width dashed line spanning the card's inner
// width, with two corner dots sitting on top at x=9 (and x=width-9). Solid dot
// backgrounds visually terminate the line at each dot.
export function DecorativeGrid() {
  return (
    <div className="relative h-[19px] w-full">
      <div className="border-ds-neutral-200 dark:border-ds-neutral-800 absolute left-2 right-2 top-1/2 h-0 -translate-y-1/2 border-t border-dashed" />
      <CornerDot className="left-[9px] top-1/2" />
      <CornerDot className="left-[calc(100%-9px)] top-1/2" />
    </div>
  );
}

interface AuthCardProps {
  children: ReactNode;
  /** Where the close X navigates. Defaults to home. */
  closeHref?: string;
  /** Hide the close X button. */
  hideClose?: boolean;
  /** Triggers exit animation and disables pointer events. */
  isAnimatingOut?: boolean;
  /** Whether the card should run its default scale/fade entrance. */
  entryAnimation?: boolean;
  /** ARIA props forwarded to the card surface. */
  ariaBusy?: boolean;
  ariaLabel?: string;
  className?: string;
  /**
   * How far the horizontal guides run: a window's width past each side (`viewport`, the original's), or to the edges
   * of the nearest inline-size container (`container`: the caller's stage sets `container-type: inline-size`).
   */
  reach?: "viewport" | "container";
  /** `md` 480 px (the original's), `lg` 560 px. */
  size?: "md" | "lg";
}

/**
 * Shared auth-card chrome: dashed crosshair guides, corner-dot decorative
 * dividers, close X, and the rounded card surface with fade/scale animation.
 *
 * Children render between the top and bottom DecorativeGrid rows. Inner section
 * dividers (`px-[9px]` + `border-x border-dashed`) are content-specific and
 * stay with the consumer.
 */
export function AuthCard({
  children,
  closeHref = "/",
  hideClose = false,
  isAnimatingOut = false,
  entryAnimation = true,
  ariaBusy,
  ariaLabel,
  className,
  reach = "viewport",
  size = "md",
}: AuthCardProps) {
  // From the card's sides to the container's: the card is centred in it, so each side is half the difference away.
  const across =
    reach === "container"
      ? "left-[calc((100%-100cqw)/2)] right-[calc((100%-100cqw)/2)]"
      : "-left-[100vw] -right-[100vw]";
  return (
    <div className={cn("relative mx-auto w-full", size === "lg" ? "max-w-[560px]" : "max-w-[480px]")}>
      {/* Vertical crosshair lines — extend beyond the card and align to the
          same inner column as the DecorativeGrid dots. Kept wrapper-relative
          so transformed auth shells do not break the positioning. */}
      <div
        aria-hidden
        className="border-ds-neutral-200 dark:border-ds-neutral-800 pointer-events-none absolute -bottom-[100vh] -top-[100vh] left-[29px] border-l border-dashed"
      />
      <div
        aria-hidden
        className="border-ds-neutral-200 dark:border-ds-neutral-800 pointer-events-none absolute -bottom-[100vh] -top-[100vh] right-[29px] border-l border-dashed"
      />

      {/* Horizontal crosshair lines — extend far left/right beyond the card, aligned with
          the top and bottom DecorativeGrid dot rows. Card has p-5 (20px) padding and the
          DecorativeGrid line sits at y=9.5 within its 19px row, so line y = 29.5 from
          card top / bottom. Scoped to this wrapper so they scroll with the card. */}
      <div
        aria-hidden
        className={cn(
          "border-ds-neutral-200 dark:border-ds-neutral-800 pointer-events-none absolute top-[29.5px] border-t border-dashed",
          across,
        )}
      />
      <div
        aria-hidden
        className={cn(
          "border-ds-neutral-200 dark:border-ds-neutral-800 pointer-events-none absolute bottom-[29.5px] border-t border-dashed",
          across,
        )}
      />

      {!hideClose && (
        <Link
          href={closeHref}
          aria-label="Close"
          className="bg-ds-surface-muted hover:bg-ds-surface-card dark:hover:bg-ds-surface-card absolute -right-9 -top-[35px] z-10 flex h-9 w-9 items-center justify-center rounded-[8px] shadow-xs transition-colors duration-200 ease-[ease]"
        >
          <IconXmarkOutline18 className="text-ds-text-subtle h-4 w-4" />
        </Link>
      )}

      <div
        className={cn(
          "bg-ds-surface-card border-ds-border-default relative z-[1] overflow-hidden rounded-[20px] border p-5",
          "shadow-[0px_1px_3px_0px_rgba(23,22,25,0.05),0px_1px_2px_0px_rgba(23,22,25,0.1)]",
          isAnimatingOut && "auth-card-animating-out pointer-events-none",
          entryAnimation && !isAnimatingOut && "auth-card-entry",
          className,
        )}
        aria-busy={ariaBusy}
        aria-label={ariaLabel}
      >
        <div
          aria-hidden
          className="border-ds-neutral-200 dark:border-ds-neutral-800 pointer-events-none absolute bottom-[29.5px] left-[29px] top-[29.5px] border-l border-dashed"
        />
        <div
          aria-hidden
          className="border-ds-neutral-200 dark:border-ds-neutral-800 pointer-events-none absolute bottom-[29.5px] right-[29px] top-[29.5px] border-l border-dashed"
        />
        <DecorativeGrid />
        {children}
        <DecorativeGrid />
      </div>
    </div>
  );
}

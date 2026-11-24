// from b3-mono apps/b3os-web/components/ui/dialog.tsx @ f50f3ba3b97e
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as React from "react";
import { IconXmarkOutline18 } from "../lib/icons";

import { cn } from "../lib/utils";

function findScrollableElement(target: EventTarget | null, fallback: HTMLElement): HTMLElement {
  let element = target instanceof HTMLElement ? target : fallback;

  while (element && element !== fallback) {
    const style = window.getComputedStyle(element);
    const overflowY = style.overflowY;
    const canScroll = (overflowY === "auto" || overflowY === "scroll") && element.scrollHeight > element.clientHeight;

    if (canScroll) {
      return element;
    }

    if (!element.parentElement) break;
    element = element.parentElement;
  }

  return fallback;
}

function preventScrollBounce(event: React.WheelEvent<HTMLElement>) {
  const container = event.currentTarget;
  const scrollable = findScrollableElement(event.target, container);
  const { scrollTop, scrollHeight, clientHeight } = scrollable;
  const deltaY = event.deltaY;
  const isAtTop = scrollTop <= 0;
  const isAtBottom = scrollTop + clientHeight >= scrollHeight - 1;

  if ((deltaY < 0 && isAtTop) || (deltaY > 0 && isAtBottom)) {
    event.preventDefault();
  }
}

function preventTouchBounce(event: React.TouchEvent<HTMLElement>, startY: number | null) {
  if (startY === null || event.touches.length !== 1) return;

  const container = event.currentTarget;
  const scrollable = findScrollableElement(event.target, container);
  const currentY = event.touches[0]?.clientY;

  if (currentY === undefined) return;

  const deltaY = currentY - startY;
  const { scrollTop, scrollHeight, clientHeight } = scrollable;
  const isAtTop = scrollTop <= 0;
  const isAtBottom = scrollTop + clientHeight >= scrollHeight - 1;

  if ((deltaY > 0 && isAtTop) || (deltaY < 0 && isAtBottom)) {
    event.preventDefault();
  }
}

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 ease-out-quart fixed inset-0 z-[9999] bg-black/80 backdrop-blur-xs duration-200 data-[state=closed]:pointer-events-none",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    hideCloseButton?: boolean;
    preventCloseOnOutsideClick?: boolean;
    /** Overrides the inner content card (padding, overflow, bg). The outer glass frame is always present. */
    innerClassName?: string;
    /** Extra classes for the backdrop overlay (e.g. higher z-index for stacked modals). */
    overlayClassName?: string;
  }
>(
  (
    {
      className,
      innerClassName,
      overlayClassName,
      children,
      hideCloseButton = false,
      preventCloseOnOutsideClick = false,
      ...props
    },
    ref,
  ) => {
    const touchStartYRef = React.useRef<number | null>(null);

    return (
      <DialogPortal>
        <DialogOverlay
          className={cn(preventCloseOnOutsideClick && "pointer-events-none bg-black/60", overlayClassName)}
        />
        {/* The original enters from translate(-50%, -48%) to its centre, Tailwind 3's translate being replaced by the
            entrance's transform. Tailwind 4's translate-* is the `translate` property, which the transform adds to, so
            the same 2% rise is slide-in-from-bottom-[2%] here (and slide-out-to-bottom-[2%] on the way out). */}
        <DialogPrimitive.Content
          ref={ref}
          className={cn(
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.97] data-[state=open]:zoom-in-[0.97] data-[state=closed]:slide-out-to-bottom-[2%] data-[state=open]:slide-in-from-bottom-[2%] ease-out-quart fixed left-[50%] top-[50%] w-full max-w-lg origin-center translate-x-[-50%] translate-y-[-50%] duration-200 data-[state=closed]:pointer-events-none",
            "rounded-ds-22 shadow-ds-overlay border-ds-border bg-ds-alpha-white-15 dark:bg-ds-alpha-white-5 border backdrop-blur-md",
            "z-[10000]",
            className,
            // Frame ring padding — MUST stay after `className` so a consumer's contentClass p-0 can't strip it (twMerge: last wins).
            "p-2",
          )}
          onPointerDownOutside={(e) => {
            if (preventCloseOnOutsideClick) {
              e.preventDefault();
              return;
            }
            // Prevent closing when interacting with portal'd Radix content (Popovers, Selects, Comboboxes)
            const target = e.target as HTMLElement;
            if (target?.closest?.("[data-radix-popper-content-wrapper]")) {
              e.preventDefault();
            }
          }}
          onInteractOutside={(e) => {
            if (preventCloseOnOutsideClick) {
              e.preventDefault();
              return;
            }
            const target = e.target as HTMLElement;
            if (target?.closest?.("[data-radix-popper-content-wrapper]")) {
              e.preventDefault();
            }
          }}
          {...props}
        >
          <div
            className={cn(
              "bg-ds-surface-card rounded-ds-lg shadow-ds-b3-card relative grid max-h-[calc(85vh-12px)] gap-4 overflow-y-auto overscroll-none p-6",
              innerClassName,
            )}
            onWheelCapture={preventScrollBounce}
            onTouchStart={(event) => {
              touchStartYRef.current = event.touches[0]?.clientY ?? null;
            }}
            onTouchMove={(event) => {
              preventTouchBounce(event, touchStartYRef.current);
            }}
            onTouchEnd={() => {
              touchStartYRef.current = null;
            }}
          >
            {children}
            {!hideCloseButton && (
              // The original's focus:outline-hidden is a Tailwind 4 name its Tailwind 3 build ignored: not ported.
              <DialogPrimitive.Close className="text-ds-text-secondary focus:bg-ds-surface-muted data-[state=open]:bg-ds-surface-muted data-[state=open]:text-ds-text-secondary absolute right-4 top-4 rounded-ds-4 opacity-70 transition-opacity duration-200 ease-[ease] hover:opacity-100 focus:opacity-100 focus:ring-0 disabled:pointer-events-none">
                <IconXmarkOutline18 className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </DialogPrimitive.Close>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    );
  },
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)} {...props} />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("body-sm", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};

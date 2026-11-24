// EXTRACT X5, adoption: the console's Dialog (src/app/ui/Dialog.tsx) on the original B3OS's dialog
// (primitives/dialog.tsx, Radix): its overlay, glass frame, card and entrance, with the console's sections inside. A
// module of its own so the console loads Radix's dialog when a dialog first opens, not with every page that has one.
// Its class strings are compiled by the ds core stylesheet (core.css), with the component's own.
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { DialogContent, DialogDescription, DialogTitle, Dialog as DsDialog } from "../primitives/dialog";

export interface ConsoleDialogProps {
  open: boolean;
  onClose: () => void;
  /** Words, or words with a part kept whole (a repository's name: area 3 fix, P3). */
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  dismissible?: boolean;
  /** The console's close button (its Button and glyph), at the title's right. */
  closeButton: ReactNode;
  /** Focus on close when the opener is gone (a revoked row): the kit's ResponsiveDialog passes its fallback. */
  onOpenerGone?: () => void;
}

export default function ConsoleDialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide = false,
  dismissible = true,
  closeButton,
  onOpenerGone,
}: ConsoleDialogProps) {
  const body = children !== null && children !== undefined && children !== false;
  // What had focus when the dialog opened (area 3 fix, F2): a console dialog is controlled, with no Radix trigger, so
  // Radix returned focus to nothing (the page's body) on Escape or Cancel. Kept as `open` turns true, before Radix's
  // focus scope moves it inside, and given back on close while it is still in the page.
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const el = document.activeElement;
    opener.current = el instanceof HTMLElement && el !== document.body ? el : null;
  }, [open]);
  return (
    <DsDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        hideCloseButton
        preventCloseOnOutsideClick={!dismissible}
        onEscapeKeyDown={(e) => {
          if (!dismissible) e.preventDefault();
        }}
        onCloseAutoFocus={(e) => {
          const el = opener.current;
          if (el?.isConnected) {
            e.preventDefault();
            el.focus({ preventScroll: true });
          } else if (onOpenerGone) {
            // What opened it is gone (a revoked row): never the page's body (a11y audit 11-23, S3).
            e.preventDefault();
            onOpenerGone();
          }
        }}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          const content = e.currentTarget as HTMLElement;
          const field = content.querySelector<HTMLElement>(
            "[data-dialog-body] :is(input:not([type=hidden]):not([type=checkbox]):not([aria-hidden]):not([disabled]), select, textarea, button[role=combobox]:not([disabled]))",
          );
          if (field && window.matchMedia?.("(pointer: fine)").matches) field.focus();
          else content.focus();
        }}
        // Radix names the description itself (its own id on DialogDescription and on aria-describedby); with none, an
        // explicit undefined says so. An id of our own on both made Radix look for its id, find nothing and log
        // "Missing Description or aria-describedby" for every dialog that had one (the sandbox Pause and Delete).
        {...(description ? {} : { "aria-describedby": undefined })}
        data-dialog=""
        className={`${wide ? "w-[min(760px,calc(100vw-32px))]" : "w-[min(560px,calc(100vw-32px))]"} max-w-none focus:outline-hidden max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:pb-0`}
        innerClassName="flex max-h-[min(86dvh,820px)] flex-col gap-0 overflow-hidden p-0 max-sm:max-h-[92dvh] max-sm:rounded-b-none"
      >
        {/* The close button sits in the title's corner, so the description under the title takes the dialog's whole
            width (area 3 fix, P3: on a phone's sheet it was a column 60 px narrower beside the button). */}
        <div className={`relative px-6 py-5 ${body ? "border-b border-line-soft" : ""}`}>
          {/* 16 px semibold: a dialog's title sits under the page's 20 px one, as Linear's and Vercel's (console area 7
              review, P2: it was the page title's text-h4). */}
          <DialogTitle className="min-w-0 pr-10 text-body leading-6 tracking-normal text-ink max-md:pr-12">
            {title}
          </DialogTitle>
          {description ? (
            <DialogDescription className="mt-1 text-ui text-ink-3 text-pretty">{description}</DialogDescription>
          ) : null}
          <div className="absolute top-5 right-6">{closeButton}</div>
        </div>
        {body ? (
          <div data-dialog-body className="min-h-0 overflow-y-auto px-6 py-5">
            {children}
          </div>
        ) : null}
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-soft bg-surface-muted px-6 py-4 max-sm:flex-col-reverse max-sm:items-stretch">
            {footer}
          </div>
        ) : null}
      </DialogContent>
    </DsDialog>
  );
}

// The detail drawer (LIBRARY.md "drawers"; React Bits data-table-6's synced detail panel). A row's detail opens beside
// the list as a deliberate floating panel (the memory note: "a side panel is part of the layout or a deliberate
// floating panel, never drawn over the canvas's content"): 8 px off the window's right edge in the original's glass
// frame (its dialog's ring: hairline, backdrop blur, the overlay shadow) around the stage's surface, a light scrim
// behind. It slides in from the right (260 ms, the drawer curve) and out faster (180 ms). Its header holds the name,
// a meta line, the id to copy, previous and next (the j and k keys step through the list without closing) and close
// (Escape). On a phone it is a bottom sheet you can drag down to dismiss (vaul). Focus is trapped while open and goes
// back to the row that opened it.

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { Icon } from "../../ui/Icon";
import { cn } from "../lib/utils";
import { MiddleEllipsis } from "../signature/middle-ellipsis";
import { CopyText } from "./copy";
import { Kbd, useShortcut } from "./kbd";
import { PHONE, useMediaQuery } from "./media";
import { MetaLine } from "./page-header";
import { useRevealEntering } from "./skeleton";
import { useVaul } from "./vaul";
import "./css/lite.css";
import "./kit.css";

export interface DetailDrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Facts under the title, parted by the pixel square. */
  meta?: readonly ReactNode[];
  /** The object's id, copyable. */
  id?: string;
  /** A tabs row under the header. */
  tabs?: ReactNode;
  /** Steps to the previous or next row while open (j / k, and the arrows in the header). */
  onPrev?: (() => void) | null;
  onNext?: (() => void) | null;
  /** Actions at the header's right, before previous, next and close (Open, a More menu). */
  actions?: ReactNode;
  children: ReactNode;
  /** The panel's width on a desktop (default 560). */
  width?: number;
  /** A description for screen readers, when the meta line is not one. */
  description?: string;
  /**
   * Where a title too long for its line is cut: at the end (default) or in the middle, for a name whose end says
   * which (a tool's name, a path: "github__search…issues"). A string title only.
   */
  titleEllipsis?: "end" | "middle";
  /**
   * Where a phone's sheet puts previous and next: beside the title (default) or at its foot ("foot": a row of two
   * 44 px buttons under the body, the title kept whole). Wider windows keep them beside the title.
   */
  stepsAt?: "head" | "foot";
}

/**
 * The row a detail shows now, marked by the list (`data-kit-open-row`: DataTable's open row, or a card list's open
 * card), followed while the detail is open, so closing it gives focus back to the row it shows now (after j/k steps),
 * not to the one that opened it.
 */
function useOpenRow(open: boolean) {
  const row = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const el = document.querySelector<HTMLElement>("[data-kit-open-row]");
    if (el) row.current = el;
  });
  useLayoutEffect(() => {
    if (open) row.current = document.querySelector<HTMLElement>("[data-kit-open-row]");
  }, [open]);
  return row;
}

function Header({
  title,
  meta,
  id,
  onPrev,
  onNext,
  actions,
  onClose,
  titleEllipsis = "end",
  stepsAt = "head",
  mode,
}: Omit<DetailDrawerProps, "children" | "open" | "tabs" | "width"> & { mode: "dialog" | "sheet" | "pane" }) {
  const phone = mode !== "dialog";
  // A middle cut draws the shortened name; the whole one is the title's accessible name (and its hover).
  const shown =
    titleEllipsis === "middle" && typeof title === "string" ? (
      <>
        <span className="sr-only">{title}</span>
        <span className="kit-drawer__title-cut" aria-hidden="true" title={title}>
          <MiddleEllipsis text={title} />
        </span>
      </>
    ) : (
      title
    );
  return (
    <div className="kit-drawer__head">
      <div className="kit-drawer__grid">
        <div className="kit-drawer__titles">
          {mode === "pane" ? (
            <h2 className="kit-drawer__title">{shown}</h2>
          ) : (
            <DialogTitleSlot phone={phone}>{shown}</DialogTitleSlot>
          )}
          {meta?.length || id ? (
            <div className="kit-drawer__meta">
              {meta?.length ? <MetaLine items={meta} /> : null}
              {id ? <CopyText value={id} /> : null}
            </div>
          ) : null}
        </div>
        {actions ? <div className="kit-drawer__actions">{actions}</div> : null}
        <div className="kit-drawer__tools">
          {(onPrev !== undefined || onNext !== undefined) && !(mode === "sheet" && stepsAt === "foot") ? (
            <span className="kit-drawer__steps">
              <button
                type="button"
                className="kit-icon-btn kit-press"
                aria-label="Previous"
                title="Previous (k)"
                disabled={!onPrev}
                onClick={() => onPrev?.()}
              >
                <Icon name="chevronUp" size={15} />
              </button>
              <button
                type="button"
                className="kit-icon-btn kit-press"
                aria-label="Next"
                title="Next (j)"
                disabled={!onNext}
                onClick={() => onNext?.()}
              >
                <Icon name="chevronDown" size={15} />
              </button>
            </span>
          ) : null}
          {phone ? (
            <button type="button" className="kit-icon-btn kit-press" aria-label="Close" onClick={onClose}>
              <Icon name="close" size={15} />
            </button>
          ) : (
            <DialogPrimitive.Close className="kit-icon-btn kit-press" aria-label="Close">
              <Icon name="close" size={15} />
            </DialogPrimitive.Close>
          )}
        </div>
      </div>
    </div>
  );
}

function DialogTitleSlot({ phone, children }: { phone: boolean; children: ReactNode }) {
  // The sheet draws only once vaul is in (useVaul), so on a phone it is here.
  const VaulDrawer = useVaul(phone);
  return phone && VaulDrawer ? (
    <VaulDrawer.Title className="kit-drawer__title">{children}</VaulDrawer.Title>
  ) : (
    <DialogPrimitive.Title className="kit-drawer__title">{children}</DialogPrimitive.Title>
  );
}

/** While `open`, the app's root (the page behind a modal drawer, its content portaled outside it) is inert. */
function usePageInert(open: boolean) {
  useLayoutEffect(() => {
    if (!open) return;
    const page = document.getElementById("root");
    if (!page || page.hasAttribute("inert")) return;
    page.setAttribute("inert", "");
    return () => page.removeAttribute("inert");
  }, [open]);
}

export function DetailDrawer(props: DetailDrawerProps) {
  const { open, onClose, tabs, children, width = 560, description, onPrev, onNext } = props;
  const phone = useMediaQuery(PHONE);
  const VaulDrawer = useVaul(phone);
  useShortcut("j", () => onNext?.(), { enabled: open && !!onNext });
  useShortcut("k", () => onPrev?.(), { enabled: open && !!onPrev });
  // What had focus when it opened (the row), given back on close: a controlled dialog has no Radix trigger to return
  // to, so focus would land on the page's body (the console dialog's fix, ds/adopt/console-dialog).
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const el = document.activeElement;
    opener.current = el instanceof HTMLElement && el !== document.body ? el : null;
  }, [open]);
  const openRow = useOpenRow(open);
  // Modal, with its scrim: the page behind is inert while the drawer is open (out of reach of the pointer, the Tab
  // key and a screen reader; Radix's own aria-hidden left the app's root out), the drawer's content being portaled
  // outside it (the Actions judge r3).
  usePageInert(open);
  const giveBack = (e: Event) => {
    const row = openRow.current;
    const el = row?.isConnected ? row : opener.current;
    if (!el?.isConnected) return;
    e.preventDefault();
    // The page is reachable again before the focus goes back to its row.
    document.getElementById("root")?.removeAttribute("inert");
    el.focus({ preventScroll: true });
  };

  if (phone) {
    // vaul loads on a phone only (vaul.ts), from this drawer's mount: a sheet asked for before it arrives shows then.
    if (!VaulDrawer) return null;
    return (
      <VaulDrawer.Root open={open} onOpenChange={(o) => !o && onClose()} shouldScaleBackground={false} autoFocus>
        <VaulDrawer.Portal>
          <VaulDrawer.Overlay className="kit-sheet-scrim" />
          <VaulDrawer.Content
            className="kit-sheet"
            aria-describedby={undefined}
            aria-modal="true"
            onCloseAutoFocus={giveBack}
          >
            <span className="kit-sheet__handle" aria-hidden="true" />
            {description ? <VaulDrawer.Description className="sr-only">{description}</VaulDrawer.Description> : null}
            <Header {...props} mode="sheet" />
            {tabs ? <div className="kit-drawer__tabs">{tabs}</div> : null}
            <div className="kit-drawer__body">{children}</div>
            {props.stepsAt === "foot" && (onPrev !== undefined || onNext !== undefined) ? (
              <div className="kit-drawer__foot-steps">
                <button type="button" disabled={!onPrev} onClick={() => onPrev?.()}>
                  <Icon name="chevronUp" size={15} />
                  Previous
                </button>
                <button type="button" disabled={!onNext} onClick={() => onNext?.()}>
                  Next
                  <Icon name="chevronDown" size={15} />
                </button>
              </div>
            ) : null}
          </VaulDrawer.Content>
        </VaulDrawer.Portal>
      </VaulDrawer.Root>
    );
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="kit-drawer-scrim" />
        <DialogPrimitive.Content
          aria-modal="true"
          className="kit-drawer"
          style={{ width: `min(${width}px, calc(100vw - 16px))` }}
          onCloseAutoFocus={giveBack}
          {...(description ? {} : { "aria-describedby": undefined })}
          // Open with the focus on the panel itself (its close and title follow), not on the first control (the id's copy
          // button, which drew a ring there).
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
          }}
          tabIndex={-1}
        >
          {description ? (
            <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
          ) : null}
          <div className="kit-drawer__card">
            <Header {...props} mode="dialog" />
            {tabs ? <div className="kit-drawer__tabs">{tabs}</div> : null}
            <div className="kit-drawer__body">{children}</div>
            {onPrev !== undefined || onNext !== undefined ? (
              <div className="kit-drawer__foot" aria-hidden="true">
                <Kbd keys="j" /> <Kbd keys="k" /> to step <span className="kit-drawer__foot-gap" /> <Kbd keys="esc" />{" "}
                to close
              </div>
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** A labelled block inside a drawer's body: a 12 px label over its content, divided from the next by a hairline. */
export function DrawerSection({
  label,
  aside,
  children,
  className,
}: {
  label: ReactNode;
  /** On the label's line, at the right (a view switch, a copy button). */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("kit-drawer-section", className)}>
      {aside ? (
        <div className="kit-drawer-section__bar">
          <h3 className="kit-drawer-section__label">{label}</h3>
          {aside}
        </div>
      ) : (
        <h3 className="kit-drawer-section__label">{label}</h3>
      )}
      {children}
    </section>
  );
}

// Fields and InlineForm live in fields.tsx (perf audit 11-23: a page with a fact list loaded vaul through this module);
// their names stay exported from here too.
export { Fields, InlineForm } from "./fields";

/**
 * The detail beside its list, for a wide window (at 1280 px and up; React Bits data-table-6's synced panel): the list
 * narrows and the pane takes the right column, sticky under the page's top, so stepping rows with j and k never hides the
 * columns being compared. The same header, body and keys as the drawer; Escape closes it and focus goes back to the row.
 */
export function DetailPane(
  props: Omit<DetailDrawerProps, "width" | "description"> & {
    label: string;
    /** No entrance (it lands with its page: a trace opened at a chosen call). Inside a Reveal it is still anyway. */
    still?: boolean;
  },
) {
  const { open, onClose, tabs, children, onPrev, onNext, label, still = false } = props;
  const revealing = useRevealEntering();
  const openRow = useOpenRow(open);
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const el = document.activeElement;
    opener.current = el instanceof HTMLElement && el !== document.body ? el : null;
  }, [open]);
  useShortcut("j", () => onNext?.(), { enabled: open && !!onNext });
  useShortcut("k", () => onPrev?.(), { enabled: open && !!onPrev });
  useShortcut(
    "Escape",
    () => {
      onClose();
      const row = openRow.current;
      (row?.isConnected ? row : opener.current)?.focus({ preventScroll: true });
    },
    { enabled: open, inFields: true },
  );
  if (!open) return null;
  return (
    <aside className="kit-pane" aria-label={label} data-still={still || revealing ? "" : undefined}>
      <Header {...props} mode="pane" />
      {tabs ? <div className="kit-drawer__tabs">{tabs}</div> : null}
      <div className="kit-pane__body">{children}</div>
      {onPrev !== undefined || onNext !== undefined ? (
        <div className="kit-drawer__foot" aria-hidden="true">
          <Kbd keys="j" /> <Kbd keys="k" /> to step <span className="kit-drawer__foot-gap" /> <Kbd keys="esc" /> to
          close
        </div>
      ) : null}
    </aside>
  );
}

/** A list and its detail pane side by side: the list takes what the pane leaves (a 420 px column while it is open). */
export function SplitDetail({ open, list, pane }: { open: boolean; list: ReactNode; pane: ReactNode }) {
  return (
    <div className="kit-split" data-open={open ? "" : undefined}>
      <div className="kit-split__list">{list}</div>
      {pane}
    </div>
  );
}

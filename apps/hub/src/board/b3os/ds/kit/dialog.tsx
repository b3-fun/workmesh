// Dialogs that become drawers on a phone (LIBRARY.md "dialogs"; Sean: "a responsivemodal element ... a dialog on
// desktop and drawer on mobile"), and the one shared confirm (PHILOSOPHY P16: "always use a shadcn element to have a
// shared alert/confirm modal", never confirm()). On a desktop it is the console's dialog (the original's glass frame,
// the title line, body and footer divided by hairlines: ds/adopt/console-dialog); under 768 px a vaul sheet from the
// bottom with a drag handle, the same sections, the footer's buttons full width and stacked with the primary on top.
// The confirm runs its action with the button busy, closes on success with a success haptic, and on failure stays open
// and says why under the body.
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../ui/Icon";
import { ConsoleButton } from "../adopt/console-controls";
import ConsoleDialog from "../adopt/console-dialog";
import { cutId } from "./charts/frame";
import { CopyText } from "./copy";
import { haptic } from "./haptics";
import { PHONE, useMediaQuery } from "./media";
import { useVaul } from "./vaul";
import "./css/lite.css";
import "./kit.css";

export interface ResponsiveDialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** false: Escape and a click outside do not close it (a secret shown once). */
  dismissible?: boolean;
  /**
   * Where focus goes on close when what opened it is gone (a revoked row): the next row, the list's heading. Default:
   * the page's title (a11y audit 11-23, S3: it fell to the body).
   */
  focusAfter?: () => HTMLElement | null | undefined;
}

/** Focus after a dialog closes and its opener is gone: the caller's choice, else the page's title, never the body. */
export function focusFallback(pick?: () => HTMLElement | null | undefined) {
  const el = pick?.() ?? document.querySelector<HTMLElement>("main h1, h1");
  if (!el?.isConnected) return;
  if (!el.matches("a[href], button, input, select, textarea, [tabindex]")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

export function ResponsiveDialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide,
  dismissible = true,
  focusAfter,
}: ResponsiveDialogProps) {
  const phone = useMediaQuery(PHONE);
  const VaulDrawer = useVaul(phone);
  // On a phone's sheet, focus goes back to what opened it (the desktop dialog does this in ds/adopt/console-dialog).
  const opener = useRef<HTMLElement | null>(null);
  // No key has gone down inside the sheet since it opened (its onClickCapture), and when it opened.
  const armed = useRef(false);
  const openedAt = useRef(0);
  useLayoutEffect(() => {
    if (!open) return;
    armed.current = false;
    openedAt.current = performance.now();
    const el = document.activeElement;
    opener.current = el instanceof HTMLElement && el !== document.body ? el : null;
  }, [open]);
  if (phone) {
    // vaul loads on a phone only (vaul.ts), from this dialog's mount: a sheet asked for before it arrives shows then.
    if (!VaulDrawer) return null;
    return (
      <VaulDrawer.Root
        open={open}
        onOpenChange={(o) => !o && onClose()}
        dismissible={dismissible}
        shouldScaleBackground={false}
        // The sheet takes the focus and traps it (vaul leaves it on the page behind by default, so Tab walked the page
        // under the sheet: the Settings judge, the invite sheet at 390).
        autoFocus
      >
        <VaulDrawer.Portal>
          <VaulDrawer.Overlay className="kit-sheet-scrim" />
          <VaulDrawer.Content
            className="kit-sheet"
            data-dialog=""
            tabIndex={-1}
            onOpenAutoFocus={(e) => {
              // A control the dialog names (data-autofocus, never a destructive one), else its first field, else the
              // sheet itself: never a confirm's action, which the key that opened the sheet would press (a11y audit
              // 11-23, S1: Enter on "Owner" made the person an owner through "Make owner").
              e.preventDefault();
              const sheet = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
              const named = sheet?.querySelector<HTMLElement>('[data-autofocus]:not([data-variant="destructive"])');
              const field = sheet?.querySelector<HTMLElement>(
                "[data-dialog-body] :is(input:not([type=hidden]):not([type=checkbox]):not([disabled]), select, textarea)",
              );
              (named ?? field ?? sheet)?.focus({ preventScroll: true });
            }}
            onKeyDownCapture={() => {
              armed.current = true;
            }}
            onClickCapture={(e) => {
              // A keyboard's click (detail 0) before any key went down in the sheet, in the moment it opened, is the
              // opening key's keypress carrying through: swallowed. A pointer's click always counts, and so does a
              // screen reader's activation later on (it may carry no key either).
              if (e.detail === 0 && !armed.current && performance.now() - openedAt.current < 400) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              const el = opener.current;
              if (el?.isConnected) el.focus({ preventScroll: true });
              else focusFallback(focusAfter);
            }}
            {...(description ? {} : { "aria-describedby": undefined })}
          >
            <span className="kit-sheet__handle" aria-hidden="true" />
            <div className="kit-dialog__head">
              <VaulDrawer.Title className="kit-dialog__title">{title}</VaulDrawer.Title>
              {description ? (
                <VaulDrawer.Description className="kit-dialog__desc">{description}</VaulDrawer.Description>
              ) : null}
            </div>
            {children !== undefined && children !== null && children !== false ? (
              <div className="kit-dialog__body" data-dialog-body="">
                {children}
              </div>
            ) : null}
            {footer ? <div className="kit-dialog__foot">{footer}</div> : null}
          </VaulDrawer.Content>
        </VaulDrawer.Portal>
      </VaulDrawer.Root>
    );
  }
  return (
    <ConsoleDialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={footer}
      wide={wide}
      dismissible={dismissible}
      onOpenerGone={() => focusFallback(focusAfter)}
      closeButton={
        <ConsoleButton
          variant="ghost"
          size="sm"
          className="b3os-btn--icon -mt-1 -mr-2"
          onClick={onClose}
          aria-label="Close"
        >
          <Icon name="close" size={16} />
        </ConsoleButton>
      }
    >
      {children}
    </ConsoleDialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  /** A question: "Delete market-brief?" */
  title: ReactNode;
  /** What happens, plainly: "Its sandboxes stop and its address goes offline." */
  body?: ReactNode;
  /** The confirm button's words: "Delete". */
  confirm: string;
  /** The cancel button's words, when "Cancel" would read as the action itself: "Keep running" beside "Cancel run". */
  cancel?: string;
  /** `danger` fills red (it destroys); `brand` for a confirm that only commits. */
  tone?: "danger" | "brand";
  /**
   * Content between the body and the buttons: what stops working (a list), a checkbox the reader must tick, a field
   * (Remove, Leave, Make member are then the shared confirm itself).
   */
  children?: ReactNode;
  /** The action; a rejected promise keeps the dialog open with its message. */
  onConfirm: () => void | Promise<void>;
  /** False keeps the confirm disabled until a condition holds (Access's Take down: the key's name typed). */
  ready?: boolean;
  /** Where focus goes on close when what opened it is gone (the revoked row): ResponsiveDialog's focusAfter. */
  focusAfter?: () => HTMLElement | null | undefined;
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  body,
  confirm,
  cancel = "Cancel",
  tone = "danger",
  onConfirm,
  children,
  ready = true,
  focusAfter,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; requestId: string | null } | null>(null);
  const run = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      haptic("success");
      onClose();
    } catch (e) {
      haptic("error");
      setError(failureOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ResponsiveDialog
      open={open}
      onClose={() => {
        if (!busy) {
          setError(null);
          onClose();
        }
      }}
      title={title}
      description={body}
      dismissible={!busy}
      focusAfter={focusAfter}
      footer={
        <div className="kit-dialog__buttons">
          <ConsoleButton variant="neutral" onClick={onClose} disabled={busy}>
            {cancel}
          </ConsoleButton>
          <ConsoleButton
            variant={tone === "danger" ? "destructive" : "brand"}
            onClick={() => void run()}
            loading={busy}
            disabled={!ready}
          >
            {confirm}
          </ConsoleButton>
        </div>
      }
    >
      {/* The body band only when there is something in it: `{children}{error}` was always an array, so a confirm with
          only a question drew an empty band between two rules (Settings judge r2, K1). */}
      {hasContent(children) || error ? (
        <>
          {children}
          {error ? (
            <p className="kit-dialog__error" role="alert">
              {error.message}
              {error.requestId ? (
                <span className="kit-dialog__error-id">
                  request
                  <CopyText
                    value={error.requestId}
                    display={cutId(error.requestId)}
                    label={`Copy request id ${error.requestId}`}
                  />
                </span>
              ) : null}
            </p>
          ) : null}
        </>
      ) : null}
    </ResponsiveDialog>
  );
}

/**
 * Why the action failed and its request id, read from what it threw: an API error's own words (`detail`) and
 * `requestId` when it has them (the console's ApiError does), else its message.
 */
export function failureOf(e: unknown): { message: string; requestId: string | null } {
  const o = (e && typeof e === "object" ? e : {}) as { detail?: unknown; message?: unknown; requestId?: unknown };
  const message =
    typeof o.detail === "string" && o.detail
      ? o.detail
      : typeof o.message === "string" && o.message
        ? o.message
        : "That did not work. Try again.";
  return { message, requestId: typeof o.requestId === "string" && o.requestId ? o.requestId : null };
}

/** Whether a node draws anything: not nothing, null, false or an empty string, nor a list of only those. */
function hasContent(node: ReactNode): boolean {
  if (node === undefined || node === null || node === false || node === true || node === "") return false;
  if (Array.isArray(node)) return node.some(hasContent);
  return true;
}

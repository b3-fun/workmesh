// Copy to clipboard with feedback (LIBRARY.md "copy"; PHILOSOPHY P8 and P19: "make the text snippet copyable on click",
// IDs in code formatting that copy). The feedback is in place, not a toast: the copy glyph turns into a check by the
// make-interfaces-feel-better recipe (both glyphs stay in the DOM, crossfading on opacity, scale 0.25 to 1 and blur 4 px
// to 0 on cubic-bezier(0.2, 0, 0, 1)), the kit's one announcer says "Copied" (announce.ts), a light haptic on a phone, and it settles back
// after 1.4 s. CopyText is a value you click to copy: mono, a tint on hover, the glyph at its right, "Copied" in a small
// bubble above it.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../ui/Icon";
import { cn } from "../lib/utils";
import { announce } from "./announce";
import { haptic } from "./haptics";
import "./css/lite.css";
import "./kit.css";

/** Writes text to the clipboard; falls back to a hidden textarea where the async clipboard is refused. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused (an insecure origin, no focus): try the old way.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** `copied` is true for `ms` after a successful copy; `failed` after a refused one. */
export function useCopy(ms = 1400) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    async (text: string) => {
      const ok = await writeClipboard(text);
      setState(ok ? "copied" : "failed");
      haptic(ok ? "light" : "error");
      announce(ok ? "Copied" : "Could not copy");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), ms);
      return ok;
    },
    [ms],
  );
  return { copied: state === "copied", failed: state === "failed", copy };
}

/** The copy glyph and the check, both drawn, crossfading. */
export function CopyGlyph({ copied, size = 16 }: { copied: boolean; size?: number }) {
  return (
    <span
      className="kit-copy-glyph"
      data-copied={copied ? "" : undefined}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span className="kit-copy-glyph__copy">
        <Icon name="copy" size={size} />
      </span>
      <span className="kit-copy-glyph__check">
        <Icon name="check" size={size} />
      </span>
    </span>
  );
}

export interface CopyButtonProps {
  value: string;
  /** What is copied, for the button's name: "Copy the key" (default "Copy"). */
  label?: string;
  size?: "sm" | "md";
  /** On a dark code surface. */
  inverse?: boolean;
  /** Nothing to copy yet. */
  disabled?: boolean;
  className?: string;
}

export function CopyButton({
  value,
  label = "Copy",
  size = "sm",
  inverse = false,
  disabled,
  className,
}: CopyButtonProps) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      className={cn("kit-icon-btn kit-press", className)}
      data-size={size}
      data-inverse={inverse ? "" : undefined}
      aria-label={copied ? "Copied" : label}
      title={label}
      disabled={disabled}
      onClick={() => void copy(value)}
    >
      <CopyGlyph copied={copied} size={size === "sm" ? 14 : 16} />
    </button>
  );
}

export interface CopyTextProps {
  /** What is copied. */
  value: string;
  /** What is shown, when shorter than the value (an id's middle cut: sbx_01m5t3…jv4r). */
  display?: string;
  /** Monospace (default): ids, keys, paths. */
  mono?: boolean;
  /** The value as `<code>`: an identifier is code (a dotted limit id is not prose to read past). */
  code?: boolean;
  className?: string;
  /** The accessible name, when the value alone does not say what it is ("Copy sandbox id sbx_…"). Default:
   * "<shown value>, copy". */
  label?: string;
}

export function CopyText({ value, display, mono = true, code = false, label, className }: CopyTextProps) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      className={cn("kit-copy-text", mono && "font-mono", className)}
      onClick={() => void copy(value)}
      title={display && display !== value ? value : undefined}
      aria-label={label ?? `${display ?? value}, copy`}
      data-copied={copied ? "" : undefined}
    >
      {code ? (
        <code className="kit-copy-text__value">{display ?? value}</code>
      ) : (
        <span className="kit-copy-text__value">{display ?? value}</span>
      )}
      <CopyGlyph copied={copied} size={13} />
      <span className="kit-copy-text__bubble" aria-hidden="true">
        Copied
      </span>
    </button>
  );
}

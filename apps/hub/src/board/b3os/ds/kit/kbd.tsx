// Keyboard-shortcut hints and the hook that binds them (LIBRARY.md "kbd"). The keycap is the original's (the sidebar's
// search field shows ⌘ K in it): 11 px Geist Mono on the sunken surface, a 1 px hairline and the debossed shadow.
// "mod" prints ⌘ on Apple platforms and Ctrl elsewhere. A shortcut never fires while the reader types in a field, and
// what it does happens at once: nothing animates on a keyboard action (emil-design-eng).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import "./css/lite.css";
import "./kit.css";

export function isApple(): boolean {
  if (typeof navigator === "undefined") return true;
  const p =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
  return /mac|iphone|ipad|ipod/i.test(p ?? "");
}

const GLYPH: Record<string, string> = {
  shift: "⇧",
  alt: "⌥",
  enter: "↵",
  esc: "Esc",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  backspace: "⌫",
  tab: "Tab",
};

/** What a key name prints as: `mod` is ⌘ or Ctrl, `shift` ⇧, arrows as arrows, a letter upper-cased. */
export function keyLabel(key: string, apple = isApple()): string {
  const k = key.toLowerCase();
  if (k === "mod") return apple ? "⌘" : "Ctrl";
  if (k === "alt" && !apple) return "Alt";
  return GLYPH[k] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** A key's name as a screen reader says it ("Command", "Enter"), not its glyph (a11y audit 11-23, M11). */
const SPOKEN: Record<string, string> = {
  shift: "Shift",
  enter: "Enter",
  esc: "Escape",
  up: "Up arrow",
  down: "Down arrow",
  left: "Left arrow",
  right: "Right arrow",
  backspace: "Backspace",
  tab: "Tab",
};
export function keyWords(key: string, apple = isApple()): string {
  const k = key.toLowerCase();
  if (k === "mod") return apple ? "Command" : "Control";
  if (k === "alt") return apple ? "Option" : "Alt";
  return SPOKEN[k] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** A shortcut as aria-keyshortcuts writes it ("Meta+Enter"); a sequence's first step. */
export function ariaKeys(keys: string | readonly string[], apple = isApple()): string {
  const step = parse(keys)[0] ?? [];
  const name = (k: string) => {
    const l = k.toLowerCase();
    if (l === "mod") return apple ? "Meta" : "Control";
    if (l === "esc") return "Escape";
    if (/^(up|down|left|right)$/.test(l)) return `Arrow${l[0]?.toUpperCase()}${l.slice(1)}`;
    return l.length === 1 ? l.toUpperCase() : `${l[0]?.toUpperCase()}${l.slice(1)}`;
  };
  return step.map(name).join("+");
}

export interface KbdProps {
  /** "mod+k", ["mod", "k"] or "g then a" (a sequence): each key its own cap. */
  keys: string | readonly string[];
  /** On the inverse surface of a tooltip. */
  inverse?: boolean;
  className?: string;
}

function parse(keys: string | readonly string[]): string[][] {
  if (Array.isArray(keys)) return [keys as string[]];
  return (keys as string).split(/\s+then\s+/).map((step) => step.split("+").map((k) => k.trim()));
}

export function Kbd({ keys, inverse = false, className }: KbdProps) {
  const steps = parse(keys);
  const said = steps.map((s) => s.map((k) => keyWords(k)).join(" ")).join(" then ");
  // Inside a control (Scrape ⌘↵) the caps are not part of its name ("Scrape⌘↵": a11y audit 11-23, M11): hidden, and
  // the control carries the shortcut as aria-keyshortcuts instead. Elsewhere they read as their keys' names.
  const ref = useRef<HTMLSpanElement>(null);
  const [inControl, setInControl] = useState(false);
  useLayoutEffect(() => {
    const control = ref.current?.parentElement?.closest<HTMLElement>(
      "button, a[href], [role=button], [role=tab], [role=menuitem]",
    );
    setInControl(!!control);
    if (control && !control.hasAttribute("aria-keyshortcuts"))
      control.setAttribute("aria-keyshortcuts", ariaKeys(keys));
  }, [keys]);
  return (
    <span
      ref={ref}
      className={cn("kit-kbd-group", className)}
      {...(inControl ? { "aria-hidden": true } : { "aria-label": said, role: "img" })}
    >
      {steps.map((step, i) => (
        <span key={i} className="kit-kbd-step" aria-hidden="true">
          {i > 0 ? <span className="kit-kbd-then">then</span> : null}
          {step.map((k) => (
            <kbd key={k} className="kit-kbd" data-inverse={inverse ? "" : undefined}>
              {keyLabel(k)}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

/** Whether a key event comes from a place where the reader is typing. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.getAttribute("role") === "combobox";
}

export interface ShortcutOptions {
  /** ⌘ on Apple, Ctrl elsewhere, must be held. */
  mod?: boolean;
  shift?: boolean;
  enabled?: boolean;
  /** Fire even while typing in a field (a ⌘K that opens search from anywhere). */
  inFields?: boolean;
}

/** Binds one key (event.key, case-insensitive) on the document while mounted. */
export function useShortcut(key: string, handler: (e: KeyboardEvent) => void, opts: ShortcutOptions = {}): void {
  const latest = useRef(handler);
  latest.current = handler;
  const { mod = false, shift = false, enabled = true, inFields = false } = opts;
  useEffect(() => {
    if (!enabled) return;
    const apple = isApple();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      if (e.key.toLowerCase() !== key.toLowerCase()) return;
      const held = apple ? e.metaKey : e.ctrlKey;
      if (held !== mod || e.shiftKey !== shift || e.altKey) return;
      if (!mod && (e.metaKey || e.ctrlKey)) return;
      if (!inFields && isTyping(e.target)) return;
      e.preventDefault();
      latest.current(e);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [key, mod, shift, enabled, inFields]);
}

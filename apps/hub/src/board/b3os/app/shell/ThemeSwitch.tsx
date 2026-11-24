// The theme control (admin redesign 1121): Light, Dark or the system's setting, each with its icon and word, on the
// console's segmented track (the original's ds-segmented). Settings > Appearance and the account popover draw it (the
// original kept its Theme toggle in its header's settings popover). No choice yet reads as Light, the default every page
// draws (lib/theme-bootstrap.ts: the owner, 11-21, "default to light mode not system mode").

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { applyTheme, readThemeChoice, type ThemeChoice } from "../../lib/theme-bootstrap";
import { Icon, type IconName } from "../../ui/Icon";

const ITEMS: { v: ThemeChoice; icon: IconName; label: string }[] = [
  { v: "light", icon: "sun", label: "Light" },
  { v: "dark", icon: "moon", label: "Dark" },
  { v: "system", icon: "monitor", label: "System" },
];

export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const [choice, setChoice] = useState<ThemeChoice>(() => readThemeChoice() ?? "light");
  // Another control changed it (the sidebar's Dark mode switch): show what was saved.
  useEffect(() => {
    const mo = new MutationObserver(() => setChoice(readThemeChoice() ?? "light"));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  // System follows the system while it is the choice.
  useEffect(() => {
    if (choice !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [choice]);
  const pick = (v: ThemeChoice) => {
    applyTheme(v);
    setChoice(v);
  };
  // A radio group is one Tab stop, the chosen radio; the arrows move and choose (a11y audit 11-23, M8: three stops and
  // no arrows).
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    const to =
      e.key === "Home" ? 0 : e.key === "End" ? ITEMS.length - 1 : step ? (i + step + ITEMS.length) % ITEMS.length : -1;
    const item = ITEMS[to];
    if (!item) return;
    e.preventDefault();
    pick(item.v);
    refs.current[to]?.focus();
  };
  return (
    <div
      className={`b3os-segmented ${compact ? "flex w-full [&>button]:flex-1 [&>button]:justify-center [&>button]:px-2" : "w-fit"}`}
      role="radiogroup"
      aria-label="Color theme"
    >
      {ITEMS.map((it, i) => (
        <button
          key={it.v}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={choice === it.v}
          tabIndex={choice === it.v ? 0 : -1}
          data-active={choice === it.v ? "true" : undefined}
          onClick={() => pick(it.v)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          <Icon name={it.icon} size={16} />
          {it.label}
        </button>
      ))}
    </div>
  );
}

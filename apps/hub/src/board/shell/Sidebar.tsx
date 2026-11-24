// The sidebar, from the console's (b3os-beta apps/web/src/app/shell/Sidebar.tsx @ 65e00f860): the wordmark and its
// chip, the glossy create button (here: Connect a machine), the nav in labelled groups with the raised active pill that
// slides between rows and a pixel grid that plays on the row under the pointer, then the Dark mode row and the account
// card. Bullpen's nav: the board, your machines, and one row per person (the board narrowed to them).

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { ProjectTile } from "../b3os/app/shell/triggers";
import { Switch } from "../b3os/ds/primitives/switch";
import { PixelGrid, pickPixelGridSeed } from "../b3os/ds/signature/pixel-grid";
import { applyTheme } from "../b3os/lib/theme-bootstrap";
import { Icon, type IconName } from "../b3os/ui/Icon";
import { useBoardData } from "../board-context";

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  active: boolean;
}

/** The theme as the page has it now (the bootstrap set <html data-theme> before paint). As the console's useDark. */
function useDark(): [boolean, (dark: boolean) => void] {
  const read = () => typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark";
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return [dark, (d) => setDark(applyTheme(d ? "dark" : "light") === "dark")];
}

function useNav(): { label: string | null; items: NavItem[] }[] {
  const [location] = useLocation();
  const person = new URLSearchParams(useSearch()).get("person");
  const { view } = useBoardData();
  const onBoard = location === "/" || location.startsWith("/sessions/");
  return [
    {
      label: null,
      items: [
        { href: "/", label: "Board", icon: "home" as const, active: onBoard && !person },
        { href: "/machines", label: "Machines", icon: "terminal" as const, active: location.startsWith("/machines") },
      ],
    },
    {
      label: "People",
      items: (view?.lanes ?? []).map((l) => ({
        href: `/?person=${encodeURIComponent(l.person.email)}`,
        label: l.person.name,
        icon: "user" as const,
        active: location === "/" && person === l.person.email,
      })),
    },
  ].filter((g) => g.items.length > 0);
}

/** One list for all groups, so the active pill is one element that slides to the current row (the console's NavList). */
function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const groups = useNav();
  const listRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ y: number; h: number } | null>(null);
  // The row under the pointer or focus: its pixel grid plays (the original's autoplay={hovered}).
  const [hot, setHot] = useState<string | null>(null);
  const activeKey = groups.flatMap((g) => g.items).find((i) => i.active)?.href ?? null;
  const place = useCallback(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !row) return setPill(null);
    setPill({ y: row.offsetTop, h: row.offsetHeight });
  }, []);
  useLayoutEffect(() => {
    place();
  }, [activeKey, groups.length, place]);
  useEffect(() => {
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [place]);
  const placed = useRef(false);
  useEffect(() => {
    if (pill) placed.current = true;
  }, [pill]);
  return (
    <nav ref={listRef} aria-label="Bullpen" className="side-nav">
      {pill ? (
        <span
          className="side-nav__pill"
          data-still={placed.current ? undefined : ""}
          style={{ transform: `translateY(${pill.y}px)`, height: pill.h }}
          aria-hidden="true"
        />
      ) : null}
      {groups.map((group) => (
        <div key={group.label ?? "top"} className="side-nav__group">
          {group.label ? <p className="side-nav__label">{group.label}</p> : null}
          <ul>
            {group.items.map((it) => (
              <li key={it.href}>
                <Link
                  href={it.href}
                  className="side-nav__item"
                  aria-current={it.active ? "page" : undefined}
                  onClick={onNavigate}
                  onPointerEnter={() => setHot(it.href)}
                  onPointerLeave={() => setHot((h) => (h === it.href ? null : h))}
                  onFocus={() => setHot(it.href)}
                  onBlur={() => setHot((h) => (h === it.href ? null : h))}
                >
                  <Icon name={it.icon} size={18} />
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  <span className="side-nav__pixels" aria-hidden="true">
                    <PixelGrid
                      pattern={pickPixelGridSeed(it.label).pattern}
                      color="blue"
                      size="xs"
                      autoplay={hot === it.href}
                    />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** The sidebar's column; `close` is the phone drawer's close button (drawn at the right of the logo row). */
export function SidebarContent({ onNavigate, close }: { onNavigate?: () => void; close?: ReactNode }) {
  const [dark, setDark] = useDark();
  const themeId = useId();
  const { model, setConnectOpen } = useBoardData();
  const me = model?.me ?? null;
  return (
    <div className="side">
      <div className="side__head">
        {close ? <span className="order-last ml-auto">{close}</span> : null}
        <Link href="/" className="side__brand" aria-label="Bullpen home" onClick={onNavigate}>
          <span className="b3os-wordmark h-[18px] text-ink" role="img" aria-label="B3OS" />
        </Link>
        <span className="b3os-chip">Bullpen</span>
      </div>
      <button
        type="button"
        className="side-create"
        aria-haspopup="dialog"
        data-pixel-pulse=""
        onClick={() => {
          onNavigate?.();
          setConnectOpen(true);
        }}
      >
        <Icon name="plus" size={14} />
        <span>Connect a machine</span>
      </button>
      <NavList onNavigate={onNavigate} />
      <div className="side__foot">
        <label htmlFor={themeId} className="side-nav__item side__theme">
          <Icon name="moon" size={18} />
          <span className="flex-1 truncate">Dark mode</span>
          <Switch id={themeId} size="sm" checked={dark} onCheckedChange={setDark} />
        </label>
        {me ? (
          <Link href="/machines" className="side-account" aria-label={`${me.name}, ${me.email}: your machines`} onClick={onNavigate}>
            <span className="relative shrink-0">
              <ProjectTile name={me.name} />
            </span>
            <span className="min-w-0 flex-1 text-left">
              <span className="side-account__project">{me.name}</span>
              <span className="side-account__org">{model?.project.name}</span>
            </span>
            <Icon name="chevronRight" size={14} className="shrink-0 text-ink-3" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

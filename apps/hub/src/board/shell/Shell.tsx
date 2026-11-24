// The console's layout (b3os-beta apps/web/src/app/Shell.tsx @ 65e00f860): the grey canvas, the sidebar on it, the page
// as a raised stage with its status footer; under 1024 px a sticky top bar and the sidebar in a drawer. The drawer's
// focus handling is the console's useDrawerFocus, unchanged.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { StatusDot } from "../b3os/ds/layout/status-dot";
import { PageColumn } from "../b3os/ds/layout/page-column";
import { Icon } from "../b3os/ui/Icon";
import { useBoardData } from "../board-context";
import { ConnectDialog } from "../components/ConnectDialog";
import { SidebarContent } from "./Sidebar";

/** What Tab can reach inside the phone drawer. */
const FOCUSABLE = 'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex="0"]';

/** The phone drawer is a modal: focus moves in, Tab cycles inside, Escape closes, focus goes back to its opener. */
function useDrawerFocus(open: boolean, panel: { current: HTMLElement | null }, close: () => void) {
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !panel.current?.contains(active)) opener.current = active;
    const items = () =>
      Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.tabIndex !== -1);
    items()[0]?.focus();
    const menuOpen = () => document.querySelector("[data-radix-popper-content-wrapper]") !== null;
    const onKey = (e: KeyboardEvent) => {
      if (menuOpen()) return;
      if (e.key === "Escape") {
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const list = items();
      const first = list[0];
      const last = list.at(-1);
      if (!first || !last) return;
      const inside = panel.current?.contains(document.activeElement) ?? false;
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.documentElement.style.overflow = "";
      const back = opener.current;
      if (back?.isConnected && !panel.current?.isConnected) back.focus();
    };
  }, [open, panel, close]);
}

/** The stage's foot: the board's live connection on the left (the console's status slot), the relay on the right. */
function StageFooter() {
  const { conn } = useBoardData();
  const words =
    conn === "live"
      ? ({ tone: "ok", text: "Live" } as const)
      : conn === "connecting"
        ? ({ tone: "off", text: "Connecting" } as const)
        : ({ tone: "warn", text: "Reconnecting" } as const);
  return (
    <footer className="stage-foot">
      <span className="stage-foot__status" role="status">
        <StatusDot tone={words.tone}>{words.text}</StatusDot>
      </span>
      <nav aria-label="Links" className="stage-foot__links">
        <a href="https://github.com/seangeng/agentblip" target="_blank" rel="noopener noreferrer">
          Relay
        </a>
        <span className="stage-foot__dot" aria-hidden="true" />
        <a href="https://linear.app/npclabs/issue/B3-7165" target="_blank" rel="noopener noreferrer">
          Linear
        </a>
      </nav>
    </footer>
  );
}

export function Shell({ children, full = false }: { children: ReactNode; full?: boolean }) {
  const [open, setOpen] = useState(false);
  const [location] = useLocation();
  const drawerRef = useRef<HTMLDivElement>(null);
  const { model, connectOpen, setConnectOpen } = useBoardData();
  useEffect(() => setOpen(false), [location]);
  const closeDrawer = useCallback(() => setOpen(false), []);
  useDrawerFocus(open, drawerRef, closeDrawer);
  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="app-sidebar" aria-label="Sidebar">
        <SidebarContent />
      </aside>
      <div className="app-main">
        <header className="app-topbar">
          <Link href="/" className="flex min-h-11 min-w-0 items-center gap-2.5" aria-label="Board">
            <span className="b3os-mark h-6 shrink-0 text-ink" role="img" aria-label="B3OS" />
            <span className="truncate text-small font-medium text-ink-2">{model?.project.name ?? "B3"} / Bullpen</span>
          </Link>
          <span className="flex shrink-0 items-center">
            <button
              type="button"
              className="b3os-btn b3os-btn--ghost b3os-btn--icon w-11"
              aria-label="Open navigation"
              aria-expanded={open}
              onClick={() => setOpen(true)}
            >
              <Icon name="menu" />
            </button>
          </span>
        </header>
        <main id="main" className="app-frame" tabIndex={-1}>
          <div className="app-frame__body">
            <PageColumn full={full}>{children}</PageColumn>
          </div>
          <StageFooter />
        </main>
      </div>
      {open ? (
        <div className="app-drawer" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="app-drawer__scrim" aria-hidden="true" onClick={() => setOpen(false)} />
          <div ref={drawerRef} className="app-drawer__panel">
            <SidebarContent
              onNavigate={() => setOpen(false)}
              close={
                <button
                  type="button"
                  className="b3os-btn b3os-btn--ghost b3os-btn--icon w-11"
                  aria-label="Close navigation"
                  onClick={() => setOpen(false)}
                >
                  <Icon name="close" />
                </button>
              }
            />
          </div>
        </div>
      ) : null}
      <ConnectDialog open={connectOpen} onClose={() => setConnectOpen(false)} />
    </div>
  );
}

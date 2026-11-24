import { DropdownMenu } from "radix-ui";
import { useEffect, useState } from "react";
import type { Person } from "../../shared/types";
import type { Conn } from "../store";
import { Button, IconPlus, cx } from "./ui";

type Theme = "system" | "light" | "dark";

function readTheme(): Theme {
  try {
    const t = localStorage.getItem("bullpen-theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem("bullpen-theme");
      else localStorage.setItem("bullpen-theme", theme);
    } catch {
      // storage blocked: the choice lasts for this tab only
    }
  }, [theme]);
  return [theme, setTheme] as const;
}

export function LiveIndicator({ conn }: { conn: Conn }) {
  const live = conn === "live";
  return (
    <span
      className="flex items-center gap-2 text-[12px] text-muted"
      title={live ? "Live" : conn === "connecting" ? "Connecting" : "Reconnecting; showing the last snapshot"}
    >
      <span className="relative flex size-2">
        {live && <span className="live-ping absolute inset-0 rounded-full bg-accent" />}
        <span className={cx("relative inline-flex size-2 rounded-full", live ? "bg-accent" : "bg-faint")} />
      </span>
      <span className="max-sm:sr-only">{live ? "Live" : conn === "connecting" ? "Connecting" : "Reconnecting"}</span>
    </span>
  );
}

function Count({ n, label }: { n: number; label: string }) {
  return (
    <span className="whitespace-nowrap">
      <span className="tnum font-semibold text-fg">{n}</span> {label}
    </span>
  );
}

export function TopBar({
  projectName,
  me,
  conn,
  agentsWorking,
  waiting,
  peopleOnline,
  onConnect,
}: {
  projectName: string;
  me: Person;
  conn: Conn;
  agentsWorking: number;
  waiting: number;
  peopleOnline: number;
  onConnect: () => void;
}) {
  const [theme, setTheme] = useTheme();
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-surface px-4 py-3 sm:h-14 sm:flex-nowrap sm:py-0">
      <div className="flex items-baseline gap-2">
        <span className="text-[15px] font-bold tracking-[-0.01em] text-fg">{projectName}</span>
        <span className="text-[13px] text-faint">Bullpen</span>
      </div>

      <div className="order-last flex w-full flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted sm:order-none sm:w-auto">
        <Count n={agentsWorking} label={agentsWorking === 1 ? "agent working" : "agents working"} />
        <Count n={waiting} label="waiting on people" />
        <Count n={peopleOnline} label={peopleOnline === 1 ? "person online" : "people online"} />
      </div>

      <div className="ml-auto flex items-center gap-3">
        <LiveIndicator conn={conn} />
        <Button variant="secondary" onClick={onConnect}>
          <IconPlus />
          <span className="max-sm:hidden">Connect a machine</span>
          <span className="sm:hidden">Connect</span>
        </Button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={`Signed in as ${me.email}`}
              className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-sunk text-[12px] font-semibold text-fg transition-colors hover:bg-hover max-sm:size-10"
            >
              {me.name.charAt(0)}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="menu-in z-50 min-w-52 rounded-lg border border-line bg-surface p-1 text-[13px] shadow-pop"
            >
              <DropdownMenu.Label className="px-2 py-1.5 font-mono text-[12px] text-muted">{me.email}</DropdownMenu.Label>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <DropdownMenu.Label className="px-2 pt-1 pb-0.5 text-[11px] text-faint">Theme</DropdownMenu.Label>
              <DropdownMenu.RadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
                {(["system", "light", "dark"] as const).map((t) => (
                  <DropdownMenu.RadioItem
                    key={t}
                    value={t}
                    className="flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-text outline-none data-highlighted:bg-hover data-highlighted:text-fg"
                  >
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                    <DropdownMenu.ItemIndicator className="size-1.5 rounded-full bg-accent" />
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}

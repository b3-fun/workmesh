import { useMemo, useState } from "react";
import type { HubEvent } from "../../shared/types";
import { turnDuration } from "../lib/transcript";
import { eventKey } from "../store";
import { clock } from "../time";
import type { SessionView } from "../view";
import { Button, ColumnHeader, IconClose, Row, cx } from "./ui";

const PAGE = 150;

function PathText({ path }: { path: string }) {
  const i = path.lastIndexOf("/");
  const dir = i >= 0 ? path.slice(0, i + 1) : "";
  const base = i >= 0 ? path.slice(i + 1) : path;
  return (
    <span className="flex min-w-0" title={path}>
      {dir && <span className="min-w-0 truncate text-faint">{dir}</span>}
      <span className="shrink-0 text-text">{base}</span>
    </span>
  );
}

function prNumber(url: string): string {
  return `#${url.split("/").pop()}`;
}

const firstLine = (t: string) => t.replace(/[`*_#>]+/g, "").replace(/\s+/g, " ").trim();

function What({ e }: { e: HubEvent }) {
  switch (e.kind) {
    case "prompt":
      return (
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-accent">prompt</span>
          {e.text && <span className="min-w-0 truncate font-sans text-[12.5px] text-text">{firstLine(e.text)}</span>}
        </span>
      );
    case "message":
      return <span className="min-w-0 truncate font-sans text-[12.5px] text-muted">{firstLine(e.text ?? "")}</span>;
    case "turn":
      return (
        <span className="min-w-0 truncate text-faint">
          turn ended{e.durationMs != null ? ` · ${turnDuration(e.durationMs)}` : ""}
        </span>
      );
    case "start":
      return <span className="text-faint">session started</span>;
    case "end":
      return <span className="text-faint">session ended</span>;
    case "idle":
      return <span className="text-faint">idle</span>;
    case "waiting":
      return <span className="truncate text-warn-text">{e.label ?? "waiting"}</span>;
    case "tool":
      return (
        <span className="flex min-w-0 items-baseline gap-2">
          {e.tool && <span className="shrink-0 text-fg">{e.tool.startsWith("mcp__") ? e.tool.split("__")[1] : e.tool}</span>}
          {e.desc && !e.path && !e.cmd ? (
            <span className="min-w-0 truncate font-sans text-[12.5px] text-muted">{e.desc}</span>
          ) : e.path ? (
            <PathText path={e.path} />
          ) : e.cmd ? (
            <span className="min-w-0 truncate text-text">{e.cmd}</span>
          ) : e.label ? (
            <span className="min-w-0 truncate text-muted">{e.label}</span>
          ) : null}
          {e.ok === false && <span className="shrink-0 text-bad">failed</span>}
        </span>
      );
  }
}

export function LiveTail({
  events,
  fresh,
  selected,
  sessions,
  nameOf,
  onSelect,
  onClear,
  onLoadOlder,
}: {
  events: HubEvent[];
  fresh: Set<string>;
  selected: SessionView | null;
  sessions: Record<string, SessionView>;
  nameOf: (email: string) => string;
  onSelect: (hubKey: string) => void;
  onClear: () => void;
  onLoadOlder: (before: number) => Promise<number>;
}) {
  const [limit, setLimit] = useState(PAGE);
  const [exhausted, setExhausted] = useState<string | null>(null);
  const shown = useMemo(
    () => (selected ? events.filter((e) => e.hubKey === selected.hubKey) : events),
    [events, selected],
  );
  const rows = shown.slice(0, limit);
  const canLoadOlder = selected && exhausted !== selected.hubKey && shown.length >= limit;

  return (
    <section aria-label="Live tail" className="flex min-h-0 flex-col">
      <ColumnHeader title={selected ? "Live tail" : "Live tail · all sessions"}>
        {selected && (
          <Button variant="ghost" className="-mr-2 h-7 px-2 text-[12px]" onClick={onClear} aria-label="Show all sessions">
            <IconClose />
            All
          </Button>
        )}
      </ColumnHeader>
      {selected && (
        <div className="flex flex-col gap-0.5 border-b border-line px-4 pb-3">
          <span className="truncate font-mono text-[13px] font-medium text-fg">{selected.name ?? selected.key}</span>
          <span className="truncate text-[12px] text-muted">
            {selected.person}
            {selected.machine && <span className="text-faint"> · {selected.machine}</span>}
            {selected.repo && <span className="text-faint"> · {selected.repo}</span>}
          </span>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="px-4 pt-2 text-[13px] text-faint">Quiet. Tool calls show up here as they happen.</p>
      ) : (
        <ol className="min-h-0 flex-1 overflow-y-auto pb-4 font-mono text-[12px] scroll-thin">
          {rows.map((e) => {
            const key = eventKey(e);
            const s = sessions[e.hubKey];
            return (
              <li key={key} className={cx(fresh.has(key) && "row-in")}>
                <Row
                  onActivate={() => onSelect(e.hubKey)}
                  label={undefined}
                  className={cx(
                    "grid items-baseline gap-x-3 px-4 py-[5px] transition-colors hover:bg-hover",
                    selected ? "grid-cols-[auto_minmax(0,1fr)_auto]" : "grid-cols-[auto_3rem_minmax(0,1fr)_auto]",
                  )}
                >
                  <time className="tnum text-faint" dateTime={new Date(e.ts).toISOString()}>
                    {clock(e.ts)}
                  </time>
                  {!selected && (
                    <span className="truncate font-sans text-[12.5px] font-medium text-muted" title={s?.name ?? undefined}>
                      {nameOf(e.email)}
                    </span>
                  )}
                  <What e={e} />
                  {e.pr ? (
                    <a
                      href={e.pr}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(ev) => ev.stopPropagation()}
                      className="text-accent hover:underline"
                    >
                      PR {prNumber(e.pr)}
                    </a>
                  ) : (
                    <span />
                  )}
                </Row>
              </li>
            );
          })}
          {(shown.length > limit || canLoadOlder) && (
            <li className="px-4 pt-2">
              <Button
                variant="ghost"
                className="-ml-2 text-[12px]"
                onClick={async () => {
                  if (shown.length > limit) setLimit(limit + PAGE);
                  else if (selected) {
                    const oldest = shown[shown.length - 1]?.ts ?? Date.now();
                    const n = await onLoadOlder(oldest);
                    if (n === 0) setExhausted(selected.hubKey);
                    setLimit(limit + PAGE);
                  }
                }}
              >
                Older
              </Button>
            </li>
          )}
        </ol>
      )}
    </section>
  );
}

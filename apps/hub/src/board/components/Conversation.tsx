import { Collapsible } from "radix-ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HubEvent } from "../../shared/types";
import { buildTranscript, prLinks, turnDuration, type Item } from "../lib/transcript";
import { duration, useNow } from "../time";
import { currentNow, repoName, type SessionView } from "../view";
import { Markdown } from "./Markdown";
import { Button, IconChevron, IconClose, IssueChip, StateDot, cx } from "./ui";

const hmFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const hm = (ts: number) => hmFmt.format(new Date(ts));
const clockFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** "mcp__claude-in-chrome__navigate" -> "claude-in-chrome · navigate". */
function toolName(tool: string | null): string {
  if (!tool) return "tool";
  if (tool.startsWith("mcp__")) {
    const [, server, ...rest] = tool.split("__");
    return `${server} · ${rest.join("__")}`;
  }
  return tool;
}

const prNumber = (url: string) => `#${url.split("/").pop()}`;

/** A transcript row: a 14 px gutter for the marker, then the content. */
function Gutter({ marker, children, className }: { marker: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx("grid grid-cols-[14px_minmax(0,1fr)] gap-x-2.5", className)}>
      <span aria-hidden className="flex h-[22px] items-center justify-center">
        {marker}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const Dot = ({ className }: { className: string }) => <span className={cx("size-[5px] rounded-full", className)} />;

function PromptItem({ e, person }: { e: HubEvent; person: string }) {
  const [open, setOpen] = useState(false);
  if (!e.text) {
    return (
      <div className="flex items-baseline gap-2 pt-1 text-[12px] text-faint">
        <span className="font-medium text-muted">{person}</span> sent a prompt
        <time className="tnum ml-auto font-mono">{hm(e.ts)}</time>
      </div>
    );
  }
  const long = e.text.length > 600 || e.text.split("\n").length > 8;
  return (
    <div className="rounded-lg bg-sunk px-3.5 pt-2 pb-2.5">
      <div className="flex items-baseline justify-between gap-3 text-[12px]">
        <span className="font-semibold text-fg">{person}</span>
        <time className="tnum font-mono text-faint">{hm(e.ts)}</time>
      </div>
      <p
        className={cx(
          "mt-0.5 text-[13.5px] leading-[1.55] whitespace-pre-wrap text-text [overflow-wrap:anywhere]",
          long && !open && "line-clamp-6",
        )}
      >
        {e.text}
      </p>
      {(long || e.truncated) && (
        <div className="mt-1 flex items-baseline gap-3 text-[12px]">
          {long && (
            <button
              type="button"
              onClick={() => setOpen(!open)}
              className="cursor-pointer font-medium text-muted transition-colors hover:text-fg max-sm:py-2"
            >
              {open ? "Show less" : "Show all"}
            </button>
          )}
          {e.truncated && (!long || open) && <span className="text-faint">Cut at 4,000 characters</span>}
        </div>
      )}
    </div>
  );
}

function ToolsItem({ item }: { item: Extract<Item, { k: "tools" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger className="group w-full cursor-pointer text-left">
        <Gutter marker={<Dot className={item.failed ? "bg-bad" : "bg-faint"} />}>
          <span className="flex items-baseline gap-1.5 text-[13px] leading-[22px] text-muted transition-colors group-hover:text-fg">
            <span className="min-w-0">
              {item.label}
              {item.failed > 0 && <span className="text-bad"> · {item.failed} failed</span>}
            </span>
            <span className="shrink-0 translate-y-[1px] text-faint">
              <IconChevron open={open} />
            </span>
          </span>
        </Gutter>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <ol className="mt-1 ml-[6px] border-l border-line pl-[17px]">
          {item.events.map((e) => (
            <li key={e.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-[3px]">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-mono text-[12px] text-fg">{toolName(e.tool)}</span>
                {e.desc && <span className="min-w-0 text-[12.5px] text-text">{e.desc}</span>}
                {e.path ? (
                  <span className="min-w-0 font-mono text-[12px] text-muted [overflow-wrap:anywhere]">{e.path}</span>
                ) : e.cmd ? (
                  <span className="font-mono text-[12px] text-muted">{e.cmd}</span>
                ) : null}
                {e.pr && (
                  <a href={e.pr} target="_blank" rel="noopener noreferrer" className="font-mono text-[12px] text-accent hover:underline">
                    PR {prNumber(e.pr)}
                  </a>
                )}
                {e.ok === false && <span className="font-mono text-[12px] text-bad">failed</span>}
              </span>
              <time className="tnum font-mono text-[11.5px] text-faint">{clockFmt.format(new Date(e.ts))}</time>
            </li>
          ))}
        </ol>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function TurnItem({ e }: { e: HubEvent }) {
  return (
    <div className="border-b border-line pt-1 pb-5">
      {e.summary && <p className="text-[13px] leading-[1.55] text-fg">{e.summary}</p>}
      <p className={cx("tnum font-mono text-[11.5px] text-faint", e.summary && "mt-1")}>
        {e.durationMs != null ? `Worked for ${turnDuration(e.durationMs)} · ` : "Turn ended · "}
        {hm(e.ts)}
      </p>
    </div>
  );
}

function ItemView({ item, person }: { item: Item; person: string }) {
  switch (item.k) {
    case "prompt":
      return <PromptItem e={item.e} person={person} />;
    case "message":
      return (
        <Gutter marker={<Dot className="bg-fg/75" />}>
          <Markdown text={item.e.text ?? ""} className="text-[13.5px] leading-[1.6] text-text" />
        </Gutter>
      );
    case "tools":
      return <ToolsItem item={item} />;
    case "waiting":
      return (
        <Gutter marker={<Dot className="bg-warn" />}>
          <p className="text-[13px] leading-[22px] text-warn-text">Waiting on {person}{item.e.label ? ` · ${item.e.label}` : ""}</p>
        </Gutter>
      );
    case "turn":
      return <TurnItem e={item.e} />;
    case "mark":
      return (
        <p className="tnum font-mono text-[11.5px] text-faint">
          {item.text} · {hm(item.e.ts)}
        </p>
      );
  }
}

function Working({ s }: { s: SessionView }) {
  const now = useNow();
  return (
    <Gutter marker={<Dot className="bg-ok" />}>
      <p className="truncate text-[12.5px] leading-[22px] text-muted">
        {s.activity && s.activity !== "thinking" ? s.activity : "Working"}
        <span className="tnum font-mono text-[11.5px] text-faint"> · {duration(now - s.stateSince)}</span>
      </p>
    </Gutter>
  );
}

export function Conversation({
  session: s,
  events,
  fresh,
  onClose,
  onLoadOlder,
}: {
  session: SessionView;
  /** All events the board holds, newest first. */
  events: HubEvent[];
  fresh: Set<string>;
  onClose: () => void;
  onLoadOlder: (before: number) => Promise<number>;
}) {
  const mine = useMemo(() => events.filter((e) => e.hubKey === s.hubKey).reverse(), [events, s.hubKey]);
  const items = useMemo(() => buildTranscript(mine), [mine]);
  const prs = useMemo(() => prLinks(mine), [mine]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** Distance from the bottom to restore after older items load above. */
  const anchor = useRef<number | null>(null);
  const [unseen, setUnseen] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const metadataOnly = s.share !== "conversation";
  const dim = s.offline || s.state === "ended";

  // A newly opened session starts at its latest item.
  useLayoutEffect(() => {
    atBottom.current = true;
    setUnseen(false);
    setExhausted(false);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.hubKey]);

  // Follow the bottom while the reader is there; otherwise offer a jump. Older items keep the reader's place.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    let last = inner.offsetHeight;
    const ro = new ResizeObserver(() => {
      const h = inner.offsetHeight;
      const grew = h > last;
      last = h;
      if (anchor.current != null) {
        el.scrollTop = el.scrollHeight - anchor.current;
        anchor.current = null;
      } else if (atBottom.current) el.scrollTop = el.scrollHeight;
      else if (grew) setUnseen(true);
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (atBottom.current) setUnseen(false);
  };

  const jump = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = true;
    setUnseen(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const loadOlder = async () => {
    const el = scroller.current;
    if (!el || loading) return;
    setLoading(true);
    anchor.current = el.scrollHeight - el.scrollTop;
    try {
      const n = await onLoadOlder(mine[0]?.ts ?? Date.now());
      if (n === 0) {
        anchor.current = null;
        setExhausted(true);
      }
    } finally {
      setLoading(false);
    }
  };

  const status =
    s.state === "waiting" && !dim
      ? (s.waitingReason ?? s.activity ?? "Needs input")
      : (currentNow(s) ?? (dim ? null : s.activity) ?? (s.offline ? "Offline" : s.state === "ended" ? "Ended" : null));

  return (
    <section aria-label={`Conversation: ${s.name ?? s.key}`} className="relative flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-line px-4 pb-3">
        <div className="flex h-10 items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <StateDot state={s.state} offline={s.offline} />
            <span className="truncate font-mono text-[13px] font-semibold text-fg">{s.name ?? s.key}</span>
            {s.source !== "claude-code" && <span className="shrink-0 font-mono text-[11px] text-faint">{s.source}</span>}
            {s.agents != null && s.agents > 1 && <span className="tnum shrink-0 font-mono text-[11px] text-muted">{s.agents} agents</span>}
          </span>
          <Button variant="ghost" className="-mr-2 h-7 px-2 text-[12px] max-sm:h-9" onClick={onClose} aria-label="Close conversation, show all sessions">
            <IconClose />
            All
          </Button>
        </div>
        <p className="truncate text-[12px] text-muted">
          {s.person}
          {s.machine && <span className="text-faint"> · {s.machine}</span>}
          {s.repo && <span className="text-faint" title={s.repo}> · {repoName(s.repo)}</span>}
          {s.branch && <span className="font-mono text-[11.5px] text-faint"> · {s.branch}</span>}
        </p>
        {status && (
          <p
            className={cx(
              "mt-2 text-[14px] leading-snug font-medium tracking-[-0.005em]",
              s.state === "waiting" && !dim ? "text-warn-text" : dim ? "text-muted" : "text-fg",
            )}
          >
            {status}
          </p>
        )}
        {s.state === "waiting" && !dim && currentNow(s) && s.waitingReason && (
          <p className="mt-0.5 text-[12.5px] text-muted">{currentNow(s)}</p>
        )}
        {(s.issues.length > 0 || prs.length > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {s.issues.map((id) => (
              <IssueChip key={id} id={id} />
            ))}
            {prs.map((url) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-[4px] border border-line px-1 py-px font-mono text-[11px] leading-[16px] text-accent transition-colors hover:border-accent"
              >
                PR {prNumber(url)}
              </a>
            ))}
          </div>
        )}
        {metadataOnly && (
          <p className="mt-2 text-[12px] text-faint">
            Activity only. {s.person} keeps prompts and messages on this machine.
          </p>
        )}
      </header>

      <div ref={scroller} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div ref={content} className="flex flex-col gap-3 px-4 pt-3 pb-6">
          {mine.length > 0 && !exhausted && mine[0]!.kind !== "start" && (
            <Button variant="ghost" className="-ml-2 self-start text-[12px]" disabled={loading} onClick={loadOlder}>
              Earlier
            </Button>
          )}
          {items.length === 0 && <p className="text-[13px] text-faint">Nothing yet. Prompts, messages and tool calls show up here as they happen.</p>}
          {items.map((item) => (
            <div key={item.key} className={cx(fresh.has(item.k === "tools" ? item.key.slice(6) : item.key) && "row-in")}>
              <ItemView item={item} person={s.person} />
            </div>
          ))}
          {s.state === "working" && !dim && <Working s={s} />}
        </div>
      </div>

      {unseen && (
        <button
          type="button"
          onClick={jump}
          className="menu-in absolute bottom-4 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-fg shadow-pop transition-colors hover:bg-hover max-sm:py-2.5"
        >
          New activity
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
            <path d="M8 3v10M4 9l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </section>
  );
}

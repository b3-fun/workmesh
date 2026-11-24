import { useState } from "react";
import type { HubEvent } from "../../shared/types";
import { MetaLine } from "../b3os/ds/kit/page-header";
import { Status } from "../b3os/ds/kit/status";
import { Working } from "../b3os/ds/kit/wait";
import { Icon } from "../b3os/ui/Icon";
import { turnDuration, type Item } from "../lib/transcript";
import { duration, useNow } from "../time";
import type { SessionView } from "../view";
import { Markdown } from "./Markdown";

// The conversation, modeled on Claude Code's transcript (SPEC.md §12), drawn on the console's tokens and kit pieces:
// prompts on a tint, the agent's messages beside a dot, each run of tool calls one line that opens to its calls, waits
// as a status, and a turn's end as its summary over a meta line.

const hmFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
export const hm = (ts: number) => hmFmt.format(new Date(ts));
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

export const prNumber = (url: string) => `#${url.split("/").pop()}`;

function Prompt({ e, person }: { e: HubEvent; person: string }) {
  const [open, setOpen] = useState(false);
  if (!e.text) {
    return (
      <p className="bp-mark">
        {person} sent a prompt · {hm(e.ts)}
      </p>
    );
  }
  const long = e.text.length > 600 || e.text.split("\n").length > 8;
  return (
    <div className="bp-prompt">
      <div className="bp-prompt__head">
        <span className="bp-prompt__who">{person}</span>
        <time className="bp-prompt__time">{hm(e.ts)}</time>
      </div>
      <p className="bp-prompt__text" data-clamped={long && !open ? "" : undefined}>
        {e.text}
      </p>
      {long || e.truncated ? (
        <p className="bp-prompt__foot">
          {long ? (
            <button type="button" className="kit-link" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Show less" : "Show all"}
            </button>
          ) : null}
          {e.truncated && (!long || open) ? <span>Cut at 4,000 characters</span> : null}
        </p>
      ) : null}
    </div>
  );
}

function Tools({ item }: { item: Extract<Item, { k: "tools" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bp-step" data-kind="tools">
      <span className="bp-step__dot" data-tone={item.failed ? "failed" : "quiet"} aria-hidden="true" />
      <div className="min-w-0">
        <button type="button" className="bp-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span>
            {item.label}
            {item.failed > 0 ? <span className="bp-fold__failed"> · {item.failed} failed</span> : null}
          </span>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={14} className="bp-fold__chev" />
        </button>
        {open ? (
          <ol className="bp-calls">
            {item.events.map((e) => (
              <li key={e.id} className="bp-calls__row">
                <span className="bp-calls__what">
                  <span className="bp-calls__tool">{toolName(e.tool)}</span>
                  {e.desc ? <span className="bp-calls__desc">{e.desc}</span> : null}
                  {e.path ? <span className="bp-calls__path">{e.path}</span> : e.cmd ? <span className="bp-calls__path">{e.cmd}</span> : null}
                  {e.pr ? (
                    <a href={e.pr} target="_blank" rel="noopener noreferrer" className="kit-link">
                      PR {prNumber(e.pr)}
                    </a>
                  ) : null}
                  {e.ok === false ? <span className="bp-calls__failed">failed</span> : null}
                </span>
                <time className="bp-calls__time">{clockFmt.format(new Date(e.ts))}</time>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </div>
  );
}

function ItemView({ item, person }: { item: Item; person: string }) {
  switch (item.k) {
    case "prompt":
      return <Prompt e={item.e} person={person} />;
    case "message":
      return (
        <div className="bp-step">
          <span className="bp-step__dot" aria-hidden="true" />
          <Markdown text={item.e.text ?? ""} />
        </div>
      );
    case "tools":
      return <Tools item={item} />;
    case "waiting":
      return (
        <div className="bp-step">
          <span className="bp-step__gap" aria-hidden="true" />
          <Status tone="warn">
            Waiting on {person}
            {item.e.label ? ` · ${item.e.label}` : ""}
          </Status>
        </div>
      );
    case "turn":
      return (
        <div className="bp-turn">
          {item.e.summary ? <p className="bp-turn__summary">{item.e.summary}</p> : null}
          <MetaLine
            items={[item.e.durationMs != null ? `Worked for ${turnDuration(item.e.durationMs)}` : "Turn ended", hm(item.e.ts)]}
          />
        </div>
      );
    case "mark":
      return (
        <p className="bp-mark">
          {item.text} · {hm(item.e.ts)}
        </p>
      );
  }
}

/** The pixel loader and what the agent is doing, while it works (the kit's Working: "a model thinking"). */
function WorkingLine({ s }: { s: SessionView }) {
  const now = useNow();
  return (
    <div className="bp-step">
      <span className="bp-step__gap" aria-hidden="true" />
      <Working counter={` · ${duration(now - s.stateSince)}`}>
        {s.activity && s.activity !== "thinking" ? s.activity : "Working"}
      </Working>
    </div>
  );
}

export function Transcript({
  items,
  session,
  fresh,
}: {
  items: Item[];
  session: SessionView;
  fresh: Set<string>;
}) {
  const live = session.state === "working" && !session.offline;
  return (
    <div className="bp-transcript">
      {items.map((item) => (
        <div key={item.key} className={fresh.has(item.k === "tools" ? item.key.slice(6) : item.key) ? "bp-in" : undefined}>
          <ItemView item={item} person={session.person} />
        </div>
      ))}
      {live ? <WorkingLine s={session} /> : null}
    </div>
  );
}

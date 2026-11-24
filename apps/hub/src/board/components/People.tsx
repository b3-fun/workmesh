import { Collapsible } from "radix-ui";
import { useState } from "react";
import { age, useNow } from "../time";
import { repoName, type Lane, type SessionView } from "../view";
import { Age, IconChevron, IssueChip, Row, StateDot, cx } from "./ui";

function SessionRow({
  s,
  selected,
  fresh,
  onSelect,
}: {
  s: SessionView;
  selected: boolean;
  fresh: boolean;
  onSelect: (hubKey: string) => void;
}) {
  const dim = s.offline || s.state === "ended";
  const waiting = s.state === "waiting" && !dim;
  const activity = s.offline ? "offline" : s.state === "ended" ? "ended" : (s.activity ?? s.state);
  // The summary leads; the relay's live label stays as a trace beside the branch (SPEC.md §12).
  const lead = waiting ? (s.waitingReason ?? s.nowLine ?? activity) : (s.nowLine ?? activity);
  const trace = lead !== activity ? activity : null;
  return (
    <Row
      onActivate={() => onSelect(s.hubKey)}
      pressed={selected}
      label={`${s.name ?? s.key}, ${lead}`}
      className={cx(
        "relative grid grid-cols-[7px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-md px-3 py-2 transition-colors",
        selected ? "bg-accent-soft" : "hover:bg-hover",
        dim && "opacity-60",
        fresh && "row-in",
      )}
    >
      {selected && <span aria-hidden className="absolute top-2 bottom-2 left-0 w-[2px] rounded-r bg-accent" />}
      <StateDot state={s.state} offline={s.offline} />
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-mono text-[12.5px] font-medium text-fg">{s.name ?? s.key}</span>
        {s.source !== "claude-code" && <span className="shrink-0 font-mono text-[11px] text-faint">{s.source}</span>}
        {s.agents != null && s.agents > 1 && (
          <span className="tnum shrink-0 font-mono text-[11px] text-muted">{s.agents} agents</span>
        )}
        {s.phase && <span className="truncate font-mono text-[11px] text-faint">{s.phase}</span>}
      </span>
      <Age ts={s.state === "ended" ? (s.endedAt ?? s.lastEventAt) : (s.lastEventAt ?? s.updatedAt)} className="text-[11.5px] text-faint" />
      <span className={cx("col-start-2 col-end-4 line-clamp-2 min-w-0 text-[13px] leading-[1.45]", waiting ? "text-warn-text" : "text-text")}>
        {lead}
        {s.background && !dim && <span className="text-faint"> · background</span>}
      </span>
      {(trace || s.branch || s.issues.length > 0) && (
        <span className="col-start-2 col-end-4 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-0.5">
          {trace && <span className="max-w-[14rem] truncate font-mono text-[11.5px] text-muted">{trace}</span>}
          {s.branch && (
            <span className="max-w-[16rem] truncate font-mono text-[11.5px] text-faint" title={s.branch}>
              {s.branch}
            </span>
          )}
          {s.issues.map((id) => (
            <IssueChip key={id} id={id} />
          ))}
        </span>
      )}
    </Row>
  );
}

function LaneHeader({ lane }: { lane: Lane }) {
  const now = useNow();
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 pb-1">
      <div className="flex min-w-0 items-baseline gap-2">
        <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-fg">{lane.person.name}</h3>
        {lane.isMe && <span className="text-[12px] text-faint">you</span>}
        {lane.activityOnly && (
          <span className="text-[12px] text-faint" title="Shares tool activity only: no prompts or messages">
            activity only
          </span>
        )}
        {!lane.online && (
          <span className="truncate text-[12px] text-faint">
            offline{lane.lastSeenAt ? <span className="tnum font-mono"> · {age(now - lane.lastSeenAt)}</span> : null}
          </span>
        )}
      </div>
      {(lane.working > 0 || lane.waiting > 0) && (
        <div className="tnum flex shrink-0 gap-3 font-mono text-[11.5px] text-muted">
          {lane.working > 0 && <span>{lane.working} working</span>}
          {lane.waiting > 0 && <span className="text-warn-text">{lane.waiting} waiting</span>}
        </div>
      )}
    </div>
  );
}

function LaneView({
  lane,
  selected,
  fresh,
  onSelect,
}: {
  lane: Lane;
  selected: string | null;
  fresh: Set<string>;
  onSelect: (hubKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const activeCount = lane.groups.reduce((n, g) => n + g.sessions.length, 0);
  return (
    <section aria-label={lane.person.name} className="border-t border-line pt-4 pb-3 first:border-t-0">
      <LaneHeader lane={lane} />
      {activeCount === 0 && (
        <p className="px-3 pt-1 pb-1 text-[13px] text-faint">
          {lane.devices.length === 0 ? "No machine connected." : "No open sessions."}
        </p>
      )}
      {lane.groups.map((g) => (
        <div key={g.repo ?? "-"} className="mt-2">
          <div className="px-3 pb-0.5 font-mono text-[11px] text-faint" title={g.repo ?? undefined}>
            {repoName(g.repo)}
          </div>
          {g.sessions.map((s) => (
            <SessionRow
              key={s.hubKey}
              s={s}
              selected={selected === s.hubKey}
              fresh={fresh.has(s.hubKey)}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}
      {lane.dormant.length > 0 && (
        <Collapsible.Root open={open} onOpenChange={setOpen} className="mt-2">
          <Collapsible.Trigger className="flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] text-faint transition-colors hover:text-muted max-sm:py-2.5">
            <IconChevron open={open} />
            <span className="tnum">
              {lane.dormant.length} ended or offline
            </span>
          </Collapsible.Trigger>
          <Collapsible.Content>
            {lane.dormant.map((s) => (
              <SessionRow key={s.hubKey} s={s} selected={selected === s.hubKey} fresh={false} onSelect={onSelect} />
            ))}
          </Collapsible.Content>
        </Collapsible.Root>
      )}
    </section>
  );
}

export function People({
  lanes,
  selected,
  fresh,
  onSelect,
}: {
  lanes: Lane[];
  selected: string | null;
  fresh: Set<string>;
  onSelect: (hubKey: string) => void;
}) {
  return (
    <div className="px-1 pb-6">
      {lanes.map((lane) => (
        <LaneView key={lane.person.email} lane={lane} selected={selected} fresh={fresh} onSelect={onSelect} />
      ))}
    </div>
  );
}

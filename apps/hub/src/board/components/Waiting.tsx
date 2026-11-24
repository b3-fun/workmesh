import { duration, useNow } from "../time";
import { repoName, type SessionView } from "../view";
import { ColumnHeader, IssueChip, Row, cx } from "./ui";

function WaitedFor({ since }: { since: number }) {
  const now = useNow();
  return <span className="tnum font-mono text-[12px] text-warn-text">{duration(now - since)}</span>;
}

export function Waiting({
  sessions,
  meEmail,
  selected,
  onSelect,
}: {
  sessions: SessionView[];
  meEmail: string;
  selected: string | null;
  onSelect: (hubKey: string) => void;
}) {
  return (
    <section aria-label="Waiting on a person" className="flex min-h-0 flex-col">
      <ColumnHeader title="Waiting on a person" count={sessions.length} />
      {sessions.length === 0 ? (
        <p className="px-4 pt-1 pb-6 text-[13px] text-faint">Nobody is waiting.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          {sessions.map((s) => {
            const mine = s.email === meEmail;
            return (
              <li key={s.hubKey} className="border-t border-line first:border-t-0">
                <Row
                  onActivate={() => onSelect(s.hubKey)}
                  pressed={selected === s.hubKey}
                  className={cx(
                    "relative flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-hover",
                    selected === s.hubKey && "bg-accent-soft hover:bg-accent-soft",
                  )}
                >
                  {mine && <span aria-hidden className="absolute top-3 bottom-3 left-0 w-[2px] rounded-r bg-warn" />}
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-[13px]">
                      <span className="font-semibold text-fg">{mine ? "You" : s.person}</span>
                      <span className="text-faint"> · </span>
                      <span className="font-mono text-[12px] text-text">{s.name ?? s.key}</span>
                    </span>
                    <WaitedFor since={s.stateSince} />
                  </span>
                  <span className="text-[13px] text-text">{s.activity ?? "Needs input"}</span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11.5px] text-faint">
                    <span title={s.repo ?? undefined}>{repoName(s.repo)}</span>
                    {s.branch && <span className="max-w-[12rem] truncate">{s.branch}</span>}
                    {s.issues.map((id) => (
                      <IssueChip key={id} id={id} />
                    ))}
                  </span>
                </Row>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

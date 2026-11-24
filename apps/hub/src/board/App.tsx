import { useCallback, useEffect, useMemo, useState } from "react";
import { displayName } from "../shared/types";
import { ConnectDialog } from "./components/ConnectDialog";
import { Conversation } from "./components/Conversation";
import { DigestStrip } from "./components/Digest";
import { EmptyState } from "./components/EmptyState";
import { LiveTail } from "./components/LiveTail";
import { PairPage } from "./components/PairPage";
import { People } from "./components/People";
import { TopBar } from "./components/TopBar";
import { Waiting } from "./components/Waiting";
import { Button, ColumnHeader, cx } from "./components/ui";
import { useBoard } from "./store";
import { useNow } from "./time";
import { derive } from "./view";

function Centered({ title, body, action }: { title: string; body?: string; action?: () => void }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface px-4">
      <div className="max-w-[24rem] text-center">
        <h1 className="text-[17px] font-semibold text-fg">{title}</h1>
        {body && <p className="mt-1.5 text-[13.5px] text-muted">{body}</p>}
        {action && (
          <Button variant="primary" className="mt-5" onClick={action}>
            Reload
          </Button>
        )}
      </div>
    </div>
  );
}

function Board() {
  const { model, conn, signedOut, loadError, loadHistory } = useBoard();
  const [selected, setSelected] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const now = useNow();
  const view = useMemo(() => (model ? derive(model, now) : null), [model, now]);

  const waitingCount = view?.waiting.length ?? 0;
  useEffect(() => {
    document.title = waitingCount > 0 ? `${waitingCount} waiting · Bullpen` : "Bullpen";
  }, [waitingCount]);

  const nameOf = useCallback(
    (email: string) => model?.people.find((p) => p.email === email)?.name ?? displayName(email),
    [model?.people],
  );

  const select = useCallback(
    (hubKey: string) => {
      setSelected((cur) => (cur === hubKey ? null : hubKey));
      void loadHistory(hubKey).catch(() => undefined);
      if (window.matchMedia("(max-width: 63.99rem)").matches) {
        requestAnimationFrame(() => document.getElementById("tail")?.scrollIntoView({ behavior: "smooth", block: "start" }));
      }
    },
    [loadHistory],
  );

  if (signedOut) return <Centered title="Sign in again" body="Your session expired." action={() => location.reload()} />;
  if (!model || !view) {
    return loadError ? (
      <Centered title="Can't reach the hub" body="Retrying in the background." action={() => location.reload()} />
    ) : (
      <div className="min-h-dvh bg-surface" />
    );
  }

  const selectedView = selected ? (view.sessions[selected] ?? null) : null;

  return (
    <div className="flex min-h-dvh flex-col bg-surface lg:h-dvh">
      <TopBar
        projectName={model.project.name}
        me={model.me}
        conn={conn}
        agentsWorking={view.agentsWorking}
        waiting={view.waiting.length}
        peopleOnline={view.peopleOnline}
        onConnect={() => setConnectOpen(true)}
      />
      <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
      <DigestStrip digest={model.digest} />
      {!view.hasDevices ? (
        <EmptyState />
      ) : (
        <main
          className={cx(
            "grid min-h-0 flex-1 max-lg:divide-y max-lg:divide-line",
            // A selected session's conversation needs reading width; the lanes give some up.
            selectedView
              ? "lg:grid-cols-[minmax(15rem,18rem)_minmax(0,1fr)_minmax(26rem,1.15fr)]"
              : "lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)_minmax(20rem,26.5rem)]",
          )}
        >
          <div className="flex min-h-0 flex-col lg:border-r lg:border-line">
            <Waiting sessions={view.waiting} meEmail={model.me.email} selected={selected} onSelect={select} />
          </div>
          <div className="flex min-h-0 flex-col">
            <ColumnHeader title="People" count={view.lanes.length} />
            <div className="min-h-0 flex-1 lg:overflow-y-auto scroll-thin">
              <People lanes={view.lanes} selected={selected} fresh={model.fresh} onSelect={select} />
            </div>
          </div>
          <div id="tail" className="flex min-h-0 flex-col max-lg:h-[85dvh] lg:border-l lg:border-line">
            {selectedView ? (
              <Conversation
                key={selectedView.hubKey}
                session={selectedView}
                events={model.events}
                fresh={model.fresh}
                onClose={() => setSelected(null)}
                onLoadOlder={(before) => loadHistory(selectedView.hubKey, before)}
              />
            ) : (
              <LiveTail
                events={model.events}
                fresh={model.fresh}
                selected={null}
                sessions={view.sessions}
                nameOf={nameOf}
                onSelect={(hubKey) => hubKey !== selected && select(hubKey)}
                onClear={() => setSelected(null)}
                onLoadOlder={() => Promise.resolve(0)}
              />
            )}
          </div>
        </main>
      )}
      <footer className="flex h-8 shrink-0 items-center border-t border-line bg-surface px-4 text-[11.5px] text-faint">
        {model.summarizer ? `Summaries by ${model.summarizer}` : "Summaries off"}
      </footer>
    </div>
  );
}

export function App() {
  return location.pathname === "/pair" ? <PairPage /> : <Board />;
}

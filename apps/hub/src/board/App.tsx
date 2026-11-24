import { useCallback, useEffect, useMemo, useState } from "react";
import { displayName } from "../shared/types";
import { ConnectDialog } from "./components/ConnectDialog";
import { EmptyState } from "./components/EmptyState";
import { LiveTail } from "./components/LiveTail";
import { PairPage } from "./components/PairPage";
import { People } from "./components/People";
import { TopBar } from "./components/TopBar";
import { Waiting } from "./components/Waiting";
import { Button, ColumnHeader } from "./components/ui";
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
      {!view.hasDevices ? (
        <EmptyState />
      ) : (
        <main className="grid min-h-0 flex-1 max-lg:divide-y max-lg:divide-line lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)_minmax(20rem,26.5rem)]">
          <div className="flex min-h-0 flex-col lg:border-r lg:border-line">
            <Waiting sessions={view.waiting} meEmail={model.me.email} selected={selected} onSelect={select} />
          </div>
          <div className="flex min-h-0 flex-col">
            <ColumnHeader title="People" count={view.lanes.length} />
            <div className="min-h-0 flex-1 lg:overflow-y-auto scroll-thin">
              <People lanes={view.lanes} selected={selected} fresh={model.fresh} onSelect={select} />
            </div>
          </div>
          <div id="tail" className="flex min-h-0 flex-col max-lg:max-h-[80dvh] lg:border-l lg:border-line">
            <LiveTail
              events={model.events}
              fresh={model.fresh}
              selected={selectedView}
              sessions={view.sessions}
              nameOf={nameOf}
              onSelect={(hubKey) => hubKey !== selected && select(hubKey)}
              onClear={() => setSelected(null)}
              onLoadOlder={(before) => (selected ? loadHistory(selected, before) : Promise.resolve(0))}
            />
          </div>
        </main>
      )}
    </div>
  );
}

export function App() {
  return location.pathname === "/pair" ? <PairPage /> : <Board />;
}

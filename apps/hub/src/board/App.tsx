import { type ReactNode, useEffect } from "react";
import { Link, Route, Switch } from "wouter";
import { EmptyState } from "./b3os/ds/kit/empty-state";
import { PageHeaderView } from "./b3os/ds/kit/page-header";
import { ButtonLink } from "./b3os/app/ui/primitives";
import { BoardProvider, useBoardData } from "./board-context";
import { BoardPage } from "./pages/Board";
import { MachinesPage } from "./pages/Machines";
import { PairPage } from "./pages/Pair";
import { SessionPage } from "./pages/Session";
import { Shell } from "./shell/Shell";

/** The browser tab: the page's name, then Workmesh; the board leads with how many wait on a person. */
function useTitle(name: string) {
  const { view } = useBoardData();
  const waiting = view?.waiting.length ?? 0;
  useEffect(() => {
    document.title = `${waiting > 0 ? `${waiting} waiting · ` : ""}${name} · Workmesh`;
  }, [name, waiting]);
}

function Titled({ name, children }: { name: string; children: ReactNode }) {
  useTitle(name);
  return <>{children}</>;
}

function NotFound() {
  return (
    <>
      <PageHeaderView title="No page here" />
      <EmptyState
        kind="none"
        title="Nothing at this address"
        action={
          <ButtonLink linkAs={Link} href="/" variant="neutral">
            Back to the board
          </ButtonLink>
        }
      />
    </>
  );
}

export function App() {
  return (
    <Switch>
      <Route path="/pair">
        <PairPage />
      </Route>
      <Route>
        <BoardProvider>
          <Shell>
            <Switch>
              <Route path="/sessions/:key">
                {(p) => (
                  <Titled name="Session">
                    <SessionPage hubKey={decodeURIComponent(p.key)} />
                  </Titled>
                )}
              </Route>
              <Route path="/machines">
                <Titled name="Machines">
                  <MachinesPage />
                </Titled>
              </Route>
              <Route path="/">
                <Titled name="Board">
                  <BoardPage />
                </Titled>
              </Route>
              <Route>
                <Titled name="No page here">
                  <NotFound />
                </Titled>
              </Route>
            </Switch>
          </Shell>
        </BoardProvider>
      </Route>
    </Switch>
  );
}

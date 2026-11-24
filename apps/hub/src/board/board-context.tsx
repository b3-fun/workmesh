import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { displayName } from "../shared/types";
import { useBoard } from "./store";
import { useNow } from "./time";
import { derive, type BoardView } from "./view";

type Board = ReturnType<typeof useBoard> & {
  view: BoardView | null;
  nameOf: (email: string) => string;
  /** The connect dialog, opened from the sidebar, the empty state and Machines. */
  connectOpen: boolean;
  setConnectOpen: (open: boolean) => void;
};

const Ctx = createContext<Board | null>(null);

/** One board read and one socket for every page of the shell. */
export function BoardProvider({ children }: { children: ReactNode }) {
  const board = useBoard();
  const now = useNow();
  const view = useMemo(() => (board.model ? derive(board.model, now) : null), [board.model, now]);
  const people = board.model?.people;
  const nameOf = useCallback(
    (email: string) => people?.find((p) => p.email === email)?.name ?? displayName(email),
    [people],
  );
  const [connectOpen, setConnectOpen] = useState(false);
  return <Ctx.Provider value={{ ...board, view, nameOf, connectOpen, setConnectOpen }}>{children}</Ctx.Provider>;
}

export function useBoardData(): Board {
  const b = useContext(Ctx);
  if (!b) throw new Error("useBoardData outside BoardProvider");
  return b;
}

// vaul, the phone's bottom sheet, loaded only where a phone draws a sheet (perf audit 11-23: 8.4 KiB gzipped in every
// page with a drawer or a dialog, on a desktop too). A drawer or dialog that mounts on a phone starts the load at once,
// closed, so the sheet is there when a row or a button opens it; a sheet asked for before it arrives shows when it does.
import { useEffect, useState } from "react";

type Vaul = typeof import("vaul")["Drawer"];

let loaded: Vaul | null = null;
let pending: Promise<Vaul> | null = null;

export function loadVaul(): Promise<Vaul> {
  pending ??= import("vaul").then((m) => {
    loaded = m.Drawer;
    return m.Drawer;
  });
  return pending;
}

/** vaul once loaded (it starts loading when `want` is first true), else null. */
export function useVaul(want: boolean): Vaul | null {
  const [vaul, setVaul] = useState<Vaul | null>(loaded);
  useEffect(() => {
    if (!want || vaul) return;
    let live = true;
    void loadVaul().then((v) => {
      if (live) setVaul(v);
    });
    return () => {
      live = false;
    };
  }, [want, vaul]);
  return vaul ?? loaded;
}

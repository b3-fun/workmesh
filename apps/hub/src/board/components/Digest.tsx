import { useEffect, useState } from "react";
import type { Digest } from "../../shared/types";
import { age, useNow } from "../time";
import { Button, IconClose } from "./ui";

const KEY = "bullpen-digest-dismissed";

function dismissed(builtAt: number): boolean {
  try {
    return localStorage.getItem(KEY) === String(builtAt);
  } catch {
    return false;
  }
}

/** "Since you looked": what finished while the viewer was away (SPEC.md §11, §12). Dismissible. */
export function DigestStrip({ digest }: { digest: Digest | null }) {
  const now = useNow();
  const [hidden, setHidden] = useState(() => (digest ? dismissed(digest.builtAt) : true));
  useEffect(() => setHidden(digest ? dismissed(digest.builtAt) : true), [digest]);
  if (!digest || hidden || digest.lines.length === 0) return null;
  return (
    <section aria-label="Since you looked" className="row-in relative shrink-0 border-b border-line bg-surface">
      <span aria-hidden className="absolute top-3 bottom-3 left-0 w-[2px] rounded-r bg-accent" />
      <div className="flex items-start gap-3 py-2.5 pr-2 pl-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[12px] font-semibold text-muted">
            Since you looked <span className="tnum font-mono text-[11px] font-normal text-faint">{age(now - digest.since)} ago</span>
          </h2>
          <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4 text-[13.5px] leading-[1.5] text-text marker:text-faint">
            {digest.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </div>
        <Button
          variant="ghost"
          className="h-7 w-7 px-0! max-sm:h-10 max-sm:w-10"
          aria-label="Dismiss"
          onClick={() => {
            setHidden(true);
            try {
              localStorage.setItem(KEY, String(digest.builtAt));
            } catch {
              // storage blocked: hidden for this page view only
            }
          }}
        >
          <IconClose />
        </Button>
      </div>
    </section>
  );
}

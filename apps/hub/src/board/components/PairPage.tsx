import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { PairInfo, Person } from "../../shared/types";
import { ApiError, SignedOut, api } from "../api";
import { useNow } from "../time";
import { SharingNote } from "./ConnectDialog";
import { Button } from "./ui";

type Phase =
  | { k: "enter"; error?: string }
  | { k: "loading" }
  | { k: "ready"; info: PairInfo }
  | { k: "done"; machine: string }
  | { k: "taken"; info: PairInfo }
  | { k: "expired" }
  | { k: "signedout" }
  | { k: "error"; message: string };

const CODE_RE = /^[A-Z]{4}-\d{4}$/;

function normalize(raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : raw.toUpperCase().trim();
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <header className="flex h-14 items-center gap-2 border-b border-line px-4">
        <a href="/" className="flex items-baseline gap-2">
          <span className="text-[15px] font-bold tracking-[-0.01em] text-fg">B3</span>
          <span className="text-[13px] text-faint">Bullpen</span>
        </a>
      </header>
      <main className="flex flex-1 justify-center px-4 pt-[12vh] pb-16">
        <div className="w-full max-w-[27rem]">{children}</div>
      </main>
    </div>
  );
}

function Countdown({ until }: { until: number }) {
  const now = useNow();
  const left = Math.max(0, Math.floor((until - now) / 1000));
  return (
    <span className="tnum font-mono">
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    </span>
  );
}

export function PairPage() {
  const initial = normalize(new URLSearchParams(location.search).get("code") ?? "");
  const [phase, setPhase] = useState<Phase>(CODE_RE.test(initial) ? { k: "loading" } : { k: "enter" });
  const [me, setMe] = useState<Person | null>(null);
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const now = useNow();

  const lookup = async (code: string) => {
    setPhase({ k: "loading" });
    try {
      const [info, who] = await Promise.all([api.pairInfo(code), me ? Promise.resolve(me) : api.me()]);
      setMe(who);
      if (info.status === "expired") setPhase({ k: "expired" });
      else if (info.status === "approved") {
        setPhase(info.approvedBy === who.email ? { k: "done", machine: info.machine } : { k: "taken", info });
      } else setPhase({ k: "ready", info });
    } catch (err) {
      if (err instanceof SignedOut) setPhase({ k: "signedout" });
      else if (err instanceof ApiError && err.status === 404) setPhase({ k: "enter", error: "No pairing with that code." });
      else setPhase({ k: "error", message: "Couldn't reach the hub. Try again." });
    }
  };

  useEffect(() => {
    if (CODE_RE.test(initial)) void lookup(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A pending code that runs out while the page is open.
  useEffect(() => {
    if (phase.k === "ready" && now > phase.info.expiresAt) setPhase({ k: "expired" });
  }, [now, phase]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const code = normalize(draft);
    if (!CODE_RE.test(code)) {
      setPhase({ k: "enter", error: "Codes look like ABCD-1234." });
      return;
    }
    history.replaceState(null, "", `/pair?code=${code}`);
    void lookup(code);
  };

  if (phase.k === "loading") return <Shell>{null}</Shell>;

  if (phase.k === "signedout") {
    return (
      <Shell>
        <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-fg">Sign in again</h1>
        <p className="mt-2 text-[14px] text-muted">Your session expired.</p>
        <Button variant="primary" className="mt-6" onClick={() => location.reload()}>
          Reload
        </Button>
      </Shell>
    );
  }

  if (phase.k === "ready") {
    const { info } = phase;
    return (
      <Shell>
        <h1 className="text-[20px] leading-snug font-semibold tracking-[-0.02em] text-fg">
          Connect <span className="font-mono text-[18px] font-medium">{info.machine}</span> to B3 as {me?.name}?
        </h1>
        <div className="mt-6 border-y border-line py-5">
          <div className="font-mono text-[28px] font-medium tracking-[0.12em] text-fg">{info.code}</div>
          <p className="mt-1 text-[13px] text-muted">Approve only if your terminal shows this code.</p>
        </div>
        <p className="mt-3 text-[12px] text-faint">
          <span className="font-mono">{info.client}</span> · expires in <Countdown until={info.expiresAt} />
        </p>
        <div className="mt-6 flex gap-2">
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.approve(info.code);
                setPhase({ k: "done", machine: r.machine });
              } catch (err) {
                if (err instanceof ApiError && err.status === 410) setPhase({ k: "expired" });
                else if (err instanceof ApiError && err.status === 409) setPhase({ k: "taken", info });
                else if (err instanceof SignedOut) setPhase({ k: "signedout" });
                else setPhase({ k: "error", message: "Approval failed. Try again." });
              } finally {
                setBusy(false);
              }
            }}
          >
            Approve
          </Button>
          <Button variant="secondary" onClick={() => location.assign("/")}>
            Cancel
          </Button>
        </div>
        <div className="mt-8">
          <SharingNote />
        </div>
      </Shell>
    );
  }

  if (phase.k === "done") {
    return (
      <Shell>
        <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-fg">Connected</h1>
        <p className="mt-2 text-[14px] text-muted">
          <span className="font-mono text-[13px] text-text">{phase.machine}</span> now shares its B3 sessions. The
          terminal finishes on its own.
        </p>
        <Button variant="primary" className="mt-6" onClick={() => location.assign("/")}>
          Open the board
        </Button>
      </Shell>
    );
  }

  if (phase.k === "taken") {
    return (
      <Shell>
        <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-fg">Already approved</h1>
        <p className="mt-2 text-[14px] text-muted">Someone else approved this code. Start a new one in your terminal.</p>
      </Shell>
    );
  }

  if (phase.k === "expired") {
    return (
      <Shell>
        <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-fg">This code expired</h1>
        <p className="mt-2 text-[14px] text-muted">
          Run <span className="font-mono text-[13px] text-text">agentblip hub connect</span> again for a new one.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-fg">Connect a machine</h1>
      <p className="mt-2 text-[14px] text-muted">
        {phase.k === "error" ? phase.message : "Enter the code your terminal shows."}
      </p>
      <form onSubmit={submit} className="mt-6 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="ABCD-1234"
          aria-label="Pairing code"
          autoFocus
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          className="h-9 w-full min-w-0 rounded-md border border-line-strong bg-surface px-3 font-mono text-[15px] tracking-[0.08em] text-fg uppercase outline-none placeholder:text-faint focus:border-accent max-sm:h-11"
        />
        <Button type="submit" variant="primary" className="h-9 max-sm:h-11">
          Continue
        </Button>
      </form>
      {phase.k === "enter" && phase.error && <p className="mt-2 text-[13px] text-bad">{phase.error}</p>}
    </Shell>
  );
}

import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import type { PairInfo, Person } from "../../shared/types";
import { Bone, EaseHeight, Reveal } from "../b3os/ds/kit/skeleton";
import { AnimatedCheckmark } from "../b3os/ds/signature/animated-checkmark";
import { ThemeSwitch } from "../b3os/app/shell/ThemeSwitch";
import { AuthHead, AuthNote, AuthSection } from "../b3os/app/ui/AuthCard";
import { AuthBackground } from "../b3os/ds/layout/AuthBackground";
import { AuthCard as DsAuthCard } from "../b3os/ds/layout/AuthCard";
import { Button, Field, TextInput } from "../b3os/app/ui/primitives";
import { ApiError, SignedOut, api } from "../api";
import { useNow } from "../time";

// Approving a relay's pairing code (SPEC.md §3.1), as the console approves a CLI sign-in (b3os-beta
// apps/web/src/app/pages/Device.tsx @ 65e00f860): the auth card, the code large to hold beside the terminal's, the
// facts, then Approve.

const CODE_RE = /^[A-Z]{4}-\d{4}$/;
function normalize(raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : raw.toUpperCase().trim();
}

/**
 * The console's auth card (app/ui/AuthCard.tsx), composed from the same parts: the dashed card over its pointer
 * halftone on the dot grid, the body in one EaseHeight, the theme switch under it. Its line under the card names
 * the board's host, not the console's.
 */
function AuthCard({ children }: { children: ReactNode }) {
  return (
    <div className="auth-stage b3os-dotgrid">
      <AuthBackground />
      <main className="auth-column">
        <DsAuthCard hideClose entryAnimation={false} reach="container" size="md">
          <EaseHeight className="auth-body">{children}</EaseHeight>
        </DsAuthCard>
        <p className="mt-5 flex flex-wrap items-center justify-center gap-2 text-caption text-ink-3">
          <a href="/" className="inline-flex min-h-11 items-center hover:text-ink">
            {location.host}
          </a>
        </p>
        <div className="mt-1 flex justify-center">
          <ThemeSwitch />
        </div>
      </main>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The card's shape while the code is looked up: the code's block, the facts and the two buttons. */
function PairBones() {
  const line = (w: string, cls = "text-ui") => (
    <span className={`kit-bone-line ${cls}`}>
      <Bone className={`kit-bone--inline ${w}`} />
    </span>
  );
  return (
    <div className="grid gap-5" aria-hidden="true" data-kit-skeleton="">
      <div className="auth-code">
        <Bone className="auth-code__bone" />
        <span className="kit-bone-line auth-code__line">
          <Bone className="kit-bone--inline w-28" />
        </span>
      </div>
      <div className="grid gap-1.5">
        <dl className="auth-facts">
          {["w-40", "w-24", "w-44"].map((w) => (
            <div key={w}>
              <dt>{line("w-14")}</dt>
              <dd>{line(w)}</dd>
            </div>
          ))}
        </dl>
        {line("w-48", "text-caption")}
      </div>
      <div className="flex gap-2 max-sm:flex-col-reverse">
        <Bone className="auth-bone-button sm:flex-1" />
        <Bone className="auth-bone-button sm:flex-1" />
      </div>
    </div>
  );
}

const SHARES: Record<string, string> = {
  conversation: "Prompts, the agent's messages and tool activity",
  metadata: "Tool activity only",
};

function minutesLeft(until: number, now: number): string {
  const s = Math.max(0, Math.round((until - now) / 1000));
  return s >= 60 ? `in ${Math.ceil(s / 60)} min` : `in ${s} s`;
}

type Look =
  | { k: "enter"; error?: string }
  | { k: "reading"; code: string }
  | { k: "ready"; info: PairInfo }
  | { k: "done"; machine: string }
  | { k: "taken" }
  | { k: "expired" }
  | { k: "unknown"; code: string }
  | { k: "failed"; code: string; error: unknown }
  | { k: "signedout" };

export function PairPage() {
  const initial = normalize(new URLSearchParams(location.search).get("code") ?? "");
  const [look, setLook] = useState<Look>(CODE_RE.test(initial) ? { k: "reading", code: initial } : { k: "enter" });
  const [me, setMe] = useState<Person | null>(null);
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [approveError, setApproveError] = useState<unknown>(null);
  const inputId = useId();
  const decided = useRef<HTMLHeadingElement>(null);
  const now = useNow();

  useEffect(() => {
    document.title = "Connect a machine · Workmesh";
  }, []);

  const lookup = useCallback(async (code: string) => {
    setLook({ k: "reading", code });
    try {
      const [info, who] = await Promise.all([api.pairInfo(code), api.me()]);
      setMe(who);
      if (info.status === "expired") setLook({ k: "expired" });
      else if (info.status === "approved") setLook(info.approvedBy === who.email ? { k: "done", machine: info.machine } : { k: "taken" });
      else setLook({ k: "ready", info });
    } catch (error) {
      if (error instanceof SignedOut) setLook({ k: "signedout" });
      else if (error instanceof ApiError && error.status === 404) setLook({ k: "unknown", code });
      else setLook({ k: "failed", code, error });
    }
  }, []);

  useEffect(() => {
    if (CODE_RE.test(initial)) void lookup(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A pending code that runs out while the page is open.
  useEffect(() => {
    if (look.k === "ready" && now > look.info.expiresAt) setLook({ k: "expired" });
  }, [now, look]);

  useEffect(() => {
    if (look.k === "done" || look.k === "taken" || look.k === "expired") decided.current?.focus();
  }, [look.k]);

  const restart = () => {
    history.replaceState(null, "", "/pair");
    setDraft("");
    setLook({ k: "enter" });
  };

  const head =
    look.k === "done" ? (
      <AuthHead
        tone="ok"
        mark={<AnimatedCheckmark className="size-8" strokeWidth={3} color="var(--ds-green-500)" />}
        title="Connected"
        line="Go back to your terminal. It finishes on its own."
        titleRef={decided}
      />
    ) : look.k === "taken" ? (
      <AuthHead
        icon="closeCircle"
        tone="danger"
        title="Already approved"
        line="Someone else approved this code. Start a new one in your terminal."
        titleRef={decided}
      />
    ) : look.k === "expired" ? (
      <AuthHead
        icon="clock"
        title="This code expired"
        line={
          <>
            Run <code className="font-mono">workmesh hub connect</code> again for a new code.
          </>
        }
        titleRef={decided}
      />
    ) : look.k === "signedout" ? (
      <AuthHead icon="lock" title="Sign in again" line="Your session expired." />
    ) : (
      <AuthHead
        icon="terminal"
        title="Connect a machine"
        line={
          me ? (
            <>
              As <span className="font-medium text-ink">{me.email}</span>. Approve only a code your own terminal shows now.
            </>
          ) : (
            "Approve only a code your own terminal shows now."
          )
        }
      />
    );

  let body: ReactNode = null;
  if (look.k === "enter") {
    body = (
      <form
        className="grid gap-4"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          const code = normalize(draft);
          if (!CODE_RE.test(code)) return setLook({ k: "enter", error: "Codes look like ABCD-1234." });
          history.replaceState(null, "", `/pair?code=${code}`);
          void lookup(code);
        }}
      >
        <Field label="Code from your terminal" htmlFor={inputId} error={look.error ?? null}>
          <TextInput
            id={inputId}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (look.error) setLook({ k: "enter" });
            }}
            placeholder="ABCD-1234"
            className="auth-otp uppercase"
            autoFocus
          />
        </Field>
        <Button type="submit" variant="brand" size="lg" className="w-full">
          Continue
        </Button>
      </form>
    );
  } else if (look.k === "unknown") {
    body = (
      <div className="grid gap-4">
        <AuthNote title={`No pairing for ${look.code}`}>
          It's unknown or expired. Run <code className="font-mono">workmesh hub connect</code> again for a new code.
        </AuthNote>
        <Button variant="neutral" onClick={restart}>
          Enter a different code
        </Button>
      </div>
    );
  } else if (look.k === "failed") {
    body = (
      <div className="grid gap-4">
        <AuthNote
          error={look.error}
          title={`The code ${look.code} did not load`}
          action={
            <Button size="sm" variant="neutral" icon="refresh" onClick={() => void lookup(look.code)}>
              Retry
            </Button>
          }
        />
        <Button variant="ghost" onClick={restart}>
          Enter a different code
        </Button>
      </div>
    );
  } else if (look.k === "signedout") {
    body = (
      <Button variant="brand" size="lg" className="w-full" onClick={() => location.reload()}>
        Sign in
      </Button>
    );
  } else if (look.k === "ready") {
    const { info } = look;
    body = (
      <div className="grid gap-5">
        <div className="auth-code">
          <p className="auth-code__value">{info.code}</p>
          <p className="auth-code__line">Expires {minutesLeft(info.expiresAt, now)}</p>
        </div>
        <div className="grid gap-1.5">
          <dl className="auth-facts">
            <Row label="Machine">
              <span className="block truncate font-mono">{info.machine}</span>
            </Row>
            <Row label="Client">
              <span className="block truncate font-mono">{info.client}</span>
            </Row>
            <Row label="Shares">{info.share ? SHARES[info.share] : "Chosen in the terminal"}</Row>
          </dl>
          <p className="text-caption text-ink-3">Only sessions in b3-fun repos. Machine and client are self-reported.</p>
        </div>
        {approveError ? <AuthNote error={approveError} title="That did not go through" /> : null}
        <div className="flex gap-2 max-sm:flex-col-reverse">
          <Button variant="ghost" size="lg" className="sm:flex-1" onClick={() => location.assign("/")}>
            Cancel
          </Button>
          <Button
            variant="brand"
            size="lg"
            className="sm:flex-1"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setApproveError(null);
              try {
                const r = await api.approve(info.code);
                setLook({ k: "done", machine: r.machine });
              } catch (err) {
                if (err instanceof SignedOut) setLook({ k: "signedout" });
                else if (err instanceof ApiError && err.status === 410) setLook({ k: "expired" });
                else if (err instanceof ApiError && err.status === 409) setLook({ k: "taken" });
                else setApproveError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            Approve
          </Button>
        </div>
      </div>
    );
  } else if (look.k === "done") {
    body = (
      <div className="grid gap-4">
        <p className="text-ui text-ink-2">
          <span className="font-mono text-ink">{look.machine}</span> now shares its B3 sessions.
        </p>
        <Button variant="brand" size="lg" className="w-full" onClick={() => location.assign("/")}>
          Open the board
        </Button>
      </div>
    );
  } else if (look.k === "expired" || look.k === "taken") {
    body = (
      <Button variant="neutral" onClick={restart}>
        Enter a different code
      </Button>
    );
  }

  return (
    <AuthCard>
      <AuthSection>
        {head}
        <Reveal loading={look.k === "reading"} skeleton={<PairBones />}>
          {body}
        </Reveal>
      </AuthSection>
    </AuthCard>
  );
}

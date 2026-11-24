import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Note } from "../b3os/ds/kit/attention";
import { InlineError } from "../b3os/ds/kit/charts/frame";
import { CopyButton } from "../b3os/ds/kit/copy";
import { EmptyState } from "../b3os/ds/kit/empty-state";
import { PageHeaderView } from "../b3os/ds/kit/page-header";
import { PageReveal } from "../b3os/ds/kit/page-reveal";
import { SkeletonHeader, SkeletonRows } from "../b3os/ds/kit/skeleton";
import { Status } from "../b3os/ds/kit/status";
import { ButtonLink } from "../b3os/app/ui/primitives";
import { Icon } from "../b3os/ui/Icon";
import { ApiError } from "../api";
import { useBoardData } from "../board-context";
import { prNumber, Transcript } from "../components/Transcript";
import { buildTranscript, prLinks } from "../lib/transcript";
import { leadText, repoName, sessionLook } from "../view";
import { Link } from "wouter";

/** The page's shape while its history is read: the detail header and the transcript's rows. */
function SessionBones() {
  return (
    <>
      <SkeletonHeader back tile line meta actions={0} />
      <div data-page-slot="panel" className="bp-transcript-col">
        <SkeletonRows rows={6} />
      </div>
    </>
  );
}

const EMPTY = new Set<string>();

type Read = { state: "reading" } | { state: "done" } | { state: "failed"; error: unknown };

/**
 * A session's conversation as a console detail page: back to the board, the agent's mark on the tile, its state inline,
 * the now line under the name, its facts parted by pixel squares, then the transcript. It follows the newest item while
 * the reader is at the bottom; scrolled up, a button offers the way back down.
 */
export function SessionPage({ hubKey }: { hubKey: string }) {
  const { model, view, loadHistory } = useBoardData();
  const fresh = model?.fresh ?? EMPTY;
  const [read, setRead] = useState<Read>({ state: "reading" });
  const [retrying, setRetrying] = useState(false);
  const [earlier, setEarlier] = useState<"idle" | "busy" | "none">("idle");
  const readHistory = useCallback(async () => {
    try {
      await loadHistory(hubKey);
      setRead({ state: "done" });
    } catch (error) {
      setRead({ state: "failed", error });
    }
  }, [hubKey, loadHistory]);
  useEffect(() => {
    setRead({ state: "reading" });
    setEarlier("idle");
    void readHistory();
  }, [readHistory]);

  const s = view?.sessions[hubKey] ?? null;
  const events = model?.events;
  const mine = useMemo(() => (events ?? []).filter((e) => e.hubKey === hubKey).reverse(), [events, hubKey]);
  const items = useMemo(() => buildTranscript(mine), [mine]);
  const prs = useMemo(() => prLinks(mine), [mine]);

  // Follow the bottom while the reader is there; scrolled up, offer a jump instead.
  const body = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const landed = !!model && read.state !== "reading";
  useEffect(() => {
    const onScroll = () => {
      atBottom.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 64;
      if (atBottom.current) setUnseen(false);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = body.current;
    if (!el || !landed) return;
    // Land on the newest item.
    window.scrollTo({ top: document.documentElement.scrollHeight });
    let last = el.offsetHeight;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      const grew = h > last;
      last = h;
      if (atBottom.current) window.scrollTo({ top: document.documentElement.scrollHeight });
      else if (grew) setUnseen(true);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [landed, hubKey]);

  const missing = landed && !s;
  return (
    <PageReveal
      className="kit-page-floor"
      loading={!landed}
      resetKey={hubKey}
      failed={missing}
      skeleton={<SessionBones />}
    >
      {s ? (
        <>
          <PageHeaderView
            back={{ href: "/", label: "Board" }}
            tile={{ brand: s.source === "codex" ? "openai" : "anthropic" }}
            title={<span className="font-mono">{s.name ?? s.key}</span>}
            status={<Status status={sessionLook(s)} />}
            line={leadText(s)}
            meta={[
              s.machine ? `${s.person} on ${s.machine}` : s.person,
              s.repo ? repoName(s.repo) : null,
              s.branch ? <span className="font-mono">{s.branch}</span> : null,
              ...s.issues.map((id) => (
                <a key={id} href={`https://linear.app/npclabs/issue/${id}`} target="_blank" rel="noopener noreferrer" className="kit-link font-mono">
                  {id}
                </a>
              )),
              ...prs.map((url) => (
                <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="kit-link">
                  PR {prNumber(url)}
                </a>
              )),
            ]}
            actions={<CopyButton value={s.key} label={`Copy session id ${s.key}`} size="md" />}
          />
          <div className="bp-transcript-col" data-page-slot="panel" ref={body}>
            {s.share !== "conversation" ? (
              <Note>Activity only. {s.person} keeps prompts and messages on this machine.</Note>
            ) : null}
            {read.state === "failed" ? (
              <InlineError
                align="start"
                onRetry={() => {
                  setRetrying(true);
                  void readHistory().finally(() => setRetrying(false));
                }}
                retrying={retrying}
                requestId={read.error instanceof ApiError ? (read.error.requestId ?? undefined) : undefined}
                retryAfter={read.error instanceof ApiError ? (read.error.retryAfterS ?? undefined) : undefined}
                retryKey={read.error}
              >
                Earlier activity did not load
              </InlineError>
            ) : mine.length > 0 && mine[0]!.kind !== "start" && earlier !== "none" ? (
              <button
                type="button"
                className="kit-link bp-earlier"
                disabled={earlier === "busy"}
                onClick={async () => {
                  setEarlier("busy");
                  const n = await loadHistory(hubKey, mine[0]!.ts).catch(() => -1);
                  setEarlier(n === 0 ? "none" : "idle");
                }}
              >
                Earlier
              </button>
            ) : null}
            {items.length === 0 ? (
              <p className="home-quiet">Nothing yet. Prompts, messages and tool calls show here as they happen.</p>
            ) : (
              <Transcript items={items} session={s} fresh={fresh} />
            )}
          </div>
          {unseen ? (
            <button
              type="button"
              className="bp-jump kit-press"
              onClick={() => {
                atBottom.current = true;
                setUnseen(false);
                window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
              }}
            >
              New activity
              <Icon name="chevronDown" size={14} />
            </button>
          ) : null}
        </>
      ) : (
        <>
          <PageHeaderView back={{ href: "/", label: "Board" }} title="Session" />
          <EmptyState
            kind="none"
            title="No session here"
            body="It ended more than 12 hours ago, or its machine was disconnected."
            action={
              <ButtonLink linkAs={Link} href="/" variant="neutral">
                Back to the board
              </ButtonLink>
            }
          />
        </>
      )}
    </PageReveal>
  );
}

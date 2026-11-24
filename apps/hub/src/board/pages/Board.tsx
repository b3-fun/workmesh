import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import type { HubEvent } from "../../shared/types";
import { Attention, AttentionQuiet, SkeletonAttention } from "../b3os/ds/kit/attention";
import { Bone } from "../b3os/ds/kit/bone";
import { RowCard } from "../b3os/ds/kit/cards";
import { CopyButton } from "../b3os/ds/kit/copy";
import { EmptyState } from "../b3os/ds/kit/empty-state";
import { PageHeaderView } from "../b3os/ds/kit/page-header";
import { PageReveal } from "../b3os/ds/kit/page-reveal";
import { SkeletonFigures, SkeletonRows } from "../b3os/ds/kit/skeleton";
import { Status } from "../b3os/ds/kit/status";
import { Figure, FigureStrip, Ticker } from "../b3os/ds/kit/ticker";
import { Button } from "../b3os/app/ui/primitives";
import { ApiError } from "../api";
import { useBoardData } from "../board-context";
import { prNumber } from "../components/Transcript";
import { turnDuration } from "../lib/transcript";
import { age, clock, duration, useNow } from "../time";
import { type Lane, leadText, repoName, sessionLook, type SessionView } from "../view";

// The board, in the console Home's frame (b3os-beta apps/web/src/app/pages/home): the Attention line over the figures,
// then the sessions waiting on a person and each person's sessions beside what finished while you were away and the
// live activity (one column under 1280 px, in the same order). Each count is said once.

const href = (s: SessionView) => `/sessions/${encodeURIComponent(s.hubKey)}`;

const FIGURES = [
  { icon: "play" as const, label: "Agents working" },
  { icon: "terminal" as const, label: "Sessions open" },
  { icon: "user" as const, label: "People online" },
];

/** A section's heading row: its title (and a count) at the left, its action at the right. As Home's SecHead. */
function SecHead({ title, count, aside }: { title: ReactNode; count?: string | null; aside?: ReactNode }) {
  return (
    <div className="home-sec__head">
      <h2 className="home-sec__title">
        {title}
        {count ? <span className="home-sec__count">{count}</span> : null}
      </h2>
      {aside}
    </div>
  );
}

function SecHeadBone({ title = 112 }: { title?: number }) {
  return (
    <div className="home-sec__head">
      <span className="home-sec__title">
        <Bone className="kit-bone--inline" style={{ width: title }} />
      </span>
    </div>
  );
}

/** Row cards loading, in the row card's own frame (Home's RowBones). */
function RowBones({ rows }: { rows: number }) {
  return (
    <div className="home-rows" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="kit-row-card" aria-hidden="true">
          <span className="kit-row-card__link">
            <Bone className="kit-bone--tile-sm" />
            <span className="kit-row-card__main home-row-bone__main">
              <Bone className="kit-bone--line" style={{ width: `${46 + ((i * 17) % 28)}%` }} />
              <Bone className="kit-bone--text" style={{ width: `${58 + ((i * 13) % 30)}%` }} />
            </span>
          </span>
          <span className="kit-row-card__value">
            <Bone className="kit-bone--line ml-auto w-12" />
          </span>
          <span className="kit-row-card__actions" />
        </div>
      ))}
    </div>
  );
}

/** The board's first read, part for part (the header needs no read and is drawn at once). */
function BoardBones() {
  return (
    <div data-kit-skeleton="">
      <div className="home-stack">
        <div className="home-lead">
          <SkeletonAttention />
          <SkeletonFigures shapes={FIGURES.map((f) => ({ ...f, head: "shown" as const, sub: true }))} />
        </div>
        <div className="home-split">
          <section className="home-sec" aria-hidden="true" data-page-slot="panel">
            <SecHeadBone title={96} />
            <RowBones rows={4} />
          </section>
          <section className="home-sec" aria-hidden="true">
            <SecHeadBone title={72} />
            <SkeletonRows rows={6} meta={false} />
          </section>
        </div>
      </div>
    </div>
  );
}

function Waited({ since }: { since: number }) {
  const now = useNow();
  return <span className="tabular-nums">{duration(now - since)}</span>;
}

function Ago({ ts }: { ts: number | null }) {
  const now = useNow();
  return ts ? <span className="tabular-nums">{age(now - ts)}</span> : null;
}

/** One session as the console's row card: the agent's mark, its name and state, what it is doing and its facts. */
function SessionRow({ s, waiting = false, withPerson = false }: { s: SessionView; waiting?: boolean; withPerson?: boolean }) {
  return (
    <RowCard
      brand={s.source === "codex" ? "openai" : "anthropic"}
      brandMono
      title={s.name ?? s.key}
      status={<Status status={sessionLook(s)} />}
      meta={[
        <span key="lead" className="bp-row-lead">
          {leadText(s)}
        </span>,
        withPerson ? s.person : null,
        s.repo ? repoName(s.repo) : null,
        s.branch && !waiting ? <span className="font-mono">{s.branch}</span> : null,
        ...s.issues.map((id) => (
          <span key={id} className="font-mono">
            {id}
          </span>
        )),
      ]}
      value={
        waiting ? <Waited since={s.stateSince} /> : <Ago ts={s.state === "ended" ? (s.endedAt ?? s.lastEventAt) : (s.lastEventAt ?? s.updatedAt)} />
      }
      href={href(s)}
      actions={<CopyButton value={s.key} label={`Copy session id ${s.key}`} />}
    />
  );
}

function LaneSection({ lane }: { lane: Lane }) {
  const [open, setOpen] = useState(false);
  const active = lane.groups.flatMap((g) => g.sessions);
  return (
    <section className="home-sec" aria-label={lane.person.name}>
      <SecHead
        title={
          <>
            {lane.person.name}
            {lane.isMe ? <span className="bp-sec-note">you</span> : null}
            {!lane.online ? <span className="bp-sec-note">offline</span> : null}
          </>
        }
        count={active.length ? String(active.length) : null}
        aside={lane.activityOnly ? <span className="bp-sec-aside">Activity only</span> : null}
      />
      {active.length === 0 ? (
        <p className="home-quiet">{lane.devices.length === 0 ? "No machine connected." : "No open sessions."}</p>
      ) : (
        <div className="home-rows">
          {active.map((s) => (
            <SessionRow key={s.hubKey} s={s} />
          ))}
        </div>
      )}
      {lane.dormant.length > 0 ? (
        <>
          {open ? (
            <div className="home-rows bp-dormant">
              {lane.dormant.map((s) => (
                <SessionRow key={s.hubKey} s={s} />
              ))}
            </div>
          ) : null}
          <button type="button" className="home-more w-full" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide" : `${lane.dormant.length} ended or offline`}
          </button>
        </>
      ) : null}
    </section>
  );
}

const DISMISSED = "workmesh-digest-dismissed";

/** "Since you looked": what finished while the viewer was away (SPEC.md §11), said once as panel content. */
function SinceYouLooked() {
  const { model } = useBoardData();
  const digest = model?.digest ?? null;
  const now = useNow();
  const read = () => {
    try {
      return digest ? localStorage.getItem(DISMISSED) === String(digest.builtAt) : true;
    } catch {
      return false;
    }
  };
  const [hidden, setHidden] = useState(read);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new digest is a new question.
  useEffect(() => setHidden(read()), [digest?.builtAt]);
  if (!digest || hidden || !digest.lines.length) return null;
  return (
    <section className="home-sec" aria-label="Since you looked">
      <SecHead
        title="Since you looked"
        count={`${age(now - digest.since)} ago`}
        aside={
          <Button
            variant="link"
            size="sm"
            className="home-sec__link"
            onClick={() => {
              setHidden(true);
              try {
                localStorage.setItem(DISMISSED, String(digest.builtAt));
              } catch {
                // storage blocked: hidden for this page view only
              }
            }}
          >
            Dismiss
          </Button>
        }
      />
      <ul className="home-rows bp-digest">
        {digest.lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </section>
  );
}

const oneLine = (t: string) =>
  t
    .replace(/`+|\*\*|__/g, "")
    .replace(/^[\s#>*-]+/, "")
    .replace(/\s+/g, " ")
    .trim();

function What({ e }: { e: HubEvent }) {
  switch (e.kind) {
    case "prompt":
      return <span className="bp-tail__text">{e.text ? oneLine(e.text) : "Sent a prompt"}</span>;
    case "message":
      return <span className="bp-tail__text bp-tail__text--quiet">{oneLine(e.text ?? "")}</span>;
    case "turn":
      return <span className="bp-tail__text bp-tail__text--quiet">Turn ended{e.durationMs != null ? ` · ${turnDuration(e.durationMs)}` : ""}</span>;
    case "start":
      return <span className="bp-tail__text bp-tail__text--quiet">Session started</span>;
    case "end":
      return <span className="bp-tail__text bp-tail__text--quiet">Session ended</span>;
    case "idle":
      return <span className="bp-tail__text bp-tail__text--quiet">Idle</span>;
    case "waiting":
      return <span className="bp-tail__text bp-tail__text--warn">{e.label ?? "Waiting"}</span>;
    case "tool":
      return (
        <span className="bp-tail__tool">
          <span className="bp-tail__name">{e.tool?.startsWith("mcp__") ? e.tool.split("__")[1] : e.tool}</span>
          <span className="bp-tail__arg">{e.path ?? e.cmd ?? e.desc ?? e.label ?? ""}</span>
          {e.ok === false ? <span className="bp-tail__failed">failed</span> : null}
          {e.pr ? <span className="kit-link">PR {prNumber(e.pr)}</span> : null}
        </span>
      );
  }
}

/** The live tail: every shared session's events, newest first, one line each; each opens its session. */
function Activity({ person }: { person: string | null }) {
  const { model, view, nameOf } = useBoardData();
  const rows = useMemo(
    () =>
      (model?.events ?? [])
        .filter((e) => (person ? e.email === person : true) && view?.sessions[e.hubKey])
        .slice(0, 40),
    [model?.events, person, view?.sessions],
  );
  return (
    <section className="home-sec" aria-label="Activity">
      <SecHead title="Activity" />
      {rows.length === 0 ? (
        <p className="home-quiet">Quiet. Tool calls show here as they happen.</p>
      ) : (
        <ol className="home-rows bp-tail">
          {rows.map((e) => (
            <li key={`${e.deviceId}:${e.id}`} className={model?.fresh.has(`${e.deviceId}:${e.id}`) ? "bp-in" : undefined}>
              <Link href={`/sessions/${encodeURIComponent(e.hubKey)}`} className="bp-tail__row">
                <time className="bp-tail__time" dateTime={new Date(e.ts).toISOString()}>
                  {clock(e.ts)}
                </time>
                {!person ? <span className="bp-tail__who">{nameOf(e.email)}</span> : null}
                <What e={e} />
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function BoardBody({ person }: { person: string | null }) {
  const { view } = useBoardData();
  if (!view) return null;
  const lanes = person ? view.lanes.filter((l) => l.person.email === person) : view.lanes;
  const waiting = person ? view.waiting.filter((s) => s.email === person) : view.waiting;
  const open = Object.values(view.sessions).filter((s) => s.state !== "ended" && !s.offline);
  const working = open.filter((s) => s.state === "working").length;
  const idle = open.filter((s) => s.state === "idle").length;
  return (
    <div className="home-stack">
      <div className="home-lead">
        <Attention
          grow={false}
          items={[
            {
              count: waiting.length,
              label: ["session waiting on a person", "sessions waiting on a person"],
              tone: "warn",
              href: "#waiting",
            },
          ]}
          quiet="Nobody is waiting"
        />
        <FigureStrip label="Now">
          <Figure icon="play" label="Agents working" value={<Ticker value={view.agentsWorking} />} sub={`in ${working} ${working === 1 ? "session" : "sessions"}`} />
          <Figure icon="terminal" label="Sessions open" value={<Ticker value={open.length} />} sub={`${idle} idle`} />
          <Figure icon="user" label="People online" value={<Ticker value={view.peopleOnline} />} sub={`of ${view.lanes.length}`} />
        </FigureStrip>
      </div>
      <div className="home-split">
        <div className="home-stack">
          {waiting.length ? (
            <section className="home-sec" id="waiting" aria-label="Waiting on a person">
              <SecHead title="Waiting on a person" />
              <div className="home-rows">
                {waiting.map((s) => (
                  <SessionRow key={s.hubKey} s={s} waiting withPerson />
                ))}
              </div>
            </section>
          ) : null}
          {lanes.map((lane) => (
            <LaneSection key={lane.person.email} lane={lane} />
          ))}
        </div>
        <div className="home-stack">
          <SinceYouLooked />
          <Activity person={person} />
        </div>
      </div>
    </div>
  );
}

/**
 * The first read failed: the Attention slot says so once, with Retry (Home's outage line: AttentionQuiet neutral), and
 * the figures show their dashes, so nothing moves from the skeleton.
 */
function BoardFailed() {
  const { loadError, retry, retrying } = useBoardData();
  const err = loadError instanceof ApiError ? loadError : null;
  return (
    <div className="home-stack">
      <div className="home-lead">
        <AttentionQuiet
          tone="neutral"
          action={{ label: retrying ? "Retrying" : "Retry", onClick: retry, retryAfter: err?.retryAfterS ?? undefined, retryKey: loadError }}
        >
          The board did not load{err?.requestId ? <span className="font-mono"> · request {err.requestId}</span> : null}
        </AttentionQuiet>
        <FigureStrip label="Now">
          {FIGURES.map((f) => (
            <Figure key={f.label} icon={f.icon} label={f.label} value={<Ticker value={null} missing="Did not load" />} sub=" " />
          ))}
        </FigureStrip>
      </div>
    </div>
  );
}

export function BoardPage() {
  const { model, view, loadError, signedOut, setConnectOpen } = useBoardData();
  const person = new URLSearchParams(useSearch()).get("person");
  const personName = person ? (model?.people.find((p) => p.email === person)?.name ?? null) : null;
  const landed = !!model || !!loadError || signedOut;
  return (
    <PageReveal
      className="home-page kit-page-floor"
      header={
        personName ? (
          <PageHeaderView back={{ href: "/", label: "Board" }} title={personName} />
        ) : (
          <PageHeaderView title="Board" />
        )
      }
      loading={!landed}
      skeleton={<BoardBones />}
    >
      {signedOut ? (
        <EmptyState
          kind="error"
          size="page"
          title="Sign in again"
          body="Your session expired."
          action={
            <Button variant="brand" onClick={() => location.reload()}>
              Sign in
            </Button>
          }
        />
      ) : !model || !view ? (
        <BoardFailed />
      ) : !view.hasDevices ? (
        <EmptyState
          kind="start"
          size="page"
          title="No machines yet"
          body="Connect the machine your agents run on. Its sessions show here within seconds."
          action={
            <Button variant="brand" icon="plus" onClick={() => setConnectOpen(true)}>
              Connect a machine
            </Button>
          }
        />
      ) : (
        <BoardBody person={person} />
      )}
    </PageReveal>
  );
}

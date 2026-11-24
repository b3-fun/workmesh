import type { ReactNode, Ref } from "react";
import { describeError } from "../../api/client";
import { B3IQ_URL } from "../../content/site";
import { EaseHeight } from "../../ds/kit/ease";
import { AuthBackground } from "../../ds/layout/AuthBackground";
import { AuthCard as DsAuthCard } from "../../ds/layout/AuthCard";
import { B3iqWordmark, StackedMark } from "../../ui/brand";
import { Icon, type IconName } from "../../ui/Icon";
import { MockRibbon, ThemeSwitch } from "../Shell";
import "./AuthCard.css";

/**
 * Sign-in, onboarding, CLI approval, an invite and the dashboard's error screen: the original B3OS's auth card
 * (ds/layout/AuthCard: the dashed guides, the corner dots) over its pointer halftone (ds/layout/AuthBackground, light
 * theme only, nothing with reduced motion), on the dot grid as the stage behind the card and nowhere else (admin
 * redesign area 10). Its body is the original BetterAuthLoginWindow's: sections inside the card's dashed column
 * (`AuthSection`), parted by the original's dashed "[OR] CONTINUE WITH" row (`AuthDivider`), the logomark on its glass
 * tile (`AuthMark`) over a centred title. Under the card: the mock line (never a band on the grid), the site and its
 * compute, and the theme switch, so a page reached from a terminal link can change a saved dark or light choice.
 *
 * The card's top is anchored (a fixed offset that centres a usual card, AuthCard.css) and its body sits in one
 * EaseHeight (`.auth-body`): a card centred in the stage moved its title whenever its height changed (a lookup landing,
 * an error line, the invites for you: the judge's B2, 168 to 445 px on the CLI page in one frame). Now its head stays
 * put, each page's skeleton is drawn in its own shape, and what grows or shrinks does so at the card's foot, eased.
 */
export function AuthCard({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="auth-stage b3os-dotgrid">
      <AuthBackground />
      {/* The page's main region (a11y audit 11-23, M2: the auth pages had no landmark, their words outside any). */}
      <main className="auth-column">
        <DsAuthCard hideClose entryAnimation={false} reach="container" size={wide ? "lg" : "md"}>
          <EaseHeight className="auth-body">{children}</EaseHeight>
        </DsAuthCard>
        <div className="auth-mock mt-4 flex justify-center">
          <MockRibbon />
        </div>
        <p className="mt-5 flex flex-wrap items-center justify-center gap-2 text-caption text-ink-3">
          <a href="/" className="inline-flex min-h-11 items-center hover:text-ink">
            beta.b3os.org
          </a>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1.5">
            on
            <a href={B3IQ_URL} rel="noopener" className="inline-flex min-h-11 items-center text-ink-2 hover:text-ink">
              <B3iqWordmark height={10} />
            </a>
            compute
          </span>
        </p>
        <div className="mt-1 flex justify-center">
          <ThemeSwitch />
        </div>
      </main>
    </div>
  );
}

/** One section of the card's dashed column (the original's `px-[9px]` frame and its dashed sides). */
export function AuthSection({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="auth-section">
      <div className={className ? `auth-section__body ${className}` : "auth-section__body"}>{children}</div>
    </div>
  );
}

/** The original's dashed row between two sections: "[OR] CONTINUE WITH", in its mono caps. */
export function AuthDivider({ lead = "OR", children }: { lead?: string; children?: ReactNode }) {
  return (
    <div className="auth-section" aria-hidden="true">
      <div className="auth-divider">
        <p>
          [<span className="auth-divider__lead">{lead}</span>]{children ? <> {children}</> : null}
        </p>
      </div>
    </div>
  );
}

/**
 * The card's head, centred as the original's: the B3OS logomark on its glass tile (or a glyph on one: an invite, a
 * failure), the title, one line under it.
 */
export function AuthHead({
  title,
  line,
  icon,
  mark,
  tone = "brand",
  chip,
  titleRef,
}: {
  title: ReactNode;
  line?: ReactNode;
  /** A glyph on the tile instead of the mark. */
  icon?: IconName;
  /** The tile's content itself (an approved sign-in's animated check). */
  mark?: ReactNode;
  tone?: "brand" | "danger" | "ok";
  /** A chip after the title ("Beta"). */
  chip?: ReactNode;
  /** The title, for a page that moves the focus to it when the card's state changes (a decision, a result). */
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div className="auth-head">
      <span className="auth-mark" data-tone={icon || mark ? tone : undefined} aria-hidden="true">
        {mark ?? (icon ? <Icon name={icon} size={24} /> : <StackedMark height={26} className="text-ink" />)}
      </span>
      <div className="auth-head__text">
        <h1 className="auth-head__title" ref={titleRef} tabIndex={titleRef ? -1 : undefined}>
          {title}
          {chip ? <span className="b3os-chip auth-head__chip">{chip}</span> : null}
        </h1>
        {line ? <p className="auth-head__line">{line}</p> : null}
      </div>
    </div>
  );
}

/**
 * A fact or a failure said in one line with no fill (no band on a tint: the banner rule): a glyph in its tone, the
 * title, the reason, the request id to quote, at most one action under it.
 */
export function AuthNote({
  tone = "danger",
  title,
  children,
  error,
  action,
}: {
  tone?: "danger" | "warn" | "info" | "ok";
  title?: ReactNode;
  children?: ReactNode;
  /** A failed call: its reason (unless `children` says it) and its request id. */
  error?: unknown;
  action?: ReactNode;
}) {
  const described = error ? describeError(error) : null;
  // Beside a Retry the words drop their own "Try again in 5 s." (the button says it; round 2's S8).
  const said =
    described && action ? described.message.replace(/\s*Try again in [^.]+\.\s*$/, "").trim() : described?.message;
  const glyph: IconName = tone === "ok" ? "check" : tone === "info" ? "info" : "alert";
  return (
    <div className="auth-note" data-tone={tone} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={glyph} size={16} className="auth-note__glyph" />
      <div className="auth-note__body">
        {title ? <p className="auth-note__title">{title}</p> : null}
        {(children ?? said) ? <p className="auth-note__text">{children ?? said}</p> : null}
        {described?.requestId ? <p className="auth-note__id">request {described.requestId}</p> : null}
        {action ? <div className="auth-note__action">{action}</div> : null}
      </div>
    </div>
  );
}

// What is wrong now (LIBRARY.md "attention"; the judge's line 2, P18: "the first read"): the one row Home shows before
// any figure, "2 applications down · 3 routines failing", each count in its status colour and linking to its list, and
// one "View" at the end. One line on a neutral tint, quieter than the brand; it says nothing at all when nothing is
// wrong (no "All good" banner), so its presence is the signal. It wraps on a phone, the link staying at the end.
import { type ReactNode, useRef } from "react";
import { Icon, type IconName } from "../../ui/Icon";
import { cn } from "../lib/utils";
import { InlineError } from "./charts/frame";
import { useCountdown } from "./countdown";
import { KitLink } from "./link";
import { Bone, TextBone, useBoneGrow, useMountGrow } from "./skeleton";
import "./css/lite.css";
import "./kit.css";

export interface AttentionItem {
  count: number;
  /**
   * The noun phrase after the count, singular and plural: ["application down", "applications down"]. With `what`, the
   * predicate after the names instead: ["at its cap", "at their cap"].
   */
  label: [one: string, many: string];
  /**
   * What it counts, by name, so the line says why as well as how many: ["Sandboxes", "Browser sessions"] reads
   * "Sandboxes and Browser sessions at their cap" (the count still sets singular or plural).
   */
  what?: readonly string[];
  /**
   * `failed` red, `warn` amber, `neutral` ink: a state the page cannot tell ("Errors and Calls did not load"), not a
   * problem it found. A line of neutral items only takes the info mark; any failed or warn item sets the line's tone.
   */
  tone?: "failed" | "warn" | "neutral";
  href?: string;
  /**
   * The item's one action after its words ("Calls did not load · Retry"): a press or a link. On a phone it ends the
   * item's 44 px row, a 44 px target. An item with an action may still link its words (`href`).
   */
  action?: AttentionAction;
}

/** An Attention item's action: Retry for a read that did not load, or a link to where it is fixed. */
export type AttentionAction =
  | { label: string; href: string }
  | {
      label: string;
      onClick: () => void;
      /**
       * Seconds before the action can work (a 429's or a 503's Retry-After): "Retry in 4 s" stands where it will be,
       * not pressable, so a page's lines stop offering Retry together during the wait (sweep r3). The count is shown,
       * said once.
       */
      retryAfter?: number;
      /** A new failure with the same wait starts the count again (as InlineError's retryKey). */
      retryKey?: unknown;
    };

/** An action's wait, then the action: `children` once `retryAfter` has run out. */
function ActionWait({
  action,
  className,
  children,
}: {
  action: AttentionAction;
  className: string;
  children: ReactNode;
}) {
  const wait = "onClick" in action ? action.retryAfter : undefined;
  const left = useCountdown(wait, "onClick" in action ? action.retryKey : undefined);
  if (left <= 0) return <>{children}</>;
  return (
    <span className={cn(className, "kit-attn__wait")} data-retry-in={left}>
      <span aria-hidden="true">{`${action.label} in ${left} s`}</span>
      <span className="sr-only">{`${action.label} in ${Math.ceil(wait ?? 0)} seconds`}</span>
    </span>
  );
}

/** An item's words as the line sets them: its head (the count, or the names), then the rest. */
export function attentionWords(i: AttentionItem): { head: string; tail: string } {
  return {
    head: i.what?.length ? names(i.what) : i.count.toLocaleString("en-US"),
    tail: i.count === 1 ? i.label[0] : i.label[1],
  };
}

/** The line's tone: red if any item is failed, amber if any is warn, else neutral (the info mark). */
function lineTone(items: readonly AttentionItem[]): "failed" | "warn" | "neutral" {
  const tones = items.map((i) => i.tone ?? "failed");
  return tones.includes("failed") ? "failed" : tones.includes("warn") ? "warn" : "neutral";
}

/** Names in a sentence: "Sandboxes", "Sandboxes and Browser sessions", "A, B and C". */
export function names(list: readonly string[]): string {
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** One wordless item's bone (the line's words not known yet). */
function BoneItem({ index, grow }: { index: number; grow: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useBoneGrow(ref, grow);
  return (
    <span ref={ref} className="kit-attn__item kit-attn__bone-item">
      <Bone className={cn("kit-bone--inline max-w-full", index === 0 ? "w-56" : "w-40")} />
    </span>
  );
}

/**
 * One item's bone in its own words: the line's own item (its separator, its link and chevron, its action) with the
 * words drawn as bones (TextBone), so it is the item's width on a desktop's line and its row on a phone, and the bone
 * wraps exactly where the line will (Home's busy line at 1024 took two lines, 16 px under a bone that counted items).
 */
function WordsItem({ item, index, grow }: { item: AttentionItem; index: number; grow: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useBoneGrow(ref, grow);
  const { head, tail } = attentionWords(item);
  return (
    <span ref={ref} className="kit-attn__item" data-tone={item.tone ?? "failed"}>
      {index > 0 ? (
        <span className="kit-attn__sep" aria-hidden="true">
          ·
        </span>
      ) : null}
      <span className={item.href ? "kit-attn__link" : undefined}>
        <span className="kit-attn__text">
          <span className="kit-attn__count">
            <TextBone>{head}</TextBone>
          </span>
          {tail ? (
            <>
              {" "}
              <TextBone>{tail}</TextBone>
            </>
          ) : null}
        </span>
        {item.href ? <Icon name="chevronRight" size={14} className="kit-attn__chev" /> : null}
      </span>
      {item.action ? (
        <span className="kit-attn__item-action">
          <span className="kit-attn__sep" aria-hidden="true">
            ·
          </span>
          <span className="kit-attn__item-act">
            <TextBone>{item.action.label}</TextBone>
          </span>
        </span>
      ) : null}
    </span>
  );
}

/** Words drawn as their own bone (skeleton.tsx; exported here too, where SkeletonNote first had it). */
export { TextBone };

/**
 * A worded notice loading (a routine's warnings: a glyph, then a line of words a reason): the line's own frame, a glyph
 * bone and each line's words as a TextBone, so the bone is the notice's height at every width. It grows in when it
 * mounts after the page's first paint (`growAtBoot`: in its first 1.2 s too). Routines' WarningsBone can be this.
 */
export function SkeletonNote({
  lines,
  slot = "attention",
  growAtBoot = false,
  className,
}: {
  /** The notice's lines as they will read. */
  lines: readonly string[];
  /** Its page-load slot. */
  slot?: string;
  growAtBoot?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useMountGrow(ref, true, growAtBoot);
  return (
    <section ref={ref} className={cn("kit-note-bone", className)} data-page-slot={slot} aria-hidden="true">
      <div className="kit-note-bone__line">
        <Bone className="kit-note-bone__glyph" />
        <ul className="kit-note-bone__lines">
          {lines.map((l, i) => (
            <li key={`${i}-${l}`}>
              <TextBone>{l}</TextBone>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * The Attention line's bone, for a skeleton that already knows a line will be there (a first read said so): the line's
 * own frame with a glyph bone and its items. `items` as a count draws a wordless bone an item (one line on a desktop, a
 * 44 px row each on a phone); as the items themselves (the ones the page will pass to Attention, from the reads in so
 * far) it draws each in its own words, separators, links' chevrons and actions in their places, so the bone wraps where
 * the line will at every width. It grows in with the kit's eased mount (200 ms) when it arrives after the skeleton, and
 * an item added after it mounted grows in too, so the bones under it slide; it carries the attention slot.
 */
/**
 * A failed read's line loading (Actions' FailLineBone, made the kit's): the kit's own InlineError with its words,
 * inert and unseen, its words and request id drawn as bones, so it is the line's height at every width and wraps as the
 * line will; its mark and Retry (or the Retry-After's "Retry in 5 s") keep their room. It grows in when it mounts after
 * its skeleton (a read the page waits on said it failed), so the parts under it slide; `grow={false}` when it is there
 * from the skeleton's first frame.
 */
export function SkeletonInlineError({
  children,
  requestId,
  retryAfter,
  retryKey,
  align = "start",
  grow = true,
  className,
}: {
  /** The line's words, as InlineError will say them. */
  children: ReactNode;
  requestId?: string;
  /** The reads' Retry-After, so the bone holds "Retry in 5 s" where the line will (it can wrap the line once more). */
  retryAfter?: number;
  retryKey?: unknown;
  align?: "center" | "start";
  grow?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useBoneGrow(ref, grow);
  return (
    <div ref={ref} className={cn("kit-inline-error-bone", className)} aria-hidden="true" inert>
      <InlineError align={align} requestId={requestId} retryAfter={retryAfter} retryKey={retryKey} onRetry={() => {}}>
        {children}
      </InlineError>
    </div>
  );
}

export function SkeletonAttention({
  items = 1,
  text,
  action,
  growAtBoot = false,
  className,
}: {
  /**
   * How many items the line will hold, or the items themselves (their words drawn as bones; those with no count left
   * out, as Attention does; none yet: one wordless bone).
   */
  items?: number | readonly AttentionItem[];
  /** The line's words when the page knows them as one text: drawn as a bone of the words, wrapping where they will. */
  text?: string;
  /** The line's own action's words ("View all"), where Attention draws it (hidden on a phone, as it is). */
  action?: string;
  /** Grow in the page's first 1.2 s too (a line that arrives with a cold link's first read). */
  growAtBoot?: boolean;
  className?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  useMountGrow(wrap, true, growAtBoot);
  const worded = typeof items === "number" ? null : items.filter((i) => i.count > 0);
  const n = worded ? Math.max(1, worded.length) : Math.max(1, items as number);
  // The items the bone drew at mount; one the reads add later grows in.
  const firstItems = useRef(n);
  return (
    <div ref={wrap} className="kit-attn-wrap" data-page-slot="attention" aria-hidden="true">
      <div
        className={cn("kit-attn kit-attn--bone", className)}
        data-items={n > 1 ? n : undefined}
        data-tone={worded?.length ? lineTone(worded) : undefined}
      >
        <span className="kit-attn__glyph">
          <Bone className="kit-bone--glyph" />
        </span>
        <p className="kit-attn__items">
          {text ? (
            <span className="kit-attn__item kit-attn__bone-text">
              <span className="kit-attn__text">
                <TextBone>{text}</TextBone>
              </span>
            </span>
          ) : worded?.length ? (
            worded.map((it, i) => (
              <WordsItem key={`item-${i + 1}`} item={it} index={i} grow={i >= firstItems.current} />
            ))
          ) : (
            Array.from({ length: n }, (_, i) => (
              <BoneItem key={`bone-${i + 1}`} index={i} grow={i >= firstItems.current} />
            ))
          )}
        </p>
        {action ? (
          <span className="kit-attn__action">
            <TextBone>{action}</TextBone>
            <Icon name="chevronRight" size={12} className="kit-attn__action-chev" />
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function Attention({
  items,
  action,
  grow = true,
  quiet,
  className,
}: {
  items: readonly AttentionItem[];
  /**
   * Grow from nothing when it mounts after the page's first paint (its own read landing later). False when it arrives
   * with its page (it is then in place when the page lands). Inside a Reveal it never grows either way.
   */
  grow?: boolean;
  /** The one way in, naming what it opens ("View all", to the filtered list); hidden on a phone, where each count is its
   * own 44 px row that links to its list. */
  action?: { label: string; href: string };
  /** Said when nothing needs attention (an ok quiet line, AttentionQuiet), for a page that always keeps the slot. */
  quiet?: ReactNode;
  className?: string;
}) {
  const shown = items.filter((i) => i.count > 0);
  if (!shown.length) return quiet ? <AttentionQuiet className={className}>{quiet}</AttentionQuiet> : null;
  return <AttentionRow items={shown} action={action} grow={grow} className={className} />;
}

/**
 * A fact that is not a problem, said once and quietly: one line, no fill, no pattern (a text band on a tint or on the
 * dot grid is the rule's "no"). A glyph in a quiet ink (`ok` a check in the success ink, `warn` an amber mark), the
 * words in ink 3, and at most one action. Attention stays for problems; a plan or info fact is a Note or a figure.
 */
export function Note({
  icon,
  tone = "neutral",
  action,
  children,
  className,
}: {
  icon?: IconName | null;
  tone?: "neutral" | "ok" | "warn";
  action?: { label: string; href: string } | { label: string; onClick: () => void };
  children: ReactNode;
  className?: string;
}) {
  const glyph = icon === null ? null : (icon ?? (tone === "ok" ? "check" : tone === "warn" ? "alert" : "info"));
  return (
    <p className={cn("kit-note", className)} data-tone={tone}>
      {glyph ? (
        <span className="kit-note__glyph" aria-hidden="true">
          <Icon name={glyph} size={14} />
        </span>
      ) : null}
      <span className="kit-note__text">{children}</span>
      {action ? (
        "href" in action ? (
          <KitLink href={action.href} className="kit-link kit-note__action">
            {action.label}
          </KitLink>
        ) : (
          <button type="button" className="kit-link kit-note__action" onClick={action.onClick}>
            {action.label}
          </button>
        )
      ) : null}
    </p>
  );
}

/**
 * The Attention slot when nothing needs it: one quiet line where the Attention line would be (no fill: it is not a
 * problem), the line's height, so a page that always keeps the slot (its bone is in the skeleton) lands on it. `ok`: a
 * check in the success ink ("Nothing failed in the last hour"); `neutral`: a plain mark ("The last hour did not load")
 * with one action (Retry), which stays on a phone at 44 px (Attention's own "View all" hides there, its counts being
 * rows).
 */
export function AttentionQuiet({
  tone = "ok",
  action,
  counter,
  children,
  className,
}: {
  tone?: "ok" | "neutral";
  /** One action; `retryAfter` holds a Retry as "Retry in 4 s" for a Retry-After (see AttentionAction). */
  action?: AttentionAction;
  /** What ticks beside the words ("Retry in 4 s"): shown, never spoken, so the status is not said each second (S5). */
  counter?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="kit-attn-wrap" data-page-slot="attention">
      <div className={cn("kit-attn", className)} data-tone={tone} data-quiet="" role="status">
        <span className="kit-attn__glyph" aria-hidden="true">
          {/* Neutral is a fact, not a warning ("No calls in the last hour"): an info mark, never the alert triangle. */}
          <Icon name={tone === "ok" ? "check" : "info"} size={15} />
        </span>
        <p className="kit-attn__items">
          <span className="kit-attn__text">
            {children}
            {counter !== undefined && counter !== null ? <span aria-hidden="true">{counter}</span> : null}
          </span>
        </p>
        {action ? (
          "href" in action ? (
            <KitLink href={action.href} className="kit-attn__action">
              {action.label}
              <Icon name="chevronRight" size={12} />
            </KitLink>
          ) : (
            <ActionWait action={action} className="kit-attn__action">
              <button type="button" className="kit-attn__action" onClick={action.onClick}>
                {action.label}
              </button>
            </ActionWait>
          )
        ) : null}
      </div>
    </div>
  );
}

function AttentionRow({
  items: shown,
  action,
  grow,
  className,
}: {
  items: readonly AttentionItem[];
  action?: { label: string; href: string };
  grow: boolean;
  className?: string;
}) {
  // Arriving with the data after the page's first paint, the line grows from nothing, so the figures under it slide;
  // arriving with the page (inside PageReveal's content), it is in place when the page lands.
  const wrap = useRef<HTMLDivElement>(null);
  useMountGrow(wrap, grow);
  const worst = lineTone(shown);
  const word = (i: AttentionItem): ReactNode => {
    const { head, tail } = attentionWords(i);
    return (
      <span className="kit-attn__text">
        <span className="kit-attn__count">{head}</span>
        {tail ? ` ${tail}` : null}
      </span>
    );
  };
  return (
    <div ref={wrap} className="kit-attn-wrap" data-page-slot="attention">
      <div className={cn("kit-attn", className)} data-tone={worst} role="status">
        <span className="kit-attn__glyph" aria-hidden="true">
          {/* A line that names only what it cannot tell (neutral items) takes the info mark, never the alert. */}
          <Icon name={worst === "neutral" ? "info" : "alert"} size={15} />
        </span>
        <p className="kit-attn__items">
          {shown.map((i, n) => (
            <span key={i.label[1]} className="kit-attn__item" data-tone={i.tone ?? "failed"}>
              {n > 0 ? (
                <span className="kit-attn__sep" aria-hidden="true">
                  ·
                </span>
              ) : null}
              {i.href ? (
                <KitLink href={i.href} className="kit-attn__link">
                  {word(i)}
                  <Icon name="chevronRight" size={14} className="kit-attn__chev" />
                </KitLink>
              ) : (
                word(i)
              )}
              {i.action ? (
                <span className="kit-attn__item-action">
                  <span className="kit-attn__sep" aria-hidden="true">
                    ·
                  </span>
                  {"href" in i.action ? (
                    <KitLink href={i.action.href} className="kit-link kit-attn__item-act">
                      {i.action.label}
                    </KitLink>
                  ) : (
                    <ActionWait action={i.action} className="kit-attn__item-act">
                      <button type="button" className="kit-link kit-attn__item-act" onClick={i.action.onClick}>
                        {i.action.label}
                      </button>
                    </ActionWait>
                  )}
                </span>
              ) : null}
            </span>
          ))}
        </p>
        {action ? (
          <KitLink href={action.href} className="kit-attn__action">
            {action.label}
            <Icon name="chevronRight" size={12} />
          </KitLink>
        ) : null}
      </div>
    </div>
  );
}

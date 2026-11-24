/**
 * Dashboard building blocks. Since EXTRACT X5 the controls are the original B3OS's components (src/ds, through the
 * console adapters in src/ds/adopt): Button, the loader, the form fields, the status badges, the skeleton, the empty
 * state and the tabs keep their names, props and behaviour here, so every page that imports them is unchanged, and
 * draw as the original draws them. Field, the copy controls, the notes, Meter and Dash are the console's own. Their
 * stylesheet (src/ds/core.css) is the entry's first (main.tsx), so a caller's classes, in the console's stylesheet
 * after it, win over the component's own where a media query sets the same property (max-md:w-11 over w-9).
 */
import {
  type ButtonHTMLAttributes,
  type ComponentProps,
  cloneElement,
  Fragment,
  type InputHTMLAttributes,
  isValidElement,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ApiError, describeError } from "../../api/client";
import {
  COPY_VALUE_CLASS,
  ConsoleButton,
  ConsoleButtonLink,
  ConsoleCheckbox,
  ConsolePixelLoader,
  ConsoleRadio,
  ConsoleRadioGroup,
  ConsoleSelect,
  ConsoleSkeleton,
  ConsoleTabs,
  ConsoleTextArea,
  ConsoleTextInput,
  revealTab,
  tabId,
} from "../../ds/adopt/console-controls";
import { useCountdown } from "../../ds/kit/countdown";
import { QuietEmptyState } from "../../ds/layout/quiet-empty-state";
import { StatusDot, type StatusDotTone } from "../../ds/layout/status-dot";
import { NOT_MEASURED } from "../../lib/format";
import { withoutRetryHint } from "../../lib/retry-hint";
import { Icon, type IconName } from "../../ui/Icon";

/* ---------------- an empty value ---------------- */

/**
 * A value the console does not have (lib/format.ts NOT_MEASURED): one em dash, quiet, in the sans face wherever it
 * sits. A mono cell would draw it one character wide, and the same table would show two dashes (11-08 review).
 */
export function Dash({ title }: { title?: string }) {
  return (
    <span className="font-sans text-ink-3" title={title}>
      {NOT_MEASURED}
    </span>
  );
}

/* ---------------- media ---------------- */

/**
 * Whether a media query matches now, and again whenever it changes. Here, in the dashboard's first chunk, rather than
 * a module of its own: the application page, its traces, a routine's Steps tab and the marketplace share it, and a
 * module of its own was one more hashed file and one more `_headers` rule (console area 6 fix, F2).
 */
export function useMedia(query: string): boolean {
  const get = () => typeof window !== "undefined" && !!window.matchMedia?.(query).matches;
  const [on, setOn] = useState(get);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const f = () => setOn(m.matches);
    f();
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [query]);
  return on;
}

/* ---------------- buttons ---------------- */

type Variant = "brand" | "neutral" | "inverse" | "ghost" | "link" | "danger" | "destructive";
type Size = "xs" | "sm" | "md" | "lg" | "xl";

export function Button({
  variant = "neutral",
  size = "md",
  icon,
  loading = false,
  className = "",
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  loading?: boolean;
  /** The <button> itself, for a caller that moves focus to it (React 19 passes it as a prop). */
  ref?: Ref<HTMLButtonElement>;
}) {
  // "danger" is a control a confirm follows (ConfirmButton, a Dialog, Vault's Keep/Delete): quiet until hovered,
  // focused or pressed, then red. "destructive" fills red and only commits (§5.1). One press that commits at once is
  // ConfirmButton, never a bare "danger" Button: a touch screen has no hover, so it would never show red first.
  // The original's Button (EXTRACT X5); `data-variant` names the console's variant.
  return (
    <ConsoleButton
      variant={variant}
      size={size}
      loading={loading}
      iconNode={icon ? <Icon name={icon} size={16} /> : undefined}
      className={className}
      disabled={disabled}
      {...rest}
    >
      {children}
    </ConsoleButton>
  );
}

/**
 * A link drawn as a Button (the original's Button around an <a>: NEEDS 15). For a console route the caller passes its
 * router's Link as `linkAs` (client navigation); this module does not import the router, which the console-kit group
 * (home's address and lease) would then pull into a chunk of its own. Same variants and sizes as Button.
 */
export function ButtonLink({
  variant = "neutral",
  size = "md",
  icon,
  className = "",
  children,
  ...rest
}: ComponentProps<typeof ConsoleButtonLink> & {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
}) {
  return (
    <ConsoleButtonLink
      variant={variant}
      size={size}
      iconNode={icon ? <Icon name={icon} size={16} /> : undefined}
      className={className}
      {...rest}
    >
      {children}
    </ConsoleButtonLink>
  );
}

/** How long an armed ConfirmButton waits for its second press. */
export const CONFIRM_MS = 3000;

/**
 * How soon after a confirm asks a press may answer it. A double click, a double tap or a held key presses twice in
 * well under this, before anyone has read the question (11-09 review: a double click cancelled a run with the red
 * question on screen for 1 ms). Windows' default double-click time is the same 500 ms.
 */
export const CONFIRM_GAP_MS = 500;

/**
 * Tells the press that answers a confirm from the second half of the press that opened it. Call `asked(e)` on the
 * press that opens the question; `ready(e)` on a later press is false under CONFIRM_GAP_MS, and for the next click
 * of the same multi-click (`detail` counts them on the system's own double-click time, which can be longer). Only
 * that next click: a person on a slow double-click setting who clicks again still gets through.
 */
export function useConfirmGap() {
  const asked = useRef<{ at: number; clicks: number } | null>(null);
  return {
    asked: (e: { detail: number }) => {
      asked.current = { at: performance.now(), clicks: e.detail };
    },
    ready: (e: { detail: number }) => {
      const a = asked.current;
      if (!a) return true;
      return performance.now() - a.at >= CONFIRM_GAP_MS && !(a.clicks > 0 && e.detail === a.clicks + 1);
    },
  };
}

/**
 * An action that cannot be taken back, in two presses on one button (§5.1): at rest the quiet "danger" control; the
 * first press turns it into the filled red button asking `confirm` ("Cancel run?", in words only: the icon goes, so
 * the question takes little more room than the label did); a press on that runs `onConfirm`.
 * It backs out after CONFIRM_MS, when focus leaves it, or on Escape. A press sooner than CONFIRM_GAP_MS after the
 * first, or a held key's repeat, does nothing: a double click or a double tap only asks. Staying one button keeps
 * keyboard focus on it, and a touch screen, which has no hover, still shows red before anything happens. When the
 * confirm needs a sentence (what is lost, what is kept), open a Dialog from a "danger" Button instead.
 */
export function ConfirmButton({
  confirm,
  confirmName,
  onConfirm,
  icon,
  children,
  onBlur,
  onKeyDown,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  /** The armed button's text, a short question: "Cancel run?", "Kill?". */
  confirm: string;
  /** The armed button's accessible name, when `confirm` alone does not say what it acts on ("Remove beat 2?"). */
  confirmName?: string;
  onConfirm: () => void;
  size?: Size;
  icon?: IconName;
  loading?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const gap = useConfirmGap();
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      {...rest}
      variant={armed ? "destructive" : "danger"}
      icon={armed ? undefined : icon}
      aria-label={armed ? (confirmName ?? confirm) : rest["aria-label"]}
      onClick={(e) => {
        if (!armed) {
          gap.asked(e);
          return setArmed(true);
        }
        if (!gap.ready(e)) return;
        setArmed(false);
        onConfirm();
      }}
      onBlur={(e) => {
        setArmed(false);
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        // A held Enter repeats its keydown, and each one presses the button: only the first counts.
        if (e.key === "Enter" && e.repeat) e.preventDefault();
        // Escape backs out of the confirm, and only that: a dialog around the button stays open.
        if (armed && e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setArmed(false);
        }
        onKeyDown?.(e);
      }}
    >
      {armed ? confirm : children}
    </Button>
  );
}

/** In-button loading: the original's 3x3 pixel loader in brand blue (§5.9). Still under reduced motion. */
export function PixelLoader({ label = "Loading" }: { label?: string }) {
  return <ConsolePixelLoader label={label} />;
}

/* ---------------- form fields ---------------- */

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  className = "",
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  // The error (or the hint) describes the control (a11y audit 11-23, M12: the sign-in email was invalid with nothing
  // tied to it): the field's one control is given the line's id, and is invalid while there is an error.
  const msgId = htmlFor && (error || hint) ? `${htmlFor}-msg` : undefined;
  const control =
    msgId && isValidElement<{ "aria-describedby"?: string; "aria-invalid"?: boolean | "true" | "false" }>(children)
      ? cloneElement(children, {
          "aria-describedby": [children.props["aria-describedby"], msgId].filter(Boolean).join(" "),
          ...(error ? { "aria-invalid": true } : {}),
        })
      : children;
  return (
    <div className={`grid gap-2 ${className}`}>
      <label htmlFor={htmlFor} className="text-small font-medium text-ink-2">
        {label}
      </label>
      {control}
      {error ? (
        <p id={msgId} className="flex items-start gap-1.5 text-small text-danger" role="alert">
          <Icon name="alert" size={16} className="mt-px shrink-0" />
          {error}
        </p>
      ) : hint ? (
        <p id={msgId} className="text-small text-ink-3 text-pretty">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** The original's Input. */
export function TextInput({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <ConsoleTextInput className={className} {...rest} />;
}

/** The original's Textarea, in the console's mono (code and JSON go in it). */
export function TextArea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <ConsoleTextArea className={className} {...rest} />;
}

/**
 * The original's select (Radix's listbox, drawn as the console's Input; console area 2 fix, R1): callers keep the
 * native select's props, `<option>` children and `onChange(e)` (ds/adopt/console-controls ConsoleSelect).
 */
export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <ConsoleSelect className={className} {...rest}>
      {children}
    </ConsoleSelect>
  );
}

/**
 * A checkbox (console area 2 fix, R1: the original's, never the browser's): `checked` and `onChange(checked)`. Put it
 * inside a <label> with its words, or give it an `aria-label`.
 */
export const Checkbox = ConsoleCheckbox;

/** Radios: a RadioGroup (`value`, `onValueChange`) around a Radio per choice, each inside its <label>. */
export const RadioGroup = ConsoleRadioGroup;
export const Radio = ConsoleRadio;

/* ---------------- status ---------------- */

/**
 * How each state the API returns draws (AUDIT 2.1, DIRECTION 1.2): a dot and the word, one look across the console,
 * the application header's (ds/layout/status-dot). ok green, warn yellow, off grey, failed red: the dot's colour, the
 * word in the secondary ink.
 */
// The status dot for the entry's own modules (Shell.tsx): imported from its library file there, Rolldown split it and
// the empty state into a ds file app.html preloaded (web truth fix round, F2); through here it stays in the entry's file.
export { StatusDot };

const STATUS_TONE: Record<string, StatusDotTone> = {
  active: "ok",
  succeeded: "ok",
  approved: "ok",
  operational: "ok",
  ready: "ok",
  completed: "ok",
  delivered: "ok",
  answered: "ok",
  live: "ok",
  paused: "warn",
  waiting: "warn",
  retrying: "warn",
  queued: "off",
  pending: "off",
  stopped: "off",
  closed: "off",
  skipped: "off",
  expired: "off",
  canceled: "off",
  cancelled: "off",
  superseded: "off",
  ended: "off",
  timed_out: "off",
  incomplete: "off",
  revoked: "failed",
  failed: "failed",
  denied: "failed",
};

/** Words for work under way now: the pixel grid plays in the dot's place until it settles (DIRECTION 2). */
const UNDER_WAY = new Set(["starting", "creating", "scraping", "processing", "building", "applying", "in_progress"]);

/** "timed_out" reads "Timed out". */
export const statusWord = (status: string) => {
  const w = status.replace(/_/g, " ");
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/**
 * A state as a dot and its word (AUDIT 2.1; it was the original's badge, a tinted pill). `work`: the state belongs to
 * a piece of work (a run, a step, a job, a render), whose "running" means under way now, so the pixel grid plays in
 * the dot's place; a sandbox, a process or a session that is running is simply up (a green dot).
 */
export function StatusBadge({
  status,
  work = false,
  quiet = false,
  label,
  className = "",
}: {
  status: string;
  work?: boolean;
  /**
   * The dot alone, its word for a screen reader and on hover: a row of a short list whose page already says the state
   * (a run's steps under its "Succeeded"; console area 2 fix, F3). The caller passes it only for the expected state,
   * so a step that differs (Failed, Running with the grid) still says so.
   */
  quiet?: boolean;
  /** The words beside the dot, where they say more than the state ("Failed · 12 attempts"); the state's word by default. */
  label?: string;
  className?: string;
}) {
  const underWay = UNDER_WAY.has(status) || (work && status === "running");
  const tone: StatusDotTone = underWay ? "live" : status === "running" ? "ok" : (STATUS_TONE[status] ?? "off");
  const word = label ?? statusWord(status);
  const badge = (
    <StatusDot tone={tone} running={underWay} runningLabel={word} className={`text-ui ${className}`}>
      {quiet ? <span className="sr-only">{word}</span> : word}
    </StatusDot>
  );
  return quiet ? (
    <span title={word} className="inline-flex shrink-0">
      {badge}
    </span>
  ) : (
    badge
  );
}

/**
 * An HTTP status as a dot and the code in mono (AUDIT 2.2; it was a green pill for every 200, 25 on one screen of
 * Requests): the code grey, its dot green for a 2xx, grey for a 3xx, yellow for a 4xx, red for a 5xx (a status is a
 * coloured dot and a neutral word: the orchestrator's ruling after console area 3, which took the 4xx's warning ink).
 */
export function HttpStatus({ code, plain = false }: { code: number; plain?: boolean }) {
  // `plain`: the code alone, grey mono, beside a state that already carries the dot (a webhook delivery's row:
  // console area 2 fix, F4, a failure was red three times on one row).
  if (plain) return <span className="font-mono text-ui text-ink-2 tabular-nums">{code}</span>;
  const tone: StatusDotTone = code >= 500 ? "failed" : code >= 400 ? "warn" : code >= 300 ? "off" : "ok";
  return (
    <StatusDot tone={tone} className="font-mono text-ui tabular-nums">
      {code}
    </StatusDot>
  );
}

/* ---------------- lists and kinds as words (AUDIT 2.3) ---------------- */

/** Scopes, hosts or grants: mono text joined by ", ", never a chip each. */
export function MonoList({ items, className = "" }: { items: readonly string[]; className?: string }) {
  return (
    <span className={`font-mono text-caption text-ink-2 [overflow-wrap:anywhere] ${className}`}>
      {items.join(", ")}
    </span>
  );
}

/**
 * A kind or an effect (cron, webhook, reads): a lower-case word in the tertiary ink. `warn` ("irreversible") puts the
 * library's yellow dot beside the same grey word: a status is a dot and a plain word, never coloured text (look fixes
 * 1114, ruling 9: it was orange text where every other row had a grey word).
 */
export function KindWord({ children, warn = false }: { children: ReactNode; warn?: boolean }) {
  const word = <span className="text-small whitespace-nowrap text-ink-3">{children}</span>;
  return warn ? (
    <StatusDot tone="warn" className="text-small">
      {word}
    </StatusDot>
  ) : (
    word
  );
}

/* ---------------- copy ---------------- */

export function useCopy(timeout = 1600) {
  const [copied, setCopied] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (t.current) clearTimeout(t.current);
    },
    [],
  );
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (t.current) clearTimeout(t.current);
      t.current = setTimeout(() => setCopied(false), timeout);
      return true;
    } catch {
      return false;
    }
  };
  return { copied, copy };
}

export function CopyButton({
  text,
  label = "Copy",
  size = "sm",
  variant = "neutral",
  className = "",
  iconOnly = false,
}: {
  text: string;
  label?: string;
  size?: Size;
  variant?: Variant;
  className?: string;
  iconOnly?: boolean;
}) {
  const { copied, copy } = useCopy();
  return (
    <Button
      variant={variant}
      size={size}
      icon={copied ? "check" : "copy"}
      onClick={() => copy(text)}
      className={`${iconOnly ? "b3os-btn--icon max-md:w-11" : ""} ${className}`}
      aria-label={iconOnly ? label : undefined}
    >
      {iconOnly ? null : <span aria-live="polite">{copied ? "Copied" : label}</span>}
    </Button>
  );
}

/**
 * A command's words, each kept whole, so a line breaks only at a space. A browser also breaks after a hyphen, which
 * splits `apt-get` and `--force-confold` across lines and reads as a typo. A word over 40 characters may still break
 * so it cannot push the page sideways. The text, and so what a person selects and copies, is unchanged.
 */
function WholeWords({ text }: { text: string }) {
  // The space sits between the spans, outside nowrap, where the line may break.
  return text.split(" ").map((word, i) => (
    // The words of one fixed string never reorder, so the index is a stable key.
    <Fragment key={i}>
      {i ? " " : null}
      <span className={word.length > 40 ? undefined : "whitespace-nowrap"}>{word}</span>
    </Fragment>
  ));
}

/** A value in mono with a copy button, e.g. an id, a URL or an export line. */
export function CopyField({
  value,
  label,
  secret = false,
  wrap = false,
}: {
  value: string;
  label?: string;
  secret?: boolean;
  /** A command people read before they copy it: it wraps at its spaces on a narrow screen instead of ending in "…". */
  wrap?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code
        id={id}
        className={`${COPY_VALUE_CLASS} ${wrap ? "whitespace-normal" : "truncate"} ${secret ? "select-all" : ""}`}
        title={value}
      >
        {wrap ? <WholeWords text={value} /> : value}
      </code>
      <CopyButton text={value} label={label ? `Copy ${label}` : "Copy"} iconOnly size="lg" />
    </div>
  );
}

/**
 * An id under a name (console audit finding 8): small mono text that copies itself, with a copy icon that turns to a
 * check. Secondary by design; the name above it is what people read. 44 px tall on phones.
 */
export function CopyId({ value, label = "id" }: { value: string; label?: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(value)}
      aria-label={`Copy ${label} ${value}`}
      className="-mx-1.5 inline-flex min-h-7 items-center gap-1.5 rounded-xs px-1.5 font-mono text-small text-ink-3 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus-visible:text-ink max-md:min-h-11"
    >
      <span className="text-left break-all">{value}</span>
      <Icon name={copied ? "check" : "copy"} size={14} className={`shrink-0 ${copied ? "text-success" : ""}`} />
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

/* ---------------- feedback ---------------- */

/** A failure's Retry-After in seconds (a 429's or a 503's), 0 when it has none. */
export function retryAfterOf(error: unknown): number {
  return error instanceof ApiError ? (error.retryAfterS ?? 0) : 0;
}

/** A failure's words without their retry hint (lib/retry-hint.ts, which the site's "Try it" reads too). */
export { withoutRetryHint };

/** `message` replaces the error's own text (the request id still shows); `action` goes under it (a retry). */
export function ErrorNote({
  error,
  title = "That did not work",
  message,
  action,
  onRetry,
}: {
  error: unknown;
  title?: string;
  message?: string;
  action?: ReactNode;
  /** A Retry under the words; a Retry-After counts down in its place, and the words drop their own retry hint. */
  onRetry?: () => void;
}) {
  const described = describeError(error);
  const { requestId } = described;
  const left = useCountdown(onRetry ? retryAfterOf(error) : 0, error);
  const words = message ?? (onRetry ? withoutRetryHint(described.message) : described.message);
  // A row with a red glyph, no fill (the admin redesign's banner rule: no text band on a tint; a red panel shouted
  // louder than the page's one blue action, console audit finding 17): the glyph carries the tone, as Notice's does.
  // The alert is the title and the words (a11y audit 11-23, S5): the request id, renewed by each automatic retry, and
  // Retry's countdown sit outside it, so it is said once, and again only when the words change.
  return (
    <div className="flex gap-2.5 py-1 text-ui text-ink" data-error-note="">
      <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-danger" />
      <div className="min-w-0">
        <div role="alert">
          <p className="font-medium text-ink">{title}</p>
          <p className="mt-0.5 text-ink-2 text-pretty">{words}</p>
        </div>
        {requestId ? <p className="mt-1 font-mono text-caption break-all text-ink-3">request {requestId}</p> : null}
        {action ? <div className="mt-2">{action}</div> : null}
        {onRetry ? (
          <div className="mt-2">
            <Button size="sm" variant="neutral" icon="refresh" disabled={left > 0} onClick={onRetry}>
              {left > 0 ? `Retry in ${left} s` : "Retry"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A remark beside the thing it is about (AUDIT 2.4): no fill, no border (the admin redesign's banner rule: no text
 * band on a tint or the dot grid; a bordered tinted box for every remark was S19, inside a dialog's card S15); only
 * the icon carries the tone, as ErrorNote's does, the words in the quiet ink.
 */
export function Notice({ tone = "info", children }: { tone?: "info" | "warning"; children: ReactNode }) {
  return (
    <div className="flex gap-2.5 py-1 text-ui text-ink-2" data-notice={tone}>
      <Icon
        name={tone === "warning" ? "alert" : "info"}
        size={16}
        className={`mt-0.5 shrink-0 ${tone === "warning" ? "text-warning" : "text-ink-3"}`}
      />
      <div className="min-w-0 text-pretty">{children}</div>
    </div>
  );
}

/**
 * An empty list (AUDIT 2.5): two centred lines, the title and one line under it, and the page's one action only where
 * the header does not already have it; the library's QuietEmptyState with its quiet pixel field (DIRECTION 2). It was
 * the original's dotted box with a lifting icon tile (S14). At most 8 words (DIRECTION 3).
 */
export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return <QuietEmptyState title={title} description={body} action={action} />;
}

/** The original's skeleton. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <ConsoleSkeleton className={className} />;
}

/* ---------------- tabs (segmented) ---------------- */

// The original's Tabs (EXTRACT X5): revealTab and tabId move with them and keep their names here.
export { revealTab, tabId };

/**
 * The content of the selected tab, for a `Tabs` given the same `panelId`: role=tabpanel, labelled by that tab, so
 * a screen reader announces which tab's content this is.
 */
export function TabPanel({
  panelId,
  value,
  className,
  children,
}: {
  panelId: string;
  value: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="tabpanel" id={panelId} aria-labelledby={tabId(panelId, value)} className={className}>
      {children}
    </div>
  );
}

type TabItem<T extends string> = {
  value: T;
  label: ReactNode;
  count?: number;
  /** The tab's words where `label` is not plain text (the phone's select shows them). */
  text?: string;
};

/** A tab's words in the phone's select: "Sandboxes (15)". */
const optionText = <T extends string>(it: TabItem<T>) =>
  `${it.text ?? (typeof it.label === "string" ? it.label : it.value)}${it.count === undefined ? "" : ` (${it.count})`}`;

/** More tabs than this, and a phone shows the set as one select (AUDIT 2.6). */
export const PHONE_TABS_MAX = 4;

/**
 * The original's segmented tabs (EXTRACT X5). Under 640 px (AUDIT 2.6) a set of more than four renders as one select
 * (16 px text, 44 px tall, named by `label`), so no tab row scrolls sideways; four or fewer keep the row, each tab with
 * 8 px of padding a side. `phone="row"`: a set laid out for a phone already (the application's five short words);
 * `phone="select"`: four or fewer whose counts still do not fit (the webhook deliveries).
 */
export function Tabs<T extends string>({
  phone = "auto",
  ...props
}: {
  value: T;
  onChange: (v: T) => void;
  items: TabItem<T>[];
  label: string;
  className?: string;
  /** The id of the `TabPanel` that shows the selected tab: each tab gets an id and aria-controls it. */
  panelId?: string;
  phone?: "auto" | "row" | "select";
  /** `sm` for a set inside a panel's bar or under another set. */
  size?: "sm" | "md";
  /** No tray (the library's ghost tabs, the chosen one filled in ink): a set inside a panel or under another set. */
  quiet?: boolean;
}) {
  if (phone === "row" || (phone === "auto" && props.items.length <= PHONE_TABS_MAX)) return <ConsoleTabs {...props} />;
  return (
    <div className="min-w-0 max-sm:w-full" data-phone-tabs="">
      <div className={`sm:hidden ${props.className ?? ""}`}>
        <Select aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
          {props.items.map((it) => (
            <option key={it.value} value={it.value}>
              {optionText(it)}
            </option>
          ))}
        </Select>
      </div>
      <ConsoleTabs {...props} className={`max-sm:hidden ${props.className ?? ""}`} />
    </div>
  );
}

/* ---------------- meter ---------------- */

/** How close a count is to its limit: "danger" at 90 % and over, "warning" at 70 %, the colours a `Meter` fills in. */
export function usageTone(value: number, max: number): "danger" | "warning" | null {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return pct >= 90 ? "danger" : pct >= 70 ? "warning" : null;
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const level = usageTone(value, max);
  const tone = level === "danger" ? "bg-danger-dot" : level === "warning" ? "bg-warning-dot" : "bg-brand";
  return (
    <span
      className="relative block h-2 overflow-hidden rounded-full bg-surface-sunken shadow-groove"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <span
        className={`absolute inset-y-0 left-0 rounded-full ${tone}`}
        style={{ width: `${Math.max(pct, value > 0 ? 2 : 0)}%` }}
      />
    </span>
  );
}

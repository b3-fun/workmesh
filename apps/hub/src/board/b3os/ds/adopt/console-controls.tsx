// EXTRACT X5, adoption: the console's own controls (src/app/ui/primitives.tsx) drawn with the original B3OS's
// components. Each keeps the console's props, roles and behaviour, so the pages that import the old names and their
// tests stay as they are, and renders the ported component: the original's Button, Skeleton, Tabs, Input,
// Textarea and PixelLoader. The class strings here are compiled by the ds core stylesheet (ds/core.css) with the ds
// family's Tailwind rules, as the ported files' own are. Where the console's rules and the original differ, the owner's
// rule wins and the line says which (BRIEF.md "His rules", DIRECTION.md).
import {
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  Children,
  type ComponentPropsWithoutRef,
  type ComponentType,
  Fragment,
  type InputHTMLAttributes,
  isValidElement,
  type KeyboardEvent,
  type OptionHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/utils";
import { Button as DsButton } from "../primitives/button";
import { CheckBoxControl, type CheckBoxControlProps } from "../primitives/CheckBox";
import { Input } from "../primitives/input";
import { RadioGroup, RadioGroupItem } from "../primitives/radio-group";
import {
  Select as DsSelect,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../primitives/select";
import { Skeleton as DsSkeleton } from "../primitives/skeleton";
import { Tabs as DsTabs, TabsList, TabsTrigger } from "../primitives/tabs";
import { Textarea } from "../primitives/textarea";
import { PixelLoader } from "../signature/pixel-loader";

/* ---------------- buttons ---------------- */

export type ConsoleVariant = "brand" | "neutral" | "inverse" | "ghost" | "link" | "danger" | "destructive";
export type ConsoleSize = "xs" | "sm" | "md" | "lg" | "xl";

/** The console's variant names on the original's: neutral is its white button, inverse its black one. */
const DS_VARIANT = {
  brand: "brand",
  neutral: "white",
  inverse: "black",
  ghost: "ghost",
  link: "link-brand",
  danger: "ghost",
  destructive: "destructive",
} as const;

const VARIANT_CLASS: Record<ConsoleVariant, string> = {
  // The owner's rule (BRIEF "What he means": glow is AI slop; NEEDS 5, decided here): the brand button keeps the
  // original's 1 px ring and drop without its blue glow, the console's chrome token.
  brand: "shadow-[var(--b3os-chrome-brand)]",
  // A neutral button that opens something in the page (aria-expanded, such as Run with input) looks pressed while it
  // is open: the original's pressed fill.
  neutral:
    "aria-expanded:before:from-ds-neutral-200 aria-expanded:before:to-ds-neutral-100 dark:aria-expanded:before:from-ds-neutral-900 dark:aria-expanded:before:to-ds-neutral-800",
  inverse: "",
  // The original's ghost fills its hover, press and focus with the light neutrals in both themes (its app was light where
  // ghosts sat); in the console's dark the label (white) stood on #e4e4e7. Dark takes the dark neutrals (console area 5).
  ghost:
    "dark:hover:bg-ds-neutral-800 dark:active:bg-ds-neutral-800 dark:focus-visible:bg-ds-neutral-900 dark:aria-expanded:hover:bg-ds-neutral-800" +
    // A ghost toggle that is on (aria-pressed: a filter, Diff) is filled, as the quiet tabs' chosen one (console area 6).
    " aria-pressed:bg-ds-surface-sunken dark:aria-pressed:bg-ds-neutral-800",
  link: "",
  // The console's quiet destructive control (research/b3os-design.md §5.1), which the original does not have: the
  // original's ghost, grey at rest, red on a soft red wash under the pointer, keyboard focus or a press. Tailwind 4's
  // hover applies only where something hovers, so a touch screen does not keep a backed-out ConfirmButton red.
  danger:
    "text-ds-text-subtle hover:bg-ds-error-surface hover:text-ds-error-text focus-visible:text-ds-error-text active:bg-ds-error-surface active:text-ds-error-text",
  destructive: "",
};

/**
 * Keyboard focus as the rest of the console draws it (theme.css :focus-visible, a 2 px outline of the focus blue, 2 px
 * off): the original's buttons hide the outline and draw a 1 px or inset ring, so one screen showed two focus marks
 * (console area 1 fix, P1). One of them, everywhere: the console's.
 */
export const CONSOLE_FOCUS =
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--b3-focus) focus-visible:ring-0 focus-visible:after:shadow-none";

export interface ConsoleButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ConsoleVariant;
  size?: ConsoleSize;
  /** The glyph before the label (the console's 16 px icon). */
  iconNode?: ReactNode;
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * The console's Button on the original's. A caller's `b3os-btn--icon` (the old recipe's square icon button) becomes the
 * original's iconOnly; phones keep the console's 44 px floor (BRIEF: touch targets 44 px), links excepted as before.
 */
export function ConsoleButton({
  variant = "neutral",
  size = "md",
  iconNode,
  loading = false,
  className = "",
  children,
  disabled,
  type = "button",
  ...rest
}: ConsoleButtonProps) {
  const tokens = className.split(/\s+/).filter(Boolean);
  const iconOnly = tokens.includes("b3os-btn--icon");
  const own = tokens.filter((t) => t !== "b3os-btn--icon").join(" ");
  return (
    <DsButton
      type={type}
      variant={DS_VARIANT[variant]}
      size={size}
      iconOnly={iconOnly}
      data-variant={variant}
      // The original's overflow-hidden takes away a flex item's automatic minimum width: without min-w-max a button in a
      // tight row (a wrapping action row, a dialog's title line) shrank below its label and clipped it, where the
      // console's wrapped to the next line. An icon button keeps its square.
      className={cn(
        VARIANT_CLASS[variant],
        CONSOLE_FOCUS,
        // The foundation kit's press (admin redesign 1121, PHILOSOPHY P8: "a small pressed state"): 0.96 on press, on the
        // transform the original's 150 ms ease-out-quart transition already carries; never on a link.
        variant !== "link" && "active:not-disabled:[transform:scale(0.96)]",
        "min-w-max",
        iconOnly && "shrink-0",
        variant !== "link" && "max-md:min-h-11",
        // The disabled look while loading (DsButton's own disabled: is the attribute's).
        loading && "pointer-events-none opacity-30",
        own,
      )}
      // Loading keeps the button in the tab order (a disabled button that had focus dropped it to the page's body: a11y
      // audit 11-23, S2): aria-disabled and aria-busy say it, the disabled look is the same, and a press does nothing.
      disabled={disabled}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      {...rest}
      onClick={(e) => {
        if (loading) {
          e.preventDefault();
          return;
        }
        rest.onClick?.(e);
      }}
    >
      {loading ? (
        // Not part of the button's name ("Loading Running a security check": a11y audit M11).
        <span aria-hidden="true" className="contents">
          <PixelLoader
            size="xs"
            color={variant === "brand" || variant === "inverse" || variant === "destructive" ? "white" : "blue"}
          />
        </span>
      ) : (
        iconNode
      )}
      {children}
    </DsButton>
  );
}

export interface ConsoleButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: ConsoleVariant;
  size?: ConsoleSize;
  /** The glyph before the label (the console's 16 px icon), or any node (a pixel arrow after it goes in children). */
  iconNode?: ReactNode;
  /**
   * The element that draws the link: the console's router link for a route of its own (the page changes in place,
   * under /app), passed in by the caller so this boot-group module does not pull the router into its chunk; without it
   * a plain <a href>.
   */
  linkAs?: ComponentType<AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>;
}

/**
 * A link drawn as the console's Button: the original's Button with `asChild` around an <a> (NEEDS 15: links drawn as
 * buttons kept the old recipe classes, which look like the Button by its tokens but are not it). The same variants,
 * sizes and phone floor as ConsoleButton; a link has no disabled or loading state (aria-busy is the caller's).
 */
export function ConsoleButtonLink({
  variant = "neutral",
  size = "md",
  iconNode,
  className = "",
  children,
  linkAs: A,
  href = "",
  ...rest
}: ConsoleButtonLinkProps) {
  return (
    <DsButton
      asChild
      variant={DS_VARIANT[variant]}
      size={size}
      data-variant={variant}
      className={cn(
        VARIANT_CLASS[variant],
        CONSOLE_FOCUS,
        // The foundation kit's press (admin redesign 1121, PHILOSOPHY P8: "a small pressed state"): 0.96 on press, on the
        // transform the original's 150 ms ease-out-quart transition already carries; never on a link.
        variant !== "link" && "active:not-disabled:[transform:scale(0.96)]",
        "min-w-max",
        variant !== "link" && "max-md:min-h-11",
        className,
      )}
    >
      {A ? (
        <A href={href} {...rest}>
          {iconNode}
          {children}
        </A>
      ) : (
        <a href={href} {...rest}>
          {iconNode}
          {children}
        </a>
      )}
    </DsButton>
  );
}

/* ---------------- the loader ---------------- */

/** The console's in-button and inline loader: the original's 3 by 3 pixel loader, its calm default pattern. */
export function ConsolePixelLoader({ label = "Loading" }: { label?: string }) {
  return <PixelLoader size="xs" aria-label={label} />;
}

/* ---------------- form fields ---------------- */

/** Phones: 44 px tall and 16 px text, so iOS does not zoom (BRIEF: form fields 16 px, touch targets 44 px). */
const FIELD_PHONE = "max-md:h-11 max-md:text-base";

export function ConsoleTextInput({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <Input className={cn(FIELD_PHONE, className)} {...rest} />;
}

/**
 * In the console's mono (code and JSON go in it). NEEDS 7, decided here: the console keeps Geist Mono, the beta's one
 * mono (DIRECTION 1.1: one sans, one mono), where the original's fields fall back to the system's.
 */
export function ConsoleTextArea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <Textarea className={cn("font-mono leading-ds-relaxed max-md:text-base", className)} {...rest} />;
}

type SelectOption = { value: string; label: string; disabled?: boolean };
type SelectEntry = SelectOption | { group: string; options: SelectOption[] };

/** The words of an <option>'s children ("{org} / {name}" is two strings and a slash). */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

/** The callers' <option> and <optgroup> children, read as the listbox's items (fragments and arrays flattened). */
function readOptions(children: ReactNode): SelectEntry[] {
  const out: SelectEntry[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const props = child.props as OptionHTMLAttributes<HTMLOptionElement> & { label?: string; children?: ReactNode };
    if (child.type === Fragment) out.push(...readOptions(props.children));
    else if (child.type === "option") {
      const label = textOf(props.children);
      out.push({ value: props.value === undefined ? label : String(props.value), label, disabled: props.disabled });
    } else if (child.type === "optgroup")
      out.push({
        group: String(props.label ?? ""),
        options: readOptions(props.children).filter((e): e is SelectOption => !("group" in e)),
      });
  });
  return out;
}

/** Radix's items may not have an empty value; the console's "All", "Default" and "Not set" options do. */
const EMPTY_VALUE = "__b3os-empty__";
const toListbox = (v: string) => (v === "" ? EMPTY_VALUE : v);
const fromListbox = (v: string) => (v === EMPTY_VALUE ? "" : v);

/**
 * The console's select on the original's (Radix's listbox, primitives/select.tsx): the owner, 11-12, "no native inputs
 * (radio, checkbox, textareas, input, drop-down, selects)" (console area 2 fix, R1). The callers keep the native
 * select's props: `value` or `defaultValue`, `<option>` and `<optgroup>` children, and `onChange(e)` with
 * `e.target.value`, so the 28 pages that use it are unchanged. The trigger is drawn as the console's Input (sunken, the
 * inset shadow, 40 px, 44 px and 16 px text on a phone) and takes the id, the aria props and the class; it carries the
 * value as its `value` attribute, as a select did. A form field's `name` and `required` go on a hidden input that holds
 * the real value (an empty choice is "" there, so the browser's required check still stops the submit and points at
 * the field).
 */
export function ConsoleSelect({
  className = "",
  children,
  value,
  defaultValue,
  onChange,
  disabled,
  name,
  required,
  form,
  ...trigger
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const entries = readOptions(children);
  const flat = entries.flatMap((e) => ("group" in e ? e.options : [e]));
  const controlled = value !== undefined;
  const [own, setOwn] = useState(() => String(defaultValue ?? flat.find((o) => !o.disabled)?.value ?? ""));
  const current = controlled ? String(value) : own;
  const triggerRef = useRef<HTMLButtonElement>(null);
  // A value that matches no option: the native select showed its first option, so the trigger does too.
  const shown = flat.some((o) => o.value === current) ? undefined : flat.find((o) => !o.disabled)?.label;
  const item = (o: SelectOption) => (
    <SelectItem
      key={o.value}
      value={toListbox(o.value)}
      disabled={o.disabled}
      data-value={o.value}
      className="text-sm max-md:min-h-11 max-md:items-center max-md:text-base"
    >
      {o.label}
    </SelectItem>
  );
  return (
    <span className="relative block min-w-0">
      <DsSelect
        value={toListbox(current)}
        onValueChange={(v) => {
          const next = fromListbox(v);
          if (!controlled) setOwn(next);
          // The native change event's shape the callers read: e.target.value (and currentTarget, name).
          const target = { value: next, name: name ?? "" };
          onChange?.({ target, currentTarget: target } as unknown as ChangeEvent<HTMLSelectElement>);
        }}
        disabled={disabled}
      >
        <SelectTrigger
          ref={triggerRef}
          value={current}
          className={cn(
            "bg-ds-surface-sunken shadow-ds-input-inset gap-2 rounded-ds-xs text-left",
            FIELD_PHONE,
            className,
          )}
          {...(trigger as ComponentPropsWithoutRef<typeof SelectTrigger>)}
        >
          <SelectValue placeholder={shown} />
        </SelectTrigger>
        {/* Never wider than the screen leaves it (a phone: its long items wrap), 8 px off the screen's edges. */}
        <SelectContent collisionPadding={8} className="max-w-[var(--radix-select-content-available-width)]">
          {entries.map((e) =>
            "group" in e ? (
              <SelectGroup key={`group:${e.group}`}>
                <SelectLabel className="text-ds-text-muted pl-2 text-xs font-medium normal-case">{e.group}</SelectLabel>
                {e.options.map(item)}
              </SelectGroup>
            ) : (
              item(e)
            ),
          )}
        </SelectContent>
      </DsSelect>
      {name || required ? (
        <input
          aria-hidden="true"
          tabIndex={-1}
          name={name}
          form={form}
          required={required}
          value={current}
          onChange={() => {}}
          onFocus={() => triggerRef.current?.focus()}
          className="pointer-events-none absolute inset-0 size-full opacity-0"
        />
      ) : null}
    </span>
  );
}

/* ---------------- checkbox and radio ---------------- */

/**
 * The console's checkbox: the original's box (primitives/CheckBox, brand, 16 px; Radix's checkbox, a button), with the
 * console's focus ring (console area 2 fix, R1: no native control). It sits inside the caller's <label>, which names
 * it and gives it the row's 44 px touch target; an `aria-label` names one with no label text (a grid of scopes).
 */
export function ConsoleCheckbox({ className, ...rest }: Omit<CheckBoxControlProps, "size" | "variant">) {
  return <CheckBoxControl size="sm" variant="brand" className={cn(CONSOLE_FOCUS, "mt-0", className)} {...rest} />;
}

/**
 * One choice of a ConsoleRadioGroup: the original's radio (primitives/radio-group), with the console's focus ring. Like
 * the checkbox it sits inside the caller's <label>.
 */
export function ConsoleRadio({ className, ...rest }: ComponentPropsWithoutRef<typeof RadioGroupItem>) {
  // The owner's rule (no glow; NEEDS 5, as the brand button): the chosen dot without the original's 12 px blue glow.
  return (
    <RadioGroupItem
      className={cn(CONSOLE_FOCUS, "shrink-0 focus-visible:ring-0 [&_span]:shadow-none", className)}
      {...rest}
    />
  );
}

/** The group the radios belong to (Radix's: arrow keys move and choose, Tab enters on the chosen one). */
export function ConsoleRadioGroup({ className, ...rest }: ComponentPropsWithoutRef<typeof RadioGroup>) {
  return <RadioGroup className={cn("gap-0", className)} {...rest} />;
}

/* ---------------- skeleton ---------------- */

/** A placeholder in the shape of what loads: the original's skeleton (its pulse; still with reduced motion). */
export function ConsoleSkeleton({ className = "" }: { className?: string }) {
  return <DsSkeleton aria-hidden="true" className={cn("block min-h-3 motion-reduce:animate-none", className)} />;
}

/* ---------------- tabs ---------------- */

/** Scrolls a tab row sideways, and only it, so `tab` is inside its visible width. */
export function revealTab(tab: HTMLElement | null | undefined) {
  const row = tab?.parentElement;
  if (!tab || !row || row.scrollWidth <= row.clientWidth) return;
  const left = tab.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft;
  if (left < row.scrollLeft) row.scrollLeft = Math.max(0, left - 16);
  else if (left + tab.offsetWidth > row.scrollLeft + row.clientWidth)
    row.scrollLeft = left + tab.offsetWidth - row.clientWidth + 16;
}

/** The id of a tab in a set whose panel is `panelId`: the panel is labelled by the selected tab. */
export const tabId = (panelId: string, value: string) => `${panelId}-tab-${value}`;

/**
 * The console's segmented tabs on the original's (Radix Tabs, its default variant: a sunken strip with the selected tab
 * raised). Radix's root holds only the list: the page draws the selected tab's content in its own TabPanel, labelled
 * by the tab's id as before. A click selects as the console's did (Radix itself selects on mouse down and on focus).
 */
export function ConsoleTabs<T extends string>({
  value,
  onChange,
  items,
  label,
  className = "",
  panelId,
  size = "md",
  quiet = false,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: ReactNode; count?: number; text?: string }[];
  label: string;
  className?: string;
  panelId?: string;
  /** The library's sizes: `sm` (28 px) for a set inside a panel's bar or under another set. */
  size?: "sm" | "md";
  /**
   * No tray: the library's ghost tabs, the chosen one a filled surface in ink (console area 2 fix, P1 and F4: a set
   * inside a panel or under another set, so a screen shows one tray).
   */
  quiet?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = items.findIndex((it) => it.value === value);
  // A row wider than a phone scrolls sideways inside itself; keep the selected tab in view, as when a link opens a
  // page on a tab past the right edge.
  useEffect(() => {
    if (selected >= 0) revealTab(refs.current[selected]);
  }, [selected]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    // Home and End as the console's tabs had them (Radix's roving focus moves focus there; this selects too).
    if (e.key !== "Home" && e.key !== "End") return;
    const item = items[e.key === "Home" ? 0 : items.length - 1];
    if (item && i >= 0) onChange(item.value);
  };
  return (
    <DsTabs
      value={value}
      onValueChange={(v) => onChange(v as T)}
      activationMode="automatic"
      size={size}
      variant={quiet ? "ghost" : "default"}
      // Never wider than its column: the list scrolls sideways inside it (a11y audit 11-23, S6: at 320 px a grid or a
      // wrapping row took the tabs' full width as its least and pushed the page past the window).
      className="min-w-0 max-w-full"
    >
      <TabsList aria-label={label} className={cn("max-w-full overflow-x-auto", className)}>
        {items.map((it, i) => (
          <TabsTrigger
            key={it.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            value={it.value}
            id={panelId ? tabId(panelId, it.value) : undefined}
            aria-controls={panelId}
            count={it.count}
            onClick={() => {
              if (it.value !== value) onChange(it.value);
            }}
            onKeyDown={(e) => onKey(e, i)}
            // A phone: 8 px a side, so four tabs fit 390 px (AUDIT 2.6; a set of more is a select there).
            className={cn(
              "shrink-0 max-md:min-h-11 max-sm:px-2",
              // On the tray, an unchosen tab's words in the second ink: the muted one was 4.31:1 on it (a11y S10).
              !quiet && "data-[state=inactive]:text-ds-text-subtle dark:data-[state=inactive]:text-ds-text-muted",
              quiet &&
                "data-[state=active]:bg-ds-surface-sunken data-[state=active]:text-ds-text-primary dark:data-[state=active]:bg-ds-surface-sunken dark:data-[state=active]:text-ds-text-primary",
            )}
          >
            {it.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </DsTabs>
  );
}

/* ---------------- copy ---------------- */

/**
 * The read-only value box of the original's CopyField (layout/form-field.tsx), without its label line, in the
 * console's mono (NEEDS 7, as ConsoleTextArea).
 */
export const COPY_VALUE_CLASS =
  "border-ds-border-default bg-ds-surface-raised text-ds-text-primary rounded-ds-md min-w-0 flex-1 border px-3 py-2 font-mono text-xs";

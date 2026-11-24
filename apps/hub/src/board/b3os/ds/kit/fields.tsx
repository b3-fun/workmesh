// Label and value pairs and the control row under them (a drawer's facts, a settings section's), in a module of their
// own (perf audit 11-23): a page with a fact list and no drawer (sign-in's access pages, Keys' facts) loads neither vaul
// nor the dialog.
import type { FormEvent, ReactNode } from "react";
import { cn } from "../lib/utils";
import "./css/lite.css";
import "./kit.css";

/** Label and value pairs (a request's method, status, time): two columns on a desktop, stacked on a phone. */
export function Fields({
  rows,
  ruled = false,
}: {
  rows: readonly { label: ReactNode; value: ReactNode }[];
  /**
   * A settings section's facts: a rule above, a hairline under each row, 48 px rows with a 160 px label column (one
   * column on a phone), the value at the body's size.
   */
  ruled?: boolean;
}) {
  return (
    <dl className="kit-fields" data-ruled={ruled ? "" : undefined}>
      {rows.map((r, i) => (
        <div key={i} className="kit-fields__row">
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A field and its button on one line inside a fact's value (an organization's name and Save), stacked on a phone: the
 * control row of ruled Fields.
 */
export function InlineForm({
  onSubmit,
  children,
  label,
  className,
}: {
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <form className={cn("kit-inline-form", className)} onSubmit={onSubmit} aria-label={label}>
      {children}
    </form>
  );
}

import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { SessionState } from "../../shared/types";
import { age, useNow } from "../time";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-semibold whitespace-nowrap",
        "transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98] disabled:cursor-default disabled:opacity-50",
        "max-sm:h-10",
        variant === "primary" && "bg-accent text-accent-fg hover:brightness-110",
        variant === "secondary" && "border border-line-strong bg-surface text-fg hover:bg-hover",
        variant === "ghost" && "text-muted hover:bg-hover hover:text-fg",
        variant === "danger" && "bg-bad text-white hover:brightness-110",
        className,
      )}
    />
  );
}

export function StateDot({ state, offline }: { state: SessionState; offline?: boolean }) {
  const dim = offline || state === "ended";
  return (
    <span
      aria-hidden
      className={cx(
        "inline-block size-[7px] shrink-0 rounded-full",
        dim && "border border-faint bg-transparent",
        !dim && state === "working" && "bg-ok",
        !dim && state === "waiting" && "bg-warn",
        !dim && state === "idle" && "bg-faint",
      )}
    />
  );
}

export function stateLabel(state: SessionState, offline: boolean): string {
  if (offline) return "offline";
  return state;
}

export function IssueChip({ id }: { id: string }) {
  return (
    <a
      href={`https://linear.app/npclabs/issue/${id}`}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="rounded-[4px] border border-line px-1 py-px font-mono text-[11px] leading-[16px] text-muted transition-colors hover:border-accent hover:text-accent"
    >
      {id}
    </a>
  );
}

/** Relative age that ticks every second. */
export function Age({ ts, className }: { ts: number | null | undefined; className?: string }) {
  const now = useNow();
  if (!ts) return null;
  return <span className={cx("tnum font-mono", className)}>{age(now - ts)}</span>;
}

export function ColumnHeader({ title, count, children }: { title: string; count?: number; children?: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-3 px-4">
      <h2 className="flex items-baseline gap-2 text-[12px] font-semibold tracking-[0.01em] text-muted">
        {title}
        {count != null && <span className="tnum font-mono text-[11px] font-normal text-faint">{count}</span>}
      </h2>
      {children}
    </div>
  );
}

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-sunk py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 flex-1 font-mono text-[12.5px] [overflow-wrap:anywhere] text-fg sm:overflow-x-auto sm:whitespace-nowrap sm:scroll-thin">
        <span className="text-faint select-none">$ </span>
        {command}
      </code>
      <Button
        variant="ghost"
        className="h-7 px-2 max-sm:h-9"
        aria-label={copied ? "Copied" : "Copy command"}
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <IconCheck /> : <IconCopy />}
        <span className="text-[12px] font-medium max-sm:sr-only">{copied ? "Copied" : "Copy"}</span>
      </Button>
    </div>
  );
}

const iconProps = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  // Icon-only buttons pass px-0, which can lose to the base px-3; never let the icon be squeezed.
  style: { flexShrink: 0 },
};

export const IconCopy = () => (
  <svg {...iconProps}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
  </svg>
);
export const IconCheck = () => (
  <svg {...iconProps}>
    <path d="m3.5 8.5 3 3 6-7" />
  </svg>
);
export const IconChevron = ({ open }: { open?: boolean }) => (
  <svg {...iconProps} width={12} height={12}>
    <path d={open ? "m4 6 4 4 4-4" : "m6 4 4 4-4 4"} />
  </svg>
);
export const IconClose = ({ size = 14 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
);
export const IconPlus = () => (
  <svg {...iconProps}>
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

/** A clickable row that may contain links (a <button> may not). */
export function Row({
  onActivate,
  pressed,
  className,
  children,
  label,
}: {
  onActivate: () => void;
  pressed?: boolean;
  className?: string;
  children: ReactNode;
  label?: string;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={pressed}
      aria-label={label}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      className={cx("cursor-pointer outline-offset-[-2px]", className)}
    >
      {children}
    </div>
  );
}

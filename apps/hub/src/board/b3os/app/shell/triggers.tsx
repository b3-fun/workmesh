// The sidebar's two menu buttons, drawn once for both states: the first paint (static, in the dashboard's first load)
// and the Radix menus that load right after (menus.tsx: the dropdown and the popover stay out of the first load, as
// every ds menu does). Same markup in both, so nothing moves when the menus arrive.

import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { Icon } from "../../ui/Icon";

/** The original's glossy Create button (MainSidebar's "Create New Workflow"): brand gradient, pressed at 0.96. */
export const CreateTrigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function CreateTrigger({ className = "", ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className={`side-create ${className}`}
        aria-haspopup="menu"
        data-pixel-pulse=""
        {...rest}
      >
        <Icon name="plus" size={14} />
        <span>Create</span>
      </button>
    );
  },
);

/** A project's initial on the original's pressed tile (UserOrgSwitcher's avatar disc, square for a project). */
export function ProjectTile({ name, size = 32 }: { name: string; size?: number }) {
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span className="side-tile" style={{ width: size, height: size }} aria-hidden="true">
      {letter}
    </span>
  );
}

/** The original's account card (UserOrgSwitcher's trigger): the project, its organization in caps, a badge slot. */
export const AccountTrigger = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { project: string; org: string; badge?: ReactNode }
>(function AccountTrigger({ project, org, badge, className = "", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={`side-account ${className}`}
      aria-label={`Project ${project}, ${org}. Switch project or organization`}
      {...rest}
    >
      <span className="relative shrink-0">
        <ProjectTile name={project} />
        {badge}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="side-account__project">{project}</span>
        <span className="side-account__org">{org}</span>
      </span>
      <Icon name="chevronUpDown" size={14} className="shrink-0 text-ink-3" />
    </button>
  );
});

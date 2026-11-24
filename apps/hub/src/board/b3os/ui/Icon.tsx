/**
 * One outline icon set for the whole site and dashboard: 18 px grid, 1.5 px stroke, square caps
 * (research/b3os-design.md §7). Icons are currentColor and decorative unless given a label.
 */
import type { ReactNode } from "react";

const PATHS = {
  copy: (
    <>
      <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
      <path d="M3.5 11.5v-7a1 1 0 0 1 1-1h7" />
    </>
  ),
  check: <path d="M3.5 9.5 7 13l7.5-8" />,
  arrowRight: <path d="M3.5 9h11M10.5 5l4 4-4 4" />,
  arrowLeft: <path d="M14.5 9h-11M7.5 5l-4 4 4 4" />,
  external: <path d="M7 4.5h6.5V11M13.5 4.5l-9 9" />,
  menu: <path d="M3 5.5h12M3 9h12M3 12.5h12" />,
  more: <path d="M4.5 9h.01M9 9h.01M13.5 9h.01" strokeWidth="2.25" />,
  close: <path d="m4.5 4.5 9 9M13.5 4.5l-9 9" />,
  closeCircle: (
    <>
      <circle cx="9" cy="9" r="6.5" />
      <path d="m6.75 6.75 4.5 4.5M11.25 6.75l-4.5 4.5" />
    </>
  ),
  chevronUpDown: <path d="m6 7 3-3 3 3M6 11l3 3 3-3" />,
  help: (
    <>
      <circle cx="9" cy="9" r="6.5" />
      <path d="M7.25 7.25a1.75 1.75 0 1 1 2.5 1.6c-.5.25-.75.6-.75 1.15v.25M9 12.25v.01" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="5" height="5" rx="1" />
      <rect x="10" y="3" width="5" height="5" rx="1" />
      <rect x="3" y="10" width="5" height="5" rx="1" />
      <rect x="10" y="10" width="5" height="5" rx="1" />
    </>
  ),
  gamepad: (
    <>
      <rect x="2.5" y="5.5" width="13" height="7.5" rx="2.5" />
      <path d="M5.5 9.25h2.5M6.75 8v2.5M11.5 8.75h.01M13 10h.01" />
    </>
  ),
  sun: (
    <>
      <circle cx="9" cy="9" r="3" />
      <path d="M9 1.75v1.5M9 14.75v1.5M1.75 9h1.5M14.75 9h1.5M3.87 3.87l1.06 1.06M13.07 13.07l1.06 1.06M3.87 14.13l1.06-1.06M13.07 4.93l1.06-1.06" />
    </>
  ),
  moon: <path d="M14.5 10.6A5.75 5.75 0 0 1 7.4 3.5a5.75 5.75 0 1 0 7.1 7.1Z" />,
  monitor: (
    <>
      <rect x="2.5" y="3.5" width="13" height="9" rx="1.5" />
      <path d="M6.5 15.5h5M9 12.5v3" />
    </>
  ),
  vision: (
    <>
      <rect x="2.5" y="3.5" width="13" height="11" rx="2" />
      <path d="M2.5 6.5h13M5 5h.01M6.75 5h.01" />
    </>
  ),
  render: (
    <>
      <rect x="2.5" y="3.5" width="13" height="11" rx="2" />
      <path d="m7.5 6.75 3.75 2.25-3.75 2.25Z" />
    </>
  ),
  sandboxes: (
    <>
      <rect x="2.5" y="3.5" width="13" height="11" rx="2" />
      <path d="m5.5 7.25 2 1.75-2 1.75M9.5 11h3" />
    </>
  ),
  routines: (
    <>
      <circle cx="4.5" cy="4.5" r="1.75" />
      <circle cx="4.5" cy="13.5" r="1.75" />
      <circle cx="13.5" cy="9" r="1.75" />
      <path d="M6.25 4.5H8a2 2 0 0 1 2 2V7a2 2 0 0 0 2 2M6.25 13.5H8a2 2 0 0 0 2-2V11a2 2 0 0 1 2-2" />
    </>
  ),
  actions: <path d="M10 2.5 4.5 10H9l-1 5.5L13.5 8H9Z" />,
  infer: (
    <>
      <rect x="5" y="5" width="8" height="8" rx="1" />
      <path d="M7 2.5V5M11 2.5V5M7 13v2.5M11 13v2.5M2.5 7H5M2.5 11H5M13 7h2.5M13 11h2.5" />
    </>
  ),
  key: (
    <>
      <circle cx="6" cy="12" r="3" />
      <path d="m8.2 9.8 6.3-6.3M12.5 5.5l2 2M10.5 7.5 12 9" />
    </>
  ),
  usage: <path d="M3 15h12M5.5 12V8.5M9 12V4.5M12.5 12V9.5" />,
  limits: (
    <>
      <path d="M3 13a6 6 0 1 1 12 0" />
      <path d="m9 13 3-4" />
    </>
  ),
  requests: <path d="M6.5 5h8M6.5 9h8M6.5 13h8M3.5 5h.01M3.5 9h.01M3.5 13h.01" />,
  // A trace: its calls as staggered bars on a time axis (a waterfall), on the set's 18 px grid.
  trace: <path d="M3 2.75v12.5M5.5 5h5.5M8 9h6.5M11 13h4.25" />,
  marketplace: (
    <>
      <rect x="3" y="3" width="5" height="5" rx="1" />
      <rect x="10" y="3" width="5" height="5" rx="1" />
      <rect x="3" y="10" width="5" height="5" rx="1" />
      <rect x="10" y="10" width="5" height="5" rx="1" />
    </>
  ),
  link: (
    <path d="m7.5 10.5 3-3M8 5.5l1.5-1.5a3 3 0 0 1 4.25 4.25L12.25 9.75M10 12.5l-1.5 1.5a3 3 0 0 1-4.25-4.25L5.75 8.25" />
  ),
  /** An event leaving for an endpoint: one source, two receivers. */
  webhook: (
    <>
      <circle cx="9" cy="4.75" r="2" />
      <circle cx="4.5" cy="13.25" r="2" />
      <circle cx="13.5" cy="13.25" r="2" />
      <path d="M8 6.5 5.5 11.5M10 6.5l2.5 5M6.5 13.25h5" />
    </>
  ),
  playground: <path d="m6.5 5-4 4 4 4M11.5 5l4 4-4 4" />,
  settings: (
    <>
      <path d="M3 5h7M13.5 5H15M3 13h1.5M8 13h7" />
      <circle cx="11.75" cy="5" r="1.75" />
      <circle cx="6.25" cy="13" r="1.75" />
    </>
  ),
  logout: <path d="M7 3.5H4.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H7M11 6l3 3-3 3M14 9H7" />,
  plus: <path d="M9 3.5v11M3.5 9h11" />,
  minus: <path d="M3.5 9h11" />,
  trash: <path d="M3.5 5h11M7 5V3.5h4V5M5 5l.75 9.5h6.5L13 5" />,
  refresh: <path d="M14.5 9a5.5 5.5 0 1 1-1.6-3.9M14.5 3.5v3h-3" />,
  search: (
    <>
      <circle cx="8" cy="8" r="4.5" />
      <path d="m11.5 11.5 3 3" />
    </>
  ),
  chevronRight: <path d="M7 4.5 11.5 9 7 13.5" />,
  chevronDown: <path d="M4.5 7 9 11.5 13.5 7" />,
  /* EXTRACT X1: the up and left chevrons the original B3OS's select and calendar use (drawn mirrored, not rotated) */
  chevronUp: <path d="M4.5 11 9 6.5 13.5 11" />,
  chevronLeft: <path d="M11 4.5 6.5 9 11 13.5" />,
  mail: (
    <>
      <rect x="2.5" y="4" width="13" height="10" rx="1.5" />
      <path d="m3 5 6 4.5L15 5" />
    </>
  ),
  docs: (
    <path d="M3.5 3.5h4A1.5 1.5 0 0 1 9 5v9.5A1.5 1.5 0 0 0 7.5 13h-4ZM14.5 3.5h-4A1.5 1.5 0 0 0 9 5v9.5a1.5 1.5 0 0 1 1.5-1.5h4Z" />
  ),
  layers: <path d="M9 2.75 15.25 6 9 9.25 2.75 6ZM2.75 9.25 9 12.5l6.25-3.25M2.75 12.25 9 15.5l6.25-3.25" />,
  pause: <path d="M6.5 4.5v9M11.5 4.5v9" />,
  stop: <rect x="4.5" y="4.5" width="9" height="9" rx="1" />,
  play: <path d="m6 4 8 5-8 5Z" />,
  home: <path d="M3 8.5 9 3.5l6 5V15H3ZM7 15v-4h4v4" />,
  user: (
    <>
      <circle cx="9" cy="6.5" r="3" />
      <path d="M3.5 15.5a5.5 5.5 0 0 1 11 0" />
    </>
  ),
  info: (
    <>
      <circle cx="9" cy="9" r="6.5" />
      <path d="M9 8.25v4M9 5.75v.01" />
    </>
  ),
  alert: <path d="M9 3 15.5 14.5h-13ZM9 7.5V11M9 12.75v.01" />,
  clock: (
    <>
      <circle cx="9" cy="9" r="6.5" />
      <path d="M9 5.5V9l2.5 1.5" />
    </>
  ),
  image: (
    <>
      <rect x="2.5" y="3.5" width="13" height="11" rx="1.5" />
      <circle cx="6.5" cy="7.5" r="1.25" />
      <path d="m2.5 12.5 3.5-3 3 2.5 2.5-2 4 3.5" />
    </>
  ),
  video: (
    <>
      <rect x="2.5" y="4" width="10" height="10" rx="1.5" />
      <path d="m12.5 7.5 3-2v7l-3-2" />
    </>
  ),
  file: <path d="M4.5 2.5h6l3 3v10h-9ZM10.5 2.5v3h3" />,
  // A directory: central-icons' folder-1 (square-outlined, radius 0, stroke 1.5) on the 18 px grid.
  folder: <path d="M2.25 3.25H7.5L9 5.5h6.75v9.25H2.25Z" />,
  download: <path d="M9 3v8.5M5.5 8 9 11.5 12.5 8M3.5 15h11" />,
  /** The deploy product: the download glyph turned up (a build leaving for the node). */
  deploy: <path d="M9 11.5V3M5.5 6.5 9 3l3.5 3.5M3.5 15h11" />,
  // Its own glyph, the tray kept at the foot (console area 5 fix: the Files tab drew download turned 180 degrees, and a
  // graphic is never rotated).
  upload: <path d="M9 12V3.5M5.5 7 9 3.5 12.5 7M3.5 15h11" />,
  eye: (
    <>
      <path d="M1.75 9S4.5 4 9 4s7.25 5 7.25 5S13.5 14 9 14 1.75 9 1.75 9Z" />
      <circle cx="9" cy="9" r="2.25" />
    </>
  ),
  globe: (
    <>
      <circle cx="9" cy="9" r="6.5" />
      <path d="M2.5 9h13M9 2.5c2 2 2 11 0 13M9 2.5c-2 2-2 11 0 13" />
    </>
  ),
  versions: (
    <>
      <circle cx="5" cy="4.5" r="1.75" />
      <circle cx="5" cy="13.5" r="1.75" />
      <circle cx="13" cy="6.5" r="1.75" />
      <path d="M5 6.25v5.5M13 8.25c0 3-8 2-8 3.5" />
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="8" width="11" height="7.5" rx="1.5" />
      <path d="M6 8V5.75a3 3 0 0 1 6 0V8" />
    </>
  ),
  terminal: (
    <>
      <rect x="2.5" y="3.5" width="13" height="11" rx="2" />
      <path d="m5.5 7.25 2 1.75-2 1.75M9.5 11h3" />
    </>
  ),
  status: (
    <>
      <circle cx="9" cy="9" r="6.5" />
      <path d="M5.5 9h1.75l1-2.5 1.5 5 1-2.5h1.75" />
    </>
  ),
  database: (
    <>
      <ellipse cx="9" cy="4.75" rx="5.5" ry="2" />
      <path d="M3.5 4.75v8.5c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2v-8.5M3.5 9c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2" />
    </>
  ),
  volume: (
    <>
      <rect x="2.75" y="5.25" width="12.5" height="7.5" rx="1.5" />
      <path d="M2.75 9.75h12.5M11.25 11.25h1.5" />
    </>
  ),
  commit: (
    <>
      <circle cx="9" cy="9" r="2.75" />
      <path d="M1.75 9h4.5M11.75 9h4.5" />
    </>
  ),
  branch: (
    <>
      <circle cx="5" cy="4.25" r="1.75" />
      <circle cx="5" cy="13.75" r="1.75" />
      <circle cx="13" cy="5.75" r="1.75" />
      <path d="M5 6v6M13 7.5c0 3.5-8 2.5-8 4.5" />
    </>
  ),
  rollback: <path d="M4.5 6.5h6.25a3.75 3.75 0 0 1 0 7.5H7M7.5 3.5l-3 3 3 3" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 18,
  label,
  className,
}: {
  name: IconName;
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 18 18"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="round"
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** GitHub's mark (filled brand glyph, used only on the sign-in button). */
export function GitHubMark({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

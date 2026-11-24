import { useSyncExternalStore } from "react";

// One shared 1 s ticker so relative ages tick without each row owning a timer.
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(fn: () => void) {
  listeners.add(fn);
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Server clock offset (serverNow - Date.now()), set from /api/state. */
let offset = 0;
export function setServerOffset(ms: number) {
  offset = Math.abs(ms) < 5_000 ? 0 : ms;
}

/** Ticking "now" on the server's clock. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now + offset);
}

export function serverNow(): number {
  return Date.now() + offset;
}

/** 12s, 4m, 3h, 2d */
export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** 4m 05s under an hour, then 1h 12m: for waits, where the seconds matter early on. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const clockFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
export function clock(ts: number): string {
  return clockFmt.format(new Date(ts));
}

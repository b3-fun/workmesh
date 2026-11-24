// A Retry-After's countdown (InlineError, app/ui's LoadError and ErrorNote, Usage's ReadFailed). Its own module, with no
// chart or kit imports, so the first load can hold it (vite.config.ts EXTRACT rule 4 keeps kit/charts lazy).
import { useEffect, useState } from "react";

/**
 * Seconds left of a wait (a 429's or a 503's Retry-After), counting down to 0. It starts again when `seconds` or `key`
 * changes (a new failure with the same wait).
 */
export function useCountdown(seconds: number | undefined, key?: unknown): number {
  const total = Math.max(0, Math.ceil(seconds ?? 0));
  const [left, setLeft] = useState(total);
  useEffect(() => {
    setLeft(total);
    if (!total) return;
    const started = Date.now();
    const t = setInterval(() => {
      const rest = Math.max(0, total - Math.floor((Date.now() - started) / 1000));
      setLeft(rest);
      if (rest === 0) clearInterval(t);
    }, 250);
    return () => clearInterval(t);
  }, [total, key]);
  return left;
}

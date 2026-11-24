// Whether a media query matches, kept current (the kit's drawer and dialog pick their phone form with it).
import { useEffect, useState } from "react";

/** The kit's phone breakpoint: under 768 px a dialog is a drawer and a detail panel a bottom sheet. */
export const PHONE = "(max-width: 767px)";

export function useMediaQuery(query: string): boolean {
  const get = () => {
    try {
      return typeof window !== "undefined" && window.matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  const [on, setOn] = useState(get);
  useEffect(() => {
    let m: MediaQueryList;
    try {
      m = window.matchMedia(query);
    } catch {
      return;
    }
    const f = () => setOn(m.matches);
    f();
    m.addEventListener?.("change", f);
    return () => m.removeEventListener?.("change", f);
  }, [query]);
  return on;
}

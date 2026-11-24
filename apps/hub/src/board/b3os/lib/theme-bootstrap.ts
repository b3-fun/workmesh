/**
 * Runs inline in <head> before CSS paints (research/b3os-design.md §14.2), so no page flashes the wrong theme. Order:
 * ?theme= > saved choice > light. Every page, the dashboard and the site, is light until the reader picks (the owner,
 * 11-21: "default to light mode not system mode"); only a saved "system" choice follows the system. The build hashes
 * this exact string for the CSP (scripts/build.mjs).
 */
export const THEME_STORAGE_KEY = "b3os-theme";

export const THEME_BOOTSTRAP = `(function(){try{var d=document.documentElement,q=new URLSearchParams(location.search).get("theme"),s=localStorage.getItem("${THEME_STORAGE_KEY}"),m=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light",t=q==="dark"||q==="light"?q:s==="dark"||s==="light"?s:s==="system"?m:"light";d.setAttribute("data-theme",t)}catch(e){}})();`;

export type ThemeChoice = "light" | "dark" | "system";

export function readThemeChoice(): ThemeChoice | null {
  try {
    const s = localStorage.getItem(THEME_STORAGE_KEY);
    return s === "light" || s === "dark" || s === "system" ? s : null;
  } catch {
    return null;
  }
}

/** The theme a choice draws: light with no choice, the system's only for "system". `_marketing` is kept for callers. */
export function resolveTheme(choice: ThemeChoice | null, _marketing = false): "light" | "dark" {
  if (choice === "dark") return "dark";
  if (choice === "system")
    return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return "light";
}

export function applyTheme(choice: ThemeChoice): "light" | "dark" {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Private mode or blocked storage: the choice applies to this page only.
  }
  const root = document.documentElement;
  const theme = resolveTheme(choice, root.hasAttribute("data-marketing"));
  root.setAttribute("data-theme", theme);
  return theme;
}

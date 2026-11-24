// One polite live region for the kit's passing words ("Copied", a toast's title), made as soon as a module that speaks
// loads, so it is in the page before its first message (a11y audit 11-23: a region inserted already holding its words
// is not read, which made the first toast on a page silent, S11; and every copy button and sparkline carried a region of
// its own, read even behind an open modal, M10). No stylesheet: it hides itself inline.
let region: HTMLElement | null = null;

function ensure(): HTMLElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  if (region?.isConnected) return region;
  region = document.createElement("div");
  region.setAttribute("aria-live", "polite");
  region.setAttribute("aria-atomic", "true");
  region.setAttribute("data-kit-announcer", "");
  region.style.cssText =
    "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";
  document.body.appendChild(region);
  return region;
}

/** Says `words` once, politely: the same words twice in a row are said again (a no-break space told apart). */
export function announce(words: string): void {
  const r = ensure();
  if (!r) return;
  r.textContent = r.textContent === words ? `${words}\u00a0` : words;
}

/** What the announcer said last (tests). */
export function announced(): string {
  return (region?.textContent ?? "").replace(/\u00a0$/, "");
}

if (typeof document !== "undefined") {
  if (document.body) ensure();
  else document.addEventListener("DOMContentLoaded", () => ensure(), { once: true });
}

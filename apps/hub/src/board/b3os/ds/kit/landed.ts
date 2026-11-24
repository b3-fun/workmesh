// Code a page does not need to land (a figure's roll, the brand marks' paths, a chart's plot) loads once the page has
// landed, so it never shares the network with what the page needs first (perf round 2: on a phone's Fast 3G those
// loads, started at mount, came in before the page and pushed its largest paint 0.4 s later).
//
// Landed: no PageReveal is loading its first read (no `[data-page-reveal][data-loading]` for two frames), then the
// browser is idle. A page without a PageReveal lands at once. Never later than `MAX_WAIT_MS` after it was asked.

const MAX_WAIT_MS = 8000;
let landed: Promise<void> | null = null;

const idle = (fn: () => void) => {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(fn, { timeout: 1000 });
  else window.setTimeout(fn, 50);
};

/** Resolves once the page on screen has landed and the browser is idle (at most 8 s after the first call). */
export function whenLanded(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  landed ??= new Promise<void>((done) => {
    const start = performance.now();
    let quiet = 0;
    const look = () => {
      const loading = document.querySelector("[data-page-reveal][data-loading]");
      quiet = loading ? 0 : quiet + 1;
      if (quiet >= 2 || performance.now() - start > MAX_WAIT_MS) idle(() => done());
      else requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  return landed;
}

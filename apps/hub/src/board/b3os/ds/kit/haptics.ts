// Haptics on phones (PHILOSOPHY P8: "do the little details, add web-haptics"), through web-haptics (Lochie Axon, MIT,
// no dependencies, 2.3 KB gzipped): the Vibration API on Android, and on iOS Safari the switch-control tap it fires
// from a hidden label. Only on a coarse pointer (a desktop never vibrates), always beside a visible change, never as the
// only signal (Apple's HIG, the web-haptics skill): selection for a tab or segment, light for a toggle or copy, success
// or error when an action's result arrives.
import type { WebHaptics } from "web-haptics";

export type HapticKind = "selection" | "light" | "medium" | "success" | "warning" | "error";

let engine: WebHaptics | null = null;
// The library loads on a phone only, as soon as a page that can buzz loads this module, and never on a desktop (perf
// audit 11-23: it sat in every kit page's first chunk). A tap in the few hundred ms before it arrives has no haptic,
// which is never the only signal.
let Engine: (new () => WebHaptics) | null = null;
if (typeof window !== "undefined" && touch())
  void import("web-haptics")
    .then((m) => {
      Engine = m.WebHaptics;
    })
    .catch(() => {});

function touch(): boolean {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/** One haptic, in the same event handler as the visual change it belongs to. A no-op off phones and in tests. */
export function haptic(kind: HapticKind = "light"): void {
  if (typeof window === "undefined" || typeof document === "undefined" || !touch()) return;
  try {
    if (!Engine) return;
    engine ??= new Engine();
    void engine.trigger(kind).catch(() => {});
  } catch {
    // Unsupported or blocked: the visual change already said it.
  }
}

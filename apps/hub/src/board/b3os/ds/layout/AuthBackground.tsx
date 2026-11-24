// from b3-mono apps/b3os-web/components/auth/AuthBackground.tsx @ f50f3ba3b97e
// The original renders a hosted UnicornStudio WebGL scene here (unicornstudio-react, project V4VM6A36r105T59uEVXI,
// the homepage hero's scene): a halftone glow of light-blue dots that follows the pointer with a short trail, on
// the light theme only. The package and its hosted scene are not added (the orchestrator's ruling 1: the native
// canvas ships); the effect is the shared native canvas, signature/PointerHalftone.tsx, with its `auth` preset,
// matched to frames of the original (shots/ds-original/signature/hover/pointer-login): dots on a 6 px grid whose size
// and opacity follow a trail of soft splats left by the pointer, each fading with a 150 ms half-life. It listens on
// the window as the scene does (the card above it takes the pointer), draws only while something is fading, and
// does nothing with reduced motion (the auth preset has nothing at rest, so its still frame is empty).
// X5 (review finding 11): on b3os.org/login the hosted scene covers the page's dot grid (`login-bg`) once it has
// loaded, so after the first paint the ground is a plain surface with the card's guides and the trail. Here the
// canvas's ground is painted with the page surface once it mounts: the dots are the first paint only.
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { PointerHalftone } from "../signature/PointerHalftone";

export function AuthBackground({ className }: { className?: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className={cn("absolute inset-0 z-0 overflow-hidden dark:hidden", className)} aria-hidden="true">
      <PointerHalftone scene="auth" style={mounted ? { background: "var(--ds-surface-primary)" } : undefined} />
    </div>
  );
}

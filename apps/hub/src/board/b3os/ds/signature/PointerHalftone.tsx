// The original B3OS's hosted UnicornStudio scenes (unicornstudio-react's UnicornScene in b3-mono apps/b3os-web
// @ f50f3ba3b97e: components/auth/AuthBackground.tsx and components/homepage/HeroBackground.tsx, project
// V4VM6A36r105T59uEVXI; components/homepage/AutomateOperations.tsx, RwAccR4YsBdSpSTlO545; components/homepage/
// QuoteBackground.tsx and components/home/_shared/QuoteBackground.tsx, FojzbSuBEKszdwrdUU73), rebuilt natively on
// one canvas with one preset per scene (EXTRACT X4, the orchestrator's ruling 1: no third-party scene host, no CSP
// change, no unicornstudio-react). Each preset is matched to frames of the original recorded on b3os.org
// (scratch/console-elegance/shots/ds-original/site/pointer-<scene>/ and signature/hover/pointer-login/):
// - auth and hero: light-blue dots on a 6 px grid, lit only by a trail of soft splats the pointer leaves, each fading
//   with a 150 ms half-life; nothing at rest.
// - automate: light-grey dots on a 10.7 px grid in small clusters that drift slowly at rest (the scene shows in the
//   card's margins, around the video).
// - quote: elliptical halftone ripples of white dots on the band's blue gradient, growing outward and fading at rest
//   (two at a time), their centre leaning toward the pointer, and a short white trail behind it.
// Cost: the canvas draws only what is lit (the boxes around each splat, cluster and ring), batched by opacity (the quote
// band, which lights thousands of dots at rest, at half resolution into one pixel buffer: X5, review finding 19); it runs
// only while the scene is on screen and the tab is visible, at most at the original's 30 frames a second, and a scene
// with nothing lit and nothing idle draws nothing at all. A touch does nothing (the original's scenes follow a mouse);
// with reduced motion the canvas draws one still frame and listens to nothing.
import { type CSSProperties, useEffect, useRef } from "react";
import { cn } from "../lib/utils";
import { HALFTONE_SCENES, type HalftoneScene, type HalftoneSceneName, mountHalftone } from "./halftone";

export { HALFTONE_SCENES, type HalftoneScene, type HalftoneSceneName };

export interface PointerHalftoneProps {
  /** The scene's preset, or a scene of your own. */
  scene: HalftoneSceneName | HalftoneScene;
  className?: string;
  style?: CSSProperties;
}

/**
 * The halftone canvas. It fills its positioned parent and takes no pointer events: it listens on the window, as the
 * hosted scene did, so the content above it keeps the pointer.
 */
export function PointerHalftone({ scene, className, style }: PointerHalftoneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cfg = typeof scene === "string" ? HALFTONE_SCENES[scene] : scene;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return mountHalftone(canvas, cfg);
  }, [cfg]);

  return (
    <canvas
      ref={canvasRef}
      data-pointer-stage
      aria-hidden="true"
      className={cn("pointer-events-none block h-full w-full", className)}
      style={cfg.background ? { background: cfg.background, ...style } : style}
    />
  );
}

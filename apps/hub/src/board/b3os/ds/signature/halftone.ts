// The pointer halftone's canvas engine, without React (console area 8 fix round, R1): PointerHalftone.tsx runs it in an
// effect, and the prerendered site, which loads no React in the browser, runs it from src/site/halftone.ts behind the
// home hero. What it draws and why is PointerHalftone.tsx's header; the code moved here unchanged.

export type HalftoneSceneName = "auth" | "hero" | "automate" | "quote";

export interface HalftoneScene {
  /** Grid pitch and the largest dot's radius, in CSS pixels. */
  pitch: number;
  maxDot: number;
  /** The dots' colour, and their opacity at the faintest and the strongest. */
  color: readonly [number, number, number];
  alpha: readonly [number, number];
  /** The canvas's pixel ratio cap (the original's `dpi`) and frame cap (its `fps`). */
  dpi: number;
  fps: number;
  /**
   * The pointer's trail: a splat every `spacing` px of travel, `radius` px wide, fading by half every `halfLife` ms.
   * `speedGain` widens and strengthens the splats of a fast move (the original's trail is a broad band after a sweep
   * across the window, a small blob when the pointer moves slowly).
   */
  trail?: { radius: number; halfLife: number; spacing: number; strength: number; speedGain?: number };
  /** Clusters that drift at rest: `count` soft blobs of `radius` px moving at about `speed` px/s. */
  drift?: { count: number; radius: number; speed: number; strength: number };
  /**
   * Ripples at rest: `count` elliptical rings, each growing from `minR` to `maxR` (px, horizontal) over `lifeMs`,
   * fading in and out as it goes, spaced evenly in time; the ellipse's width-to-height ratio, the ring's half-width,
   * and how much of the way to the pointer their centre leans.
   */
  rings?: {
    count: number;
    minR: number;
    maxR: number;
    lifeMs: number;
    aspect: number;
    width: number;
    lean: number;
    strength: number;
  };
  /** A CSS background drawn under the dots (the quote band's gradient). */
  background?: string;
  /**
   * How the lit cells are drawn: `sprites` (one image copy per dot, the default) or `pixels` (every dot written
   * into one pixel buffer and put on the canvas in one call: for a scene that lights thousands of dots at rest).
   */
  raster?: "sprites" | "pixels";
}

// X5 (review finding 10): auth and hero at the original's strength and decay. Its deepest dot is #85a3ff and its trail
// fades over about 450 ms (lit dots on a row after the pointer leaves, 150 ms apart: 122, 66, 17); the X4 presets drew
// about half as strong (#5c7cff at 0.85 at most) and faded by half every 150 ms. Now #85a3ff at full opacity at the
// top level (the faintest at 1.9 times the old), a 200 ms half-life.
export const HALFTONE_SCENES: Record<HalftoneSceneName, HalftoneScene> = {
  auth: {
    pitch: 6,
    maxDot: 2,
    color: [133, 163, 255],
    alpha: [0.475, 1],
    dpi: 2,
    fps: 60,
    trail: { radius: 70, halfLife: 200, spacing: 14, strength: 0.35, speedGain: 1.4 },
  },
  hero: {
    pitch: 6,
    maxDot: 2.3,
    color: [133, 163, 255],
    alpha: [0.475, 1],
    dpi: 1,
    fps: 30,
    trail: { radius: 70, halfLife: 200, spacing: 14, strength: 0.35, speedGain: 1 },
  },
  automate: {
    pitch: 10.7,
    maxDot: 3.2,
    color: [212, 212, 216],
    alpha: [0.55, 1],
    dpi: 1.5,
    fps: 30,
    drift: { count: 5, radius: 22, speed: 22, strength: 0.95 },
    trail: { radius: 34, halfLife: 150, spacing: 14, strength: 0.28, speedGain: 1 },
  },
  // X5 (review finding 19): the band lit about 7,800 dots a frame at rest, one image copy each (22% of the main
  // thread); at half resolution, with every dot written into one pixel buffer, it is one canvas call a frame.
  quote: {
    pitch: 6.3,
    maxDot: 2.4,
    color: [255, 255, 255],
    alpha: [0.06, 0.5],
    dpi: 0.5,
    fps: 30,
    raster: "pixels",
    rings: { count: 2, minR: 130, maxR: 470, lifeMs: 7000, aspect: 1.32, width: 42, lean: 0.25, strength: 0.8 },
    trail: { radius: 46, halfLife: 150, spacing: 14, strength: 0.3, speedGain: 1 },
    background:
      "radial-gradient(ellipse 49% 62% at 50% 100%, rgba(172, 202, 255, 0.58) 0%, rgba(172, 202, 255, 0.46) 35%, rgba(172, 202, 255, 0.28) 62%, rgba(172, 202, 255, 0.08) 86%, rgba(172, 202, 255, 0) 100%), linear-gradient(180deg, rgb(3, 4, 255) 12%, rgb(88, 111, 255) 100%)",
  },
};

interface Splat {
  x: number;
  y: number;
  s: number;
  /** This splat's radius (a fast move's are wider). */
  r: number;
}

/** A stable value in [0, 1) per grid cell: the dots' uneven sizes inside a ring or a cluster. */
function cellNoise(gx: number, gy: number) {
  const h = Math.sin(gx * 127.1 + gy * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

const BUCKETS = 8;

/**
 * Runs `cfg` on `canvas` (which fills its positioned parent and takes no pointer events: it listens on the window) until
 * the returned function is called.
 */
export function mountHalftone(canvas: HTMLCanvasElement, cfg: HalftoneScene): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const { pitch, maxDot, color, alpha, trail, drift, rings } = cfg;
  const frameMs = 1000 / cfg.fps;

  let width = 0;
  let height = 0;
  let splats: Splat[] = [];
  let last: { x: number; y: number } | null = null;
  let pointer: { x: number; y: number } | null = null;
  const center = { x: 0, y: 0 };
  let raf = 0;
  let prev = 0;
  let lastDraw = 0;
  let onScreen = false;
  let start = performance.now();
  const seeds = Array.from({ length: drift?.count ?? 0 }, (_, i) => ({
    fx: 0.00011 + 0.00007 * cellNoise(i, 1),
    fy: 0.00013 + 0.00006 * cellNoise(i, 2),
    px: Math.PI * 2 * cellNoise(i, 3),
    py: Math.PI * 2 * cellNoise(i, 4),
  }));

  // One dot per opacity bucket, drawn once into a sprite strip at the canvas's pixel ratio: a lit cell is then one
  // image copy (an arc path per dot was hundreds of milliseconds a frame in a software raster).
  let sprites: HTMLCanvasElement | null = null;
  const spriteBox: { sx: number; size: number; rad: number }[] = [];
  const buildSprites = (dpr: number) => {
    spriteBox.length = 0;
    const sizes = Array.from({ length: BUCKETS }, (_, i) => {
      const rad = maxDot * Math.sqrt((i + 0.5) / BUCKETS);
      return { rad, size: Math.ceil((rad * 2 + 2) * dpr) };
    });
    const strip = document.createElement("canvas");
    strip.width = sizes.reduce((w, z) => w + z.size, 0);
    strip.height = Math.max(...sizes.map((z) => z.size));
    const sctx = strip.getContext("2d");
    if (!sctx) return;
    let x = 0;
    sizes.forEach(({ rad, size }, i) => {
      const a = alpha[0] + (alpha[1] - alpha[0]) * ((i + 0.5) / BUCKETS);
      sctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${a.toFixed(3)})`;
      sctx.beginPath();
      sctx.arc(x + size / 2, size / 2, rad * dpr, 0, Math.PI * 2);
      sctx.fill();
      spriteBox.push({ sx: x, size, rad: size / 2 / dpr });
      x += size;
    });
    sprites = strip;
  };

  // The pixel raster (`raster: "pixels"`): per opacity bucket, the dot's pixels as offsets from its centre pixel
  // with their colour (coverage from 4 x 4 samples), written straight into one buffer.
  let image: ImageData | null = null;
  let pixels: Uint32Array | null = null;
  let stamps: { dx: number; dy: number; rgba: number }[][] = [];
  let ratio = 1;
  const buildStamps = (dpr: number) => {
    stamps = Array.from({ length: BUCKETS }, (_, i) => {
      const rad = maxDot * Math.sqrt((i + 0.5) / BUCKETS) * dpr;
      const a = alpha[0] + (alpha[1] - alpha[0]) * ((i + 0.5) / BUCKETS);
      const reach = Math.ceil(rad) + 1;
      const out: { dx: number; dy: number; rgba: number }[] = [];
      for (let dy = -reach; dy <= reach; dy++)
        for (let dx = -reach; dx <= reach; dx++) {
          let hit = 0;
          for (let sy = 0; sy < 4; sy++)
            for (let sx = 0; sx < 4; sx++) {
              const x = dx + (sx + 0.5) / 4 - 0.5;
              const y = dy + (sy + 0.5) / 4 - 0.5;
              if (x * x + y * y <= rad * rad) hit++;
            }
          const byte = Math.round(255 * a * (hit / 16));
          // Little-endian RGBA as one 32-bit word.
          if (byte > 0)
            out.push({ dx, dy, rgba: ((byte << 24) | (color[2] << 16) | (color[1] << 8) | color[0]) >>> 0 });
        }
      return out;
    });
  };

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, cfg.dpi);
    ratio = dpr;
    if (cfg.raster === "pixels") buildStamps(dpr);
    else buildSprites(dpr);
    width = r.width;
    height = r.height;
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (cfg.raster === "pixels") {
      image = ctx.createImageData(canvas.width, canvas.height);
      pixels = new Uint32Array(image.data.buffer);
    }
    if (!center.x && !center.y) {
      center.x = width / 2;
      center.y = height / 2;
    }
  };

  /** The idle sources at time t (ms since start): the drifting clusters' centres. */
  const blobsAt = (t: number) =>
    seeds.map((s) => {
      const sp = (drift?.speed ?? 0) / 22;
      return {
        x: width * (0.5 + 0.46 * Math.sin(s.px + t * s.fx * sp * 2.2)),
        y: height * (0.5 + 0.44 * Math.sin(s.py + t * s.fy * sp * 2.2)),
      };
    });

  // The field is a grid of cells, one per dot; each source adds into the cells it reaches (a splat or cluster within
  // twice its radius, a ripple within three half-widths of its ellipse), then one pass draws the lit cells, batched by
  // opacity. Reused between frames.
  let field = new Float32Array(0);
  let cols = 0;
  let rowsN = 0;
  const draw = (now: number, still = false) => {
    const dt = prev ? now - prev : frameMs;
    prev = now;
    const t = now - start;
    if (trail) {
      const decay = 0.5 ** (dt / trail.halfLife);
      for (const s of splats) s.s *= decay;
      splats = splats.filter((s) => s.s > 0.02);
    }
    // The rings' centre leans toward the pointer while it is over the scene, and back to the middle when it leaves.
    if (rings) {
      const tx = width / 2 + (pointer ? (pointer.x - width / 2) * rings.lean : 0);
      const ty = height / 2 + (pointer ? (pointer.y - height / 2) * rings.lean : 0);
      const k = still ? 1 : 1 - Math.exp(-dt / 420);
      center.x += (tx - center.x) * k;
      center.y += (ty - center.y) * k;
    }
    ctx.clearRect(0, 0, width, height);

    const blobs = drift ? blobsAt(still ? 0 : t) : [];
    // Each ripple's radius and weight now: it grows over its life and fades in and out (sin of its phase).
    const ripples = rings
      ? Array.from({ length: rings.count }, (_, i) => {
          const phase = ((still ? 0 : t) / rings.lifeMs + i / rings.count) % 1;
          return { r: rings.minR + (rings.maxR - rings.minR) * phase, w: Math.sin(Math.PI * phase) };
        })
      : [];
    if (!blobs.length && !splats.length && !ripples.length) return false;

    const c = Math.ceil(width / pitch) + 1;
    const rn = Math.ceil(height / pitch) + 1;
    if (c !== cols || rn !== rowsN) {
      cols = c;
      rowsN = rn;
      field = new Float32Array(cols * rowsN);
    } else field.fill(0);
    // The union of the touched cells, so the drawing pass walks only those.
    let ux0 = cols;
    let uy0 = rowsN;
    let ux1 = -1;
    let uy1 = -1;
    const span = (x: number, y: number, reach: number) => {
      const gx0 = Math.max(0, Math.floor((x - reach) / pitch));
      const gy0 = Math.max(0, Math.floor((y - reach) / pitch));
      const gx1 = Math.min(cols - 1, Math.ceil((x + reach) / pitch));
      const gy1 = Math.min(rowsN - 1, Math.ceil((y + reach) / pitch));
      ux0 = Math.min(ux0, gx0);
      uy0 = Math.min(uy0, gy0);
      ux1 = Math.max(ux1, gx1);
      uy1 = Math.max(uy1, gy1);
      return [gx0, gy0, gx1, gy1] as const;
    };
    for (const s of splats) {
      const inv = 1 / (2 * (s.r / 2) ** 2);
      const [gx0, gy0, gx1, gy1] = span(s.x, s.y, s.r * 2);
      for (let gy = gy0; gy <= gy1; gy++) {
        const dy = gy * pitch + pitch / 2 - s.y;
        for (let gx = gx0; gx <= gx1; gx++) {
          const dx = gx * pitch + pitch / 2 - s.x;
          field[gy * cols + gx]! += s.s * Math.exp(-(dx * dx + dy * dy) * inv);
        }
      }
    }
    if (drift) {
      const inv = 1 / (2 * (drift.radius / 2) ** 2);
      for (const b of blobs) {
        const [gx0, gy0, gx1, gy1] = span(b.x, b.y, drift.radius * 2);
        for (let gy = gy0; gy <= gy1; gy++) {
          const dy = gy * pitch + pitch / 2 - b.y;
          for (let gx = gx0; gx <= gx1; gx++) {
            const dx = gx * pitch + pitch / 2 - b.x;
            field[gy * cols + gx]! +=
              drift.strength * Math.exp(-(dx * dx + dy * dy) * inv) * (0.45 + 0.55 * cellNoise(gx, gy));
          }
        }
      }
    }
    if (rings) {
      const reach = rings.maxR + rings.width * 3;
      const [gx0, gy0, gx1, gy1] = span(center.x, center.y, reach);
      for (let gy = gy0; gy <= gy1; gy++) {
        const ey = gy * pitch + pitch / 2 - center.y;
        for (let gx = gx0; gx <= gx1; gx++) {
          const ex = (gx * pitch + pitch / 2 - center.x) / rings.aspect;
          const d = Math.sqrt(ex * ex + ey * ey) * rings.aspect;
          let ring = 0;
          for (const rp of ripples) {
            const off = (d - rp.r) / rings.width;
            if (off > -3 && off < 3) ring = Math.max(ring, rp.w * Math.exp(-off * off));
          }
          if (ring > 0) field[gy * cols + gx]! += rings.strength * ring * (0.3 + 0.7 * cellNoise(gx, gy));
        }
      }
    }
    if (ux1 < 0) return false;

    if (cfg.raster === "pixels") {
      if (!image || !pixels) return false;
      const W = image.width;
      const H = image.height;
      pixels.fill(0);
      for (let gy = uy0; gy <= uy1; gy++) {
        for (let gx = ux0; gx <= ux1; gx++) {
          const v = field[gy * cols + gx]!;
          if (v < 0.04) continue;
          const stamp = stamps[Math.min(BUCKETS - 1, Math.floor(Math.min(1, v) * BUCKETS))]!;
          const cx = Math.round((gx * pitch + pitch / 2) * ratio);
          const cy = Math.round((gy * pitch + pitch / 2) * ratio);
          for (const p of stamp) {
            const x = cx + p.dx;
            const y = cy + p.dy;
            if (x >= 0 && y >= 0 && x < W && y < H) pixels[y * W + x] = p.rgba;
          }
        }
      }
      ctx.putImageData(image, 0, 0);
      return true;
    }

    if (!sprites) return false;
    for (let gy = uy0; gy <= uy1; gy++) {
      for (let gx = ux0; gx <= ux1; gx++) {
        const v = field[gy * cols + gx]!;
        if (v < 0.04) continue;
        const bucket = Math.min(BUCKETS - 1, Math.floor(Math.min(1, v) * BUCKETS));
        const sp = spriteBox[bucket]!;
        const px = gx * pitch + pitch / 2;
        const py = gy * pitch + pitch / 2;
        ctx.drawImage(sprites, sp.sx, 0, sp.size, sp.size, px - sp.rad, py - sp.rad, sp.rad * 2, sp.rad * 2);
      }
    }
    return true;
  };

  const idle = Boolean(drift || rings);
  const loop = (now: number) => {
    raf = 0;
    if (!onScreen || document.hidden) {
      prev = 0;
      return;
    }
    if (now - lastDraw >= frameMs - 1) {
      lastDraw = now;
      draw(now);
    }
    // Keep going while something fades or the scene moves at rest.
    if (idle || splats.length) raf = requestAnimationFrame(loop);
    else prev = 0;
  };
  const wake = () => {
    if (!raf && onScreen && !document.hidden) raf = requestAnimationFrame(loop);
  };

  resize();
  if (reduced) {
    // One still frame: the clusters and rings where they rest, no trail.
    draw(performance.now(), true);
    const ro = new ResizeObserver(() => {
      resize();
      draw(performance.now(), true);
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }

  const onMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const inside = x >= 0 && y >= 0 && x <= r.width && y <= r.height;
    pointer = inside ? { x, y } : null;
    if (!trail) {
      if (rings) wake();
      return;
    }
    if (x < -trail.radius || y < -trail.radius || x > r.width + trail.radius || y > r.height + trail.radius) {
      last = null;
      return;
    }
    const from = last ?? { x, y };
    const dist = Math.hypot(x - from.x, y - from.y);
    // A fast move (a long step between two pointer events) leaves wider, stronger splats, spaced by half their
    // radius (a wide splat every 14 px would only cost more for the same picture).
    const fast = Math.min(1.5, dist / 150) * (trail.speedGain ?? 0);
    const splatR = trail.radius * (1 + fast);
    const strength = trail.strength * (1 + fast / 2);
    const steps = Math.max(1, Math.ceil(dist / Math.max(trail.spacing, splatR / 2)));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      splats.push({ x: from.x + (x - from.x) * k, y: from.y + (y - from.y) * k, s: strength, r: splatR });
    }
    // Keep the trail bounded: a long sweep merges into the newest splats.
    if (splats.length > 240) splats = splats.slice(-240);
    last = { x, y };
    wake();
  };
  const onVisibility = () => {
    if (!document.hidden) {
      prev = 0;
      wake();
    }
  };
  // Off screen it stops (no observer, as in a test DOM: assume on screen).
  const io =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(([entry]) => {
          onScreen = Boolean(entry?.isIntersecting);
          if (onScreen) {
            prev = 0;
            wake();
          }
        });
  if (io) io.observe(canvas);
  else onScreen = true;
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  start = performance.now();
  window.addEventListener("pointermove", onMove, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("pointermove", onMove);
    document.removeEventListener("visibilitychange", onVisibility);
    io?.disconnect();
    ro.disconnect();
    if (raf) cancelAnimationFrame(raf);
  };
}

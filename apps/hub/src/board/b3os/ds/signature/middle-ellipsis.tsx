// from b3-mono apps/b3os-web/components/ui/middle-ellipsis.tsx @ f50f3ba3b97e
import { useLayoutEffect, useRef, useState } from "react";

interface Props {
  text: string;
  className?: string;
}

/**
 * Renders `text` on one line, truncating with a `…` in the middle when the
 * container is too narrow. Uses a sibling measurement span so font metrics
 * match exactly (putting it in document.body breaks inherited font size /
 * family and overestimates width, causing over-truncation).
 */
export function MiddleEllipsis({ text, className }: Props) {
  const renderRef = useRef<HTMLSpanElement | null>(null);
  const scratchRef = useRef<HTMLSpanElement | null>(null);
  const [display, setDisplay] = useState(text);

  useLayoutEffect(() => {
    const rendered = renderRef.current;
    const scratch = scratchRef.current;
    const parent = rendered?.parentElement;
    if (!rendered || !scratch || !parent) return;

    const measure = () => {
      const parentWidth = parent.clientWidth;
      if (parentWidth <= 0) return; // not laid out yet; rely on ResizeObserver
      scratch.textContent = text;
      if (scratch.scrollWidth <= parentWidth) {
        setDisplay((prev) => (prev === text ? prev : text));
        return;
      }
      let kept = text.length - 1;
      while (kept > 2) {
        const half = Math.floor(kept / 2);
        const candidate = text.slice(0, half) + "…" + text.slice(text.length - (kept - half));
        scratch.textContent = candidate;
        if (scratch.scrollWidth <= parentWidth) {
          setDisplay((prev) => (prev === candidate ? prev : candidate));
          return;
        }
        kept -= 1;
      }
      // Container too narrow for even "a…b" — show just the ellipsis rather
      // than let the full text overflow the pill.
      setDisplay((prev) => (prev === "…" ? prev : "…"));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => {
      ro.disconnect();
    };
  }, [text]);

  return (
    <>
      <span ref={renderRef} className={className}>
        {display}
      </span>
      <span
        ref={scratchRef}
        aria-hidden="true"
        className={className}
        style={{
          position: "absolute",
          visibility: "hidden",
          whiteSpace: "nowrap",
          pointerEvents: "none",
          left: -99999,
          top: -99999,
        }}
      />
    </>
  );
}

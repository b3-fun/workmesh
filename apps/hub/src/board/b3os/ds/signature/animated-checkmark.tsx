// from b3-mono apps/b3os-web/components/ui/animated-checkmark.tsx @ f50f3ba3b97e

import { useId } from "react";
import { cn } from "../lib/utils";

interface AnimatedCheckmarkProps {
  color?: string;
  checkColor?: string;
  strokeWidth?: number;
  className?: string;
  delay?: number;
  static?: boolean;
}

export function AnimatedCheckmark({
  color = "#22c55e",
  checkColor = "#fff",
  strokeWidth = 2,
  className,
  delay = 0,
  static: isStatic = false,
}: AnimatedCheckmarkProps) {
  const id = `ac-${useId().replace(/:/g, "")}`;

  if (isStatic) {
    return (
      <svg
        className={className}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 52 52"
        style={{
          borderRadius: "50%",
          display: "block",
          strokeWidth,
          stroke: checkColor,
          strokeMiterlimit: 10,
          boxShadow: `inset 0px 0px 0px 100px ${color}`,
        }}
      >
        <circle
          cx="26"
          cy="26"
          r="25"
          fill="none"
          style={{
            strokeWidth,
            strokeMiterlimit: 10,
            stroke: color,
          }}
        />
        <path fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8" style={{ transformOrigin: "50% 50%" }} />
      </svg>
    );
  }

  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
@keyframes ${id}-stroke {
  100% { stroke-dashoffset: 0; }
}
@keyframes ${id}-scale {
  0%, 100% { transform: none; }
  50% { transform: scale3d(1.08, 1.08, 1); }
}
@keyframes ${id}-fill {
  100% { box-shadow: inset 0px 0px 0px 100px ${color}; }
}
.${id} {
  border-radius: 50%;
  display: block;
  stroke-width: ${strokeWidth};
  stroke: ${checkColor};
  stroke-miterlimit: 10;
  box-shadow: inset 0px 0px 0px ${color};
  animation:
    ${id}-fill 360ms cubic-bezier(0.23, 1, 0.32, 1) ${delay + 0.35}s forwards,
    ${id}-scale 260ms cubic-bezier(0.23, 1, 0.32, 1) ${delay + 0.82}s both;
}
.${id}__circle {
  stroke-dasharray: 166;
  stroke-dashoffset: 166;
  stroke-width: ${strokeWidth};
  stroke-miterlimit: 10;
  stroke: ${color};
  fill: none;
  animation: ${id}-stroke 560ms cubic-bezier(0.23, 1, 0.32, 1) ${delay}s forwards;
}
.${id}__check {
  transform-origin: 50% 50%;
  stroke-dasharray: 48;
  stroke-dashoffset: 48;
  animation: ${id}-stroke 260ms cubic-bezier(0.23, 1, 0.32, 1) ${delay + 0.62}s forwards;
}
@media (prefers-reduced-motion: reduce) {
  .${id},
  .${id}__circle,
  .${id}__check {
    animation: none !important;
  }
  .${id} {
    box-shadow: inset 0px 0px 0px 100px ${color};
  }
  .${id}__circle,
  .${id}__check {
    stroke-dashoffset: 0;
  }
}
`,
        }}
      />
      <svg className={cn(id, className)} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">
        <circle className={`${id}__circle`} cx="26" cy="26" r="25" fill="none" />
        <path className={`${id}__check`} fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8" />
      </svg>
    </>
  );
}

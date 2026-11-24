/** Brand marks as CSS masks in currentColor (research/b3os-design.md §8.3). URLs are set in styles/brand.css. */

export function Wordmark({ height = 16, className = "" }: { height?: number; className?: string }) {
  return <span className={`b3os-wordmark ${className}`} style={{ height }} role="img" aria-label="B3OS" />;
}

export function StackedMark({ height = 30, className = "" }: { height?: number; className?: string }) {
  return <span className={`b3os-mark ${className}`} style={{ height }} role="img" aria-label="B3OS" />;
}

export function B3iqWordmark({ height = 11, className = "" }: { height?: number; className?: string }) {
  return <span className={`b3iq-wordmark ${className}`} style={{ height }} role="img" aria-label="B3IQ" />;
}

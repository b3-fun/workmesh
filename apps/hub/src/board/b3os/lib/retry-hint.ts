/** A failure's words without their retry hint ("Try again in 5 s."): Retry, or its countdown, says it. */
export function withoutRetryHint(message: string): string {
  return (
    message
      .replace(/\s*Try again in [^.]*\.$/, "")
      .replace(/\s*Try again in a few seconds\.$/, "")
      .trim() || message
  );
}

// Bullpen shim for b3os-beta apps/web/src/api/client.ts: the error type and its words, which the vendored console
// files (app/ui/primitives.tsx, app/ui/AuthCard.tsx) import. Bullpen's hub answers `{ error }` JSON; the request id is
// Cloudflare's cf-ray, which every response through the edge carries.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly requestId: string | null;
  readonly problem: null = null;
  readonly retryAfterS: number | null;

  constructor(init: { status: number; code: string; title: string; detail: string; requestId: string | null; retryAfterS: number | null }) {
    super(`${init.status} ${init.code}: ${init.detail}`);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.requestId = init.requestId;
    this.retryAfterS = init.retryAfterS;
  }
}

/** As the console's: the failure in words and the request id to quote. */
export function describeError(e: unknown): { message: string; requestId: string | null } {
  if (e instanceof ApiError) {
    const hint =
      e.status === 429 && e.retryAfterS ? ` Try again in ${e.retryAfterS} s.` : e.status === 0 ? " Check your connection." : "";
    const detail = !hint || /[.!?]$/.test(e.detail) ? e.detail : `${e.detail}.`;
    return { message: `${detail}${hint}`, requestId: e.requestId };
  }
  return { message: e instanceof Error ? e.message : String(e), requestId: null };
}

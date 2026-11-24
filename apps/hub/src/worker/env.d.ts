// Vars that exist only in some environments. DEV_USER_EMAIL is local dev only (.dev.vars). OPENROUTER_API_KEY is a
// Worker secret: when set, summaries go through OpenRouter instead of Workers AI (SPEC.md §11).
interface Env {
  DEV_USER_EMAIL?: string;
  OPENROUTER_API_KEY?: string;
}
declare namespace Cloudflare {
  interface Env {
    DEV_USER_EMAIL?: string;
    OPENROUTER_API_KEY?: string;
  }
}

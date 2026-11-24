// Vars that exist only in some environments. DEV_USER_EMAIL is local dev only (.dev.vars).
interface Env {
  DEV_USER_EMAIL?: string;
}
declare namespace Cloudflare {
  interface Env {
    DEV_USER_EMAIL?: string;
  }
}

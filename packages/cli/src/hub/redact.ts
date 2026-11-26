import os from "node:os";
import { truncateHead } from "@workmesh/core";

/**
 * Secret redaction for conversation text (docs/SPEC.md §9). Runs on the
 * machine, on every text field and `desc`, before anything is queued for the
 * hub. Each rule below has true-positive and no-mangling tests in
 * test/hub-redact.test.ts; extend both together.
 *
 * Order matters: whole blocks (PEM keys, credentialed URLs) go first, then
 * tokens recognizable by their prefix, then values recognizable by the word
 * next to them, then context-free high-entropy strings, then home paths.
 */

export const REDACTED = "[redacted]";

/** Text longer than this is cut before redaction (the hub keeps 4,000 chars anyway). */
const MAX_SCAN = 64 * 1024;

// --- value classifiers ----------------------------------------------------------

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const SEMVER = /^v?\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/;
const PLAIN_NUMBER = /^[+-]?\d{1,6}(?:\.\d+)?(?:%|ms|s|m|h|k|kb|mb|gb)?$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Dates, versions and small numbers: values that are never secrets. */
function benign(v: string): boolean {
  return ISO_DATE.test(v) || SEMVER.test(v) || PLAIN_NUMBER.test(v);
}

/** References and placeholders that stand for a secret without being one. */
function placeholder(v: string): boolean {
  const t = v.trim();
  if (!t) return true;
  if (t.includes(REDACTED)) return true;
  if (/^(?:\$|%|<|\{\{|\[\[|@\{)/.test(t)) return true; // $VAR, ${VAR}, %VAR%, <token>, {{ secrets.X }}
  if (t.includes("${") || t.includes("{{")) return true; // a template: `Bearer ${token}`
  if (/^(?:Bearer|Basic|Token)\s+\$/i.test(t)) return true; // "Bearer $TOKEN"
  if (/^(?:process\.env|import\.meta\.env|os\.environ|os\.getenv|env\.|Deno\.env|ENV\[|secrets\.|vars\.|getenv)/.test(t)) {
    return true;
  }
  if (/^(.)\1{2,}$/.test(t)) return true; // ***, xxxx, ....
  if (/(?:\.\.\.|…)$/.test(t)) return true; // an example: "sk-..."
  if (/^(?:\.\.\.|…|redacted|\*+redacted\*+|your[-_ ].*|example|placeholder|null|none|nil|undefined|true|false|n\/a|tbd|todo|unset|empty|missing|unknown|pending|required|optional)$/i.test(t)) {
    return true;
  }
  return false;
}

const CODE_WORDS = new Set([
  "await",
  "new",
  "function",
  "async",
  "yield",
  "typeof",
  "require",
  "import",
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "object",
  "unknown",
  "any",
  "never",
  "void",
  "str",
  "int",
  "bytes",
  "optional",
  "required",
  "self",
  "this",
]);

/** An expression in code rather than a literal: `getToken()`, `config.apiKey`, `newToken`, `user_token`. */
function codeLike(v: string, name?: string): boolean {
  if (/[([{]/.test(v)) return true;
  if (CODE_WORDS.has(v.toLowerCase())) return true;
  if (name !== undefined && v === name) return true;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+;?$/.test(v)) return true; // member expression
  if (/^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*;?$/.test(v) && !/\d/.test(v)) return true; // camelCase identifier
  if (/^[a-z]+(?:_[a-z]+)+;?$/.test(v)) return true; // snake_case identifier
  return false;
}

/** Long random-looking value: letters and digits, high entropy, not a date or version. */
export function looksRandom(v: string, minLength = 16): boolean {
  if (v.length < minLength || benign(v) || /\s/.test(v)) return false;
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return false;
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v)) return false; // an env var name: B3OS_NPM_TOKEN_2
  return entropy(v) >= 3;
}

/**
 * A short value after a generic secret name (`key=Xk29fj3Lq`, `sig: ab12cd34`,
 * `pass: hunter2`): letters and digits mixed, no punctuation that marks an id,
 * path or URL, not an issue id, env var name or dashed name.
 */
function shortSecret(v: string, name: string): boolean {
  const min = nameWords(name).at(-1) === "pass" ? 6 : 8;
  if (v.length < min || v.length > 64 || benign(v) || codeLike(v, name)) return false;
  if (!/^[A-Za-z0-9+=_!#%^&*~-]+$/.test(v)) return false; // ids like claude-code:s1, paths, URLs
  const c = counts(v);
  if (c.upper + c.lower < 2 || c.digit < 1) return false;
  if (/^[A-Z][A-Z0-9]*-\d+$/.test(v)) return false; // an issue id: B3-7166
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v)) return false; // an env var name
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(v)) return false; // a dashed name: arm64-linux, b3os-ci-v2
  return true;
}

/** A value after a strong secret word in prose or `key: value` form: not a plain word. */
function secretish(v: string): boolean {
  if (benign(v) || placeholder(v)) return false;
  if (!/[A-Za-z0-9]/.test(v)) return false; // "**" closing a bold label
  return /\d/.test(v) || /[^A-Za-z]/.test(v) || v.length >= 12;
}

// --- names next to values ---------------------------------------------------------

/** "AWS_SECRET_ACCESS_KEY" → [aws, secret, access, key]; "apiKey" → [api, key]. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const STRONG_LAST = new Set([
  "password",
  "passwd",
  "passphrase",
  "passcode",
  "pwd",
  "secret",
  "secrets",
  "token",
  "credential",
  "credentials",
  "apikey",
  "dsn",
  "pat",
  "authorization",
  "cookie",
]);
const KEY_QUALIFIERS = new Set([
  "api",
  "secret",
  "private",
  "access",
  "signing",
  "encryption",
  "master",
  "auth",
  "client",
  "service",
  "account",
  "license",
  "session",
  "admin",
  "deploy",
  "webhook",
]);
const GENERIC_LAST = new Set(["key", "auth", "sig", "signature", "pass", "cred", "creds", "salt"]);

type NameStrength = "strong" | "generic" | undefined;

/**
 * How strongly a name says its value is a secret. The secret word must be the
 * name's last word: `accessToken` and `OPENAI_API_KEY` are secrets,
 * `tokenCount`, `max_tokens` and `passwordHash` are not.
 */
export function nameStrength(name: string): NameStrength {
  const words = nameWords(name);
  const last = words.at(-1);
  if (!last) return undefined;
  if (STRONG_LAST.has(last)) return "strong";
  if (last === "key" && words.slice(0, -1).some((w) => KEY_QUALIFIERS.has(w))) return "strong";
  if (words.length === 1 && /^(?:api|secret|private|access)key$/.test(last)) return "strong";
  if (GENERIC_LAST.has(last)) return "generic";
  return undefined;
}

// --- rules ---------------------------------------------------------------------------

type Rule = (text: string) => string;

/** Replaces each match of `re` whose `pick` group passes `when` with REDACTED. */
function replaceGroup(
  re: RegExp,
  build: (m: RegExpExecArray) => string | undefined,
): Rule {
  return (text) =>
    text.replace(re, (...args: unknown[]) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      const whole = args[0] as string;
      return build(m) ?? whole;
    });
}

const PEM_BLOCK =
  /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

/** Tokens whose prefix says what they are; redacted wherever they appear. */
const PREFIXED: Array<{ re: RegExp; when?: (token: string) => boolean }> = [
  { re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g }, // Anthropic
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, when: (t) => /\d/.test(t) }, // OpenAI, OpenRouter (sk-or-v1-…), sk-proj-…
  { re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g }, // Stripe
  { re: /\bwhsec_[A-Za-z0-9]{20,}/g }, // Stripe webhook secret
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g }, // GitHub
  { re: /\bgithub_pat_[A-Za-z0-9_]{30,}/g }, // GitHub fine-grained
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g }, // GitLab
  { re: /\bxox[abposre]-[A-Za-z0-9-]{10,}/g }, // Slack
  { re: /\bxapp-\d-[A-Za-z0-9-]{10,}/g }, // Slack app-level
  { re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g }, // AWS access key id
  { re: /\bnpm_[A-Za-z0-9]{30,}/g }, // npm
  { re: /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g }, // Linear
  { re: /\b(?:bp|wr)_[0-9a-f]{32,}/g }, // Workmesh hub device token
  { re: /\bab_[0-9a-f]{32,}/g }, // Workmesh relay device token
  { re: /\bAIza[0-9A-Za-z_-]{35}/g }, // Google API key
  { re: /\bya29\.[0-9A-Za-z_-]{20,}/g }, // Google OAuth access token
  { re: /\bhf_[A-Za-z0-9]{30,}/g }, // Hugging Face
  { re: /\br8_[A-Za-z0-9]{30,}/g }, // Replicate
  { re: /\bgsk_[A-Za-z0-9]{30,}/g }, // Groq
  { re: /\bxai-[A-Za-z0-9]{30,}/g }, // xAI
  { re: /\bdb-[A-Za-z0-9]{24,}\b/g, when: (t) => /[A-Z]/.test(t) && /[a-z]/.test(t.slice(3)) }, // Databento
  { re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g }, // SendGrid
  { re: /\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b/g }, // Shopify
  { re: /\bdp\.(?:pt|st|sa|ct)\.[A-Za-z0-9]{30,}/g }, // Doppler
  { re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g }, // Telegram bot
  { re: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]+/g }, // Slack webhook
  { re: /https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g }, // Discord webhook
];

const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;

/** scheme://user:password@host → scheme://[redacted]@host; scheme://<long token>@host too. */
const URL_CREDS = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s/?#@:'"<>`]+):([^\s/?#@'"<>`]+)@/gi;
const URL_TOKEN_USER = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)([A-Za-z0-9_.~-]{20,})@/gi;

/** Authorization-style headers: the value after the header name. */
const AUTH_HEADER =
  /\b((?:Proxy-)?Authorization|X-Api-Key|X-Auth-Token|Api-Key|X-Access-Token|Cookie|Set-Cookie)(["'`]?\s*[:=]\s*["'`]?)(?:(Bearer|Basic|Token|Digest|Bot)\s+)?([^\s"'`,;]+)/gi;

/** "Bearer <token>" anywhere (capitalized, as in a header; lowercase is prose). */
const BEARER = /\b(Bearer|Basic|BEARER)(\s+)([A-Za-z0-9._~+/=-]{8,})/g;

/**
 * `name = value` / `name: value` / `"name": "value"` pairs whose name ends in
 * a secret word (nameStrength decides). Groups: 1 name, 2 space before,
 * 3 separator, 4 space after, 5/6/7 quoted value, 8 bare value. Names that end
 * elsewhere never match, so `https://…?access_token=…` is still examined.
 */
const ASSIGNMENT =
  /(?<![\w.-])["']?((?:[A-Za-z_][A-Za-z0-9_.-]{0,80}?)?(?:password|passwd|passphrase|passcode|pwd|secrets?|token|credentials?|key|dsn|pat|authorization|cookie|auth|sig|signature|pass|creds?|salt))["']?(\s*)(=>|:=|=|:)(\s*(?:\*{1,2}\s*)?)(?:"([^"\n]{0,500})"|'([^'\n]{0,500})'|`([^`\n]{0,500})`|([^\s"'`,;&)}\]<>]{1,500}))/gi;

/** `--token abc`, `--api-key=abc`. Groups: 1 flag name, 2 separator, 3 value (quoted or bare). */
const FLAG = /(?<![\w-])--([A-Za-z][A-Za-z0-9-]{0,60})(=|\s+)(?:"([^"\n]{1,500})"|'([^'\n]{1,500})'|([^\s"'`;|&]{1,500}))/g;

/** "password is hunter2", "the token ab12cd34ef", "API key: 1234-5678". */
const PROSE =
  /\b(password|passphrase|passcode|passwd|api[ -]key|access key|secret key|private key|secret|token)(\s+(?:is|was|of)?\s*|\s*[:=]\s*)(["'`]?)([^\s"'`,;]{6,200})/gi;

/** Context-free: long mixed-case alphanumeric runs with real entropy (a pasted API key). */
const LONG_RUN = /(?<![A-Za-z0-9_+=-])[A-Za-z0-9_+-]{32,}={0,2}(?![A-Za-z0-9_+=-])/g;

/**
 * Context-free: base64 with a `/` in it, which LONG_RUN's class splits into
 * pieces. Not inside a URL, path or dotted name (no `/ : . @ =` right before
 * it, no `.word` right after it).
 */
const B64_SLASH = /(?<![A-Za-z0-9_+/=.:@-])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9_+/=-])(?!\.\w)/g;

/**
 * Context-free: 48+ hex digits on their own (`openssl rand -hex 32`, an admin
 * token or HMAC key). Git SHAs (40) are shorter; a digest is kept when a hash
 * word labels it (`sha256:…`, `checksum = "…"`, `commit …`) or when it starts a
 * `sha256sum` line (`<hex>  file`). `0x…` values (transaction hashes) are public.
 */
const LONG_HEX = /(?<![A-Za-z0-9_+/=.-])[0-9a-fA-F]{48,}(?![A-Za-z0-9_+/=-])/g;
const HASH_LABEL =
  /(?:sha-?(?:1|224|256|384|512)(?:sum)?|blake2b?|blake3|md5|digest|checksum|hash|commit|tree|blob|object|integrity|fingerprint|etag|oid)\W{0,4}$/i;

/** Document ids in links on these hosts are access-controlled names, not credentials. */
const DOC_HOSTS =
  /https?:\/\/(?:docs\.google\.com|drive\.google\.com|sheets\.google\.com|slides\.google\.com|(?:www\.)?figma\.com|linear\.app|github\.com|(?:www\.)?notion\.so|claude\.ai)\/\S*$/;
/** Public keys: "ssh-ed25519 AAAA…", "ecdsa-sha2-nistp256 AAAA…". */
const PUBLIC_KEY_PREFIX = /(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com)\s+$/;

function counts(v: string): { upper: number; lower: number; digit: number } {
  let upper = 0;
  let lower = 0;
  let digit = 0;
  for (const ch of v) {
    if (ch >= "A" && ch <= "Z") upper++;
    else if (ch >= "a" && ch <= "z") lower++;
    else if (ch >= "0" && ch <= "9") digit++;
  }
  return { upper, lower, digit };
}

/** A context-free run that is a secret, not a hash, UUID, identifier or path piece. */
export function randomRun(v: string): boolean {
  if (UUID.test(v) || /^[0-9a-f]+$/i.test(v)) return false; // SHAs, digests
  if (/\d{8}T?\d{4,6}/.test(v)) return false; // an embedded timestamp: backup-20261124T153000Z
  const parts = v.split(/[-_]/).filter(Boolean);
  if (parts.length >= 3 && parts.filter((p) => /^[a-z]{2,}$/.test(p)).length * 2 >= parts.length) {
    return false; // words joined by dashes: env-backup-b3-…
  }
  const c = counts(v);
  if (c.upper < 3 || c.lower < 3 || c.digit < 3) return false;
  return entropy(v) >= 4;
}

function redactAssignmentValue(name: string, spaced: boolean, sep: string, quoted: string | undefined, bare: string | undefined): boolean {
  const strength = nameStrength(name);
  if (!strength) return false;
  const value = quoted ?? bare ?? "";
  if (placeholder(value)) return false;
  if (strength === "generic") return looksRandom(value) || shortSecret(value, name);
  if (quoted !== undefined) return true;
  if (benign(value)) return false;
  if (sep === ":" || spaced) return secretish(value) && !codeLike(value, name);
  // KEY=value with no spaces: shell, env files, URL queries.
  return !codeLike(value, name) || /\d/.test(value);
}

const RULES: Rule[] = [
  (t) => t.replace(PEM_BLOCK, REDACTED),
  (t) => t.replace(URL_CREDS, (_m, scheme: string) => `${scheme}${REDACTED}@`),
  replaceGroup(URL_TOKEN_USER, (m) => (looksRandom(m[2]!, 20) ? `${m[1]}${REDACTED}@` : undefined)),
  (t) => {
    let out = t;
    for (const { re, when } of PREFIXED) {
      out = out.replace(re, (tok) => (when && !when(tok) ? tok : REDACTED));
    }
    return out;
  },
  (t) => t.replace(JWT, REDACTED),
  replaceGroup(AUTH_HEADER, (m) => {
    const [, header, sep, scheme, value] = m as unknown as string[];
    if (placeholder(value!)) return undefined;
    if (!scheme) {
      // "Authorization: required" in prose; a bare scheme word means the value follows elsewhere.
      if (/^(?:Bearer|Basic|Token|Digest|Bot)$/i.test(value!) || !secretish(value!) || codeLike(value!)) return undefined;
    }
    return `${header}${sep}${scheme ? `${scheme} ` : ""}${REDACTED}`;
  }),
  replaceGroup(BEARER, (m) => {
    const value = m[3]!;
    if (placeholder(value)) return undefined;
    const ok = (value.length >= 12 && /\d/.test(value)) || (value.length >= 20 && /[A-Z]/.test(value) && /[a-z]/.test(value)) || /=$/.test(value);
    return ok && !benign(value) ? `${m[1]}${m[2]}${REDACTED}` : undefined;
  }),
  replaceGroup(ASSIGNMENT, (m) => {
    const [whole, name, before, sep, after, dq, sq, bq, rawBare] = m as unknown as string[];
    const quoted = dq ?? sq ?? bq;
    // "**Token:** none**": markdown emphasis closing a bare value is not part of it.
    const bare = rawBare?.replace(/[*_~]+$/, "");
    const emphasis = rawBare !== undefined ? rawBare.slice(bare!.length) : "";
    if (quoted === undefined && !bare) return undefined;
    if (!redactAssignmentValue(name!, !!(before || after), sep!, quoted, bare)) return undefined;
    // The match ends with the value (and its closing quote): swap just that.
    const valueLength = quoted !== undefined ? quoted.length + 1 : rawBare!.length;
    const close = quoted !== undefined ? whole!.slice(-1) : emphasis;
    return `${whole!.slice(0, whole!.length - valueLength)}${REDACTED}${close}`;
  }),
  replaceGroup(FLAG, (m) => {
    const [, flag, sep, dq, sq, bare] = m as unknown as string[];
    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
    const value = dq ?? sq ?? bare ?? "";
    if (nameStrength(flag!) !== "strong" || placeholder(value) || value.startsWith("-")) return undefined;
    return `--${flag}${sep}${quote}${REDACTED}${quote}`;
  }),
  replaceGroup(PROSE, (m) => {
    const [, word, sep, quote, raw] = m as unknown as string[];
    const value = raw!.replace(/[.!?)]+$/, "");
    if (value.length < 6 || placeholder(value) || benign(value) || !/\d/.test(value) || codeLike(value)) {
      return undefined;
    }
    // "password hunter2" is a password; after "token" or "secret" only a
    // random-looking value is (not a name like `b3os-ci-v2` or `NPM_TOKEN_2`),
    // and contract addresses are public: "the B3 token 0x…".
    if (!/^pass/i.test(word!)) {
      if (!looksRandom(value, 20) || /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value)) return undefined;
      if (/^token$/i.test(word!) && /^0x[0-9a-f]+$/i.test(value)) return undefined;
    }
    return `${word}${sep}${quote}${REDACTED}${raw!.slice(value.length)}`;
  }),
  (t) =>
    t.replace(LONG_HEX, (run: string, offset: number, all: string) => {
      if (!/\d/.test(run) || !/[a-f]/i.test(run) || entropy(run) < 3.3) return run;
      const before = all.slice(Math.max(0, offset - 40), offset);
      if (HASH_LABEL.test(before)) return run;
      if (/^(?: {2}| \*)\S/.test(all.slice(offset + run.length))) return run; // `sha256sum` output: <hex>  file
      const word = before.slice(before.search(/\S*$/));
      if (/https?:\/\//.test(word)) return run;
      return REDACTED;
    }),
  (t) =>
    t.replace(B64_SLASH, (run: string, offset: number, all: string) => {
      if (!run.includes("/") || !randomRun(run.replace(/[+/=]/g, ""))) return run;
      const before = all.slice(Math.max(0, offset - 300), offset);
      const word = before.slice(before.search(/\S*$/));
      if (/https?:\/\//.test(word) || DOC_HOSTS.test(word) || PUBLIC_KEY_PREFIX.test(before)) return run;
      return REDACTED;
    }),
  (t) =>
    t.replace(LONG_RUN, (run: string, offset: number, all: string) => {
      if (!randomRun(run) || /^0x[0-9a-f]+$/i.test(run)) return run;
      const before = all.slice(Math.max(0, offset - 300), offset);
      const urlStart = before.search(/\S*$/);
      const word = before.slice(urlStart);
      // A URL path segment ("…/datasheet/X12_Board_v3.pdf"): secrets in paths are
      // caught by the webhook rules above, query values by the name rules.
      if (/^\S*https?:\/\/[^\s/?#]+\/[^\s?#]*$/.test(word)) return run;
      if (DOC_HOSTS.test(word) || PUBLIC_KEY_PREFIX.test(before)) return run;
      return REDACTED;
    }),
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Absolute home paths → `~/…`: this machine's home dir first (any form), then
 * other `/Users/<name>` and `/home/<name>` prefixes, so no username leaves.
 */
export function rewriteHomePaths(text: string, home = os.homedir()): string {
  let out = text;
  if (home && home !== "/" && home.length > 1) {
    const h = home.replace(/\/+$/, "");
    out = out.replace(new RegExp(`${escapeRegExp(h)}(?=$|[/\\s'"\`):,;\\]}>])`, "g"), "~");
  }
  out = out.replace(/(?<![\w.~-])\/(?:Users|home)\/[^/\s'"`):,;\]}>]+(?=\/|$|[\s'"`):,;\]}>])/g, "~");
  out = out.replace(/\b[A-Za-z]:\\Users\\[^\\\s'"`]+/g, "~");
  return out;
}

export interface ScrubOptions {
  /** This machine's home dir (tests inject a fake one). */
  home?: string;
  /** Cap after redaction. */
  max?: number;
}

/** Redacts secrets and rewrites home paths. Never throws. */
export function redactSecrets(text: string, home?: string): string {
  let out = text;
  for (const rule of RULES) {
    try {
      out = rule(out);
    } catch {
      return REDACTED; // a rule failing must never let raw text through
    }
  }
  return rewriteHomePaths(out, home);
}

/**
 * Everything a text field goes through before it is queued: control
 * characters out, redaction, home paths, then the cap. Undefined for text
 * that is empty once scrubbed.
 */
export function scrubText(raw: string | undefined, opts: ScrubOptions = {}): { text: string; truncated: boolean } | undefined {
  if (typeof raw !== "string") return undefined;
  let input = raw;
  let cut = false;
  if (input.length > MAX_SCAN) {
    // Back up to whitespace so no half token sits at the cut.
    const ws = input.lastIndexOf(" ", MAX_SCAN);
    input = input.slice(0, ws > MAX_SCAN / 2 ? ws : MAX_SCAN);
    cut = true;
  }
  // eslint-disable-next-line no-control-regex
  input = input.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const redacted = redactSecrets(input, opts.home).trim();
  if (!redacted) return undefined;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  const text = truncateHead(redacted, max);
  return { text, truncated: cut || text.length < redacted.length };
}

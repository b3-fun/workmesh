/**
 * Fake secrets for the redaction and privacy tests: real prefixes, lengths
 * and alphabets, none of them live. Each one is assembled at runtime from
 * pieces so no secret-shaped literal sits in the repo (GitHub push protection
 * and other scanners would rightly flag one).
 */
const j = (...parts: string[]): string => parts.join("");

/** A deterministic pseudo-random string over an alphabet (looks random, is not). */
export function fakeChars(n: number, seed: number, alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"): string {
  let x = seed >>> 0 || 1;
  let out = "";
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out += alphabet[(x >>> 0) % alphabet.length];
  }
  return out;
}
const hex = (n: number, seed: number): string => fakeChars(n, seed, "0123456789abcdef");

export const SECRETS = {
  anthropic: j("sk", "-ant-", "api03-", fakeChars(93, 1), "AA"),
  openai: j("sk", "-proj-", fakeChars(74, 2)),
  openaiLegacy: j("sk", "-", fakeChars(48, 3)),
  openrouter: j("sk", "-or-", "v1-", hex(64, 4)),
  stripe: j("sk", "_live_", "51", fakeChars(48, 5)),
  ghp: j("gh", "p_", fakeChars(36, 6)),
  gho: j("gh", "o_", fakeChars(36, 7)),
  ghs: j("gh", "s_", fakeChars(36, 8)),
  githubPat: j("github", "_pat_", "11", fakeChars(20, 9), "_", fakeChars(59, 10)),
  slackBot: j("xo", "xb-", "2761234567890-", "4567890123456-", fakeChars(24, 11)),
  slackUser: j("xo", "xp-", "2761234567890-", "2761234567891-", "4567890123456-", hex(32, 12)),
  awsId: j("AK", "IA", fakeChars(16, 13, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")),
  awsSecret: j(fakeChars(20, 14), "/", fakeChars(19, 15)),
  npm: j("np", "m_", fakeChars(36, 16)),
  linear: j("lin", "_api_", fakeChars(40, 17)),
  hubToken: j("bp", "_", hex(64, 18)),
  relayDevice: j("ab", "_", hex(64, 19)),
  google: j("AI", "za", "Sy", fakeChars(33, 20)),
  hf: j("hf", "_", fakeChars(34, 21)),
  jwt: j("ey", "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".", "ey", "JzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0", ".", fakeChars(43, 22)),
  cloudflare: fakeChars(40, 23),
  databento: j("db", "-", fakeChars(29, 24)),
  password: j("hunt", "er2"),
  pgPassword: j("S3cr", "3tPa55!"),
  slackWebhook: j("https://hooks.", "slack.com/services/", "T0", fakeChars(9, 25, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), "/B0", fakeChars(9, 26, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), "/", fakeChars(24, 27)),
  evmKey: hex(64, 28),
} as const;

/** The secret part of the Slack webhook (what must not survive). */
export const SLACK_WEBHOOK_SECRET = SECRETS.slackWebhook.slice(-24);

export const PEM = [
  j("-----BEGIN OPENSSH ", "PRIVATE KEY-----"),
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
  "QyNTUxOQAAACBzZWNyZXRrZXlNQVJLRVJmb3J0ZXN0aW5nb25seQAAAAAAAAAAAAAAAAAAA",
  j("-----END OPENSSH ", "PRIVATE KEY-----"),
].join("\n");
/** A line from inside the PEM body (what must not survive). */
export const PEM_BODY = "c2VjcmV0a2V5TUFSS0VS";

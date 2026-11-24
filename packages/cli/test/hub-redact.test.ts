import { describe, expect, it } from "vitest";
import {
  REDACTED,
  entropy,
  nameStrength,
  nameWords,
  redactSecrets,
  rewriteHomePaths,
  scrubText,
} from "../src/hub/redact";

const HOME = "/Users/testuser";
const r = (s: string): string => redactSecrets(s, HOME);

import { PEM, PEM_BODY, SECRETS, SLACK_WEBHOOK_SECRET } from "./fixtures/fake-secrets";

describe("redactSecrets: true positives (SPEC §9 list)", () => {
  const cases: Array<[string, string, string]> = [
    ["Anthropic key", `export ANTHROPIC_API_KEY=${SECRETS.anthropic}`, SECRETS.anthropic],
    ["Anthropic key in prose", `use ${SECRETS.anthropic} for the eval`, SECRETS.anthropic],
    ["OpenAI project key", `key is ${SECRETS.openai}`, SECRETS.openai],
    ["OpenAI legacy key", `"${SECRETS.openaiLegacy}"`, SECRETS.openaiLegacy],
    ["OpenRouter key", `OPENROUTER=${SECRETS.openrouter}`, SECRETS.openrouter],
    ["Stripe secret key", `stripe login ${SECRETS.stripe}`, SECRETS.stripe],
    ["GitHub ghp_", `git clone https://${SECRETS.ghp}@github.com/b3-fun/x`, SECRETS.ghp],
    ["GitHub gho_", `token ${SECRETS.gho}`, SECRETS.gho],
    ["GitHub ghs_", SECRETS.ghs, SECRETS.ghs],
    ["GitHub fine-grained PAT", `GH_PAT=${SECRETS.githubPat}`, SECRETS.githubPat],
    ["Slack bot token", `SLACK_BOT_TOKEN: ${SECRETS.slackBot}`, SECRETS.slackBot],
    ["Slack user token", `the xoxp is ${SECRETS.slackUser}`, SECRETS.slackUser],
    ["Slack webhook", `curl -X POST ${SECRETS.slackWebhook} -d '{}'`, SLACK_WEBHOOK_SECRET],
    ["AWS access key id", `aws_access_key_id = ${SECRETS.awsId}`, SECRETS.awsId],
    ["AWS secret by name", `aws_secret_access_key = ${SECRETS.awsSecret}`, SECRETS.awsSecret],
    ["AWS secret env", `AWS_SECRET_ACCESS_KEY=${SECRETS.awsSecret} aws s3 ls`, SECRETS.awsSecret],
    ["npm token", `//registry.npmjs.org/:_authToken=${SECRETS.npm}`, SECRETS.npm],
    ["Linear key", `linear auth ${SECRETS.linear}`, SECRETS.linear],
    ["hub device token", `Authorization: Bearer ${SECRETS.hubToken}`, SECRETS.hubToken],
    ["relay device token", `{"deviceToken":"${SECRETS.relayDevice}"}`, SECRETS.relayDevice],
    ["Google API key", `?key=${SECRETS.google}`, SECRETS.google],
    ["Hugging Face token", `HF_TOKEN=${SECRETS.hf}`, SECRETS.hf],
    ["JWT", `cookie session=${SECRETS.jwt}; path=/`, SECRETS.jwt],
    ["JWT alone", `decoded ${SECRETS.jwt} fine`, SECRETS.jwt.split(".")[2]!],
    ["Bearer header", `curl -H "Authorization: Bearer ${SECRETS.cloudflare}" https://api.cloudflare.com`, SECRETS.cloudflare],
    ["Bearer anywhere", `send Bearer ${SECRETS.cloudflare} to it`, SECRETS.cloudflare],
    ["Basic auth header", "Authorization: Basic dXNlcjpodW50ZXIyMDI2", "dXNlcjpodW50ZXIyMDI2"],
    ["X-Api-Key header", `-H 'X-Api-Key: ${SECRETS.cloudflare}'`, SECRETS.cloudflare],
    ["Cloudflare token by name", `CLOUDFLARE_API_TOKEN=${SECRETS.cloudflare}`, SECRETS.cloudflare],
    ["Cloudflare token alone (entropy)", `I set it to ${SECRETS.cloudflare} earlier`, SECRETS.cloudflare],
    ["Databento key", `DATABENTO=${SECRETS.databento}`, SECRETS.databento],
    ["password = value", `password = "${SECRETS.password}"`, SECRETS.password],
    ["password: value", `password: ${SECRETS.password}`, SECRETS.password],
    ["markdown label", `- **Password:** ${SECRETS.pgPassword}**`, SECRETS.pgPassword],
    ["PASSWORD=value", "DB_PASSWORD=correcthorse psql", "correcthorse"],
    ["password in prose", `deploy with password ${SECRETS.password} please`, SECRETS.password],
    ["password is", `the password is ${SECRETS.pgPassword}`, SECRETS.pgPassword],
    ["JSON secret", `{"client_secret": "abc-def-ghi"}`, "abc-def-ghi"],
    ["YAML token", "  api_token: 'q1w2e3r4t5'", "q1w2e3r4t5"],
    ["CLI flag", `npm publish --otp 123456 --token ${SECRETS.password}x9`, `${SECRETS.password}x9`],
    ["CLI flag =", "wrangler deploy --api-key=abcd1234efgh", "abcd1234efgh"],
    ["URL credentials", `postgres://admin:${SECRETS.pgPassword}@db.internal:5432/app`, SECRETS.pgPassword],
    ["URL credentials user too", "redis://default:hunter2@cache:6379", "default:hunter2"],
    ["URL token query", "https://api.example.com/v1?access_token=Zx81Kq2w3e4r5t6y&x=1", "Zx81Kq2w3e4r5t6y"],
    ["presigned signature", "X-Amz-Signature=3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b", "3f9a8b7c6d5e4f3a2b1c"],
    ["generic key next to entropy", "license key: 7Fq2Lp9Xz3Wm8Rt4", "7Fq2Lp9Xz3Wm8Rt4"],
    ["private key hex by name", `PRIVATE_KEY=0x${SECRETS.evmKey}`, SECRETS.evmKey.slice(0, 16)],
    ["private key prose", `the private key 0x${SECRETS.evmKey} funds it`, SECRETS.evmKey.slice(0, 16)],
    ["PEM block", `here:\n${PEM}\nthen`, PEM_BODY],
  ];
  for (const [name, input, secret] of cases) {
    it(name, () => {
      const out = r(input);
      expect(out, out).not.toContain(secret);
      expect(out).toContain(REDACTED);
    });
  }

  it("redacts a PEM block cut off before its END line", () => {
    const cut = PEM.split("\n").slice(0, 3).join("\n");
    const out = r(`key:\n${cut}`);
    expect(out).not.toContain("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUA");
    expect(out.startsWith("key:\n")).toBe(true);
  });

  it("keeps the words around a redaction", () => {
    expect(r(`curl -H "Authorization: Bearer ${SECRETS.cloudflare}" https://api.cloudflare.com/client/v4`)).toBe(
      `curl -H "Authorization: Bearer ${REDACTED}" https://api.cloudflare.com/client/v4`,
    );
    expect(r(`postgres://admin:${SECRETS.pgPassword}@db:5432/app`)).toBe(`postgres://${REDACTED}@db:5432/app`);
    expect(r(`password = "${SECRETS.password}";`)).toBe(`password = "${REDACTED}";`);
    expect(r("--token abc123def --dry-run")).toBe(`--token ${REDACTED} --dry-run`);
  });

  it("is idempotent", () => {
    const once = r(`a=${SECRETS.anthropic} password: hunter2 ${SECRETS.jwt}`);
    expect(r(once)).toBe(once);
  });
});

describe("redactSecrets: no mangling of ordinary text", () => {
  const keep = [
    // prose
    "I'll run the tests, then open a PR. The token is stored in Keychain and never printed.",
    "Bearer tokens are checked on every request; Basic auth is off.",
    "The password reset flow sends an email. Secret santa is on Friday.",
    "Set the API key in the dashboard, then rotate the key every 90 days.",
    "Use a token budget of 200k and max_tokens: 4000.",
    "Authorization: required for every /api route.",
    "Token usage: 116685 input, 139 output.",
    "The B3 token 0xB3B32F9f8827D4634fE7d973Fa1034Ec9fdDB3B3 trades on Base.",
    // repo paths, URLs, ids
    "Edited packages/cli/src/hub/forwarder.ts:120 and src/worker/schema.ts.",
    "PR: https://github.com/b3-fun/b3os-beta/pull/42 (Linear B3-7166, https://linear.app/npclabs/issue/B3-7166/relay).",
    "ssh git@github.com:b3-fun/workmesh.git and https://workmesh.b3os.org/relay/ingest",
    "Commit af2476c, full sha 1d8775e4b2e9d0c1f3a5b7d9e1f3a5b7c9d1e3f5, digest sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.",
    "Session 550e8400-e29b-41d4-a716-446655440000 and version 2b7bdad8-6a5b-48ba-92bc-5cfc129dd7da.",
    "sessionId: 01a20de9-e2dc-7af1-8740-767b47aeac91",
    "Deployed at 2026-11-24T20:54:00.000Z, then 2026-11-24 15:43, timeout 5000ms, v22.11.0, workmesh 0.7.0.",
    "scikit-learn and sk-learn style pipelines; disk-1234567890abcdefghij is a volume id.",
    "node_modules/.pnpm/@cloudflare+workers-types@4.20251001.0/node_modules/@cloudflare/workers-types/index.d.ts",
    // code
    "const token = await getToken(user);\nconst password = req.body.password;\nif (password.length < 8) throw new Error('short');",
    "export const HUB_DEVICE_TOKEN_RE = /^bp_[0-9a-f]{64}$/;",
    "headers: { authorization: `Bearer ${this.token}` }",
    'curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com',
    "export GITHUB_TOKEN=$(gh auth token) && API_KEY=${API_KEY:-}",
    "token: z.string().min(1), apiKey: string; secret?: string",
    "const { token: accessToken } = await login(); apiKey = config.apiKey;",
    "password_hash = bcrypt(pw); tokenCount = 3; passwordHash: string",
    '{"key": "claude-code:s1", "issueKeys": ["B3"], "kind": "tool"}',
    "with: { token: ${{ secrets.NPM_TOKEN }} }",
    "OPENAI_API_KEY=process.env.OPENAI_API_KEY",
    "git -C ~/Documents/workmesh log --oneline -5 && npm test -- --reporter=verbose",
    "for (const [key, value] of Object.entries(map)) console.log(key, value);",
    "| Field | Type |\n|---|---|\n| `text` | string ≤ 4,000 |",
    "useHubForwarderStatusWithRetries and createDaemonServerWithHubForwarder",
    "HUB_MAX_EVENTS_PER_REQUEST_2026 test-fixture-with-a-very-long-name-2026",
    // markdown labels, secret names, examples, public ids (from a false-positive audit on real agent text)
    "- **Client secret:** stored in Keychain\n- **Secrets:** none in the repo\n**First token:** rotated",
    "Saved it as the GitHub secret `B3OS_RELEASE_NPM_KEY2` and the Access service token `b3os-bench-ci-v2`.",
    "cd ~/Documents/holydocs && CLOUDFLARE_ACCOUNT_ID=ca35bee1a2b3c4d5e6f708192a3b4c5d npx wrangler deploy",
    "Use a line such as `OPENAI_API_KEY=sk-...` or `postgres://...`.",
    "Doc: https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEf/edit",
    "Add the deploy key:\n```\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx9Kq2Lp7Rt4Wm8Xz3Nv5Bc1Df6Gh0Jk sean@studio\n```",
    'read -rs "K?API key: " && curl -sS https://api-eu1.ex2mp.com/v4/zones/settings/cache -H "Authorization: Bearer $K"',
    "- **Cloudflare zone token: none**\n- **Token:** n/a",
    "Installed; the backup is `.env-backup-b3-T-20261124T153000Z` and we fall back to the basic flow-v2.",
    "Datasheet: https://www.supermicro.com/datasheet/datasheet_SuperServer_SYS421_GPU48.pdf",
    'read -rs "K?API key: " K && curl -sS -H "Authorization: Bearer $K" https://api.example.com/v4/zones',
  ];
  for (const text of keep) {
    it(text.slice(0, 60), () => {
      expect(r(text)).toBe(text);
    });
  }
});

describe("name and value classifiers", () => {
  it("splits names into words", () => {
    expect(nameWords("AWS_SECRET_ACCESS_KEY")).toEqual(["aws", "secret", "access", "key"]);
    expect(nameWords("apiKey")).toEqual(["api", "key"]);
    expect(nameWords("XApiKey")).toEqual(["x", "api", "key"]);
    expect(nameWords("x-auth-token")).toEqual(["x", "auth", "token"]);
  });

  it("only a final secret word makes a name secret", () => {
    expect(nameStrength("accessToken")).toBe("strong");
    expect(nameStrength("OPENAI_API_KEY")).toBe("strong");
    expect(nameStrength("APIKEY")).toBe("strong");
    expect(nameStrength("client_secret")).toBe("strong");
    expect(nameStrength("primary_key")).toBe("generic");
    expect(nameStrength("tokenCount")).toBeUndefined();
    expect(nameStrength("max_tokens")).toBeUndefined();
    expect(nameStrength("passwordHash")).toBeUndefined();
    expect(nameStrength("sessionId")).toBeUndefined();
  });

  it("measures entropy", () => {
    expect(entropy("aaaa")).toBe(0);
    expect(entropy(SECRETS.cloudflare)).toBeGreaterThan(4);
  });
});

describe("rewriteHomePaths", () => {
  it("turns this machine's home into ~ in every form", () => {
    expect(rewriteHomePaths("open /Users/testuser/Documents/b3/x.ts", HOME)).toBe("open ~/Documents/b3/x.ts");
    expect(rewriteHomePaths('cd "/Users/testuser" && ls', HOME)).toBe('cd "~" && ls');
    expect(rewriteHomePaths("file:///Users/testuser/a.html", HOME)).toBe("file://~/a.html");
  });

  it("hides other users' home dirs too, and leaves other absolute paths", () => {
    expect(rewriteHomePaths("see /Users/an/dev/b3 and /home/runner/work/x", HOME)).toBe("see ~/dev/b3 and ~/work/x");
    expect(rewriteHomePaths("C:\\Users\\Gio\\code\\b3", HOME)).toBe("~\\code\\b3");
    expect(rewriteHomePaths("/opt/homebrew/bin/node /tmp/x /usr/local/lib", HOME)).toBe("/opt/homebrew/bin/node /tmp/x /usr/local/lib");
    expect(rewriteHomePaths("https://example.com/Users/foo/profile", HOME)).toBe("https://example.com/Users/foo/profile");
    expect(rewriteHomePaths("/Users/testuserx/a", HOME)).toBe("~/a"); // another user: still hidden
  });
});

describe("scrubText", () => {
  it("redacts, rewrites home paths, then caps with truncated", () => {
    const res = scrubText(`ship it, password: hunter2, from /Users/testuser/x ${"y".repeat(5000)}`, { home: HOME, max: 4000 });
    expect(res?.text.length).toBe(4000);
    expect(res?.truncated).toBe(true);
    expect(res?.text).not.toContain("hunter2");
    expect(res?.text).toContain("~/x");
    expect(scrubText("short", { max: 4000 })).toEqual({ text: "short", truncated: false });
  });

  it("drops control characters and ANSI colors; empty text is nothing", () => {
    expect(scrubText("\u001b[32mok\u001b[0m\u0000")?.text).toBe("ok");
    expect(scrubText("   ")).toBeUndefined();
    expect(scrubText(undefined)).toBeUndefined();
  });

  it("scans very long text only up to a whitespace boundary and still redacts it", () => {
    const res = scrubText(`${"word ".repeat(20_000)}${SECRETS.ghp}`, { max: 4000 });
    expect(res?.truncated).toBe(true);
    expect(JSON.stringify(res)).not.toContain(SECRETS.ghp);
  });
});

import crypto from "node:crypto";
import { z } from "zod";
import { parseVersion } from "./versions";

/**
 * Signed releases (SPEC §41). A release carries a list of its files (`workmesh-release.json`: version, creation time,
 * and each file's name, SHA-256 and size) and a signature over the exact bytes of that list
 * (`workmesh-release.json.sig`: an Ed25519 signature, base64). The client pins the maintainers' public keys
 * (`release-keys.ts`), so a file's hash is trusted only when a maintainer's key signed the list that names it. The
 * place that hosts the release can then no longer vouch for its own files.
 */

export const RELEASE_LIST = "workmesh-release.json";
export const RELEASE_LIST_SIG = "workmesh-release.json.sig";
/** A list is a few hundred bytes and a signature 88 characters; nothing near these sizes is either. */
export const MAX_LIST_BYTES = 64 * 1024;
export const MAX_SIG_BYTES = 1024;

const SHA256_RE = /^[0-9a-f]{64}$/;

export const releaseListSchema = z.object({
  version: z.string().max(40).refine((v) => parseVersion(v) !== undefined, "not a release version"),
  createdAt: z.iso.datetime(),
  files: z
    .array(z.object({ name: z.string().min(1).max(200), sha256: z.string().regex(SHA256_RE), size: z.number().int().nonnegative() }))
    .min(1)
    .max(100),
});
export type ReleaseList = z.infer<typeof releaseListSchema>;
export type ReleaseListFile = ReleaseList["files"][number];

/** Why a release's list was refused. */
export type ReleaseListProblem = "bad-signature" | "bad-list" | "wrong-version";

export type ReleaseListCheck = { ok: true; list: ReleaseList } | { ok: false; reason: ReleaseListProblem; detail: string };

/** A pinned key as a key object; undefined when the entry isn't the base64 of a raw 32-byte Ed25519 public key. */
export function releasePublicKey(entry: string): crypto.KeyObject | undefined {
  const raw = Buffer.from(entry, "base64");
  if (raw.length !== 32 || raw.toString("base64") !== entry) return undefined;
  try {
    return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
  } catch {
    return undefined;
  }
}

/** The 64 signature bytes in a `.sig` file's text; undefined when it isn't the base64 of exactly 64 bytes. */
function signatureBytes(text: string): Buffer | undefined {
  const b64 = text.trim();
  const raw = Buffer.from(b64, "base64");
  return raw.length === 64 && raw.toString("base64") === b64 ? raw : undefined;
}

/** Whether `signature` is one of `keys`' Ed25519 signature over exactly `bytes`. */
export function signedByPinnedKey(bytes: Uint8Array, signature: string, keys: readonly string[]): boolean {
  const sig = signatureBytes(signature);
  if (!sig) return false;
  for (const entry of keys) {
    const key = releasePublicKey(entry);
    if (!key) continue;
    try {
      if (crypto.verify(null, bytes, key, sig)) return true;
    } catch {
      // a key this Node can't verify with counts as no match
    }
  }
  return false;
}

/**
 * Checks a release list against the pinned keys and the release it came with: the signature must be a pinned key's
 * over these exact bytes, the bytes must be a list, and the list must be for `version`. The bytes are read as a list
 * only after their signature verified, so nothing unsigned is ever parsed.
 */
export function verifyReleaseList(bytes: Uint8Array, signature: string, keys: readonly string[], version: string): ReleaseListCheck {
  if (!signedByPinnedKey(bytes, signature, keys)) {
    return { ok: false, reason: "bad-signature", detail: `the signature on ${RELEASE_LIST} is not from a maintainer key this version trusts` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return { ok: false, reason: "bad-list", detail: `${RELEASE_LIST} is signed but is not JSON` };
  }
  const parsed = releaseListSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "bad-list", detail: `${RELEASE_LIST} is signed but is not a release list` };
  }
  if (parsed.data.version !== version) {
    return { ok: false, reason: "wrong-version", detail: `the signed list is for ${parsed.data.version}, not for this release (${version})` };
  }
  return { ok: true, list: parsed.data };
}

/**
 * The maintainer keys a release must be signed with (SPEC §41, "Signed releases"; checked in `release-signing.ts`).
 *
 * The list is empty: the maintainers have not made a signing key yet. While it is empty, release signing is not
 * switched on, and the menu bar app's download is checked against the SHA-256 GitHub lists for the release, as before.
 *
 * To switch signing on, add a public key here in a PR (CONTRIBUTING.md, "Releasing"). From the version that ships it,
 * a release without a list signed by one of these keys offers no menu bar app. Each entry is one line: the base64 of
 * a raw 32-byte Ed25519 public key, as `node scripts/sign-release.mjs --new-key <file>` prints it. Only public keys
 * belong here. The script reads this file to tell a maintainer whether their key is pinned, so keep one key per line.
 */
export const RELEASE_KEYS: readonly string[] = [];

import { execFile } from "node:child_process";
import { PACKAGE_NAME } from "./install-method";
import { RELEASE_KEYS } from "./release-keys";
import { MAX_LIST_BYTES, MAX_SIG_BYTES, RELEASE_LIST, RELEASE_LIST_SIG, verifyReleaseList } from "./release-signing";
import { readMenubarRelease } from "./update-state";
import type { MenubarHeld, MenubarHeldReason, MenubarRelease } from "./update-state";
import { parseVersion } from "./versions";

/**
 * Where new versions come from (SPEC §41): the npm registry for the CLI (the registry npm is configured with, so a
 * private mirror works), GitHub releases for the menu bar app's zip. With maintainer keys pinned (`release-keys.ts`),
 * the zip's hash comes from the release's signed list, not from what GitHub says about its own files.
 */

export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
export const RELEASES_URL = "https://api.github.com/repos/b3-fun/workmesh/releases/latest";
export const MENUBAR_ASSET = "Workmesh-menubar-macos.zip";

/** The registry from the environment (`WORKMESH_REGISTRY`, then npm's own `npm_config_registry`), if set. */
export function envRegistry(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const r = env.WORKMESH_REGISTRY || env.npm_config_registry || env.NPM_CONFIG_REGISTRY;
  return r && /^https?:\/\//.test(r) ? r : undefined;
}

/** The registry npm uses here: the environment, else `npm config get registry`, else npmjs.org. */
export function npmRegistry(npm = "npm", env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fromEnv = envRegistry(env);
  if (fromEnv) return Promise.resolve(fromEnv);
  return new Promise((resolve) => {
    execFile(npm, ["config", "get", "registry"], { timeout: 8000, env }, (err, stdout) => {
      const r = String(stdout ?? "").trim();
      resolve(!err && /^https?:\/\//.test(r) ? r : DEFAULT_REGISTRY);
    });
  });
}

export interface RegistryInfo {
  latest: string;
  /** Every published version (to check `--to`). */
  versions: string[];
  /** When the registry says each version was published (ms); empty when it gives no times. */
  published: Record<string, number>;
}

/** An ISO timestamp as ms; undefined when it isn't one. */
function timeMs(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : undefined;
}

/**
 * The `latest` dist-tag, versions and publish times of `@b3os/workmesh`, from the full packument. The abbreviated one
 * npm installs from carries no times, and the waiting time for new releases needs them.
 */
export async function fetchRegistryInfo(registry: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<RegistryInfo> {
  const url = `${registry.replace(/\/+$/, "")}/${PACKAGE_NAME.replace("/", "%2f")}`;
  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const body = (await res.json()) as { "dist-tags"?: { latest?: unknown }; versions?: unknown; time?: unknown };
  const latest = body["dist-tags"]?.latest;
  if (typeof latest !== "string" || !parseVersion(latest)) throw new Error(`${url} names no latest version`);
  const versions = body.versions && typeof body.versions === "object" ? Object.keys(body.versions).filter((v) => parseVersion(v)) : [latest];
  const times = body.time && typeof body.time === "object" ? (body.time as Record<string, unknown>) : {};
  const published: Record<string, number> = {};
  for (const v of versions) {
    const t = timeMs(times[v]);
    if (t !== undefined) published[v] = t;
  }
  return { latest, versions, published };
}

/**
 * What the latest GitHub release holds for the menu bar app: a zip to `offer`; a zip that is `held` because the
 * release failed the signing check (with why); or `none` (a draft or prerelease, no zip, or no way to check it).
 */
export type MenubarRead = { kind: "offer"; release: MenubarRelease } | { kind: "held"; held: MenubarHeld } | { kind: "none" };

type ReleaseAsset = { name?: unknown; browser_download_url?: unknown; digest?: unknown; size?: unknown; created_at?: unknown; updated_at?: unknown };

/** https, or plain http to this machine (what the tests and the mock daemon serve). */
function assetUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v);
    if (u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost"))) return u.href;
  } catch {
    // not a URL
  }
  return undefined;
}

/** A small release asset's bytes. Throws when it can't be read or is larger than `max`. */
async function fetchAsset(asset: ReleaseAsset, name: string, max: number, fetchImpl: typeof fetch, timeoutMs: number): Promise<Uint8Array> {
  const url = assetUrl(asset.browser_download_url);
  if (!url) throw new Error(`${name} has no https download link`);
  const res = await fetchImpl(url, { headers: { "user-agent": "workmesh-relay" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${name} answered ${res.status}`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`${name} is larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * The latest GitHub release's menu bar zip: version (the tag without `v`), download URL, SHA-256, size and when it
 * went out.
 *
 * With no maintainer key pinned (`keys` empty: signing is not switched on), the SHA-256 is the digest GitHub reports
 * for the asset (`digest: "sha256:…"`), and a release without one offers nothing, since the download can't be checked.
 *
 * With keys pinned, the release is offered only when it carries `workmesh-release.json` and its `.sig`, a pinned key
 * signed that list, the list is for this release's version, and it names the zip. The SHA-256 and size then come from
 * the signed list. A release that fails any of these is `held` with the reason, and so is one whose zip on GitHub is
 * not the file that was signed. The two small files are read with a size limit; a read that fails throws, like a
 * failed read of the release itself.
 */
export async function fetchMenubarRelease(
  url = process.env.WORKMESH_RELEASES_URL || RELEASES_URL,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
  keys: readonly string[] = RELEASE_KEYS,
): Promise<MenubarRead> {
  const res = await fetchImpl(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "workmesh-relay", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; published_at?: unknown; assets?: ReleaseAsset[] };
  if (body.draft === true || body.prerelease === true || typeof body.tag_name !== "string") return { kind: "none" };
  const assets = Array.isArray(body.assets) ? body.assets : [];
  const zip = assets.find((a) => a?.name === MENUBAR_ASSET);
  if (!zip) return { kind: "none" };
  const version = body.tag_name.replace(/^v/, "");
  // A tag that isn't a version is never offered, signing on or off, and its text goes into no reason.
  if (!parseVersion(version)) return { kind: "none" };
  const digest = typeof zip.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(zip.digest)?.[1]?.toLowerCase() : undefined;
  // A zip put on an older release counts from when it was put there, not from when the release went out.
  const released = timeMs(body.published_at);
  const publishedAt = released === undefined ? undefined : Math.max(released, timeMs(zip.updated_at) ?? timeMs(zip.created_at) ?? 0);
  const base = { version, url: zip.browser_download_url, releaseUrl: body.html_url, publishedAt };
  const offer = (release: MenubarRelease | undefined): MenubarRead => (release ? { kind: "offer", release } : { kind: "none" });

  if (keys.length === 0) return offer(readMenubarRelease({ ...base, sha256: digest, size: zip.size }));

  const held = (reason: MenubarHeldReason, detail: string): MenubarRead => ({ kind: "held", held: { version, reason, detail } });
  const list = assets.find((a) => a?.name === RELEASE_LIST);
  const sig = assets.find((a) => a?.name === RELEASE_LIST_SIG);
  if (!list || !sig) {
    const missing = [list ? "" : RELEASE_LIST, sig ? "" : RELEASE_LIST_SIG].filter(Boolean).join(" and ");
    return held("unsigned", `the release has no ${missing}, so no maintainer key vouches for its files`);
  }
  const listBytes = await fetchAsset(list, RELEASE_LIST, MAX_LIST_BYTES, fetchImpl, timeoutMs);
  const sigBytes = await fetchAsset(sig, RELEASE_LIST_SIG, MAX_SIG_BYTES, fetchImpl, timeoutMs);
  const check = verifyReleaseList(listBytes, Buffer.from(sigBytes).toString("utf8"), keys, version);
  if (!check.ok) return held(check.reason, check.detail);
  const file = check.list.files.find((f) => f.name === MENUBAR_ASSET);
  if (!file) return held("bad-list", `the signed list does not name ${MENUBAR_ASSET}`);
  // What GitHub says about its own copy can show that it is not the signed file. It is never what vouches for it.
  let differs: string | undefined;
  if (digest !== undefined && digest !== file.sha256) differs = "SHA-256";
  else if (digest === undefined && typeof zip.size === "number" && zip.size !== file.size) differs = "size";
  if (differs) return held("hash-mismatch", `GitHub's copy of ${MENUBAR_ASSET} is not the file the maintainers signed (its ${differs} differs)`);
  return offer(readMenubarRelease({ ...base, sha256: file.sha256, size: file.size, signed: true }));
}

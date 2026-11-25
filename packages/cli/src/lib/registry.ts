import { execFile } from "node:child_process";
import { PACKAGE_NAME } from "./install-method";
import { readMenubarRelease } from "./update-state";
import type { MenubarRelease } from "./update-state";
import { parseVersion } from "./versions";

/**
 * Where new versions come from (SPEC §41): the npm registry for the CLI (the registry npm is configured with, so a
 * private mirror works), GitHub releases for the menu bar app's zip.
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
}

/** `@b3os/workmesh`'s `latest` dist-tag and versions, from the abbreviated packument. */
export async function fetchRegistryInfo(registry: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<RegistryInfo> {
  const url = `${registry.replace(/\/+$/, "")}/${PACKAGE_NAME.replace("/", "%2f")}`;
  const res = await fetchImpl(url, {
    headers: { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const body = (await res.json()) as { "dist-tags"?: { latest?: unknown }; versions?: unknown };
  const latest = body["dist-tags"]?.latest;
  if (typeof latest !== "string" || !parseVersion(latest)) throw new Error(`${url} names no latest version`);
  const versions = body.versions && typeof body.versions === "object" ? Object.keys(body.versions).filter((v) => parseVersion(v)) : [latest];
  return { latest, versions };
}

/**
 * The latest GitHub release's menu bar zip: version (the tag without `v`), download URL and the asset's SHA-256 digest
 * (GitHub reports `digest: "sha256:…"` per asset). Undefined when the release has no zip or no digest: the menu bar
 * app then offers nothing, since it can't check the download.
 */
export async function fetchMenubarRelease(url = process.env.WORKMESH_RELEASES_URL || RELEASES_URL, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<MenubarRelease | undefined> {
  const res = await fetchImpl(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "workmesh-relay", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const body = (await res.json()) as {
    tag_name?: unknown;
    html_url?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    assets?: Array<{ name?: unknown; browser_download_url?: unknown; digest?: unknown; size?: unknown }>;
  };
  if (body.draft === true || body.prerelease === true || typeof body.tag_name !== "string") return undefined;
  const asset = (Array.isArray(body.assets) ? body.assets : []).find((a) => a?.name === MENUBAR_ASSET);
  const digest = typeof asset?.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1]?.toLowerCase() : undefined;
  return readMenubarRelease({
    version: body.tag_name.replace(/^v/, ""),
    url: asset?.browser_download_url,
    sha256: digest,
    size: asset?.size,
    releaseUrl: body.html_url,
  });
}

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MENUBAR_ASSET, fetchMenubarRelease } from "../src/lib/registry";
import { RELEASE_KEYS } from "../src/lib/release-keys";
import { MAX_LIST_BYTES, RELEASE_LIST, RELEASE_LIST_SIG, releasePublicKey, signedByPinnedKey, verifyReleaseList } from "../src/lib/release-signing";

/**
 * Signed releases (SPEC §41): a release's file list must carry a pinned maintainer key's signature before the client
 * takes a hash from it. Every key here is made inside the test; no private key is committed.
 */

interface TestKey {
  /** As the client pins it: the base64 of the raw 32-byte public key. */
  pub: string;
  sign: (bytes: Uint8Array) => string;
}

function makeKey(): TestKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  return { pub: Buffer.from(x, "base64url").toString("base64"), sign: (bytes) => crypto.sign(null, bytes, privateKey).toString("base64") };
}

const sha = (bytes: Uint8Array | string) => crypto.createHash("sha256").update(bytes).digest("hex");
const ZIP = Buffer.from("the menu bar app, zipped");
const VERSION = "0.12.4";

function listBytes(over: { version?: string; files?: unknown; createdAt?: unknown } = {}): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        version: over.version ?? VERSION,
        createdAt: over.createdAt ?? "2026-11-26T10:00:00.000Z",
        files: over.files ?? [{ name: MENUBAR_ASSET, sha256: sha(ZIP), size: ZIP.length }],
      },
      null,
      2,
    )}\n`,
  );
}

const maintainer = makeKey();
const stranger = makeKey();

describe("a release list and its signature", () => {
  it("good: a pinned key's signature over these exact bytes, for this version", () => {
    const bytes = listBytes();
    const r = verifyReleaseList(bytes, maintainer.sign(bytes), [maintainer.pub], VERSION);
    expect(r).toEqual({ ok: true, list: { version: VERSION, createdAt: "2026-11-26T10:00:00.000Z", files: [{ name: MENUBAR_ASSET, sha256: sha(ZIP), size: ZIP.length }] } });
    // The file's own line ending is part of what was signed.
    expect(signedByPinnedKey(bytes, `${maintainer.sign(bytes)}\n`, [maintainer.pub])).toBe(true);
  });

  it("any one of several pinned keys will do", () => {
    const bytes = listBytes();
    expect(verifyReleaseList(bytes, maintainer.sign(bytes), [stranger.pub, maintainer.pub], VERSION).ok).toBe(true);
  });

  it("bad: one changed byte in the list, or in the signature, and it is refused", () => {
    const bytes = listBytes();
    const sig = maintainer.sign(bytes);
    const tampered = Buffer.from(bytes.toString("utf8").replace(sha(ZIP), sha("another file")));
    expect(verifyReleaseList(tampered, sig, [maintainer.pub], VERSION)).toMatchObject({ ok: false, reason: "bad-signature" });
    const flipped = Buffer.from(sig, "base64");
    flipped[10] = flipped[10]! ^ 1;
    expect(verifyReleaseList(bytes, flipped.toString("base64"), [maintainer.pub], VERSION)).toMatchObject({ ok: false, reason: "bad-signature" });
    // Re-encoded with other whitespace, the same JSON is not the same bytes.
    const reflowed = Buffer.from(JSON.stringify(JSON.parse(bytes.toString("utf8"))));
    expect(verifyReleaseList(reflowed, sig, [maintainer.pub], VERSION)).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("an unknown key: a valid signature from a key that isn't pinned is refused", () => {
    const bytes = listBytes();
    const r = verifyReleaseList(bytes, stranger.sign(bytes), [maintainer.pub], VERSION);
    expect(r).toMatchObject({ ok: false, reason: "bad-signature" });
    expect(r.ok ? "" : r.detail).toContain("not from a maintainer key");
  });

  it("no pinned key verifies nothing; a signature that isn't 64 bytes of base64 neither", () => {
    const bytes = listBytes();
    expect(signedByPinnedKey(bytes, maintainer.sign(bytes), [])).toBe(false);
    for (const bad of ["", "not base64 at all", Buffer.alloc(63).toString("base64"), Buffer.alloc(65).toString("base64"), `${maintainer.sign(bytes)}AAAA`]) {
      expect(signedByPinnedKey(bytes, bad, [maintainer.pub])).toBe(false);
    }
  });

  it("a pinned entry that isn't a 32-byte key is skipped, never matched", () => {
    const bytes = listBytes();
    for (const junk of ["", "AAAA", "not a key", Buffer.alloc(31).toString("base64"), `${maintainer.pub} `]) {
      expect(releasePublicKey(junk)).toBeUndefined();
      expect(signedByPinnedKey(bytes, maintainer.sign(bytes), [junk])).toBe(false);
    }
    expect(signedByPinnedKey(bytes, maintainer.sign(bytes), ["not a key", maintainer.pub])).toBe(true);
  });

  it("wrong version: a signed list for another release is refused", () => {
    const bytes = listBytes({ version: "0.12.1" });
    const r = verifyReleaseList(bytes, maintainer.sign(bytes), [maintainer.pub], VERSION);
    expect(r).toEqual({ ok: false, reason: "wrong-version", detail: "the signed list is for 0.12.1, not for this release (0.12.4)" });
  });

  it("signed, but not a list: refused", () => {
    const cases = [
      Buffer.from("{ not json"),
      Buffer.from(JSON.stringify({ version: VERSION })),
      listBytes({ files: [] }),
      listBytes({ files: [{ name: MENUBAR_ASSET, sha256: "ABC", size: 1 }] }),
      listBytes({ files: [{ name: MENUBAR_ASSET, sha256: sha(ZIP), size: -1 }] }),
      listBytes({ createdAt: "yesterday" }),
      listBytes({ version: "newest" }),
    ];
    for (const bytes of cases) {
      expect(verifyReleaseList(bytes, maintainer.sign(bytes), [maintainer.pub], VERSION)).toMatchObject({ ok: false, reason: "bad-list" });
    }
  });

  it("the keys this version pins are well-formed and listed once", () => {
    for (const key of RELEASE_KEYS) expect(releasePublicKey(key), `${key} isn't a 32-byte Ed25519 public key in base64`).toBeDefined();
    expect(new Set(RELEASE_KEYS).size).toBe(RELEASE_KEYS.length);
  });
});

// ---------------------------------------------------------------------------------------------- reading a release

const API = "https://api.example.test/releases/latest";
const DL = "https://dl.example.test/v0.12.4";
const RELEASE_URL = "https://github.com/b3-fun/workmesh/releases/tag/v0.12.4";

interface FakeRelease {
  tag?: string;
  /** What GitHub says the zip's digest is; null: it reports none. */
  digest?: string | null;
  size?: number;
  list?: Uint8Array | null;
  sig?: string | null;
  publishedAt?: string;
  zipUpdatedAt?: string;
  listUrl?: string;
}

/** A stand-in for GitHub: the release's JSON at `API`, and the two small files at their download links. */
function github(o: FakeRelease = {}) {
  const asked: string[] = [];
  const listUrl = o.listUrl ?? `${DL}/${RELEASE_LIST}`;
  const digest = o.digest === undefined ? sha(ZIP) : o.digest;
  const body = {
    tag_name: o.tag ?? `v${VERSION}`,
    html_url: RELEASE_URL,
    published_at: o.publishedAt ?? "2026-11-20T08:00:00Z",
    assets: [
      { name: MENUBAR_ASSET, browser_download_url: `${DL}/${MENUBAR_ASSET}`, size: o.size ?? ZIP.length, ...(digest ? { digest: `sha256:${digest}` } : {}), ...(o.zipUpdatedAt ? { updated_at: o.zipUpdatedAt } : {}) },
      ...(o.list ? [{ name: RELEASE_LIST, browser_download_url: listUrl, size: o.list.length }] : []),
      ...(o.sig ? [{ name: RELEASE_LIST_SIG, browser_download_url: `${DL}/${RELEASE_LIST_SIG}`, size: o.sig.length }] : []),
    ],
  };
  const fetchImpl = (async (url: string) => {
    asked.push(url);
    if (url === API) return new Response(JSON.stringify(body));
    if (url === listUrl && o.list) return new Response(o.list);
    if (url === `${DL}/${RELEASE_LIST_SIG}` && o.sig) return new Response(o.sig);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, asked, read: (keys: readonly string[]) => fetchMenubarRelease(API, fetchImpl, 5000, keys) };
}

const signed = (over: Parameters<typeof listBytes>[0] = {}, by: TestKey = maintainer) => {
  const list = listBytes(over);
  return { list, sig: `${by.sign(list)}\n` };
};

describe("the menu bar's release, with a maintainer key pinned", () => {
  it("signature good: offered, with the hash and size from the signed list", async () => {
    const g = github({ ...signed(), digest: null, size: 1 });
    // GitHub reports no digest of its own here: the signed list is all the client needs.
    const r = await github({ ...signed(), digest: null }).read([maintainer.pub]);
    expect(r).toEqual({
      kind: "offer",
      release: { version: VERSION, url: `${DL}/${MENUBAR_ASSET}`, sha256: sha(ZIP), size: ZIP.length, releaseUrl: RELEASE_URL, signed: true, publishedAt: Date.parse("2026-11-20T08:00:00Z") },
    });
    // Without a digest from GitHub, a size that differs from the signed one still shows it isn't the signed file.
    expect(await g.read([maintainer.pub])).toMatchObject({ kind: "held", held: { reason: "hash-mismatch" } });
  });

  it("signature missing: the list, its signature, or both", async () => {
    const { list, sig } = signed();
    expect(await github({ list }).read([maintainer.pub])).toEqual({
      kind: "held",
      held: { version: VERSION, reason: "unsigned", detail: "the release has no workmesh-release.json.sig, so no maintainer key vouches for its files" },
    });
    expect(await github({ sig }).read([maintainer.pub])).toMatchObject({ kind: "held", held: { reason: "unsigned", detail: expect.stringContaining("no workmesh-release.json,") } });
    const neither = github();
    expect(await neither.read([maintainer.pub])).toMatchObject({ kind: "held", held: { reason: "unsigned", detail: expect.stringContaining("workmesh-release.json and workmesh-release.json.sig") } });
    // GitHub's own digest for the zip is right, and still nothing is offered.
    expect(neither.asked).toEqual([API]);
  });

  it("signature bad: the list was changed after it was signed", async () => {
    const { list, sig } = signed();
    const changed = Buffer.from(list.toString("utf8").replace(sha(ZIP), sha("a swapped zip")));
    expect(await github({ list: changed, sig, digest: sha("a swapped zip") }).read([maintainer.pub])).toMatchObject({ kind: "held", held: { version: VERSION, reason: "bad-signature" } });
  });

  it("an unknown key: signed, but not by a key this version pins", async () => {
    const r = await github(signed({}, stranger)).read([maintainer.pub]);
    expect(r).toMatchObject({ kind: "held", held: { reason: "bad-signature", detail: "the signature on workmesh-release.json is not from a maintainer key this version trusts" } });
    // The same release is fine for a client that pins that key.
    expect((await github(signed({}, stranger)).read([maintainer.pub, stranger.pub])).kind).toBe("offer");
  });

  it("wrong version: an older release's signed list under a new tag", async () => {
    const old = signed({ version: "0.12.1" });
    const r = await github({ ...old, tag: "v0.12.4" }).read([maintainer.pub]);
    expect(r).toEqual({ kind: "held", held: { version: VERSION, reason: "wrong-version", detail: "the signed list is for 0.12.1, not for this release (0.12.4)" } });
  });

  it("hash mismatch: the zip GitHub serves is not the file that was signed", async () => {
    const r = await github({ ...signed(), digest: sha("a swapped zip") }).read([maintainer.pub]);
    expect(r).toEqual({
      kind: "held",
      held: { version: VERSION, reason: "hash-mismatch", detail: "GitHub's copy of Workmesh-menubar-macos.zip is not the file the maintainers signed (its SHA-256 differs)" },
    });
  });

  it("a tag that isn't a version offers nothing, as with signing off, and its text goes no further", async () => {
    const tag = "nightly: see the notes";
    const g = github({ ...signed(), tag });
    expect(await g.read([maintainer.pub])).toEqual({ kind: "none" });
    // Neither small file is read for it, so the tag can't end up in a reason that status and doctor print.
    expect(g.asked).toEqual([API]);
    expect(await github({ tag }).read([])).toEqual({ kind: "none" });
  });

  it("a signed list that doesn't name the zip offers nothing", async () => {
    const other = signed({ files: [{ name: "Other.zip", sha256: sha(ZIP), size: ZIP.length }] });
    expect(await github(other).read([maintainer.pub])).toMatchObject({ kind: "held", held: { reason: "bad-list", detail: "the signed list does not name Workmesh-menubar-macos.zip" } });
  });

  it("the two small files are read with a limit, and only over https", async () => {
    const huge = Buffer.alloc(MAX_LIST_BYTES + 1, 0x20);
    await expect(github({ list: huge, sig: maintainer.sign(huge) }).read([maintainer.pub])).rejects.toThrow(/larger than/);
    const plain = github({ ...signed(), listUrl: "http://dl.example.test/workmesh-release.json" });
    await expect(plain.read([maintainer.pub])).rejects.toThrow(/no https download link/);
    expect(plain.asked).toEqual([API]);
  });

  it("the release's age: when it went out, or when its zip last changed if that is later", async () => {
    const at = (r: Awaited<ReturnType<typeof fetchMenubarRelease>>) => (r.kind === "offer" ? r.release.publishedAt : undefined);
    expect(at(await github({ ...signed(), publishedAt: "2026-11-20T08:00:00Z", zipUpdatedAt: "2026-11-20T07:59:00Z" }).read([maintainer.pub]))).toBe(Date.parse("2026-11-20T08:00:00Z"));
    expect(at(await github({ ...signed(), publishedAt: "2026-11-20T08:00:00Z", zipUpdatedAt: "2026-11-25T12:00:00Z" }).read([maintainer.pub]))).toBe(Date.parse("2026-11-25T12:00:00Z"));
    expect(at(await github({ publishedAt: "2026-11-20T08:00:00Z", zipUpdatedAt: "2026-11-25T12:00:00Z" }).read([]))).toBe(Date.parse("2026-11-25T12:00:00Z"));
  });
});

describe("the menu bar's release, with no key pinned (signing not switched on)", () => {
  it("an empty key list: as before, the hash is GitHub's digest and the list is not read", async () => {
    const g = github(signed({ files: [{ name: MENUBAR_ASSET, sha256: sha("what the list says"), size: 3 }] }));
    expect(await g.read([])).toEqual({
      kind: "offer",
      release: { version: VERSION, url: `${DL}/${MENUBAR_ASSET}`, sha256: sha(ZIP), size: ZIP.length, releaseUrl: RELEASE_URL, publishedAt: Date.parse("2026-11-20T08:00:00Z") },
    });
    expect(g.asked).toEqual([API]);
    expect(await github({ digest: null }).read([])).toEqual({ kind: "none" });
  });

  it("this version's own list decides the default", async () => {
    const r = await fetchMenubarRelease(API, github().fetchImpl);
    expect(r.kind).toBe(RELEASE_KEYS.length === 0 ? "offer" : "held");
  });
});

// ------------------------------------------------------------------------------------------------ the signing tool

const SCRIPT = fileURLToPath(new URL("../../../scripts/sign-release.mjs", import.meta.url));

describe("scripts/sign-release.mjs", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "workmesh-sign-"));
    fs.writeFileSync(path.join(dir, MENUBAR_ASSET), ZIP);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (args: string[], input?: string) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: dir, ...(input !== undefined ? { input } : {}) });
    return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
  };
  const keyFile = () => path.join(dir, "release-key.pem");
  /** Makes a key with the tool; returns the public key it printed. */
  const newKey = (file = keyFile()) => {
    const r = run(["--new-key", file]);
    expect(r.code, r.all).toBe(0);
    const pub = /^\s*"([A-Za-z0-9+/]{43}=)",$/m.exec(r.out)?.[1];
    expect(pub, r.out).toBeDefined();
    return { pub: pub!, out: r.all };
  };
  /** A pinned-key file in the shape of release-keys.ts. */
  const keysFile = (keys: string[]) => {
    const file = path.join(dir, "release-keys.ts");
    fs.writeFileSync(file, `/** e.g. "${stranger.pub}" in a comment is not a key */\nexport const RELEASE_KEYS: readonly string[] = [\n${keys.map((k) => `  "${k}",\n`).join("")}];\n`);
    return file;
  };
  const written = () => ({ list: fs.readFileSync(path.join(dir, RELEASE_LIST)), sig: fs.readFileSync(path.join(dir, RELEASE_LIST_SIG), "utf8") });

  it("makes a key pair: the private key in a 0600 file, only the public key on screen", () => {
    const { pub, out } = newKey();
    const pem = fs.readFileSync(keyFile(), "utf8");
    expect(pem).toContain("PRIVATE KEY");
    expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600);
    expect(releasePublicKey(pub)).toBeDefined();
    expect(out).not.toContain("PRIVATE KEY");
    expect(out).not.toContain(pem.split("\n")[1]!);
    // It never overwrites a key, and never writes one into the repo.
    expect(run(["--new-key", keyFile()])).toMatchObject({ code: 1, err: expect.stringContaining("never overwrites") });
    expect(fs.readFileSync(keyFile(), "utf8")).toBe(pem);
    const inRepo = path.join(path.dirname(SCRIPT), "..", "wm-test-key-never-written.pem");
    try {
      expect(run(["--new-key", inRepo])).toMatchObject({ code: 1, err: expect.stringContaining("inside this repo") });
      expect(fs.existsSync(inRepo)).toBe(false);
    } finally {
      fs.rmSync(inRepo, { force: true });
    }
  });

  it("what it writes verifies with the client's checking code", async () => {
    const { pub } = newKey();
    const r = run(["--key", keyFile(), "--version", VERSION, "--keys-file", keysFile([pub]), MENUBAR_ASSET]);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContain("clients accept this release");
    expect(r.all).not.toContain("PRIVATE KEY");
    const { list, sig } = written();
    const check = verifyReleaseList(list, sig, [pub], VERSION);
    expect(check).toMatchObject({ ok: true, list: { version: VERSION, files: [{ name: MENUBAR_ASSET, sha256: sha(ZIP), size: ZIP.length }] } });
    expect(Math.abs(Date.parse(check.ok ? check.list.createdAt : "") - Date.now())).toBeLessThan(60_000);
    // And end to end: a release carrying exactly these two files is offered with the signed hash.
    expect(await github({ list, sig }).read([pub])).toMatchObject({ kind: "offer", release: { version: VERSION, sha256: sha(ZIP), size: ZIP.length, signed: true } });
    // Another key, or another version's release, refuses the same files.
    expect(verifyReleaseList(list, sig, [maintainer.pub], VERSION)).toMatchObject({ ok: false, reason: "bad-signature" });
    expect(verifyReleaseList(list, sig, [pub], "0.12.5")).toMatchObject({ ok: false, reason: "wrong-version" });
  });

  it("refuses to sign with a key that isn't pinned once any key is", () => {
    newKey();
    const r = run(["--key", keyFile(), "--version", VERSION, "--keys-file", keysFile([maintainer.pub]), MENUBAR_ASSET]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("is not one of the 1 pinned");
    expect(fs.existsSync(path.join(dir, RELEASE_LIST))).toBe(false);
    expect(fs.existsSync(path.join(dir, RELEASE_LIST_SIG))).toBe(false);
  });

  it("with no key pinned it signs and says clients don't check yet; its count matches this version's list", () => {
    newKey();
    const r = run(["--key", keyFile(), "--version", VERSION, MENUBAR_ASSET]);
    // The tool reads the same list the client ships: both agree on how many keys are pinned.
    if (RELEASE_KEYS.length === 0) {
      expect(r.code, r.all).toBe(0);
      expect(r.out).toContain("Release signing is not switched on yet");
    } else {
      expect(r.code).toBe(1);
      expect(r.err).toContain(`is not one of the ${RELEASE_KEYS.length} pinned`);
    }
  });

  it("--list-only writes the list for another tool to sign: a plain Ed25519 signature over its bytes verifies", () => {
    const r = run(["--list-only", "--version", VERSION, MENUBAR_ASSET]);
    expect(r.code, r.all).toBe(0);
    expect(fs.existsSync(path.join(dir, RELEASE_LIST_SIG))).toBe(false);
    const list = fs.readFileSync(path.join(dir, RELEASE_LIST));
    expect(verifyReleaseList(list, maintainer.sign(list), [maintainer.pub], VERSION).ok).toBe(true);
  });

  it("takes the key only from a file that others can't read, outside the repo, and only an Ed25519 one", () => {
    newKey();
    fs.chmodSync(keyFile(), 0o644);
    expect(run(["--key", keyFile(), "--version", VERSION, MENUBAR_ASSET])).toMatchObject({ code: 1, err: expect.stringContaining("chmod 600") });
    fs.chmodSync(keyFile(), 0o600);
    const rsa = path.join(dir, "rsa.pem");
    fs.writeFileSync(rsa, crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    expect(run(["--key", rsa, "--version", VERSION, MENUBAR_ASSET])).toMatchObject({ code: 1, err: expect.stringContaining("Ed25519") });
    fs.writeFileSync(rsa, "not a key", { mode: 0o600 });
    expect(run(["--key", rsa, "--version", VERSION, MENUBAR_ASSET])).toMatchObject({ code: 1, err: expect.stringContaining("isn't a private key") });
    expect(run(["--key", path.join(path.dirname(SCRIPT), "sign-release.mjs"), "--version", VERSION, MENUBAR_ASSET])).toMatchObject({ code: 1, err: expect.stringContaining("inside this repo") });
    expect(run(["--version", VERSION, MENUBAR_ASSET])).toMatchObject({ code: 1, err: expect.stringContaining("--key <key file>") });
    expect(fs.existsSync(path.join(dir, RELEASE_LIST))).toBe(false);
  });

  it.each(["-", "/dev/stdin"])("the key can come through a pipe (--key %s), so it need not sit on disk", (from) => {
    const { pub } = newKey();
    const pem = fs.readFileSync(keyFile(), "utf8");
    fs.rmSync(keyFile());
    // The test's pipe is a socket on Linux, where opening /dev/stdin fails: the script must read standard input itself.
    const r = run(["--key", from, "--version", VERSION, MENUBAR_ASSET], pem);
    expect(r.code, r.all).toBe(0);
    const { list, sig } = written();
    expect(verifyReleaseList(list, sig, [pub], VERSION).ok).toBe(true);
  });

  it("refuses a version that isn't one, a missing file, and two files of one name", () => {
    newKey();
    expect(run(["--key", keyFile(), "--version", "latest", MENUBAR_ASSET])).toMatchObject({ code: 1, err: expect.stringContaining("--version takes a version") });
    expect(run(["--key", keyFile(), "--version", VERSION, "nothing.zip"])).toMatchObject({ code: 1, err: expect.stringContaining("no such file") });
    fs.mkdirSync(path.join(dir, "again"));
    fs.writeFileSync(path.join(dir, "again", MENUBAR_ASSET), "x");
    expect(run(["--key", keyFile(), "--version", VERSION, MENUBAR_ASSET, path.join("again", MENUBAR_ASSET)])).toMatchObject({ code: 1, err: expect.stringContaining("two files are named") });
  });
});

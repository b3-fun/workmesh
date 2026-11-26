#!/usr/bin/env node
// Signs a release, so an installed client can tell its files came from a maintainer (docs/SPEC.md §41, "Signed
// releases"; the steps are in CONTRIBUTING.md, "Releasing"). It writes two files to attach to the GitHub release,
// next to the files they cover:
//   workmesh-release.json      the list: version, creation time, and each file's name, SHA-256 and size
//   workmesh-release.json.sig  an Ed25519 signature over the exact bytes of that list, base64
//
//   node scripts/sign-release.mjs --new-key <key file>                          make a key pair (once)
//   node scripts/sign-release.mjs --key <key file> [--version 0.12.4] <file>…   sign a release's files
//   node scripts/sign-release.mjs --list-only [--version 0.12.4] <file>…        write the list only, to sign with another tool
//
//   --key -             read the private key from standard input (a password manager piping it in)
//   --out <dir>         where the two files go (default: beside the first file)
//   --version <v>       the release's version (default: packages/cli/package.json's)
//   --keys-file <path>  the pinned-key list to check the key against (default: the client's; tests pass their own)
//
// The private key is read from the path given and from nowhere else: never from the environment, and never from a
// file inside this repo. This script never prints it. Keep it off GitHub and out of CI.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIST = "workmesh-release.json";
const SIG = "workmesh-release.json.sig";
const KEYS_FILE = path.join(root, "packages/cli/src/lib/release-keys.ts");
const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.-]+)?$/;

function die(message) {
  console.error(`sign-release: ${message}`);
  process.exit(1);
}

const USAGE = `Usage:
  node scripts/sign-release.mjs --new-key <key file>
  node scripts/sign-release.mjs --key <key file> [--version <v>] [--out <dir>] <file>...
  node scripts/sign-release.mjs --list-only [--version <v>] [--out <dir>] <file>...`;

function parseArgs(argv) {
  const names = { "--new-key": "newKey", "--key": "key", "--version": "version", "--out": "out", "--keys-file": "keysFile" };
  const opts = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--list-only") opts.listOnly = true;
    else if (names[a]) {
      const value = argv[++i];
      if (value === undefined || value === "") die(`${a} needs a value\n${USAGE}`);
      opts[names[a]] = value;
    } else if (a.startsWith("--")) die(`unknown option ${a}\n${USAGE}`);
    else opts.files.push(a);
  }
  return opts;
}

/** Whether a path, existing or about to be written, is inside this repo's folder. */
function insideRepo(file) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const abs = path.resolve(file);
  const where = fs.existsSync(abs) ? real(abs) : path.join(real(path.dirname(abs)), path.basename(abs));
  const rel = path.relative(real(root), where);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** A public key as the client pins it: the base64 of the raw 32 bytes. */
function publicBase64(key) {
  return Buffer.from(crypto.createPublicKey(key).export({ format: "jwk" }).x, "base64url").toString("base64");
}

/** The keys pinned in the client's source: every quoted base64 string of a 32-byte key, outside comments. */
function pinnedKeys(file) {
  let source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    die(`can't read the pinned keys in ${file}`);
  }
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...code.matchAll(/["'`]([A-Za-z0-9+/]{43}=)["'`]/g)].map((m) => m[1]);
}

function newKey(file) {
  if (insideRepo(file)) die(`${file} is inside this repo. Keep the private key where it can't be committed.`);
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  try {
    fs.writeFileSync(path.resolve(file), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  } catch (err) {
    die(err?.code === "EEXIST" ? `${file} exists already. This script never overwrites a key.` : `can't write ${file} (${err?.code ?? "error"})`);
  }
  console.log(`Wrote a new private key to ${file} (mode 600).`);
  console.log("Keep it off GitHub: never in a repo, a CI secret, an environment variable, a chat or a log.");
  console.log("");
  console.log(`Public key, to pin in ${path.relative(root, KEYS_FILE)} (in a PR):`);
  console.log(`  "${publicBase64(privateKey)}",`);
}

/** `--key -` (or `/dev/stdin`): the key comes through standard input, for a password manager that pipes it in. */
const FROM_STDIN = new Set(["-", "/dev/stdin"]);

function readKey(file) {
  const fromStdin = FROM_STDIN.has(file);
  if (!fromStdin && insideRepo(file)) die(`${file} is inside this repo. Keep the private key where it can't be committed.`);
  let pem;
  try {
    if (fromStdin) {
      // Read file descriptor 0, never the path: on Linux a pipe from another program can be a socket, and opening
      // /dev/stdin on a socket fails. A pipe has no file mode worth checking.
      pem = fs.readFileSync(0);
    } else {
      const st = fs.statSync(file);
      if (st.isFile() && process.platform !== "win32" && (st.mode & 0o077) !== 0) {
        die(`${file} can be read by other users (mode ${(st.mode & 0o777).toString(8)}). Run: chmod 600 ${file}`);
      }
      pem = fs.readFileSync(file);
    }
  } catch (err) {
    die(`can't read the key file ${file} (${err?.code ?? "error"})`);
  }
  let key;
  try {
    key = crypto.createPrivateKey(pem);
  } catch {
    die(`${file} isn't a private key this script can read. It takes an unencrypted PKCS#8 PEM file, as --new-key writes.`);
  }
  if (key.asymmetricKeyType !== "ed25519") die(`${file} holds a ${key.asymmetricKeyType} key. Release signing takes an Ed25519 key.`);
  return key;
}

function describe(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    die(`no such file: ${file}`);
  }
  if (!st.isFile()) die(`${file} isn't a file`);
  const name = path.basename(file);
  if (name === LIST || name === SIG) die(`${name} is what this script writes. Name the release's own files.`);
  return { name, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), size: st.size };
}

function sign(opts) {
  if (opts.files.length === 0) die(`name the files this release holds, for example apps/menubar/dist/Workmesh-menubar-macos.zip\n${USAGE}`);
  const version = opts.version ?? JSON.parse(fs.readFileSync(path.join(root, "packages/cli/package.json"), "utf8")).version;
  if (typeof version !== "string" || !VERSION_RE.test(version)) die(`--version takes a version like 0.12.4, not ${version}`);
  const files = opts.files.map(describe);
  const twice = files.find((f, i) => files.findIndex((g) => g.name === f.name) !== i);
  if (twice) die(`two files are named ${twice.name}. A release holds one file per name.`);
  const outDir = path.resolve(opts.out ?? path.dirname(opts.files[0]));
  if (!fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) die(`${outDir} isn't a folder`);

  // The exact bytes that are signed and published: the client checks the signature over the file as it is.
  const bytes = Buffer.from(`${JSON.stringify({ version, createdAt: new Date().toISOString(), files }, null, 2)}\n`);
  const show = () => {
    console.log(`${LIST}: version ${version}, ${files.length} file${files.length === 1 ? "" : "s"}`);
    for (const f of files) console.log(`  ${f.name}  sha256 ${f.sha256}  ${f.size} bytes`);
  };

  if (opts.listOnly) {
    fs.writeFileSync(path.join(outDir, LIST), bytes);
    show();
    console.log(`Wrote ${path.join(outDir, LIST)}, not signed.`);
    console.log(`Sign these exact bytes with an Ed25519 key and put the base64 of the 64-byte signature in ${SIG}.`);
    return;
  }
  if (!opts.key) die(`give the private key's file with --key <key file>\n${USAGE}`);
  const key = readKey(opts.key);
  const pub = publicBase64(key);
  const keysFile = opts.keysFile ?? KEYS_FILE;
  const pinned = pinnedKeys(keysFile);
  if (pinned.length > 0 && !pinned.includes(pub)) {
    die(
      `this key (public key ${pub}) is not one of the ${pinned.length} pinned in ${path.relative(root, keysFile)}.\n` +
        "Clients would offer nothing from a release it signed. Nothing was written.",
    );
  }
  const signature = crypto.sign(null, bytes, key);
  if (!crypto.verify(null, bytes, crypto.createPublicKey(key), signature)) die("the new signature doesn't verify. Nothing was written.");
  fs.writeFileSync(path.join(outDir, LIST), bytes);
  fs.writeFileSync(path.join(outDir, SIG), `${signature.toString("base64")}\n`);
  show();
  console.log(`${SIG}: signed with the key whose public key is ${pub}`);
  console.log(
    pinned.length > 0
      ? `That key is one of the ${pinned.length} pinned in ${path.relative(root, keysFile)}: clients accept this release.`
      : `Release signing is not switched on yet (no key is pinned in ${path.relative(root, keysFile)}): clients don't check this signature.`,
  );
  console.log(`Wrote both to ${outDir}. Attach them to the GitHub release next to the files above.`);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) console.log(USAGE);
else if (opts.newKey) {
  if (opts.key || opts.listOnly || opts.files.length > 0) die(`--new-key makes a key and does nothing else\n${USAGE}`);
  newKey(opts.newKey);
} else sign(opts);

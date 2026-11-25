// A stand-in npm registry for the update smoke test (SPEC §41): it serves @b3os/workmesh from local tarballs (built
// with `npm pack`, never published) and passes every other package through to registry.npmjs.org, so `npm install -g`
// and `workmesh update` run exactly as they would against npm. `POST /_latest {version}` moves the `latest` tag.
// Usage: node fake-registry.mjs <port> <tarball>...
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";

const [portArg, ...tarballs] = process.argv.slice(2);
const port = Number(portArg ?? 4873);
const NAME = "@b3os/workmesh";
const UPSTREAM = "https://registry.npmjs.org";
const base = `http://127.0.0.1:${port}`;

/** version -> { manifest, file } */
const versions = new Map();
for (const file of tarballs) {
  const pkg = JSON.parse(execFileSync("tar", ["-xzOf", file, "package/package.json"], { encoding: "utf8" }));
  if (pkg.name !== NAME) throw new Error(`${file} is ${pkg.name}, not ${NAME}`);
  const buf = fs.readFileSync(file);
  const tarballName = `workmesh-${pkg.version}.tgz`;
  const { scripts: _s, devDependencies: _d, ...manifest } = pkg;
  versions.set(pkg.version, {
    file,
    tarballName,
    manifest: {
      ...manifest,
      _id: `${NAME}@${pkg.version}`,
      dist: {
        tarball: `${base}/${NAME}/-/${tarballName}`,
        shasum: crypto.createHash("sha1").update(buf).digest("hex"),
        integrity: `sha512-${crypto.createHash("sha512").update(buf).digest("base64")}`,
      },
    },
  });
}
let latest = [...versions.keys()].sort().at(0);

function packument() {
  return {
    name: NAME,
    "dist-tags": { latest },
    versions: Object.fromEntries([...versions].map(([v, x]) => [v, x.manifest])),
    modified: new Date().toISOString(),
  };
}

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const p = decodeURIComponent(url.pathname);
    try {
      if (req.method === "POST" && p === "/_latest") {
        let body = "";
        for await (const c of req) body += c;
        const v = JSON.parse(body || "{}").version;
        if (!versions.has(v)) return send(res, 400, { error: `no ${v}; have ${[...versions.keys()].join(", ")}` });
        latest = v;
        console.log(`[registry] latest -> ${v}`);
        return send(res, 200, { latest });
      }
      if (p === `/${NAME}` || p === `/${NAME.replace("/", "%2f")}`) {
        console.log(`[registry] ${req.method} ${p} (latest ${latest})`);
        return send(res, 200, packument());
      }
      const tgz = p.startsWith(`/${NAME}/-/`) ? [...versions.values()].find((x) => p.endsWith(`/${x.tarballName}`)) : undefined;
      if (tgz) {
        console.log(`[registry] tarball ${tgz.tarballName}`);
        return send(res, 200, fs.readFileSync(tgz.file), "application/octet-stream");
      }
      // Everything else (chokidar, commander, …): npm's own answer.
      const up = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, { headers: { accept: req.headers.accept ?? "application/json" } });
      const buf = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
      res.end(buf);
    } catch (err) {
      send(res, 502, { error: String(err) });
    }
  })
  .listen(port, "127.0.0.1", () => console.log(`fake registry on ${base}: ${[...versions.keys()].join(", ")} (latest ${latest})`));

process.on("SIGTERM", () => process.exit(0));

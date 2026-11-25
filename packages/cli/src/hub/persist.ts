import fs from "node:fs";
import path from "node:path";

/**
 * Small, synchronous JSON state files for the daemon (SPEC §24): written
 * atomically (a temp file renamed over the old one, so a crash mid-write never
 * leaves half a file) with mode 0600, read back leniently (missing, unreadable
 * or not JSON reads as undefined: the caller starts fresh).
 */

export function writeStateFile(file: string, value: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function readStateFile(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function removeStateFile(file: string): void {
  fs.rmSync(file, { force: true });
}

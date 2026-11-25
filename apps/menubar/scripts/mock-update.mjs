#!/usr/bin/env node
// A stand-in for `workmesh update`, which the mock daemon's update scenarios
// hand the menu bar app as `run`. It prints the kind of lines the real command
// prints, takes a few seconds, and exits like it: 0 updated, 1 failed (rolled
// back), 3 can't update this install.
//
//   node scripts/mock-update.mjs update --from 0.12.0 --to 0.12.1 [--fail | --cant]
//
// With XDG_STATE_HOME set (the app passes its environment on), it leaves the
// result where mock-daemon.mjs reads it, so GET /update then says what the real
// daemon would, and asks the mock to restart like the real daemon does at the
// end of an update. It never touches the real ~/.local/state or port 4519.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const from = arg("from", "0.12.0");
const to = arg("to", "0.12.1");
const mode = args.includes("--fail") ? "fail" : args.includes("--cant") ? "cant" : "ok";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (line) => process.stdout.write(line + "\n");
const err = (line) => process.stderr.write(line + "\n");

const stateHome = process.env.XDG_STATE_HOME;
const configHome = process.env.XDG_CONFIG_HOME;
const scratch =
  stateHome &&
  configHome &&
  resolve(stateHome) !== resolve(join(homedir(), ".local", "state")) &&
  resolve(configHome) !== resolve(join(homedir(), ".config"));

function record(result) {
  if (!scratch) return;
  writeFileSync(join(stateHome, "workmesh", "mock-update-result.json"), JSON.stringify({ at: Date.now(), from, to, ...result }) + "\n");
}

// Ask the mock daemon to go away for a few seconds and come back on a new secret.
async function restartMock() {
  if (!scratch) return;
  const cfg = join(configHome, "workmesh", "config.json");
  const sec = join(stateHome, "workmesh", "daemon.secret");
  if (!existsSync(cfg) || !existsSync(sec)) return;
  const port = JSON.parse(readFileSync(cfg, "utf8")).port;
  if (!Number.isInteger(port) || port === 4519) return;
  const secret = readFileSync(sec, "utf8").trim();
  await new Promise((done) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/mock/restart", method: "POST", headers: { authorization: `Bearer ${secret}` } }, (res) => {
      res.resume();
      res.on("end", done);
    });
    req.on("error", done);
    req.end();
  });
}

const where = "/opt/homebrew/lib/node_modules/@b3os/workmesh";

if (mode === "cant") {
  out(`Workmesh ${from} runs from a git checkout at ~/src/workmesh.`);
  out("Pull and build it there (git pull && npm run build -w @b3os/workmesh), then run `workmesh update`.");
  process.exit(3);
}

out(`Workmesh ${from} → ${to} (npm, ${where})`);
await sleep(600);
out(`Installing @b3os/workmesh@${to} with npm…`);
await sleep(2500);

if (mode === "fail") {
  err("npm error code EACCES");
  err("npm error syscall rename");
  err(`npm error path ${where}`);
  err("npm error errno -13");
  err(`npm error Error: EACCES: permission denied, rename '${where}'`);
  await sleep(400);
  out("Install failed: npm exited 243.");
  await sleep(1200);
  out(`Rolled back: Workmesh ${from} is installed and the daemon is running it again.`);
  record({ ok: false, rolledBack: true, message: "npm exited 243 (EACCES); rolled back" });
  process.exit(1);
}

out("");
out("changed 41 packages in 14s");
await sleep(800);
out(`Checking the new version: workmesh ${to}`);
await sleep(700);
out("Re-running setup: Claude Code and Codex hooks are current");
await sleep(900);
out("Restarting the daemon…");
record({ ok: true });
await restartMock();
out("  stopped the daemon (pid 48211)");
await sleep(1500);
out("  started the daemon (pid 48390) on 127.0.0.1:4519");
await sleep(300);
out(`Updated Workmesh ${from} → ${to}.`);
process.exit(0);

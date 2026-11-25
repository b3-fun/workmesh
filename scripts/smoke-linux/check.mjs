// Reads a local dev hub's board API (x-dev-user-email) and checks what the smoke test expects.
//   node check.mjs device <hub> <email> <machine> [--fresh <s>] [--count <n>]   presence online, heard in the last s
//   node check.mjs session <hub> <email> <machine> <session-id>                  the session is on the board
//   node check.mjs doctor <file> [--allow-warn name,name]                         doctor --json: no fail, no warn but allowed
// Prints one line per check; exits 1 on the first failure.
import fs from "node:fs";

const [what, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : dflt;
};
const die = (msg) => {
  console.log(`FAIL ${msg}`);
  process.exit(1);
};

async function state(hub, email) {
  const res = await fetch(`${hub}/api/state`, { headers: { "x-dev-user-email": email } });
  if (!res.ok) die(`${hub}/api/state answered ${res.status}`);
  return res.json();
}

if (what === "device") {
  const [hub, email, machine] = rest;
  const fresh = Number(flag("fresh", "45"));
  const s = await state(hub, email);
  const mine = s.devices.filter((d) => d.email === email && d.machine === machine && d.revokedAt == null);
  const count = flag("count");
  if (count !== undefined && mine.length !== Number(count)) die(`${machine}: ${mine.length} device(s) for ${email}, expected ${count}`);
  const d = mine.sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!d) die(`${machine}: no device for ${email}`);
  const ago = d.lastSeenAt ? (Date.now() - d.lastSeenAt) / 1000 : Infinity;
  const line = `${machine} (${d.client}): presence ${d.presence}, heard ${ago.toFixed(0)} s ago, ${((d.lastSeenAt - d.createdAt) / 1000).toFixed(0)} s after pairing`;
  if (d.presence !== "online") die(line);
  if (ago > fresh) die(`${line} (expected within ${fresh} s)`);
  const open = s.sessions.filter((x) => x.deviceId === d.id && x.state !== "ended").length;
  console.log(`ok   ${line}, ${open} open session(s)`);
} else if (what === "session") {
  const [hub, email, machine, sid] = rest;
  const s = await state(hub, email);
  const d = s.devices.find((x) => x.email === email && x.machine === machine && x.revokedAt == null);
  if (!d) die(`${machine}: no device`);
  const session = s.sessions.find((x) => x.deviceId === d.id && x.key === `claude-code:${sid}`);
  if (!session) die(`${machine}: session claude-code:${sid} not on the board (${s.sessions.filter((x) => x.deviceId === d.id).length} from this device)`);
  console.log(`ok   ${machine}: session ${session.key} ${session.state} in ${session.repo ?? "?"}`);
} else if (what === "doctor") {
  const [file] = rest;
  const allow = new Set((flag("allow-warn", "") || "").split(",").filter(Boolean));
  const text = fs.readFileSync(file, "utf8");
  const json = JSON.parse(text.slice(text.indexOf("{")));
  const bad = json.checks.filter((c) => c.status === "fail" || (c.status === "warn" && !allow.has(c.name)));
  for (const c of json.checks) console.log(`     ${c.status.padEnd(4)} ${c.name}: ${c.detail}`);
  if (bad.length) die(`doctor: ${bad.map((c) => `${c.name} (${c.status})`).join(", ")}`);
  console.log(`ok   doctor: ${json.checks.length} checks, none failing`);
} else {
  die(`unknown check ${what}`);
}

// Approves a Workmesh pairing the way the board does (POST /api/pair/approve {code}) once its code shows up in a
// log file. Only for a local dev hub, which takes the viewer from the x-dev-user-email header (DEV_USER_EMAIL).
// It sends the hub's own origin as `Origin`, as a browser on the board does: the hub refuses a board write without it.
// Usage: node approve.mjs <log file> <hub url> <email> [timeout s]
import fs from "node:fs";

const [file, hub, email, timeoutS = "120"] = process.argv.slice(2);
if (!file || !hub || !email) throw new Error("usage: approve.mjs <log> <hub> <email> [timeout s]");
const deadline = Date.now() + Number(timeoutS) * 1000;
const seen = new Set();
while (Date.now() < deadline) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // not written yet
  }
  // Codes look like ABCD-1234 (ANSI colour around them is fine).
  for (const m of text.matchAll(/pairing code:\s*(?:\x1b\[[0-9;]*m)*([A-Z]{4}-\d{4})/g)) {
    const code = m[1];
    if (seen.has(code)) continue;
    seen.add(code);
    const res = await fetch(`${hub}/api/pair/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dev-user-email": email, origin: new URL(hub).origin },
      body: JSON.stringify({ code }),
    });
    console.log(`approve ${code}: ${res.status} ${await res.text()}`);
    if (res.ok) process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log("approve: no pairing code before the timeout");
process.exit(1);

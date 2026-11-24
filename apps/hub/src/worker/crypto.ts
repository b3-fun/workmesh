const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b);
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}

/** Uniform pick from an alphabet using rejection sampling. */
function pick(alphabet: string, count: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  const buf = new Uint8Array(count * 2);
  while (out.length < count) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit) out += alphabet[b % alphabet.length];
      if (out.length === count) break;
    }
  }
  return out;
}

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** "ABCD-1234" */
export function pairingCode(): string {
  return `${pick(LETTERS, 4)}-${pick("0123456789", 4)}`;
}

/** 26-char Crockford ULID: 48-bit time + 80 random bits. */
export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + pick(CROCKFORD, 16);
}

/** A new device token; matches HUB_DEVICE_TOKEN_RE in @workmesh/protocol. */
export function deviceToken(): string {
  return `bp_${randomHex(32)}`;
}

// Hash password PBKDF2-SHA-256 (WebCrypto — jalan di Workers + Node 20+).
// scrypt TIDAK tersedia di Workers, jadi PBKDF2 adalah pilihan native.
// Format simpan: pbkdf2-sha256$<iterasi>$<salt b64url>$<hash b64url>

const enc = new TextEncoder();

export const DEFAULT_ITERATIONS = 60000;

export function iterationsFor(env) {
  const n = Number(env && env.PASSWORD_ITERATIONS);
  return Number.isInteger(n) && n >= 1000 ? n : DEFAULT_ITERATIONS;
}

export function b64urlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
  let s = String(str || "").replaceAll("-", "+").replaceAll("_", "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(password, salt, iters) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: iters, hash: "SHA-256" }, key, 256);
}

export async function hashPassword(password, iters = DEFAULT_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, iters);
  return `pbkdf2-sha256$${iters}$${b64urlEncode(salt)}$${b64urlEncode(new Uint8Array(bits))}`;
}

// Perbandingan timing-safe agar verify tidak bocor via timing.
export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
    const iters = Number(parts[1]);
    if (!Number.isInteger(iters) || iters < 1) return false;
    const salt = b64urlDecode(parts[2]);
    const expected = b64urlDecode(parts[3]);
    const bits = new Uint8Array(await derive(password, salt, iters));
    if (bits.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}

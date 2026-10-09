// Session cookie berbasis DB (tabel sessions, token disimpan sebagai hash SHA-256).
// Cookie hanya membawa token mentah; token mentah TIDAK PERNAH disimpan di DB.

const enc = new TextEncoder();

export const SESSION_TTL_MS = 7 * 864e5;
export const RESET_TTL_MS = 3600e3;

export function newToken(bytes = 32) {
  const rnd = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const b of rnd) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString();
}

export function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function cookieBase(env) {
  return `Path=/; HttpOnly; SameSite=Lax`;
}

export function sessionSetCookie(token, env, request) {
  const name = env.SESSION_COOKIE || "portal_session";
  let extra = "";
  try {
    if (new URL(request.url).protocol === "https:") extra = "; Secure";
  } catch {}
  return `${name}=${encodeURIComponent(token)}; ${cookieBase(env)}; Max-Age=604800${extra}`;
}

export function sessionClearCookie(env) {
  const name = env.SESSION_COOKIE || "portal_session";
  return `${name}=; ${cookieBase(env)}; Max-Age=0`;
}

export async function createSession(env, userId, request) {
  const token = newToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = isoIn(SESSION_TTL_MS);
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "";
  const ua = (request.headers.get("user-agent") || "").slice(0, 300);
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)"
  ).bind(tokenHash, userId, expiresAt, ip, ua).run();
  return { token, expiresAt };
}

export async function destroySession(env, token) {
  if (!token) return;
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

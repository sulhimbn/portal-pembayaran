// Auth session placeholder (T1). T3: ganti ke users D1 + scrypt + session table + RBAC.
// Endpoint: POST /api/auth/login {email} -> set cookie session HMAC (dev only).
//           POST /api/auth/logout -> clear cookie. GET /api/auth/me -> baca session.
import { json, COOKIE } from "../index.js";

const enc = new TextEncoder();

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export async function handleAuth(request, env) {
  const url = new URL(request.url);
  const secret = env.SESSION_SECRET || "dev-only-placeholder-secret-ganti-di-produksi";
  const cookieName = COOKIE(env);

  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    const token = getCookie(request, cookieName);
    if (!token) return json({ ok: true, user: null });
    const [payloadB64, sig] = token.split(".");
    if (!payloadB64 || !sig) return json({ ok: true, user: null });
    let payload;
    try {
      payload = JSON.parse(atob(payloadB64));
    } catch {
      return json({ ok: true, user: null });
    }
    const expect = await hmac(secret, payloadB64);
    if (expect !== sig) return json({ ok: true, user: null });
    if (payload.exp < Date.now()) return json({ ok: true, user: null });
    return json({ ok: true, user: { email: payload.email, role: payload.role || "client", placeholder: true } });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    let body = {};
    try {
      body = await request.json();
    } catch {}
    const email = String(body.email || "").trim();
    if (!email || !email.includes("@")) return json({ ok: false, error: "email_tidak_valid" }, 400);
    // T1: terima email apa pun sebagai client (dev). T3: verifikasi password + role admin.
    const payloadB64 = btoa(JSON.stringify({ email, role: "client", exp: Date.now() + 7 * 864e5 }));
    const sig = await hmac(secret, payloadB64);
    const headers = {
      "Set-Cookie": `${cookieName}=${encodeURIComponent(payloadB64 + "." + sig)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
    };
    return new Response(JSON.stringify({ ok: true, user: { email, role: "client", placeholder: true } }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", ...headers },
    });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "Set-Cookie": `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      },
    });
  }

  return json({ ok: false, error: "not_found" }, 404);
}

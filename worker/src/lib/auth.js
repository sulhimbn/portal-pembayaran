// Guard auth + RBAC untuk Worker API.
// Backend adalah penegak keamanan sebenarnya; guard frontend hanya UX.

import { json } from "../index.js";
import { getCookie, sha256Hex } from "./session.js";

export function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || "").trim());
}

export function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role };
}

// Session -> user. Return null bila: tanpa cookie, token tak dikenal,
// user suspended, atau session kedaluwarsa (sekaligus dibersihkan).
export async function getSessionUser(request, env) {
  if (!env.DB) return null;
  const token = getCookie(request, env.SESSION_COOKIE || "portal_session");
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const sess = await env.DB.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?")
    .bind(tokenHash).first();
  if (!sess) return null;
  if (String(sess.expires_at) < new Date().toISOString()) {
    try {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    } catch {}
    return null;
  }
  const u = await env.DB.prepare(
    "SELECT id, email, name, phone, role, status FROM users WHERE id = ?"
  ).bind(sess.user_id).first();
  if (!u || u.status !== "active") return null;
  return { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role };
}

// Guard: wajib login. Kembalikan { user } atau { response } (401).
export async function requireUser(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return { response: json({ ok: false, error: "login_dulu" }, 401) };
  return { user };
}

// Guard: wajib admin. 401 bila belum login, 403 bila client.
export async function requireAdmin(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return { response: json({ ok: false, error: "login_dulu" }, 401) };
  if (user.role !== "admin") return { response: json({ ok: false, error: "admin_saja" }, 403) };
  return { user };
}

// Ownership: client hanya boleh akses miliknya; admin boleh semua.
// paramUserId = id user pemilik resource. Return { response } 403 bila melanggar.
export function requireOwnership(user, paramUserId) {
  if (user.role === "admin") return {};
  if (Number(paramUserId) !== Number(user.id)) {
    return { response: json({ ok: false, error: "bukan_milik_anda" }, 403) };
  }
  return {};
}

export async function audit(env, { actor, action, entity = "", entityId = "", meta = {}, ip = "" }) {
  try {
    if (!env.DB) return;
    await env.DB.prepare(
      "INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, meta_json, ip) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(actor || null, action, entity, String(entityId), JSON.stringify(meta), ip).run();
  } catch {}
}

export function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "";
}

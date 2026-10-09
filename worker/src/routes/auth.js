// Auth client+admin (T3): users D1 + PBKDF2 + session cookie berbasis DB + RBAC dasar.
// Endpoint:
//   POST /api/auth/register        {email, password, name?, phone?} -> user client + auto-login
//   POST /api/auth/login           {email, password} -> session cookie
//   POST /api/auth/logout          -> hapus session + clear cookie
//   GET  /api/auth/me              -> user saat ini (null bila belum login)
//   POST /api/auth/reset/request   {email} -> token reset (dasar: token dikembalikan di respons;
//                                   produksi T10: kirim via email, JANGAN expose)
//   POST /api/auth/reset/confirm   {token, password} -> ganti password + cabut semua session
// Admin dibuat via SQL (lihat README): UPDATE users SET role='admin' WHERE email='...';
// register SELALU membuat role client.

import { json } from "../index.js";
import { getSessionUser, publicUser, isEmail, audit, clientIp } from "../lib/auth.js";
import { hashPassword, verifyPassword, iterationsFor } from "../lib/password.js";
import { createSession, destroySession, getCookie, newToken, sha256Hex, isoIn, RESET_TTL_MS, sessionSetCookie, sessionClearCookie } from "../lib/session.js";

const MIN_PASSWORD = 8;

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function needDb(env) {
  if (!env.DB) return json({ ok: false, error: "db_belum_dikonfigurasi" }, 500);
  return null;
}

export async function handleAuth(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const dbErr = needDb(env);
  if (dbErr) return dbErr;

  // ---- GET /api/auth/me ----
  if (request.method === "GET" && path === "/api/auth/me") {
    const user = await getSessionUser(request, env);
    return json({ ok: true, user: publicUser(user) });
  }

  // ---- POST /api/auth/register ----
  if (request.method === "POST" && path === "/api/auth/register") {
    const body = await readJson(request);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const name = String(body.name || "").trim().slice(0, 120);
    const phone = String(body.phone || "").trim().slice(0, 40);
    if (!isEmail(email)) return json({ ok: false, error: "email_tidak_valid" }, 400);
    if (password.length < MIN_PASSWORD) return json({ ok: false, error: "password_min_8" }, 400);

    const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (exists) return json({ ok: false, error: "email_sudah_terdaftar" }, 409);

    const passwordHash = await hashPassword(password, iterationsFor(env));
    const now = new Date().toISOString();
    const ins = await env.DB.prepare(
      "INSERT INTO users (email, password_hash, name, phone, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'client', 'active', ?, ?)"
    ).bind(email, passwordHash, name, phone, now, now).run();
    const user = { id: ins.meta.last_row_id, email, name, phone, role: "client" };
    await audit(env, { actor: user.id, action: "register", entity: "user", entityId: user.id, ip: clientIp(request) });

    const { token } = await createSession(env, user.id, request);
    return new Response(JSON.stringify({ ok: true, user: publicUser(user) }), {
      status: 201,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "Set-Cookie": sessionSetCookie(token, env, request),
      },
    });
  }

  // ---- POST /api/auth/login ----
  if (request.method === "POST" && path === "/api/auth/login") {
    const body = await readJson(request);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!isEmail(email) || !password) return json({ ok: false, error: "email_atau_password_salah" }, 401);

    const u = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
    const passOk = u ? await verifyPassword(password, u.password_hash) : false;
    if (!u || !passOk) {
      await audit(env, { actor: u ? u.id : null, action: "login_gagal", entity: "user", meta: { email }, ip: clientIp(request) });
      return json({ ok: false, error: "email_atau_password_salah" }, 401);
    }
    if (u.status !== "active") {
      await audit(env, { actor: u.id, action: "login_ditolak_suspended", entity: "user", entityId: u.id, ip: clientIp(request) });
      return json({ ok: false, error: "akun_disuspend" }, 403);
    }
    const user = { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role };
    await audit(env, { actor: u.id, action: "login", entity: "user", entityId: u.id, ip: clientIp(request) });
    const { token } = await createSession(env, u.id, request);
    return new Response(JSON.stringify({ ok: true, user: publicUser(user) }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "Set-Cookie": sessionSetCookie(token, env, request),
      },
    });
  }

  // ---- POST /api/auth/logout ----
  if (request.method === "POST" && path === "/api/auth/logout") {
    const token = getCookie(request, env.SESSION_COOKIE || "portal_session");
    await destroySession(env, token);
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "Set-Cookie": sessionClearCookie(env),
      },
    });
  }

  // ---- POST /api/auth/reset/request (dasar) ----
  if (request.method === "POST" && path === "/api/auth/reset/request") {
    const body = await readJson(request);
    const email = String(body.email || "").trim().toLowerCase();
    // Anti-enumerasi: selalu ok:true. Token hanya ada bila email terdaftar.
    // Dasar (tanpa email infra): token dikembalikan di respons agar bisa diuji manual.
    // T10: kirim token via email dan JANGAN sertakan di respons.
    if (!isEmail(email)) return json({ ok: true });
    const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (!u) return json({ ok: true });
    const token = newToken();
    const tokenHash = await sha256Hex("reset:" + token);
    await env.DB.prepare("UPDATE users SET reset_token_hash = ?, reset_expires_at = ?, updated_at = ? WHERE id = ?")
      .bind(tokenHash, isoIn(RESET_TTL_MS), new Date().toISOString(), u.id).run();
    await audit(env, { actor: u.id, action: "reset_diminta", entity: "user", entityId: u.id, ip: clientIp(request) });
    return json({ ok: true, reset_token: token, note: "dasar: token di respons (dev). Produksi: kirim via email." });
  }

  // ---- POST /api/auth/reset/confirm ----
  if (request.method === "POST" && path === "/api/auth/reset/confirm") {
    const body = await readJson(request);
    const token = String(body.token || "");
    const password = String(body.password || "");
    if (!token) return json({ ok: false, error: "token_tidak_valid" }, 400);
    if (password.length < MIN_PASSWORD) return json({ ok: false, error: "password_min_8" }, 400);
    const tokenHash = await sha256Hex("reset:" + token);
    const u = await env.DB.prepare("SELECT * FROM users WHERE reset_token_hash = ?").bind(tokenHash).first();
    if (!u || !u.reset_expires_at || String(u.reset_expires_at) < new Date().toISOString()) {
      return json({ ok: false, error: "token_tidak_valid_atau_kedaluwarsa" }, 400);
    }
    const passwordHash = await hashPassword(password, iterationsFor(env));
    const now = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_expires_at = NULL, updated_at = ? WHERE id = ?"
    ).bind(passwordHash, now, u.id).run();
    // Cabut semua session lama agar password baru berlaku penuh.
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(u.id).run();
    await audit(env, { actor: u.id, action: "reset_berhasil", entity: "user", entityId: u.id, ip: clientIp(request) });
    return json({ ok: true });
  }

  return json({ ok: false, error: "not_found" }, 404);
}

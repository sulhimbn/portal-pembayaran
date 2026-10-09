// Portal Pembayaran QRIS — Worker API (Cloudflare free-tier native)
// Binding: DB (D1), ASSETS (R2). Cron: invoice berulang + reminder.
// Auth T3: session cookie berbasis DB + RBAC.
//   /api/auth/*            publik (register/login/reset) + me/logout
//   /api/client/*          wajib login (client lihat miliknya; admin boleh semua)
//   /api/admin/*           wajib role admin

import { handleAuth } from "./routes/auth.js";
import { handleHealth } from "./routes/health.js";
import { handleInvoices } from "./routes/invoices.js";
import { requireUser, requireAdmin } from "./lib/auth.js";

const COOKIE = (env) => env.SESSION_COOKIE || "portal_session";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS longgar untuk dev lokal (Pages dev -> Worker dev)
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    try {
      if (pathname === "/api/health") return cors(json(await handleHealth(env)));
      if (pathname.startsWith("/api/auth")) return cors(await handleAuth(request, env));
      if (pathname.startsWith("/api/admin/")) return cors(await handleAdmin(request, env, pathname));
      if (pathname.startsWith("/api/client/")) return cors(await handleClient(request, env, pathname));
      if (pathname.startsWith("/api/invoices")) return cors(await handleInvoices(request, env));

      // Placeholder endpoint lain (T6-T8 implementasi penuh; T5 invoice selesai)
      if (pathname.startsWith("/api/")) {
        return cors(json({ ok: true, placeholder: true, path: pathname, note: "Diimplementasikan di T6-T8" }));
      }
      return cors(json({ ok: true, service: env.APP_NAME || "Portal Pembayaran QRIS", docs: "/api/health" }));
    } catch (err) {
      console.error("worker error:", err);
      return cors(json({ ok: false, error: "internal_error" }, 500));
    }
  },

  // Cron trigger: T8 isi logika invoice berulang + reminder.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      console.log(`[cron] tick at ${new Date(event.scheduledTime).toISOString()} cron=${event.cron}`);
      // T8: query D1 invoice jatuh tempo -> generate invoice baru + reminder.
    })());
  },
};

// ---- Zona client: login wajib. Semua query di-filter user_id (kecuali admin). ----
async function handleClient(request, env, pathname) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  // GET /api/client/summary — ringkasan milik sendiri (bukti scoping T3).
  // T4 mengembangkan katalog/order/layanan di bawah prefix ini.
  if (request.method === "GET" && pathname === "/api/client/summary") {
    const count = async (table) => {
      try {
        const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
          .bind(user.id).first();
        return r ? Number(r.n) || 0 : 0;
      } catch {
        return 0;
      }
    };
    return json({
      ok: true,
      user_id: user.id,
      counts: {
        orders: await count("orders"),
        services: await count("services"),
        invoices: await count("invoices"),
      },
    });
  }

  return json({ ok: false, error: "not_found" }, 404);
}

// ---- Zona admin: role admin wajib. ----
async function handleAdmin(request, env, pathname) {
  const { user, response } = await requireAdmin(request, env);
  if (response) return response;

  // GET /api/admin/summary — angka global (bukti admin guard T3).
  // T7 mengembangkan dashboard/CRUD di bawah prefix ini.
  if (request.method === "GET" && pathname === "/api/admin/summary") {
    const total = async (table) => {
      try {
        const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first();
        return r ? Number(r.n) || 0 : 0;
      } catch {
        return 0;
      }
    };
    return json({
      ok: true,
      admin: user.email,
      totals: {
        users: await total("users"),
        orders: await total("orders"),
        invoices: await total("invoices"),
      },
    });
  }

  return json({ ok: false, error: "not_found" }, 404);
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(res.body, { status: res.status, headers: h });
}

export { COOKIE };

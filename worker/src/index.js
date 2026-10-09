// Portal Pembayaran QRIS — Worker API (Cloudflare free-tier native)
// Binding: DB (D1), ASSETS (R2). Cron: invoice berulang + reminder.
// Auth T3: session cookie berbasis DB + RBAC.
//   /api/auth/*            publik (register/login/reset) + me/logout
//   /api/client/*          wajib login (client lihat miliknya; admin boleh semua)
//   /api/admin/*           wajib role admin

import { handleAuth } from "./routes/auth.js";
import { handleHealth } from "./routes/health.js";
import { handleInvoices } from "./routes/invoices.js";
import { handlePayments } from "./routes/payments.js";
import { handleCatalog } from "./routes/catalog.js";
import { requireUser, requireAdmin } from "./lib/auth.js";
import { runRecurringCron } from "./lib/recurring.js";

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
      // T4 (WS2): order + layanan client — SEBELUM catch-all /api/client/ milik T3
      // (handleClient lama mengembalikan 404 untuk path yang tak dikenalnya).
      if (pathname.startsWith("/api/client/orders") || pathname.startsWith("/api/client/services")) {
        return cors(await handleCatalog(request, env));
      }
      if (pathname.startsWith("/api/client/")) return cors(await handleClient(request, env, pathname));
      // T6 (WS3): halaman bayar HTML — SEBELUM /api/invoices (handleInvoices tak kenal /:id/pay).
      if (request.method === "GET" && /^\/api\/invoices\/\d+\/pay$/.test(pathname)) {
        return cors(await handlePayments(request, env));
      }
      if (pathname.startsWith("/api/invoices")) return cors(await handleInvoices(request, env));
      // T6 (WS3): pembayaran QRIS + webhook (guard + verifikasi signature di routes/payments.js).
      if (pathname.startsWith("/api/payments") || pathname.startsWith("/api/webhooks")) {
        return cors(await handlePayments(request, env));
      }
      // T4 (WS2): katalog produk (guard session di routes/catalog.js).
      if (pathname === "/api/catalog" || pathname.startsWith("/api/catalog/")) {
        return cors(await handleCatalog(request, env));
      }

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

  // Cron trigger T8 (lihat wrangler.toml: `0 1 * * *` 1x/hari):
  // sweep overdue -> terbitkan perpanjangan langganan jatuh tempo
  // (anti-duplikat) -> reminder + audit. Logika di lib/recurring.js.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const at = new Date(event.scheduledTime);
      console.log(`[cron] tick at ${at.toISOString()} cron=${event.cron}`);
      if (!env.DB) {
        console.log("[cron] DB binding hilang, lewati jalan ini.");
        return;
      }
      try {
        const r = await runRecurringCron(env.DB, { now: at, dryRun: false, cron: event.cron });
        console.log(`[cron] selesai: ${r.summary}`);
      } catch (err) {
        console.error("[cron] gagal:", err && err.message ? err.message : err);
      }
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

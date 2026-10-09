// Portal Pembayaran QRIS — Worker API (Cloudflare free-tier native)
// Binding: DB (D1), ASSETS (R2). Cron: invoice berulang + reminder.
// Auth: session cookie placeholder (HMAC, tanpa DB di T1) — T3 ganti ke DB+hash.

import { handleAuth } from "./routes/auth.js";
import { handleHealth } from "./routes/health.js";

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

      // Placeholder endpoint lain (T4-T8 implementasi penuh)
      if (pathname.startsWith("/api/")) {
        return cors(json({ ok: true, placeholder: true, path: pathname, note: "Diimplementasikan di T4-T8" }));
      }
      return cors(json({ ok: true, service: env.APP_NAME || "Portal Pembayaran QRIS", docs: "/api/health" }));
    } catch (err) {
      console.error("worker error:", err);
      return cors(json({ ok: false, error: "internal_error" }, 500));
    }
  },

  // Cron trigger: T8 isi logika invoice berulang + reminder.
  // T1: hanya log + catat event agar Cron terverifikasi jalan.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      console.log(`[cron] tick at ${new Date(event.scheduledTime).toISOString()} cron=${event.cron}`);
      // T8: query D1 invoice jatuh tempo -> generate invoice baru + reminder.
    })());
  },
};

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

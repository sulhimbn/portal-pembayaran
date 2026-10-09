// T4 — Route katalog + order + layanan client (WS2).
//
// Auth: session cookie DB + RBAC milik T3 (lib/auth.js) — tidak ada shim.
//   GET  /api/catalog                  katalog produk AKTIF (login wajib, murah: 1 query)
//   POST /api/client/orders            order website baru (client; selalu 'pending')
//   GET  /api/client/orders[?status]   daftar order milik sendiri
//   GET  /api/client/orders/:id        detail order milik sendiri (beserta layanan hasil approve)
//   POST /api/client/orders/:id/cancel batal (miliknya; hanya pending/awaiting_payment)
//   GET  /api/client/services[?status] daftar layanan milik sendiri (MASKED — tanpa kredensial mentah)
//   GET  /api/client/services/:id     detail operasional milik sendiri (MASKED)
//
// Layanan muncul SETELAH admin approve (T7) — order baru tidak membuat service.
// Approve/CRUD operasional milik T7 (/api/admin/*) — bukan di sini.

import { json } from "../index.js";
import { getSessionUser, clientIp, audit } from "../lib/auth.js";
import { decryptSecret, maskUsername, servicePublic } from "../lib/credentials.js";
import {
  listProducts,
  getProduct,
  productPublic,
  listOrders,
  getOrder,
  orderPublic,
  createOrder,
  cancelOrder,
  listServices,
  getService,
  err,
} from "../lib/catalog.js";

async function needLogin(request, env) {
  const caller = await getSessionUser(request, env);
  if (!caller) throw err("login_dulu", "Login dulu untuk akses katalog/order/layanan.", 401);
  return caller;
}

function needOwnerOrAdmin(caller, ownerUserId) {
  if (caller.role === "admin") return;
  if (Number(caller.id) !== Number(ownerUserId)) {
    throw err("bukan_milik_anda", "Data ini milik user lain.", 403);
  }
}

function paginate(url) {
  return {
    limit: url.searchParams.get("limit") || 50,
    offset: url.searchParams.get("offset") || 0,
  };
}

// Satu baris service DB -> bentuk publik client (aman, MASKED penuh).
// Username dicoba dekripsi (kunci tersedia) lalu di-mask; bila gagal,
// dipakai kolom wp_username_masked (ditulis admin/T7), fallback "•••".
async function toServicePublic(db, row, env) {
  let usernamePlain = null;
  if (row.wp_username_enc) {
    try {
      usernamePlain = await decryptSecret(row.wp_username_enc, env);
    } catch {
      usernamePlain = null;
    }
  }
  void db;
  return servicePublic(row, { usernamePlain });
}

export async function handleCatalog(request, env) {
  const url = new URL(request.url);
  const seg = url.pathname.split("/").filter(Boolean); // ["api","catalog"|"client", ...]
  const db = env.DB;
  if (!db) return json({ ok: false, error: "db_missing", message: "Binding D1 belum dikonfigurasi." }, 500);
  const method = request.method;
  const ip = clientIp(request);

  try {
    // ---------- katalog publik-terbatas: GET /api/catalog (login wajib) ----------
    if (seg.length === 2 && seg[0] === "api" && seg[1] === "catalog" && method === "GET") {
      const caller = await needLogin(request, env);
      void caller;
      return json({ ok: true, products: await listProducts(db, { activeOnly: true }) });
    }

    // ---------- order: POST /api/client/orders ----------
    if (seg.length === 3 && seg[2] === "orders" && method === "POST") {
      const caller = await needLogin(request, env);
      let body = {};
      try {
        body = await request.json();
      } catch {
        throw err("body_invalid", "Body harus JSON.", 400);
      }
      const order = await createOrder(db, {
        userId: caller.id,
        productId: body.productId ?? body.product_id ?? null,
        slug: body.slug ?? body.productSlug ?? null,
        qty: body.qty ?? 1,
        domainRequested: body.domain ?? body.domainRequested ?? "",
        requirements: body.requirements ?? body.kebutuhan ?? "",
        notes: body.notes ?? body.catatan ?? "",
        actorUserId: caller.id,
        ip,
      });
      return json({ ok: true, order }, 201);
    }

    // ---------- order: GET /api/client/orders ----------
    if (seg.length === 3 && seg[2] === "orders" && method === "GET") {
      const caller = await needLogin(request, env);
      const { limit, offset } = paginate(url);
      const status = url.searchParams.get("status");
      return json({ ok: true, orders: await listOrders(db, { userId: caller.id, status, limit, offset }) });
    }

    // ---------- order: GET /api/client/orders/:id + POST :id/cancel ----------
    if (seg.length >= 4 && seg[2] === "orders") {
      const id = Number(seg[3]);
      if (!Number.isInteger(id) || id < 1) throw err("id_invalid", "ID order tidak valid.", 400);
      if (seg.length === 4 && method === "GET") {
        const caller = await needLogin(request, env);
        const row = await getOrder(db, id);
        if (!row) throw err("order_tidak_ditemukan", `Order #${id} tidak ditemukan.`, 404);
        needOwnerOrAdmin(caller, row.user_id);
        const order = orderPublic(row);
        // Sertakan layanan hasil approve admin (bila ada) — bentuk MASKED.
        let services = [];
        try {
          const rows = await db
            .prepare(
              "SELECT s.id AS id, s.user_id AS user_id, s.order_id AS order_id, s.product_id AS product_id, " +
                "s.label AS label, s.domain AS domain, s.wp_url AS wp_url, " +
                "s.wp_username_enc AS wp_username_enc, s.wp_secret_enc AS wp_secret_enc, " +
                "s.wp_username_masked AS wp_username_masked, s.site_url AS site_url, s.admin_url AS admin_url, " +
                "s.serverless_info AS serverless_info, s.status AS status, s.expires_at AS expires_at, " +
                "s.created_at AS created_at, s.updated_at AS updated_at, " +
                "p.slug AS product_slug, p.name AS product_name, p.billing_period AS product_period " +
                "FROM services s LEFT JOIN products p ON p.id = s.product_id WHERE s.order_id = ? ORDER BY s.id DESC"
            )
            .bind(id)
            .all();
          services = [];
          for (const r of rows.results || []) services.push(await toServicePublic(db, r, env));
        } catch {
          services = [];
        }
        return json({ ok: true, order, services });
      }
      if (seg.length === 5 && seg[4] === "cancel" && method === "POST") {
        const caller = await needLogin(request, env);
        const row = await getOrder(db, id);
        if (!row) throw err("order_tidak_ditemukan", `Order #${id} tidak ditemukan.`, 404);
        needOwnerOrAdmin(caller, row.user_id);
        return json({ ok: true, order: await cancelOrder(db, id, { actorUserId: caller.id, ip }) });
      }
    }

    // ---------- layanan: GET /api/client/services ----------
    if (seg.length === 3 && seg[2] === "services" && method === "GET") {
      const caller = await needLogin(request, env);
      const { limit, offset } = paginate(url);
      const status = url.searchParams.get("status");
      const rows = await listServices(db, { userId: caller.id, status, limit, offset });
      const out = [];
      for (const r of rows) out.push(await toServicePublic(db, r, env));
      return json({ ok: true, services: out });
    }

    // ---------- layanan: GET /api/client/services/:id ----------
    if (seg.length === 4 && seg[2] === "services" && method === "GET") {
      const caller = await needLogin(request, env);
      const row = await getService(db, Number(seg[3]));
      if (!row) throw err("layanan_tidak_ditemukan", `Layanan #${seg[3]} tidak ditemukan.`, 404);
      needOwnerOrAdmin(caller, row.user_id);
      const service = await toServicePublic(db, row, env);
      // Info paket pendamping (aman: tanpa harga internal berlebih — harga = katalog publik).
      let product = service.product;
      try {
        const p = await getProduct(db, { id: row.product_id });
        if (p) product = { ...service.product, description: p.description, price_idr: p.price_idr };
      } catch {
        // abaikan — bentuk dasar sudah cukup
      }
      await audit(env, {
        actor: caller.id,
        action: "service.viewed",
        entity: "service",
        entityId: row.id,
        ip,
      });
      return json({ ok: true, service: { ...service, product } });
    }

    return json({ ok: false, error: "not_found" }, 404);
  } catch (e) {
    const status = Number(e.status) || 500;
    return json(
      { ok: false, error: e.code || "internal_error", message: String(e.message || e).slice(0, 300) },
      status
    );
  }
}

export { productPublic };

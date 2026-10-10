// T7 — Route /api/admin/* (WS4): dashboard + CRUD client/order/
// layanan/invoice/pembayaran/produk-harga + approve + verifikasi manual.
//
// Auth: requireAdmin milik T3 (lib/auth.js) — dipanggil di index.js
// handleAdmin SEBELUM handleAdminPanel, jadi di sini caller sudah
// pasti admin (user {id,email}). JANGAN tulis ulang guard.
// Logika tulis di lib/admin.js (me-reuse catalog/credentials/invoices).

import { json } from "../index.js";
import { clientIp, audit } from "../lib/auth.js";
import {
  adminSummary,
  adminListUsers,
  adminListOrders,
  adminListServices,
  adminListPayments,
  adminListProducts,
  adminUpdateUser,
  adminUpdateOrder,
  approveOrder,
  adminUpdateService,
  adminCreateProduct,
  adminUpdateProduct,
  adminVerifyInvoice,
  adminCreateInvoiceManual,
  adminMarkPayment,
  orderAdminPublic,
  serviceAdminPublic,
  pageParams,
  statusFilter,
  getInvoice,
  listInvoices,
  ORDER_STATUS,
  SERVICE_STATUS,
  INVOICE_STATUS,
  PAYMENT_STATUSES,
  err,
} from "../lib/admin.js";
import { getOrder } from "../lib/catalog.js";
import { getService } from "../lib/catalog.js";
import { servicePublic } from "../lib/credentials.js";
import { decryptSecret } from "../lib/credentials.js";

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw err("BODY_INVALID", "Body harus JSON.", 400);
  }
}

// Satu baris service DB -> preview admin yang aman (MASKED penuh).
async function toServiceAdmin(db, row, env) {
  void db;
  return serviceAdminPublic(row);
}

export async function handleAdminPanel(request, env, pathname, caller) {
  const url = new URL(request.url);
  const seg = pathname.split("/").filter(Boolean); // ["api","admin",...]
  const db = env.DB;
  if (!db) return json({ ok: false, error: "db_missing", message: "Binding D1 belum dikonfigurasi." }, 500);
  const method = request.method;
  const ip = clientIp(request);

  try {
    // ---------- GET /api/admin/summary — angka global (milik T3, dipertahankan) ----------
    if (seg.length === 3 && seg[2] === "summary" && method === "GET") {
      const totals = await adminSummary(db);
      // Bentuk lama T3: { users, orders, invoices } tetap ada (kompatibel).
      return json({
        ok: true,
        admin: caller.email,
        totals: { users: totals.users, orders: totals.orders, invoices: totals.invoices },
        dashboard: totals,
      });
    }

    // ---------- dashboard penuh: GET /api/admin/dashboard ----------
    if (seg.length === 3 && seg[2] === "dashboard" && method === "GET") {
      return json({ ok: true, dashboard: await adminSummary(db) });
    }

    // ---------- users: GET list / PATCH :id ----------
    if (seg[2] === "users") {
      if (seg.length === 3 && method === "GET") {
        const { limit, offset } = pageParams(url);
        const users = await adminListUsers(db, {
          q: url.searchParams.get("q") || "",
          role: url.searchParams.get("role") || null,
          status: url.searchParams.get("status") || null,
          limit,
          offset,
        });
        return json({ ok: true, users });
      }
      if (seg.length === 4 && (method === "PATCH" || method === "PUT")) {
        const body = await readJson(request);
        return json({ ok: true, user: await adminUpdateUser(db, seg[3], body, { actorUserId: caller.id, ip }) });
      }
      if (seg.length === 4 && method === "GET") {
        const id = Number(seg[3]);
        if (!Number.isInteger(id) || id < 1) throw err("ID_INVALID", "ID user tidak valid.", 400);
        const u = await db
          .prepare("SELECT id, email, name, phone, role, status, created_at, updated_at FROM users WHERE id = ?")
          .bind(id)
          .first();
        if (!u) throw err("USER_TIDAK_DITEMUKAN", `User #${id} tidak ditemukan.`, 404);
        return json({ ok: true, user: u });
      }
    }

    // ---------- orders: GET list / GET :id / PATCH :id / POST :id/approve ----------
    if (seg[2] === "orders") {
      if (seg.length === 3 && method === "GET") {
        const { limit, offset } = pageParams(url);
        const orders = await adminListOrders(db, {
          status: statusFilter(url, ORDER_STATUS),
          q: url.searchParams.get("q") || "",
          userId: url.searchParams.get("userId") || null,
          limit,
          offset,
        });
        return json({ ok: true, orders });
      }
      if (seg.length === 4 && method === "GET") {
        const row = await getOrder(db, seg[3]);
        if (!row) throw err("ORDER_TIDAK_DITEMUKAN", `Order #${seg[3]} tidak ditemukan.`, 404);
        const order = orderAdminPublic(row);
        order.user_email = row.user_id != null ? await emailOf(db, row.user_id) : null;
        let services = [];
        try {
          const rows = await db
            .prepare(
              "SELECT s.id AS id, s.user_id AS user_id, s.order_id AS order_id, s.product_id AS product_id, " +
                "s.label AS label, s.domain AS domain, s.wp_url AS wp_url, " +
                "s.wp_username_masked AS wp_username_masked, s.site_url AS site_url, s.admin_url AS admin_url, " +
                "s.serverless_info AS serverless_info, s.status AS status, s.expires_at AS expires_at, " +
                "s.created_at AS created_at, s.updated_at AS updated_at, " +
                "(LENGTH(COALESCE(s.wp_secret_enc,'')) > 0) AS has_wp_secret, " +
                "p.slug AS product_slug, p.name AS product_name, p.billing_period AS product_period " +
                "FROM services s LEFT JOIN products p ON p.id = s.product_id WHERE s.order_id = ? ORDER BY s.id DESC"
            )
            .bind(Number(seg[3]))
            .all();
          services = (rows.results || []).map(serviceAdminPublic);
        } catch {
          services = [];
        }
        return json({ ok: true, order, services });
      }
      if (seg.length === 4 && (method === "PATCH" || method === "PUT")) {
        const body = await readJson(request);
        return json({ ok: true, order: await adminUpdateOrder(db, seg[3], body, { actorUserId: caller.id, ip }) });
      }
      // POST /api/admin/orders/:id/approve — acceptance wajib T7.
      if (seg.length === 5 && seg[4] === "approve" && method === "POST") {
        const body = await readJson(request);
        const out = await approveOrder(db, seg[3], body, { actorUserId: caller.id, ip, env });
        const svc = await getService(db, out.serviceId);
        // Preview aman untuk respons: MASKED (tanpa *_enc mentah).
        const preview = await toServiceAdmin(db, svc, env);
        return json({ ok: true, order_id: out.orderId, order_status: out.order_status, service: preview }, 201);
      }
    }

    // ---------- services: GET list / GET :id / PATCH :id ----------
    if (seg[2] === "services") {
      if (seg.length === 3 && method === "GET") {
        const { limit, offset } = pageParams(url);
        const services = await adminListServices(db, {
          status: statusFilter(url, SERVICE_STATUS),
          q: url.searchParams.get("q") || "",
          userId: url.searchParams.get("userId") || null,
          orderId: url.searchParams.get("orderId") || null,
          limit,
          offset,
        });
        return json({ ok: true, services });
      }
      if (seg.length === 4 && method === "GET") {
        const row = await getService(db, seg[3]);
        if (!row) throw err("LAYANAN_TIDAK_DITEMUKAN", `Layanan #${seg[3]} tidak ditemukan.`, 404);
        let hasSecret = false;
        try {
          hasSecret = String(row.wp_secret_enc || "").length > 0;
        } catch {
          hasSecret = false;
        }
        const service = serviceAdminPublic({ ...row, has_wp_secret: hasSecret });
        await audit(env, { actor: caller.id, action: "service.viewed", entity: "service", entityId: row.id, ip });
        return json({ ok: true, service });
      }
      if (seg.length === 4 && (method === "PATCH" || method === "PUT")) {
        const body = await readJson(request);
        const row = await adminUpdateService(db, seg[3], body, { actorUserId: caller.id, ip, env });
        let hasSecret = false;
        try {
          hasSecret = String(row.wp_secret_enc || "").length > 0;
        } catch {
          hasSecret = false;
        }
        return json({ ok: true, service: serviceAdminPublic({ ...row, has_wp_secret: hasSecret }) });
      }
    }

    // ---------- invoices: GET list / POST manual / GET :id / POST :id/pay|verify|cancel ----------
    if (seg[2] === "invoices") {
      if (seg.length === 3 && method === "GET") {
        const { limit, offset } = pageParams(url);
        const st = statusFilter(url, INVOICE_STATUS);
        const qUser = url.searchParams.get("userId");
        const invoices = await listInvoices(db, {
          userId: qUser != null && qUser !== "" ? Number(qUser) : null,
          status: st,
          limit,
          offset,
        });
        return json({ ok: true, invoices });
      }
      if (seg.length === 3 && method === "POST") {
        const body = await readJson(request);
        const invoice = await adminCreateInvoiceManual(db, body, { actorUserId: caller.id, ip });
        return json({ ok: true, invoice }, 201);
      }
      if (seg.length === 4 && method === "GET") {
        const inv = await getInvoice(db, seg[3]);
        if (!inv) throw err("INVOICE_TIDAK_DITEMUKAN", `Invoice #${seg[3]} tidak ditemukan.`, 404);
        return json({ ok: true, invoice: inv });
      }
      // Verifikasi manual: POST :id/pay | :id/cancel | :id/verify {action}
      if (seg.length === 5 && method === "POST" && ["pay", "cancel", "verify"].includes(seg[4])) {
        const id = seg[3];
        if (seg[4] === "verify") {
          const body = await readJson(request);
          const action = String(body.action || "");
          if (!["pay", "cancel"].includes(action)) throw err("AKSI_INVALID", "Field 'action' harus pay/cancel.", 400);
          return json({ ok: true, invoice: await adminVerifyInvoice(db, id, action, { actorUserId: caller.id, ip }) });
        }
        const action = seg[4] === "pay" ? "pay" : "cancel";
        return json({ ok: true, invoice: await adminVerifyInvoice(db, id, action, { actorUserId: caller.id, ip }) });
      }
    }

    // ---------- payments: GET list / GET :id / POST :id/mark ----------
    if (seg[2] === "payments") {
      if (seg.length === 3 && method === "GET") {
        const { limit, offset } = pageParams(url);
        const payments = await adminListPayments(db, {
          status: statusFilter(url, PAYMENT_STATUSES),
          userId: url.searchParams.get("userId") || null,
          invoiceId: url.searchParams.get("invoiceId") || null,
          limit,
          offset,
        });
        return json({ ok: true, payments });
      }
      if (seg.length === 4 && method === "GET") {
        const id = Number(seg[3]);
        if (!Number.isInteger(id) || id < 1) throw err("ID_INVALID", "ID payment tidak valid.", 400);
        const row = await db
          .prepare(
            "SELECT py.id AS id, py.invoice_id AS invoice_id, py.user_id AS user_id, py.provider AS provider, " +
              "py.provider_ref AS provider_ref, py.amount_idr AS amount_idr, py.fee_idr AS fee_idr, " +
              "py.status AS status, py.expires_at AS expires_at, py.paid_at AS paid_at, " +
              "py.created_at AS created_at, py.updated_at AS updated_at, u.email AS user_email " +
              "FROM payments py LEFT JOIN users u ON u.id = py.user_id WHERE py.id = ?"
          )
          .bind(id)
          .first();
        if (!row) throw err("PAYMENT_TIDAK_DITEMUKAN", `Payment #${id} tidak ditemukan.`, 404);
        return json({ ok: true, payment: row });
      }
      if (seg.length === 5 && seg[4] === "mark" && method === "POST") {
        const body = await readJson(request);
        const to = String(body.status || body.to || "");
        const out = await adminMarkPayment(db, seg[3], to, { actorUserId: caller.id, ip });
        return json({ ok: true, ...out });
      }
    }

    // ---------- products: GET list / POST baru / PATCH :id ----------
    if (seg[2] === "products") {
      if (seg.length === 3 && method === "GET") {
        const products = await adminListProducts(db, {});
        return json({ ok: true, products });
      }
      if (seg.length === 3 && method === "POST") {
        const body = await readJson(request);
        return json({ ok: true, product: await adminCreateProduct(db, body, { actorUserId: caller.id, ip }) }, 201);
      }
      if (seg.length === 4 && (method === "PATCH" || method === "PUT")) {
        const body = await readJson(request);
        return json({ ok: true, product: await adminUpdateProduct(db, seg[3], body, { actorUserId: caller.id, ip }) });
      }
    }

    // ---------- audit: GET /api/admin/audit (jejak aksi, tanpa rahasia) ----------
    if (seg.length === 3 && seg[2] === "audit" && method === "GET") {
      const { limit, offset } = pageParams(url);
      const conds = [];
      const args = [];
      const entity = url.searchParams.get("entity");
      const action = url.searchParams.get("action");
      if (entity) {
        conds.push("entity = ?");
        args.push(String(entity));
      }
      if (action) {
        conds.push("action = ?");
        args.push(String(action));
      }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      const rows = await db
        .prepare(
          "SELECT id, actor_user_id, action, entity, entity_id, meta_json, ip, created_at FROM audit_logs " +
            `${where} ORDER BY id DESC LIMIT ? OFFSET ?`
        )
        .bind(...args, limit, offset)
        .all();
      return json({ ok: true, audit: rows.results || [] });
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

async function emailOf(db, userId) {
  try {
    const u = await db.prepare("SELECT email FROM users WHERE id = ?").bind(Number(userId)).first();
    return u ? u.email : null;
  } catch {
    return null;
  }
}

export { servicePublic, decryptSecret };

// T7 — Panel admin (WS4): approve order -> layanan aktif + input
// kredensial operasional + CRUD client/order/layanan/invoice/
// pembayaran/produk-harga + verifikasi manual.
//
// dipakai oleh: route /api/admin/* (T7). Me-reuse engine yang sudah ada —
// JANGAN duplikat logika:
//   lib/catalog.js  (getOrder, getService, ORDER_STATUS, SERVICE_STATUS)
//   lib/credentials.js (encryptSecret, maskUsername)
//   lib/invoices.js (getInvoice, createInvoice, markInvoicePaid, cancelInvoice,
//                    issueFromOrder, INVOICE_STATUS)
// Aturan keras: kredensial disimpan TERENKRIPSI at-rest + kolom
// wp_username_masked untuk preview tanpa dekripsi; JANGAN log password
// ke console/test/audit. Hemat D1: 1 query per list + limit/offset.

import { getOrder, getService, ORDER_STATUS, SERVICE_STATUS } from "./catalog.js";
import { encryptSecret, maskUsername } from "./credentials.js";
import {
  getInvoice,
  listInvoices,
  createInvoice,
  markInvoicePaid,
  cancelInvoice,
  issueFromOrder,
  INVOICE_STATUS,
} from "./invoices.js";

export const ADMIN_ORDER_EDITABLE = ["pending", "awaiting_payment", "paid", "processing"];
export const ADMIN_SERVICE_STATUSES = SERVICE_STATUS;
export const ADMIN_INVOICE_STATUSES = INVOICE_STATUS;
export const PAYMENT_STATUSES = ["pending", "paid", "expired", "failed", "cancelled", "refunded"];

export function err(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

function numId(v, label = "ID") {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw err("ID_INVALID", `${label} tidak valid.`, 400);
  return n;
}

function pageParams(url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  return { limit, offset };
}

function statusFilter(url, allowed, param = "status") {
  const s = url.searchParams.get(param);
  if (s == null || s === "") return null;
  if (!allowed.includes(s)) throw err("STATUS_INVALID", `Status '${s}' tidak dikenal.`, 400);
  return s;
}

async function audit(db, { actorUserId = null, action, entity, entityId, meta = {}, ip = "" }) {
  await db
    .prepare("INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, meta_json, ip) VALUES (?,?,?,?,?,?)")
    .bind(actorUserId, action, entity, String(entityId), JSON.stringify(meta), ip || "")
    .run();
}

function publicUserRow(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name || "",
    phone: u.phone || "",
    role: u.role,
    status: u.status,
    created_at: u.created_at || null,
    updated_at: u.updated_at || null,
  };
}

// ---------- ringkasan dashboard (angka global, murah: COUNT per tabel) ----------

export async function adminSummary(db) {
  const count = async (table, extraWhere = "") => {
    try {
      const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}${extraWhere}`).first();
      return r ? Number(r.n) || 0 : 0;
    } catch {
      return 0;
    }
  };
  const sum = async () => {
    try {
      const r = await db
        .prepare("SELECT COALESCE(SUM(total_idr),0) AS s FROM invoices WHERE status = 'unpaid' OR status = 'overdue'")
        .first();
      return r ? Number(r.s) || 0 : 0;
    } catch {
      return 0;
    }
  };
  const [users, orders, ordersPending, services, servicesActive, invoices, invoicesUnpaid, paymentsPending, piutang] =
    await Promise.all([
      count("users"),
      count("orders"),
      count("orders", " WHERE status = 'pending'"),
      count("services"),
      count("services", " WHERE status = 'active'"),
      count("invoices"),
      count("invoices", " WHERE status = 'unpaid' OR status = 'overdue'"),
      countPaymentsPending(db),
      sum(),
    ]);
  return {
    users,
    orders,
    orders_pending: ordersPending,
    services,
    services_active: servicesActive,
    invoices,
    invoices_unpaid: invoicesUnpaid,
    payments_pending: paymentsPending,
    piutang_idr: piutang,
  };
}

async function countPaymentsPending(db) {
  try {
    const r = await db.prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'").first();
    return r ? Number(r.n) || 0 : 0;
  } catch {
    return 0;
  }
}

// ---------- list admin (1 query per list + pagination) ----------

export async function adminListUsers(db, { q = "", role = null, status = null, limit = 50, offset = 0 } = {}) {
  limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  offset = Math.max(Number(offset) || 0, 0);
  const conds = [];
  const args = [];
  if (role != null && role !== "") {
    if (!["client", "admin"].includes(role)) throw err("STATUS_INVALID", `Role '${role}' tidak dikenal.`, 400);
    conds.push("role = ?");
    args.push(role);
  }
  if (status != null && status !== "") {
    if (!["active", "suspended"].includes(status)) throw err("STATUS_INVALID", `Status '${status}' tidak dikenal.`, 400);
    conds.push("status = ?");
    args.push(status);
  }
  if (q) {
    conds.push("(email LIKE ? OR name LIKE ?)");
    args.push(`%${q}%`, `%${q}%`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = await db
    .prepare(
      "SELECT id, email, name, phone, role, status, created_at, updated_at FROM users " +
        `${where} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .bind(...args, limit, offset)
    .all();
  return (rows.results || []).map(publicUserRow);
}

const ORDER_ADMIN_JOIN =
  "SELECT o.id AS id, o.user_id AS user_id, o.product_id AS product_id, o.qty AS qty, " +
  "o.amount_idr AS amount_idr, o.status AS status, o.notes AS notes, " +
  "o.domain_requested AS domain_requested, o.requirements AS requirements, " +
  "o.created_at AS created_at, o.updated_at AS updated_at, " +
  "u.email AS user_email, u.name AS user_name, " +
  "p.slug AS product_slug, p.name AS product_name, p.price_idr AS product_price, " +
  "p.billing_period AS product_period " +
  "FROM orders o LEFT JOIN users u ON u.id = o.user_id JOIN products p ON p.id = o.product_id";

export function orderAdminPublic(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    user_email: row.user_email || null,
    user_name: row.user_name || null,
    product: {
      id: row.product_id,
      slug: row.product_slug || null,
      name: row.product_name || null,
      price_idr: row.product_price ?? null,
      billing_period: row.product_period || null,
    },
    qty: row.qty,
    amount_idr: row.amount_idr,
    status: row.status,
    domain_requested: row.domain_requested || "",
    requirements: row.requirements || "",
    notes: row.notes || "",
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

export async function adminListOrders(db, { status = null, q = "", userId = null, limit = 50, offset = 0 } = {}) {
  limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  offset = Math.max(Number(offset) || 0, 0);
  const conds = [];
  const args = [];
  if (status != null && status !== "") {
    if (!ORDER_STATUS.includes(status)) throw err("STATUS_INVALID", `Status order '${status}' tidak dikenal.`, 400);
    conds.push("o.status = ?");
    args.push(status);
  }
  if (userId != null && userId !== "") {
    conds.push("o.user_id = ?");
    args.push(numId(userId, "userId"));
  }
  if (q) {
    conds.push("(u.email LIKE ? OR o.domain_requested LIKE ?)");
    args.push(`%${q}%`, `%${q}%`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = await db
    .prepare(`${ORDER_ADMIN_JOIN} ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`)
    .bind(...args, limit, offset)
    .all();
  return (rows.results || []).map(orderAdminPublic);
}

const SERVICE_ADMIN_JOIN =
  "SELECT s.id AS id, s.user_id AS user_id, s.order_id AS order_id, s.product_id AS product_id, " +
  "s.label AS label, s.domain AS domain, s.wp_url AS wp_url, " +
  "s.wp_username_masked AS wp_username_masked, s.site_url AS site_url, s.admin_url AS admin_url, " +
  "s.serverless_info AS serverless_info, s.status AS status, s.expires_at AS expires_at, " +
  "s.created_at AS created_at, s.updated_at AS updated_at, " +
  "u.email AS user_email, u.name AS user_name, " +
  "p.slug AS product_slug, p.name AS product_name, p.billing_period AS product_period " +
  "FROM services s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN products p ON p.id = s.product_id";

// Bentuk admin SATU layanan: aman (tanpa *_enc mentah) + flag kredensial.
export function serviceAdminPublic(row) {
  const wpUrl = String(row.wp_url || "");
  const siteUrl = String(row.site_url || "");
  const adminUrl = String(row.admin_url || "");
  const url = siteUrl || wpUrl || (row.domain ? `https://${row.domain}` : "");
  const wpAdminUrl = adminUrl || (wpUrl ? `${String(wpUrl).replace(/\/+$/, "")}/wp-admin` : null);
  return {
    id: row.id,
    user_id: row.user_id,
    user_email: row.user_email || null,
    user_name: row.user_name || null,
    order_id: row.order_id ?? null,
    product: {
      id: row.product_id ?? null,
      slug: row.product_slug || null,
      name: row.product_name || null,
      billing_period: row.product_period || null,
    },
    label: row.label || "",
    domain: row.domain || "",
    url,
    wp_url: wpUrl,
    site_url: siteUrl,
    admin_url: adminUrl,
    wp_admin_url: wpAdminUrl,
    wp_username_masked: String(row.wp_username_masked || ""),
    has_wp_username: !!String(row.wp_username_masked || ""),
    has_wp_secret: row.has_wp_secret != null ? !!row.has_wp_secret : undefined,
    serverless_info: String(row.serverless_info || ""),
    status: row.status,
    expires_at: row.expires_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

export async function adminListServices(
  db,
  { status = null, q = "", userId = null, orderId = null, limit = 50, offset = 0 } = {}
) {
  limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  offset = Math.max(Number(offset) || 0, 0);
  const conds = [];
  const args = [];
  if (status != null && status !== "") {
    if (!SERVICE_STATUS.includes(status)) throw err("STATUS_INVALID", `Status layanan '${status}' tidak dikenal.`, 400);
    conds.push("s.status = ?");
    args.push(status);
  }
  if (userId != null && userId !== "") {
    conds.push("s.user_id = ?");
    args.push(numId(userId, "userId"));
  }
  if (orderId != null && orderId !== "") {
    conds.push("s.order_id = ?");
    args.push(numId(orderId, "orderId"));
  }
  if (q) {
    conds.push("(u.email LIKE ? OR s.domain LIKE ? OR s.label LIKE ?)");
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  // has_wp_secret tanpa membaca nilai mentah: panjang ciphertext > 0.
  const rows = await db
    .prepare(
      "SELECT s.id AS id, s.user_id AS user_id, s.order_id AS order_id, s.product_id AS product_id, " +
        "s.label AS label, s.domain AS domain, s.wp_url AS wp_url, " +
        "s.wp_username_masked AS wp_username_masked, s.site_url AS site_url, s.admin_url AS admin_url, " +
        "s.serverless_info AS serverless_info, s.status AS status, s.expires_at AS expires_at, " +
        "s.created_at AS created_at, s.updated_at AS updated_at, " +
        "(LENGTH(COALESCE(s.wp_secret_enc,'')) > 0) AS has_wp_secret, " +
        "u.email AS user_email, u.name AS user_name, " +
        "p.slug AS product_slug, p.name AS product_name, p.billing_period AS product_period " +
        "FROM services s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN products p ON p.id = s.product_id " +
        `${where} ORDER BY s.id DESC LIMIT ? OFFSET ?`
    )
    .bind(...args, limit, offset)
    .all();
  return (rows.results || []).map(serviceAdminPublic);
}

export async function adminListPayments(
  db,
  { status = null, userId = null, invoiceId = null, limit = 50, offset = 0 } = {}
) {
  limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  offset = Math.max(Number(offset) || 0, 0);
  const conds = [];
  const args = [];
  if (status != null && status !== "") {
    if (!PAYMENT_STATUSES.includes(status)) throw err("STATUS_INVALID", `Status payment '${status}' tidak dikenal.`, 400);
    conds.push("py.status = ?");
    args.push(status);
  }
  if (userId != null && userId !== "") {
    conds.push("py.user_id = ?");
    args.push(numId(userId, "userId"));
  }
  if (invoiceId != null && invoiceId !== "") {
    conds.push("py.invoice_id = ?");
    args.push(numId(invoiceId, "invoiceId"));
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = await db
    .prepare(
      "SELECT py.id AS id, py.invoice_id AS invoice_id, py.user_id AS user_id, " +
        "py.provider AS provider, py.provider_ref AS provider_ref, py.amount_idr AS amount_idr, " +
        "py.fee_idr AS fee_idr, py.status AS status, py.expires_at AS expires_at, py.paid_at AS paid_at, " +
        "py.created_at AS created_at, py.updated_at AS updated_at, " +
        "u.email AS user_email, i.number AS invoice_number " +
        "FROM payments py LEFT JOIN users u ON u.id = py.user_id LEFT JOIN invoices i ON i.id = py.invoice_id " +
        `${where} ORDER BY py.id DESC LIMIT ? OFFSET ?`
    )
    .bind(...args, limit, offset)
    .all();
  return rows.results || [];
}

export async function adminListProducts(db, { activeOnly = false } = {}) {
  const rows = await db
    .prepare(
      "SELECT id, slug, name, description, price_idr, billing_period, features_json, is_active, sort_order " +
        "FROM products" +
        (activeOnly ? " WHERE is_active = 1" : "") +
        " ORDER BY sort_order, id"
    )
    .all();
  return rows.results || [];
}

// ---------- tulis: user ----------

export async function adminUpdateUser(db, id, body = {}, { actorUserId = null, ip = "" } = {}) {
  id = numId(id, "ID user");
  const row = await db.prepare("SELECT id, email, role, status FROM users WHERE id = ?").bind(id).first();
  if (!row) throw err("USER_TIDAK_DITEMUKAN", `User #${id} tidak ditemukan.`, 404);
  const patch = {};
  if (body.role != null && body.role !== "") {
    if (!["client", "admin"].includes(body.role)) throw err("ROLE_INVALID", "Role harus client/admin.", 400);
    patch.role = body.role;
  }
  if (body.status != null && body.status !== "") {
    if (!["active", "suspended"].includes(body.status)) throw err("STATUS_INVALID", "Status harus active/suspended.", 400);
    patch.status = body.status;
  }
  if (body.name != null) {
    const name = String(body.name || "").slice(0, 120);
    patch.name = name;
    await db.prepare("UPDATE users SET name = ?, updated_at = ? WHERE id = ?").bind(name, new Date().toISOString(), id).run();
  }
  if (body.phone != null) {
    const phone = String(body.phone || "").slice(0, 40);
    patch.phone = phone;
    await db.prepare("UPDATE users SET phone = ?, updated_at = ? WHERE id = ?").bind(phone, new Date().toISOString(), id).run();
  }
  if (patch.role != null) {
    await db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").bind(patch.role, new Date().toISOString(), id).run();
  }
  if (patch.status != null) {
    await db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?").bind(patch.status, new Date().toISOString(), id).run();
  }
  await audit(db, { actorUserId, action: "admin.user_updated", entity: "user", entityId: id, meta: { ...patch }, ip });
  const u = await db
    .prepare("SELECT id, email, name, phone, role, status, created_at, updated_at FROM users WHERE id = ?")
    .bind(id)
    .first();
  return publicUserRow(u);
}

// ---------- tulis: order (status + catatan) ----------

export async function adminUpdateOrder(db, id, body = {}, { actorUserId = null, ip = "" } = {}) {
  id = numId(id, "ID order");
  const row = await getOrder(db, id);
  if (!row) throw err("ORDER_TIDAK_DITEMUKAN", `Order #${id} tidak ditemukan.`, 404);
  const from = row.status;
  if (body.status != null && body.status !== "") {
    if (!ORDER_STATUS.includes(body.status)) throw err("STATUS_INVALID", `Status order '${body.status}' tidak dikenal.`, 400);
    if (body.status !== from) {
      await db
        .prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?")
        .bind(body.status, new Date().toISOString(), id)
        .run();
    }
  }
  if (body.notes != null) {
    const notes = String(body.notes || "").slice(0, 2000);
    await db.prepare("UPDATE orders SET notes = ?, updated_at = ? WHERE id = ?").bind(notes, new Date().toISOString(), id).run();
  }
  await audit(db, {
    actorUserId,
    action: "admin.order_updated",
    entity: "order",
    entityId: id,
    meta: { from, to: body.status ?? from },
    ip,
  });
  const after = await getOrder(db, id);
  return orderAdminPublic({ ...after, user_email: row.user_email, user_name: row.user_name });
}

// ---------- APPROVE: order pending -> layanan aktif + kredensial ----------
//
// Acceptance wajib T7: admin approve order pending menjadi layanan aktif +
// input URL/login WP; layanan lalu terlihat MASKED di sisi client
// (pakai servicePublic T4 — jalur client tak berubah).
// Idempotent per order: bila layanan untuk order sudah ada -> 409
// (pakai yang ada, jangan duplikat).

function cleanUrl(v, max = 500) {
  const s = String(v || "").trim().slice(0, max);
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) throw err("URL_INVALID", "URL harus diawali http(s):// (contoh: https://tokosaya.com).", 400);
  return s.replace(/\/+$/, "");
}

function cleanText(v, max, label) {
  const s = String(v ?? "");
  if (s.length > max) throw err("INPUT_INVALID", `${label} maksimal ${max} karakter.`, 400);
  return s;
}

export async function approveOrder(db, orderId, body = {}, { actorUserId = null, ip = "", env = null } = {}) {
  orderId = numId(orderId, "ID order");
  const order = await getOrder(db, orderId);
  if (!order) throw err("ORDER_TIDAK_DITEMUKAN", `Order #${orderId} tidak ditemukan.`, 404);
  if (!["pending", "awaiting_payment", "paid", "processing"].includes(order.status)) {
    throw err(
      "ORDER_TAK_BISA_APPROVE",
      `Order berstatus ${order.status} tidak bisa di-approve (bisa: pending/menunggu bayar/lunas/diproses).`,
      409
    );
  }
  // Anti-duplikat: satu order -> satu layanan.
  const existing = await db.prepare("SELECT id FROM services WHERE order_id = ? ORDER BY id DESC").bind(orderId).first();
  if (existing) {
    throw err("LAYANAN_SUDAH_ADA", `Order #${orderId} sudah punya layanan #${existing.id}.`, 409);
  }

  const label = cleanText(body.label ?? order.domain_requested ?? "", 200, "Label");
  const domain = String(body.domain ?? order.domain_requested ?? "").trim().toLowerCase().slice(0, 253);
  const siteUrl = body.site_url != null && String(body.site_url).trim() !== "" ? cleanUrl(body.site_url) : "";
  const adminUrl = body.admin_url != null && String(body.admin_url).trim() !== "" ? cleanUrl(body.admin_url) : "";
  const wpUrl = body.wp_url != null && String(body.wp_url).trim() !== "" ? cleanUrl(body.wp_url) : siteUrl || (domain ? `https://${domain}` : "");
  const wpUsername = cleanText(body.wp_username ?? "", 200, "Username WP");
  const wpSecret = cleanText(body.wp_secret ?? "", 2000, "Password WP");
  const serverlessInfo = cleanText(body.serverless_info ?? "", 2000, "Info serverless");
  const status = body.status != null && body.status !== "" ? String(body.status) : "active";
  if (!SERVICE_STATUS.includes(status)) throw err("STATUS_INVALID", `Status layanan '${status}' tidak dikenal.`, 400);
  const expiresAt = body.expires_at != null && String(body.expires_at).trim() !== "" ? String(body.expires_at).trim() : null;
  if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) throw err("TANGGAL_INVALID", "expires_at tidak valid (ISO-8601).", 400);

  // Kredensial terenkripsi at-rest; preview aman tanpa dekripsi.
  const wpUsernameEnc = wpUsername ? await encryptSecret(wpUsername, env || {}) : "";
  const wpSecretEnc = wpSecret ? await encryptSecret(wpSecret, env || {}) : "";
  const wpUsernameMasked = wpUsername ? maskUsername(wpUsername) : "";
  const now = new Date().toISOString();

  const r = await db
    .prepare(
      "INSERT INTO services (user_id, order_id, product_id, label, domain, wp_url, wp_username_enc, wp_secret_enc, " +
        "wp_username_masked, site_url, admin_url, serverless_info, status, expires_at, created_at, updated_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
    .bind(
      order.user_id,
      orderId,
      order.product_id,
      label,
      domain,
      wpUrl,
      wpUsernameEnc,
      wpSecretEnc,
      wpUsernameMasked,
      siteUrl,
      adminUrl,
      serverlessInfo,
      status,
      expiresAt,
      now,
      now
    )
    .run();
  const serviceId = r.meta && r.meta.last_row_id;

  // Order ikut maju: pending -> processing (siap ditagih / sudah aktif).
  const nextOrder = order.status === "pending" ? "processing" : order.status;
  if (nextOrder !== order.status) {
    await db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").bind(nextOrder, now, orderId).run();
  }
  // Audit TANPA nilai rahasia (hanya flag + id).
  await audit(db, {
    actorUserId,
    action: "admin.order_approved",
    entity: "order",
    entityId: orderId,
    meta: { service_id: serviceId, order_from: order.status, order_to: nextOrder, has_wp_username: !!wpUsername, has_wp_secret: !!wpSecret },
    ip,
  });

  const svc = await getService(db, serviceId);
  return { serviceId, orderId, order_status: nextOrder, service: svc };
}

// ---------- tulis: layanan (update operasional, kredensial tetap terenkripsi) ----------

export async function adminUpdateService(db, id, body = {}, { actorUserId = null, ip = "", env = null } = {}) {
  id = numId(id, "ID layanan");
  const row = await getService(db, id);
  if (!row) throw err("LAYANAN_TIDAK_DITEMUKAN", `Layanan #${id} tidak ditemukan.`, 404);
  const now = new Date().toISOString();
  const sets = [];
  const args = [];
  const meta = {};
  const set = (col, val) => {
    sets.push(`${col} = ?`);
    args.push(val);
  };

  if (body.label != null) set("label", cleanText(body.label, 200, "Label"));
  if (body.domain != null) set("domain", String(body.domain || "").trim().toLowerCase().slice(0, 253));
  if (body.site_url != null) set("site_url", String(body.site_url || "").trim() === "" ? "" : cleanUrl(body.site_url));
  if (body.admin_url != null) set("admin_url", String(body.admin_url || "").trim() === "" ? "" : cleanUrl(body.admin_url));
  if (body.wp_url != null) set("wp_url", String(body.wp_url || "").trim() === "" ? "" : cleanUrl(body.wp_url));
  if (body.serverless_info != null) set("serverless_info", cleanText(body.serverless_info, 2000, "Info serverless"));
  if (body.status != null && body.status !== "") {
    if (!SERVICE_STATUS.includes(body.status)) throw err("STATUS_INVALID", `Status layanan '${body.status}' tidak dikenal.`, 400);
    set("status", body.status);
    meta.status = body.status;
  }
  if (body.expires_at !== undefined) {
    const v = body.expires_at == null || String(body.expires_at).trim() === "" ? null : String(body.expires_at).trim();
    if (v && Number.isNaN(new Date(v).getTime())) throw err("TANGGAL_INVALID", "expires_at tidak valid (ISO-8601).", 400);
    set("expires_at", v);
  }
  if (body.wp_username != null && String(body.wp_username) !== "") {
    const plain = cleanText(body.wp_username, 200, "Username WP");
    set("wp_username_enc", await encryptSecret(plain, env || {}));
    set("wp_username_masked", maskUsername(plain));
    meta.wp_username_diubah = true;
  }
  if (body.wp_secret != null && String(body.wp_secret) !== "") {
    cleanText(body.wp_secret, 2000, "Password WP");
    set("wp_secret_enc", await encryptSecret(String(body.wp_secret), env || {}));
    meta.wp_secret_diubah = true;
  }
  if (sets.length === 0) throw err("TIDAK_ADA_PERUBAHAN", "Tidak ada field yang diubah.", 400);

  set("updated_at", now);
  args.push(id);
  await db.prepare(`UPDATE services SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();
  await audit(db, { actorUserId, action: "admin.service_updated", entity: "service", entityId: id, meta, ip });
  return getService(db, id);
}

// ---------- tulis: produk / harga ----------

export async function adminCreateProduct(db, body = {}, { actorUserId = null, ip = "" } = {}) {
  const slug = String(body.slug || "").trim().toLowerCase().slice(0, 120);
  const name = String(body.name || "").trim().slice(0, 200);
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw err("SLUG_INVALID", "Slug wajib huruf-kecil/angka/strip (contoh: paket-web-baru).", 400);
  }
  if (!name) throw err("NAMA_KOSONG", "Nama produk wajib diisi.", 400);
  const price = Math.trunc(Number(body.price_idr ?? body.price ?? 0));
  if (!(price >= 0)) throw err("HARGA_INVALID", "Harga minimal 0 rupiah.", 400);
  const period = String(body.billing_period || "once");
  if (!["once", "monthly", "yearly"].includes(period)) throw err("PERIODE_INVALID", "billing_period harus once/monthly/yearly.", 400);
  const description = String(body.description || "").slice(0, 2000);
  let features = [];
  if (Array.isArray(body.features)) features = body.features.map(String).slice(0, 50);
  else if (typeof body.features_json === "string") {
    try {
      const f = JSON.parse(body.features_json);
      if (Array.isArray(f)) features = f.map(String).slice(0, 50);
    } catch {
      throw err("FITUR_INVALID", "features_json bukan JSON array.", 400);
    }
  }
  const isActive = body.is_active == null ? 1 : Number(body.is_active) ? 1 : 0;
  const sortOrder = Math.trunc(Number(body.sort_order ?? 0)) || 0;
  const now = new Date().toISOString();
  try {
    const r = await db
      .prepare(
        "INSERT INTO products (slug, name, description, price_idr, billing_period, features_json, is_active, sort_order, created_at, updated_at) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?)"
      )
      .bind(slug, name, description, price, period, JSON.stringify(features), isActive, sortOrder, now, now)
      .run();
    const pid = r.meta && r.meta.last_row_id;
    await audit(db, { actorUserId, action: "admin.product_created", entity: "product", entityId: pid, meta: { slug, price }, ip });
    return db.prepare("SELECT id, slug, name, description, price_idr, billing_period, features_json, is_active, sort_order FROM products WHERE id = ?").bind(pid).first();
  } catch (e) {
    if (/unique/i.test(String((e && e.message) || ""))) throw err("SLUG_DUPLIKAT", `Slug '${slug}' sudah dipakai.`, 409);
    throw e;
  }
}

export async function adminUpdateProduct(db, id, body = {}, { actorUserId = null, ip = "" } = {}) {
  id = numId(id, "ID produk");
  const row = await db.prepare("SELECT id, slug FROM products WHERE id = ?").bind(id).first();
  if (!row) throw err("PRODUK_TIDAK_DITEMUKAN", `Produk #${id} tidak ditemukan.`, 404);
  const sets = [];
  const args = [];
  const meta = {};
  const set = (col, val) => {
    sets.push(`${col} = ?`);
    args.push(val);
  };
  if (body.name != null) {
    const name = String(body.name || "").trim().slice(0, 200);
    if (!name) throw err("NAMA_KOSONG", "Nama produk wajib diisi.", 400);
    set("name", name);
  }
  if (body.description != null) set("description", String(body.description || "").slice(0, 2000));
  if (body.price_idr != null || body.price != null) {
    const price = Math.trunc(Number(body.price_idr ?? body.price));
    if (!(price >= 0)) throw err("HARGA_INVALID", "Harga minimal 0 rupiah.", 400);
    set("price_idr", price);
    meta.price_idr = price;
  }
  if (body.billing_period != null && body.billing_period !== "") {
    if (!["once", "monthly", "yearly"].includes(body.billing_period)) {
      throw err("PERIODE_INVALID", "billing_period harus once/monthly/yearly.", 400);
    }
    set("billing_period", body.billing_period);
  }
  if (body.features != null || body.features_json != null) {
    let features = [];
    if (Array.isArray(body.features)) features = body.features.map(String).slice(0, 50);
    else if (typeof body.features_json === "string") {
      try {
        const f = JSON.parse(body.features_json);
        if (!Array.isArray(f)) throw new Error("bukan array");
        features = f.map(String).slice(0, 50);
      } catch {
        throw err("FITUR_INVALID", "features_json bukan JSON array.", 400);
      }
    }
    set("features_json", JSON.stringify(features));
  }
  if (body.is_active != null) set("is_active", Number(body.is_active) ? 1 : 0);
  if (body.sort_order != null) set("sort_order", Math.trunc(Number(body.sort_order)) || 0);
  if (sets.length === 0) throw err("TIDAK_ADA_PERUBAHAN", "Tidak ada field yang diubah.", 400);
  set("updated_at", new Date().toISOString());
  args.push(id);
  await db.prepare(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();
  await audit(db, { actorUserId, action: "admin.product_updated", entity: "product", entityId: id, meta, ip });
  return db.prepare("SELECT id, slug, name, description, price_idr, billing_period, features_json, is_active, sort_order FROM products WHERE id = ?").bind(id).first();
}

// ---------- verifikasi manual invoice + pembayaran ----------
//
// Me-reuse engine T5 (transisi dijaga): tandai lunas / batalkan /
// terbitkan dari order. Admin juga boleh menandai payment manual
// (catat audit; pelunasan invoice ikut via engine, bukan duplikat).

export async function adminVerifyInvoice(db, id, action, { actorUserId = null, ip = "" } = {}) {
  id = numId(id, "ID invoice");
  if (action === "pay") return markInvoicePaid(db, id, { actorUserId, ip, meta: { via: "admin-manual" } });
  if (action === "cancel") return cancelInvoice(db, id, { actorUserId, ip, meta: { via: "admin-manual" } });
  throw err("AKSI_INVALID", "Aksi harus pay/cancel.", 400);
}

export async function adminCreateInvoiceManual(db, body = {}, { actorUserId = null, ip = "" } = {}) {
  if (body.orderId != null) {
    return issueFromOrder(db, Number(body.orderId), {
      notes: body.notes,
      dueDays: body.dueDays,
      taxRate: body.taxRate,
      actorUserId,
      ip,
    });
  }
  return createInvoice(db, {
    userId: numId(body.userId, "userId"),
    orderId: body.orderId ?? null,
    serviceId: body.serviceId ?? null,
    items: body.items,
    billingPeriod: body.billingPeriod || "once",
    taxRate: body.taxRate,
    dueDays: body.dueDays,
    notes: body.notes || "",
    actorUserId,
    ip,
  });
}

export async function adminMarkPayment(db, id, to, { actorUserId = null, ip = "" } = {}) {
  id = numId(id, "ID payment");
  if (!PAYMENT_STATUSES.includes(to)) throw err("STATUS_INVALID", `Status payment '${to}' tidak dikenal.`, 400);
  const row = await db.prepare("SELECT id, invoice_id, user_id, status FROM payments WHERE id = ?").bind(id).first();
  if (!row) throw err("PAYMENT_TIDAK_DITEMUKAN", `Payment #${id} tidak ditemukan.`, 404);
  const now = new Date().toISOString();
  await db
    .prepare("UPDATE payments SET status = ?, paid_at = ?, updated_at = ? WHERE id = ?")
    .bind(to, to === "paid" ? now : null, now, id)
    .run();
  // Payment lunas manual -> invoice ikut lunas via engine (transisi dijaga).
  let invoice = null;
  if (to === "paid") {
    try {
      const inv = await getInvoice(db, row.invoice_id);
      if (inv && (inv.status === "unpaid" || inv.status === "overdue")) {
        invoice = await markInvoicePaid(db, row.invoice_id, { actorUserId, ip, meta: { via: "admin-payment-manual", payment_id: id } }, now);
      } else {
        invoice = inv;
      }
    } catch (e) {
      if (!(e && e.code === "TRANSISI_INVALID")) throw e;
      invoice = await getInvoice(db, row.invoice_id);
    }
  }
  await audit(db, {
    actorUserId,
    action: `admin.payment_${to}`,
    entity: "payment",
    entityId: id,
    meta: { invoice_id: row.invoice_id },
    ip,
  });
  const payment = await db.prepare("SELECT id, invoice_id, user_id, provider, provider_ref, amount_idr, fee_idr, status, expires_at, paid_at FROM payments WHERE id = ?").bind(id).first();
  return { payment, invoice };
}

export { pageParams, statusFilter, getInvoice, listInvoices };
export { ORDER_STATUS, SERVICE_STATUS, INVOICE_STATUS };

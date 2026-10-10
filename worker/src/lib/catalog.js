// T4 — Katalog + order + layanan client (WS2).
//
// Dipakai oleh: route publik /api/catalog (T4) dan zona /api/client/* (T4),
// panel approve admin (T7 memakai createServiceFromOrder-nya sendiri —
// order di sini TIDAK membuat baris service; layanan muncul setelah approve).
//
// Konvensi (lihat T2): uang = INTEGER rupiah (tanpa float),
// waktu = TEXT ISO-8601 UTC. Semua query parameterized (anti SQL-inject).

export const ORDER_STATUS = ["pending", "awaiting_payment", "paid", "processing", "completed", "cancelled"];
export const SERVICE_STATUS = ["pending", "active", "suspended", "expired"];
export const ORDER_CANCELABLE = ["pending", "awaiting_payment"];

export function err(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

async function audit(db, { actorUserId = null, action, entity, entityId, meta = {}, ip = "" }) {
  await db
    .prepare("INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, meta_json, ip) VALUES (?,?,?,?,?,?)")
    .bind(actorUserId, action, entity, String(entityId), JSON.stringify(meta), ip || "")
    .run();
}

// ---------- produk / katalog ----------

export function productPublic(row) {
  let features = [];
  try {
    const f = JSON.parse(row.features_json || "[]");
    if (Array.isArray(f)) features = f.map(String);
  } catch {
    features = [];
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || "",
    price_idr: row.price_idr,
    billing_period: row.billing_period,
    features,
    sort_order: row.sort_order ?? 0,
  };
}

const PRODUCT_COLS =
  "id, slug, name, description, price_idr, billing_period, features_json, is_active, sort_order";

export async function listProducts(db, { activeOnly = true } = {}) {
  const rows = await db
    .prepare(
      `SELECT ${PRODUCT_COLS} FROM products` +
        (activeOnly ? " WHERE is_active = 1" : "") +
        " ORDER BY sort_order, id"
    )
    .all();
  return (rows.results || []).map(productPublic);
}

export async function getProduct(db, { id = null, slug = null } = {}) {
  let row = null;
  if (id != null) {
    if (!Number.isInteger(Number(id))) throw err("PRODUK_INVALID", "ID produk tidak valid.", 400);
    row = await db.prepare(`SELECT ${PRODUCT_COLS} FROM products WHERE id = ?`).bind(Number(id)).first();
  } else if (slug != null) {
    row = await db
      .prepare(`SELECT ${PRODUCT_COLS} FROM products WHERE slug = ?`)
      .bind(String(slug).trim())
      .first();
  } else {
    throw err("PRODUK_INVALID", "Pilih paket dulu (productId/slug).", 400);
  }
  return row || null;
}

// ---------- validasi form order ----------

export function validateDomain(d) {
  const s = String(d || "").trim();
  if (!s) return "";
  if (s.length > 253) throw err("DOMAIN_INVALID", "Domain maksimal 253 karakter.", 400);
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(s)) {
    throw err("DOMAIN_INVALID", "Format domain tidak valid (contoh: tokosaya.com).", 400);
  }
  return s.toLowerCase();
}

function validateText(s, max, code, label) {
  const t = String(s || "");
  if (t.length > max) throw err(code, `${label} maksimal ${max} karakter.`, 400);
  return t;
}

// ---------- order ----------

const ORDER_JOIN =
  "SELECT o.id AS id, o.user_id AS user_id, o.product_id AS product_id, o.qty AS qty, " +
  "o.amount_idr AS amount_idr, o.status AS status, o.notes AS notes, " +
  "o.domain_requested AS domain_requested, o.requirements AS requirements, " +
  "o.created_at AS created_at, o.updated_at AS updated_at, " +
  "p.slug AS product_slug, p.name AS product_name, p.price_idr AS product_price, " +
  "p.billing_period AS product_period " +
  "FROM orders o JOIN products p ON p.id = o.product_id";

export function orderPublic(row) {
  return {
    id: row.id,
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

export async function getOrder(db, id) {
  if (!Number.isInteger(Number(id)) || Number(id) < 1) throw err("ID_INVALID", "ID order tidak valid.", 400);
  return db.prepare(`${ORDER_JOIN} WHERE o.id = ?`).bind(Number(id)).first();
}

export async function listOrders(db, { userId, status = null, limit = 50, offset = 0 } = {}) {
  if (!Number.isInteger(Number(userId))) throw err("USER_INVALID", "userId wajib integer.", 400);
  limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  offset = Math.max(Number(offset) || 0, 0);
  let sql = `${ORDER_JOIN} WHERE o.user_id = ?`;
  const args = [Number(userId)];
  if (status != null && status !== "") {
    if (!ORDER_STATUS.includes(status)) throw err("STATUS_INVALID", `Status order '${status}' tidak dikenal.`, 400);
    sql += " AND o.status = ?";
    args.push(status);
  }
  sql += " ORDER BY o.id DESC LIMIT ? OFFSET ?";
  args.push(limit, offset);
  const rows = await db.prepare(sql).bind(...args).all();
  return (rows.results || []).map(orderPublic);
}

// Order BARU selalu 'pending'. Layanan dibuat terpisah saat approve (T7) —
// bukan di sini (acceptance: layanan muncul setelah admin approve).
export async function createOrder(
  db,
  { userId, productId = null, slug = null, qty = 1, domainRequested = "", requirements = "", notes = "", actorUserId = null, ip = "" } = {}
) {
  if (!Number.isInteger(Number(userId))) throw err("USER_INVALID", "userId wajib integer.", 400);
  const product = await getProduct(db, { id: productId, slug });
  if (!product) throw err("PRODUK_TIDAK_DITEMUKAN", "Paket tidak ditemukan.", 404);
  if (!product.is_active) throw err("PRODUK_NONAKTIF", `Paket '${product.name}' sedang nonaktif.`, 404);

  const q = Number(qty == null || qty === "" ? 1 : qty);
  if (!Number.isInteger(q) || q < 1 || q > 100) throw err("QTY_INVALID", "Qty harus 1..100.", 400);
  const domain = validateDomain(domainRequested);
  const req = validateText(requirements, 2000, "KEBUTUHAN_INVALID", "Kebutuhan");
  const note = validateText(notes, 2000, "CATATAN_INVALID", "Catatan");
  const amount = Number(product.price_idr) * q;

  const r = await db
    .prepare(
      "INSERT INTO orders (user_id, product_id, qty, amount_idr, status, notes, domain_requested, requirements) VALUES (?,?,?,?,?,?,?,?)"
    )
    .bind(Number(userId), product.id, q, amount, "pending", note, domain, req)
    .run();
  const id = r.meta && r.meta.last_row_id;
  await audit(db, {
    actorUserId: actorUserId ?? Number(userId),
    action: "order.created",
    entity: "order",
    entityId: id,
    meta: { product_id: product.id, qty: q, amount },
    ip,
  });
  return orderPublic(await getOrder(db, id));
}

// Client boleh membatalkan order miliknya yang masih pending/menunggu bayar.
export async function cancelOrder(db, id, { actorUserId = null, ip = "" } = {}) {
  const row = await getOrder(db, id);
  if (!row) throw err("ORDER_TIDAK_DITEMUKAN", `Order #${id} tidak ditemukan.`, 404);
  if (!ORDER_CANCELABLE.includes(row.status)) {
    throw err("ORDER_TAK_BISA_BATAL", `Order ${row.status} tidak bisa dibatalkan.`, 409);
  }
  const now = new Date().toISOString();
  await db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").bind("cancelled", now, row.id).run();
  await audit(db, { actorUserId, action: "order.cancelled", entity: "order", entityId: row.id, meta: { from: row.status }, ip });
  return orderPublic(await getOrder(db, id));
}

// ---------- layanan ----------

const SERVICE_JOIN =
  "SELECT s.id AS id, s.user_id AS user_id, s.order_id AS order_id, s.product_id AS product_id, " +
  "s.label AS label, s.domain AS domain, s.wp_url AS wp_url, " +
  "s.wp_username_enc AS wp_username_enc, s.wp_secret_enc AS wp_secret_enc, " +
  "s.wp_username_masked AS wp_username_masked, s.site_url AS site_url, s.admin_url AS admin_url, " +
  "s.serverless_info AS serverless_info, s.status AS status, s.expires_at AS expires_at, " +
  "s.created_at AS created_at, s.updated_at AS updated_at, " +
  "p.slug AS product_slug, p.name AS product_name, p.billing_period AS product_period " +
  "FROM services s LEFT JOIN products p ON p.id = s.product_id";

export async function getService(db, id) {
  if (!Number.isInteger(Number(id)) || Number(id) < 1) throw err("ID_INVALID", "ID layanan tidak valid.", 400);
  return db.prepare(`${SERVICE_JOIN} WHERE s.id = ?`).bind(Number(id)).first();
}

export async function listServices(db, { userId, status = null, limit = 50, offset = 0 } = {}) {
  if (!Number.isInteger(Number(userId))) throw err("USER_INVALID", "userId wajib integer.", 400);
  limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  offset = Math.max(Number(offset) || 0, 0);
  let sql = `${SERVICE_JOIN} WHERE s.user_id = ?`;
  const args = [Number(userId)];
  if (status != null && status !== "") {
    if (!SERVICE_STATUS.includes(status)) throw err("STATUS_INVALID", `Status layanan '${status}' tidak dikenal.`, 400);
    sql += " AND s.status = ?";
    args.push(status);
  }
  sql += " ORDER BY s.id DESC LIMIT ? OFFSET ?";
  args.push(limit, offset);
  const rows = await db.prepare(sql).bind(...args).all();
  return rows.results || [];
}

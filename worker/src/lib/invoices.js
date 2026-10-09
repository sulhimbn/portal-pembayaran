// T5 — Invoice engine (WS3): nomor unik, langganan bulanan/tahunan,
// status unpaid/paid/overdue/cancelled, total+pajak, riwayat audit.
//
// Dipakai oleh: route /api/invoices (T5), webhook QRIS auto-lunas (T6),
// cron invoice berulang + reminder (T8), panel admin (T7).
//
// Konvensi (lihat T2): uang = INTEGER rupiah (tanpa float),
// waktu = TEXT ISO-8601 UTC. Semua query parameterized (anti SQL-inject).

export const TAX_RATE_DEFAULT = 0.11; // PPN 11%
export const DUE_DAYS_DEFAULT = { once: 7, monthly: 7, yearly: 14 };
export const INVOICE_STATUS = ["unpaid", "paid", "overdue", "cancelled"];

const TRANSITIONS = {
  unpaid: ["paid", "overdue", "cancelled"],
  overdue: ["paid", "cancelled"],
  paid: [],
  cancelled: [],
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function assertTransition(from, to) {
  if (!INVOICE_STATUS.includes(to)) throw err("STATUS_INVALID", `Status '${to}' tidak dikenal.`, 400);
  if (!canTransition(from, to)) {
    throw err("TRANSISI_INVALID", `Invoice ${from} tidak bisa menjadi ${to}.`, 409);
  }
}

export function err(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

// ---------- format ----------

export function formatIDR(n) {
  const v = Math.trunc(Number(n) || 0);
  return "Rp" + v.toLocaleString("id-ID");
}

export function formatTanggal(iso) {
  try {
    return new Date(iso).toLocaleDateString("id-ID", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Asia/Jakarta",
    });
  } catch {
    return String(iso || "-");
  }
}

// Format: INV/2026/10/0007 (tahun/bulan/sequence global zero-padded).
export function formatInvoiceNumber(when, seq) {
  const d = when instanceof Date ? when : new Date(when);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `INV/${yyyy}/${mm}/${String(seq).padStart(4, "0")}`;
}

// ---------- total & pajak ----------

export function computeTotals(items, taxRate = TAX_RATE_DEFAULT) {
  if (!Array.isArray(items) || items.length === 0) {
    throw err("ITEM_KOSONG", "Invoice wajib punya minimal 1 item.", 400);
  }
  if (!(taxRate >= 0 && taxRate < 1)) throw err("PAJAK_INVALID", "Tarif pajak harus 0..1.", 400);
  let amount = 0;
  const lines = items.map((it, i) => {
    const qty = Math.trunc(Number(it.qty));
    const unit = Math.trunc(Number(it.unitPrice ?? it.unit_price_idr));
    const label = String(it.label || "").trim();
    if (!label) throw err("ITEM_INVALID", `Item #${i + 1}: label wajib diisi.`, 400);
    if (!(qty >= 1)) throw err("ITEM_INVALID", `Item '${label}': qty minimal 1.`, 400);
    if (!(unit >= 0)) throw err("ITEM_INVALID", `Item '${label}': harga minimal 0.`, 400);
    const lineTotal = qty * unit;
    amount += lineTotal;
    return { label, qty, unitPrice: unit, lineTotal };
  });
  const tax = Math.round(amount * taxRate);
  return { lines, amount, tax, total: amount + tax, taxRate };
}

// ---------- nomor unik ----------

export async function nextInvoiceNumber(db, when = new Date()) {
  const row = await db.prepare("SELECT MAX(id) AS maxId FROM invoices").first();
  let seq = (row && row.maxId ? Number(row.maxId) : 0) + 1;
  for (let i = 0; i < 25; i++) {
    const candidate = formatInvoiceNumber(when, seq);
    const hit = await db.prepare("SELECT id FROM invoices WHERE number = ?").bind(candidate).first();
    if (!hit) return candidate;
    seq++;
  }
  // Fallback praktis anti-tabrakan (tetap unik via constraint UNIQUE).
  return formatInvoiceNumber(when, `${seq}${Math.floor(Math.random() * 90 + 10)}`);
}

// ---------- baca ----------

const INVOICE_COLS =
  "id, number, user_id, order_id, service_id, amount_idr, tax_idr, total_idr, " +
  "status, billing_period, issued_at, due_at, paid_at, notes";

export async function getInvoice(db, id) {
  const inv = await db
    .prepare(`SELECT ${INVOICE_COLS} FROM invoices WHERE id = ?`)
    .bind(Number(id))
    .first();
  if (!inv) return null;
  const items = await db
    .prepare("SELECT id, label, qty, unit_price_idr, line_total_idr FROM invoice_items WHERE invoice_id = ? ORDER BY id")
    .bind(inv.id)
    .all();
  const history = await historyForInvoice(db, inv.id);
  return { ...inv, items: items.results || [], history };
}

export async function listInvoices(db, { userId = null, status = null, limit = 50, offset = 0 } = {}) {
  limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  offset = Math.max(Number(offset) || 0, 0);
  const conds = [];
  const args = [];
  if (userId != null) {
    conds.push("user_id = ?");
    args.push(Number(userId));
  }
  if (status != null) {
    if (!INVOICE_STATUS.includes(status)) throw err("STATUS_INVALID", `Status '${status}' tidak dikenal.`, 400);
    conds.push("status = ?");
    args.push(status);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = await db
    .prepare(`SELECT ${INVOICE_COLS} FROM invoices ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...args, limit, offset)
    .all();
  return rows.results || [];
}

// ---------- tulis ----------

async function audit(db, { actorUserId = null, action, invoiceId, meta = {}, ip = "" }) {
  await db
    .prepare("INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, meta_json, ip) VALUES (?,?,?,?,?,?)")
    .bind(actorUserId, action, "invoice", String(invoiceId), JSON.stringify(meta), ip || "")
    .run();
}

export async function createInvoice(
  db,
  {
    userId,
    orderId = null,
    serviceId = null,
    items,
    billingPeriod = "once",
    taxRate = TAX_RATE_DEFAULT,
    dueDays = null,
    notes = "",
    issuedAt = null,
    actorUserId = null,
    ip = "",
  } = {}
) {
  if (!Number.isInteger(Number(userId))) throw err("USER_INVALID", "userId wajib integer.", 400);
  if (!["once", "monthly", "yearly"].includes(billingPeriod)) {
    throw err("PERIODE_INVALID", "billingPeriod harus once/monthly/yearly.", 400);
  }
  const t = computeTotals(items, taxRate);
  const issued = issuedAt ? new Date(issuedAt) : new Date();
  if (Number.isNaN(issued.getTime())) throw err("TANGGAL_INVALID", "issuedAt tidak valid.", 400);
  const dd = dueDays != null ? Number(dueDays) : (DUE_DAYS_DEFAULT[billingPeriod] ?? 7);
  if (!(dd >= 0 && dd <= 365)) throw err("JATUH_TEMPO_INVALID", "dueDays harus 0..365.", 400);
  const due = new Date(issued.getTime() + dd * 86400000);
  const number = await nextInvoiceNumber(db, issued);

  const r = await db
    .prepare(
      "INSERT INTO invoices (number, user_id, order_id, service_id, amount_idr, tax_idr, total_idr, status, billing_period, issued_at, due_at, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    )
    .bind(
      number,
      Number(userId),
      orderId != null ? Number(orderId) : null,
      serviceId != null ? Number(serviceId) : null,
      t.amount,
      t.tax,
      t.total,
      "unpaid",
      billingPeriod,
      issued.toISOString(),
      due.toISOString(),
      String(notes || "")
    )
    .run();
  const id = r.meta && r.meta.last_row_id;
  for (const ln of t.lines) {
    await db
      .prepare("INSERT INTO invoice_items (invoice_id, label, qty, unit_price_idr, line_total_idr) VALUES (?,?,?,?,?)")
      .bind(id, ln.label, ln.qty, ln.unitPrice, ln.lineTotal)
      .run();
  }
  await audit(db, {
    actorUserId,
    action: "invoice.created",
    invoiceId: id,
    meta: { number, amount: t.amount, tax: t.tax, total: t.total, billingPeriod },
    ip,
  });
  return getInvoice(db, id);
}

// Terbitkan invoice dari satu order (sumber utama: order / langganan).
// Menarik nama + harga + periode dari products via JOIN.
export async function issueFromOrder(db, orderId, opts = {}) {
  const row = await db
    .prepare(
      "SELECT o.id AS order_id, o.user_id AS user_id, o.qty AS qty, o.status AS order_status, " +
        "p.name AS product_name, p.price_idr AS product_price, p.billing_period AS product_period " +
        "FROM orders o JOIN products p ON p.id = o.product_id WHERE o.id = ?"
    )
    .bind(Number(orderId))
    .first();
  if (!row) throw err("ORDER_TIDAK_DITEMUKAN", `Order #${orderId} tidak ditemukan.`, 404);

  // Tautkan layanan bila order sudah punya service (hasil approve admin, T7).
  let serviceId = null;
  try {
    const svc = await db
      .prepare("SELECT id FROM services WHERE order_id = ? ORDER BY id DESC")
      .bind(Number(orderId))
      .first();
    if (svc) serviceId = svc.id;
  } catch {
    serviceId = null; // tabel services belum ada di lingkungan sangat lama — abaikan
  }

  return createInvoice(db, {
    userId: row.user_id,
    orderId: row.order_id,
    serviceId,
    items: [{ label: row.product_name, qty: row.qty, unitPrice: row.product_price }],
    billingPeriod: row.product_period || "once",
    notes: opts.notes != null ? String(opts.notes) : `Order #${row.order_id} — ${row.product_name}`,
    dueDays: opts.dueDays ?? null,
    taxRate: opts.taxRate ?? TAX_RATE_DEFAULT,
    issuedAt: opts.issuedAt ?? null,
    actorUserId: opts.actorUserId ?? null,
    ip: opts.ip || "",
  });
}

export async function setInvoiceStatus(db, id, to, { actorUserId = null, ip = "", meta = {} } = {}, nowIso = null) {
  const inv = await db
    .prepare(`SELECT ${INVOICE_COLS} FROM invoices WHERE id = ?`)
    .bind(Number(id))
    .first();
  if (!inv) throw err("INVOICE_TIDAK_DITEMUKAN", `Invoice #${id} tidak ditemukan.`, 404);
  assertTransition(inv.status, to);
  const now = nowIso || new Date().toISOString();
  await db
    .prepare("UPDATE invoices SET status = ?, paid_at = ?, updated_at = ? WHERE id = ?")
    .bind(to, to === "paid" ? now : inv.paid_at, now, inv.id)
    .run();
  await audit(db, { actorUserId, action: `invoice.${to}`, invoiceId: inv.id, meta, ip });
  return getInvoice(db, inv.id);
}

export const markInvoicePaid = (db, id, opts = {}, nowIso = null) =>
  setInvoiceStatus(db, id, "paid", opts, nowIso);

export const cancelInvoice = (db, id, opts = {}, nowIso = null) =>
  setInvoiceStatus(db, id, "cancelled", opts, nowIso);

// Dipakai cron harian (T8): unpaid yang lewat jatuh tempo -> overdue. Idempotent.
export async function sweepOverdue(db, nowIso = null) {
  const now = nowIso || new Date().toISOString();
  const r = await db
    .prepare("UPDATE invoices SET status = 'overdue', updated_at = ? WHERE status = 'unpaid' AND due_at < ?")
    .bind(now, now)
    .run();
  const changed = (r.meta && r.meta.changes) || 0;
  if (changed > 0) {
    await audit(db, {
      action: "invoice.sweep_overdue",
      invoiceId: 0,
      meta: { changed, at: now },
    });
  }
  return changed;
}

// Riwayat satu invoice (jejak audit: terbit, bayar, batal, dsb).
export async function historyForInvoice(db, invoiceId, limit = 50) {
  const rows = await db
    .prepare("SELECT id, actor_user_id, action, entity_id, meta_json, ip, created_at FROM audit_logs WHERE entity = 'invoice' AND entity_id = ? ORDER BY id DESC LIMIT ?")
    .bind(String(invoiceId), Math.min(Math.max(Number(limit) || 50, 1), 200))
    .all();
  return rows.results || [];
}

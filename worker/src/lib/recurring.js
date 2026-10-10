// T8 — Cron harian invoice berulang + reminder + audit (WS5+WS3).
//
// Dipakai oleh: scheduled handler (worker/src/index.js, trigger `0 1 * * *`
// di wrangler.toml), endpoint admin POST /api/invoices/cron-run
// (dry-run default, untuk verifikasi manual + QA T9).
// Men-reuse engine T5 (worker/src/lib/invoices.js): createInvoice via
// issueFromOrder + sweepOverdue — JANGAN duplikat logika total/pajak/nomor.
//
// Kebijakan (hemat query untuk free-tier, 1x/hari):
//  - Sumber langganan = invoice LUNAS (paid) berperiode monthly/yearly yang
//    tertaut order. Invoice once / manual tanpa order TIDAK diperpanjang.
//  - Perpanjangan jatuh tempo saat: now >= issued_at invoice lunas TERAKHIR
//    per order + 1 periode kalender (monthly +1 bulan, yearly +1 tahun).
//  - Anti-duplikat: satu order hanya diterbitkan bila TIDAK ada invoice
//    unpaid/overdue terbuka untuk order itu (1 query DISTINCT sekaligus).
//    Lolos kompetisi ganda via constraint UNIQUE invoices.number.
//  - Order berstatus cancelled tidak diperpanjang.
//  - Reminder = invoice unpaid/overdue dengan due_at <= now+3 hari.
//    Audit `invoice.reminder` ditulis sekali per invoice per hari (UTC).
//  - dryRun:true TIDAK menulis apa pun — murni rencana + log.
//
// Konvensi: uang INTEGER rupiah, waktu TEXT ISO-8601 UTC (ikut T2/T5).

import { issueFromOrder, sweepOverdue, computeTotals, TAX_RATE_DEFAULT } from "./invoices.js";

export const CRON_SCHEDULE = "0 1 * * *"; // cerminan wrangler.toml [triggers]
export const REMINDER_HORIZON_DAYS = 3;
export const RUN_LIMIT = 200; // batas kandidat & reminder per jalan (free-tier)

// ---------- periode kalender ----------

// +1 bulan / +1 tahun kalender (UTC) dari tanggal terbit.
export function addPeriod(iso, billingPeriod) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (billingPeriod === "yearly") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

export function nextDueFromIssued(issuedAt, billingPeriod) {
  const d = addPeriod(issuedAt, billingPeriod);
  return d ? d.toISOString() : null;
}

// ---------- baca ----------

// Invoice lunas berlangganan (sumber perpanjangan), digrup per order,
// hanya yang terbaru per order. 1 query + 1 query DISTINCT anti-duplikat.
export async function findRenewalCandidates(db, now = new Date()) {
  const nowIso = now instanceof Date ? now.toISOString() : String(now);
  const rows = await db
    .prepare(
      "SELECT i.id, i.number, i.order_id, i.service_id, i.user_id, " +
        "i.billing_period, i.issued_at, " +
        "o.status AS order_status, o.qty AS order_qty, " +
        "p.name AS product_name, p.price_idr AS product_price " +
        "FROM invoices i LEFT JOIN orders o ON o.id = i.order_id " +
        "LEFT JOIN products p ON p.id = o.product_id " +
        "WHERE i.billing_period IN ('monthly','yearly') " +
        "AND i.status = 'paid' AND i.order_id IS NOT NULL " +
        "ORDER BY i.id LIMIT ?"
    )
    .bind(RUN_LIMIT)
    .all();
  const paid = rows.results || [];

  // Order yang masih punya invoice terbuka -> jangan terbitkan lagi.
  const open = await db
    .prepare(
      "SELECT DISTINCT order_id FROM invoices " +
        "WHERE status IN ('unpaid','overdue') AND order_id IS NOT NULL"
    )
    .all();
  const openOrders = new Set((open.results || []).map((r) => Number(r.order_id)));

  // Terbaru per order.
  const latest = new Map();
  for (const r of paid) {
    const key = Number(r.order_id);
    if (!latest.has(key) || Number(r.id) > Number(latest.get(key).id)) latest.set(key, r);
  }

  const due = [];
  const skipped = [];
  for (const r of latest.values()) {
    const orderId = Number(r.order_id);
    if (openOrders.has(orderId)) {
      skipped.push({ orderId, reason: "invoice_terbuka_masih_ada" });
      continue;
    }
    if (r.order_status === "cancelled") {
      skipped.push({ orderId, reason: "order_dibatalkan" });
      continue;
    }
    const nextDue = nextDueFromIssued(r.issued_at, r.billing_period);
    if (!nextDue) {
      skipped.push({ orderId, reason: "tanggal_terbit_tidak_valid" });
      continue;
    }
    if (nextDue > nowIso) continue; // periode berjalan, belum jatuh tempo
    let estimate = null;
    try {
      const t = computeTotals(
        [{ label: r.product_name || "Langganan", qty: Math.max(Number(r.order_qty) || 1, 1), unitPrice: Number(r.product_price) || 0 }],
        TAX_RATE_DEFAULT
      );
      estimate = { amount: t.amount, tax: t.tax, total: t.total };
    } catch {
      estimate = null;
    }
    due.push({
      orderId,
      serviceId: r.service_id,
      userId: r.user_id,
      billingPeriod: r.billing_period,
      prevInvoiceId: r.id,
      prevNumber: r.number,
      prevIssuedAt: r.issued_at,
      nextDue,
      product: r.product_name || null,
      estimate,
    });
  }
  due.sort((a, b) => a.orderId - b.orderId);
  return { due, skipped };
}

// Invoice yang perlu diingatkan: belum lunas & jatuh tempo <= now+3 hari.
export async function findReminders(db, now = new Date(), horizonDays = REMINDER_HORIZON_DAYS) {
  const base = now instanceof Date ? now : new Date(now);
  const horizon = new Date(base.getTime() + horizonDays * 86400000).toISOString();
  const nowIso = base.toISOString();
  const rows = await db
    .prepare(
      "SELECT id, number, user_id, total_idr, status, due_at FROM invoices " +
        "WHERE status IN ('unpaid','overdue') AND due_at <= ? ORDER BY due_at LIMIT ?"
    )
    .bind(horizon, RUN_LIMIT)
    .all();
  return (rows.results || []).map((r) => ({
    invoiceId: r.id,
    number: r.number,
    userId: r.user_id,
    total: r.total_idr,
    status: r.status,
    dueAt: r.due_at,
    kind: r.status === "overdue" || String(r.due_at) < nowIso ? "overdue" : "due_soon",
  }));
}

// entity_id invoice yang sudah di-reminder hari ini (UTC) — anti spam audit.
export async function remindedToday(db, dayStartIso) {
  const rows = await db
    .prepare("SELECT entity_id FROM audit_logs WHERE action = 'invoice.reminder' AND created_at >= ?")
    .bind(dayStartIso)
    .all();
  return new Set((rows.results || []).map((r) => String(r.entity_id)));
}

// Hitung yang AKAN di-sweep tanpa menulis (untuk dry-run).
export async function countWouldSweep(db, nowIso) {
  const rows = await db
    .prepare("SELECT id FROM invoices WHERE status = 'unpaid' AND due_at < ? LIMIT ?")
    .bind(nowIso, RUN_LIMIT)
    .all();
  return (rows.results || []).length;
}

async function audit(db, { actorUserId = null, action, invoiceId, meta = {}, ip = "cron" }) {
  await db
    .prepare("INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, meta_json, ip) VALUES (?,?,?,?,?,?)")
    .bind(actorUserId, action, "invoice", String(invoiceId), JSON.stringify(meta), ip || "cron")
    .run();
}

// ---------- jalan utama ----------

// Satu jalan cron: sweep overdue -> terbitkan perpanjangan -> reminder.
// dryRun:true -> tanpa tulis, kembalikan rencana. Selalu kembalikan ringkasan
// terstruktur (dipakai sebagai "dry-run log" oleh endpoint + wrangler logs).
export async function runRecurringCron(db, { now = new Date(), dryRun = false, cron = CRON_SCHEDULE, ip = "cron" } = {}) {
  if (!db) return { ok: false, error: "db_missing" };
  const at = now instanceof Date ? now : new Date(now);
  const atIso = at.toISOString();
  const dayStart = atIso.slice(0, 10) + "T00:00:00.000Z";

  // 1. Tandai overdue.
  const swept = dryRun ? await countWouldSweep(db, atIso) : await sweepOverdue(db, atIso);

  // 2. Perpanjangan langganan jatuh tempo.
  const { due, skipped } = await findRenewalCandidates(db, at);
  const issued = [];
  const failed = [...skipped];
  if (dryRun) {
    for (const c of due) issued.push({ ...c, planned: true });
  } else {
    for (const c of due) {
      try {
        const inv = await issueFromOrder(db, c.orderId, {
          issuedAt: atIso,
          actorUserId: null, // sistem/cron
          ip,
          notes: `Perpanjangan otomatis ${c.prevNumber} — cron ${atIso.slice(0, 10)}`,
        });
        issued.push({ orderId: c.orderId, invoiceId: inv.id, number: inv.number, total: inv.total_idr, billingPeriod: inv.billing_period });
      } catch (e) {
        failed.push({ orderId: c.orderId, reason: String((e && e.code) || "gagal_terbit").slice(0, 80) });
      }
    }
  }

  // 3. Reminder + audit (sekali per invoice per hari).
  const reminders = await findReminders(db, at);
  let reminded = [];
  if (dryRun) {
    reminded = reminders.map((r) => ({ ...r, planned: true }));
  } else {
    const done = await remindedToday(db, dayStart);
    for (const r of reminders) {
      if (done.has(String(r.invoiceId))) continue;
      await audit(db, {
        action: "invoice.reminder",
        invoiceId: r.invoiceId,
        meta: { number: r.number, status: r.status, due_at: r.dueAt, total: r.total, kind: r.kind, date: atIso.slice(0, 10) },
        ip,
      });
      reminded.push(r);
    }
    // 4. Ringkasan jalan (jejak audit; hanya jalan asli, bukan dry-run).
    await audit(db, {
      action: "invoice.cron_run",
      invoiceId: 0,
      meta: {
        at: atIso,
        cron,
        swept,
        issued: issued.map((x) => x.number),
        issuedCount: issued.length,
        reminders: reminded.length,
        skipped: failed.length,
      },
      ip,
    });
  }

  const summary =
    `cron ${dryRun ? "dry-run" : "jalan"} ${atIso}: ` +
    `perpanjangan=${issued.length} overdue=${swept} reminder=${reminded.length} skip=${failed.length}`;
  console.log(`[cron] ${summary}`);
  if (dryRun && issued.length > 0) {
    for (const c of issued.slice(0, 10)) {
      console.log(`[cron] rencana: order #${c.orderId} (${c.product || c.billingPeriod}) -> estimasi Rp${(c.estimate && c.estimate.total) || 0}`);
    }
  }

  return {
    ok: true,
    at: atIso,
    cron,
    dryRun,
    swept,
    issued,
    skipped: failed,
    reminders,
    remindedCount: reminded.length,
    summary,
  };
}

// T5 — Route /api/invoices (WS3): list, terbit, detail, bayar/batal manual,
// halaman cetak/PDF, sweep overdue.
//
// Auth: session cookie DB + RBAC milik T3 (lib/auth.js) — tidak ada shim.
//   client: hanya invoice miliknya (list/detail/print/cancel, terbit dari order miliknya)
//   admin : semua (terbit manual, tandai lunas, sweep overdue)
// T6 memakai markInvoicePaid() dari lib/invoices.js langsung (bukan HTTP).
// T8 memakai sweepOverdue() + createInvoice() langsung dari cron.

import { json } from "../index.js";
import { getSessionUser, clientIp } from "../lib/auth.js";
import {
  listInvoices,
  getInvoice,
  createInvoice,
  issueFromOrder,
  markInvoicePaid,
  cancelInvoice,
  sweepOverdue,
  formatIDR,
  formatTanggal,
  err,
} from "../lib/invoices.js";
import { runRecurringCron } from "../lib/recurring.js";

async function needLogin(request, env) {
  const caller = await getSessionUser(request, env);
  if (!caller) throw err("login_dulu", "Login dulu untuk akses invoice.", 401);
  return caller;
}

async function needAdmin(request, env) {
  const caller = await needLogin(request, env);
  if (caller.role !== "admin") throw err("admin_saja", "Hanya admin.", 403);
  return caller;
}

function needOwnerOrAdmin(caller, ownerUserId) {
  if (caller.role === "admin") return;
  if (Number(caller.id) !== Number(ownerUserId)) {
    throw err("bukan_milik_anda", "Invoice ini milik user lain.", 403);
  }
}

// ---------- HTML cetak (cetak rapi + Simpan-sebagai-PDF via window.print) ----------

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STATUS_LABEL = { unpaid: "Belum Bayar", paid: "Lunas", overdue: "Jatuh Tempo", cancelled: "Dibatalkan" };
const STATUS_COLOR = { unpaid: "#92400e", paid: "#065f46", overdue: "#b91c1c", cancelled: "#6b7280" };

export function renderInvoiceHTML(inv, { appName = "Portal Pembayaran QRIS", billedTo = null } = {}) {
  const items = (inv.items || [])
    .map(
      (it, i) =>
        `<tr><td>${i + 1}</td><td>${esc(it.label)}</td><td class="r">${it.qty}</td>` +
        `<td class="r">${formatIDR(it.unit_price_idr)}</td><td class="r">${formatIDR(it.line_total_idr)}</td></tr>`
    )
    .join("");
  const color = STATUS_COLOR[inv.status] || "#111827";
  const who = billedTo ? `${esc(billedTo.name || "")} &lt;${esc(billedTo.email || "")}&gt;` : `User #${inv.user_id}`;
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Invoice ${esc(inv.number)}</title>
<style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#111827}
body{margin:0;background:#f3f4f6}.sheet{max-width:720px;margin:24px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px}
.kop{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:3px solid #111827;padding-bottom:12px;margin-bottom:16px}
.kop h1{font-size:20px;margin:0}.badge{display:inline-block;padding:4px 12px;border-radius:999px;color:#fff;font-size:13px;background:${color}}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:14px;margin:12px 0}
table{width:100%;border-collapse:collapse;font-size:14px;margin-top:8px}
th,td{border:1px solid #e5e7eb;padding:8px 10px;text-align:left}
th{background:#f9fafb}td.r,th.r{text-align:right}
.total{margin-left:auto;width:260px;margin-top:12px;font-size:14px}
.total div{display:flex;justify-content:space-between;padding:3px 0}
.total .grand{font-weight:700;font-size:17px;border-top:2px solid #111827;margin-top:6px;padding-top:8px}
.notes{font-size:13px;color:#4b5563;margin-top:14px}.toolbar{display:flex;gap:8px;margin-bottom:16px}
button{background:#111827;color:#fff;border:0;border-radius:8px;padding:9px 16px;cursor:pointer;font-size:14px}
.hint{font-size:12px;color:#6b7280}
@media print{body{background:#fff}.sheet{border:0;margin:0;max-width:none;border-radius:0}.toolbar,.hint{display:none}}
</style></head><body><div class="sheet">
<div class="toolbar"><button onclick="window.print()">Cetak / Simpan PDF</button></div>
<p class="hint">Untuk PDF: klik tombol lalu pilih tujuan "Save as PDF / Simpan sebagai PDF".</p>
<div class="kop"><div><h1>${esc(appName)}</h1><div>Invoice ${esc(inv.number)}</div></div>
<div><span class="badge">${esc(STATUS_LABEL[inv.status] || inv.status)}</span></div></div>
<div class="meta">
<div><strong>Ditagihkan ke:</strong><br />${who}</div>
<div><strong>Periode:</strong> ${esc(inv.billing_period)}<br />
<strong>Terbit:</strong> ${esc(formatTanggal(inv.issued_at))}<br />
<strong>Jatuh tempo:</strong> ${esc(formatTanggal(inv.due_at))}</div>
</div>
<table><thead><tr><th>No</th><th>Uraian</th><th class="r">Qty</th><th class="r">Harga</th><th class="r">Jumlah</th></tr></thead>
<tbody>${items}</tbody></table>
<div class="total"><div><span>Subtotal</span><span>${formatIDR(inv.amount_idr)}</span></div>
<div><span>Pajak (PPN)</span><span>${formatIDR(inv.tax_idr)}</span></div>
<div class="grand"><span>Total</span><span>${formatIDR(inv.total_idr)}</span></div></div>
${inv.notes ? `<p class="notes">Catatan: ${esc(inv.notes)}</p>` : ""}
${inv.paid_at ? `<p class="notes">Dibayar: ${esc(formatTanggal(inv.paid_at))}</p>` : ""}
</div></body></html>`;
}

// ---------- handler ----------

export async function handleInvoices(request, env) {
  const url = new URL(request.url);
  const seg = url.pathname.split("/").filter(Boolean); // ["api","invoices", ...]
  const db = env.DB;
  if (!db) return json({ ok: false, error: "db_missing", message: "Binding D1 belum dikonfigurasi." }, 500);
  const method = request.method;
  const ip = clientIp(request);

  try {
    // POST /api/invoices/sweep — tandai overdue (dipakai T8; manual: admin)
    if (seg.length === 3 && seg[2] === "sweep" && method === "POST") {
      const admin = await needAdmin(request, env);
      void admin;
      const changed = await sweepOverdue(db);
      return json({ ok: true, overdue: changed });
    }

    // POST /api/invoices/cron-run — jalan cron manual (admin saja; T8, QA T9).
    //   ?dryRun=1 (default) -> rencana saja, TANPA tulis (sesuai acceptance:
    //   "dry-run log benar"). ?dryRun=0 -> jalan asli: terbitkan invoice
    //   perpanjangan + sweep + reminder + audit (sama seperti scheduled).
    if (seg.length === 3 && seg[2] === "cron-run" && method === "POST") {
      const admin = await needAdmin(request, env);
      const dry = url.searchParams.get("dryRun");
      const dryRun = dry == null || !["0", "false", "no"].includes(String(dry).toLowerCase());
      const r = await runRecurringCron(db, { dryRun, ip: clientIp(request) || "admin-cron-run" });
      return json(
        {
          ok: true,
          at: r.at,
          cron: r.cron,
          dryRun: r.dryRun,
          swept: r.swept,
          issued: r.issued,
          skipped: r.skipped,
          reminders: r.reminders,
          remindedCount: r.remindedCount,
          summary: r.summary,
        },
        200
      );
    }

    // GET /api/invoices — riwayat/daftar (client: miliknya; admin: semua/filter userId)
    if (seg.length === 2 && method === "GET") {
      const caller = await needLogin(request, env);
      const status = url.searchParams.get("status");
      const limit = url.searchParams.get("limit") || 50;
      const offset = url.searchParams.get("offset") || 0;
      let forUser = caller.id;
      if (caller.role === "admin") {
        const q = url.searchParams.get("userId");
        forUser = q != null && q !== "" ? Number(q) : null;
      }
      const rows = await listInvoices(db, {
        userId: forUser != null ? Number(forUser) : null,
        status: status || null,
        limit,
        offset,
      });
      return json({ ok: true, invoices: rows });
    }

    // POST /api/invoices — terbitkan invoice
    //   { orderId }              client atas order miliknya / admin atas order apa pun
    //   { userId, items[], ... } admin saja (invoice manual)
    if (seg.length === 2 && method === "POST") {
      const caller = await needLogin(request, env);
      let body = {};
      try {
        body = await request.json();
      } catch {
        throw err("body_invalid", "Body harus JSON.", 400);
      }
      if (body.orderId != null) {
        const owner = await db.prepare("SELECT user_id FROM orders WHERE id = ?").bind(Number(body.orderId)).first();
        if (!owner) throw err("order_tidak_ditemukan", `Order #${body.orderId} tidak ditemukan.`, 404);
        needOwnerOrAdmin(caller, owner.user_id);
        const inv = await issueFromOrder(db, body.orderId, {
          notes: body.notes,
          dueDays: body.dueDays,
          taxRate: body.taxRate,
          actorUserId: caller.id,
          ip,
        });
        return json({ ok: true, invoice: inv }, 201);
      }
      if (caller.role !== "admin") throw err("admin_saja", "Invoice manual hanya oleh admin.", 403);
      const inv = await createInvoice(db, {
        userId: Number(body.userId),
        orderId: body.orderId ?? null,
        serviceId: body.serviceId ?? null,
        items: body.items,
        billingPeriod: body.billingPeriod || "once",
        taxRate: body.taxRate,
        dueDays: body.dueDays,
        notes: body.notes || "",
        actorUserId: caller.id,
        ip,
      });
      return json({ ok: true, invoice: inv }, 201);
    }

    // Rute ber-ID: /api/invoices/:id[/print] , POST :id/pay , :id/cancel
    if (seg.length >= 3) {
      const id = Number(seg[2]);
      if (!Number.isInteger(id) || id < 1) throw err("id_invalid", "ID invoice tidak valid.", 400);

      // GET /api/invoices/:id/print — halaman cetak/PDF (pemilik atau admin)
      if (seg.length === 4 && seg[3] === "print" && method === "GET") {
        const caller = await needLogin(request, env);
        const inv = await getInvoice(db, id);
        if (!inv) throw err("invoice_tidak_ditemukan", `Invoice #${id} tidak ditemukan.`, 404);
        needOwnerOrAdmin(caller, inv.user_id);
        let billedTo = null;
        try {
          billedTo = await db.prepare("SELECT name, email FROM users WHERE id = ?").bind(inv.user_id).first();
        } catch {
          billedTo = null;
        }
        return new Response(renderInvoiceHTML(inv, { appName: env.APP_NAME, billedTo }), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      // POST /api/invoices/:id/pay — tandai lunas manual (admin; T6 webhook via lib)
      if (seg.length === 4 && seg[3] === "pay" && method === "POST") {
        const admin = await needAdmin(request, env);
        const inv = await markInvoicePaid(db, id, { actorUserId: admin.id, ip });
        return json({ ok: true, invoice: inv });
      }

      // POST /api/invoices/:id/cancel — batalkan (pemilik atau admin)
      if (seg.length === 4 && seg[3] === "cancel" && method === "POST") {
        const caller = await needLogin(request, env);
        const inv0 = await getInvoice(db, id);
        if (!inv0) throw err("invoice_tidak_ditemukan", `Invoice #${id} tidak ditemukan.`, 404);
        needOwnerOrAdmin(caller, inv0.user_id);
        const inv = await cancelInvoice(db, id, { actorUserId: caller.id, ip });
        return json({ ok: true, invoice: inv });
      }

      // GET /api/invoices/:id — detail + items + riwayat (pemilik atau admin)
      if (seg.length === 3 && method === "GET") {
        const caller = await needLogin(request, env);
        const inv = await getInvoice(db, id);
        if (!inv) throw err("invoice_tidak_ditemukan", `Invoice #${id} tidak ditemukan.`, 404);
        needOwnerOrAdmin(caller, inv.user_id);
        return json({ ok: true, invoice: inv });
      }
    }

    return json({ ok: false, error: "not_found" }, 404);
  } catch (e) {
    const status = Number(e.status) || 500;
    return json({ ok: false, error: e.code || "internal_error", message: String(e.message || e).slice(0, 300) }, status);
  }
}

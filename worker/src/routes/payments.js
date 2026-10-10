// T6 — Route pembayaran QRIS + webhook (WS3).
//
// Auth: session cookie DB + RBAC milik T3/T5 (tidak ada shim).
//   POST /api/payments {invoiceId}  buat/ambil QR bayar (client: miliknya; admin: apa pun)
//   GET  /api/payments/:ref         cek status bayar (pemilik invoice atau admin)
//   POST /api/webhooks/xendit       callback Xendit (x-callback-token) — publik
//   POST /api/webhooks/midtrans     notifikasi Midtrans (signature SHA-512) — publik
//   POST /api/webhooks/simulated    webhook sandbox lokal (X-Webhook-Secret) — publik
//   POST /api/payments/simulate     simulasi bayar sandbox (login wajib; TANPA secret,
//                                    hanya bila QRIS_PROVIDER=simulated — dipakai
//                                    halaman bayar dev + test E2E)
//
// Webhook selalu jawab 200 {ok:true} untuk event yang dikenali — termasuk replay
// (duplicate:true) — supaya provider berhenti retry. 4xx hanya untuk signature
// salah, ref tak dikenal, atau nominal tak cocok.

import { json } from "../index.js";
import { getSessionUser, clientIp } from "../lib/auth.js";
import { getInvoice, err } from "../lib/invoices.js";
import {
  resolveProvider,
  createCharge,
  verifyXendit,
  verifyMidtrans,
  verifySimulated,
  normalizeXendit,
  normalizeMidtrans,
  normalizeSimulated,
  settlePayment,
  latestPaymentForInvoice,
  publicPayment,
} from "../lib/payments.js";

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function needLogin(request, env) {
  const caller = await getSessionUser(request, env);
  if (!caller) throw err("login_dulu", "Login dulu untuk akses pembayaran.", 401);
  return caller;
}

function needOwnerOrAdmin(caller, ownerUserId) {
  if (caller.role === "admin") return;
  if (Number(caller.id) !== Number(ownerUserId)) {
    throw err("bukan_milik_anda", "Payment ini milik user lain.", 403);
  }
}

// ---------- halaman bayar (QR + countdown + cek status) ----------

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderPayHTML({ appName = "Portal Pembayaran QRIS", invoice, payment, provider }) {
  const rupiah = "Rp" + Number(invoice.total_idr || 0).toLocaleString("id-ID");
  const isSim = provider === "simulated";
  const payload = esc(payment.qr_payload || "");
  const qrUrl = payment.qr_url || "";
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Bayar ${esc(invoice.number)} — ${esc(appName)}</title>
<style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#111827}
body{margin:0;background:#f3f4f6}.sheet{max-width:560px;margin:24px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;text-align:center}
h1{font-size:19px;margin:0 0 4px}.num{color:#4b5563;font-size:14px;margin-bottom:8px}
.total{font-size:30px;font-weight:800;margin:10px 0}
.timer{font-size:15px;font-weight:700;color:#92400e}
.timer.lunas{color:#065f46}.timer.kadaluarsa{color:#b91c1c}
#qr{width:240px;height:240px;margin:14px auto;border:1px solid #e5e7eb;border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden}
#qr img,#qr canvas{max-width:100%;max-height:100%}
code.payload{display:block;font-size:11px;word-break:break-all;background:#f9fafb;border:1px dashed #d1d5db;border-radius:8px;padding:8px;margin:10px 0;color:#374151}
.row{display:flex;gap:8px;justify-content:center;margin-top:12px}
button{background:#111827;color:#fff;border:0;border-radius:8px;padding:10px 18px;cursor:pointer;font-size:14px}
.hint{font-size:12px;color:#6b7280;margin-top:10px}
.badge{display:inline-block;padding:4px 12px;border-radius:999px;color:#fff;font-size:13px;background:#92400e}
</style></head><body><div class="sheet">
<h1>Bayar via QRIS</h1>
<div class="num">Invoice ${esc(invoice.number)} · via ${esc(provider)}</div>
<div class="total">${rupiah}</div>
<div><span class="badge" id="statusBadge">Menunggu pembayaran</span></div>
<div class="timer" id="timer">Memuat…</div>
<div id="qr"><span class="hint">Memuat QR…</span></div>
${payload ? `<code class="payload" title="Payload QRIS">${payload}</code>` : ""}
<div class="row">
<button id="cekBtn" type="button">Cek Status</button>
${isSim ? `<button id="simBtn" type="button">Simulasi Bayar (sandbox)</button>` : ""}
</div>
<p class="hint">Pindai QR dengan aplikasi apa pun (DANA/OVO/GoPay/m-banking). Halaman mengecek otomatis tiap 5 detik; QR kedaluwarsa 30 menit.</p>
<p class="hint"><a href="/invoices/">← Kembali ke Invoice</a></p>
</div>
<script src="/vendor-qrcode.min.js"></script>
<script>
(function(){
var ref = ${JSON.stringify(payment.provider_ref)};
var exp = ${JSON.stringify(payment.expires_at)};
var stEl = document.getElementById("statusBadge");
var tmEl = document.getElementById("timer");
var cek = document.getElementById("cekBtn");
var sim = document.getElementById("simBtn");
var done = false;

function sisa(){
  var s = Math.max(0, Math.floor((new Date(exp).getTime() - Date.now())/1000));
  var m = Math.floor(s/60), d = s%60;
  return ("0"+m).slice(-2)+":"+("0"+d).slice(-2);
}
function tick(){
  if (done) return;
  tmEl.textContent = "Berakhir dalam " + sisa();
  if (sisa() === "00:00") { tmEl.textContent = "QR kedaluwarsa — buat pembayaran baru."; tmEl.className = "timer kadaluarsa"; }
}
async function cekStatus(silent){
  try {
    var r = await fetch("/api/payments/" + encodeURIComponent(ref));
    var j = await r.json();
    var st = j.ok && j.payment ? j.payment.status : "?";
    if (st === "paid") {
      done = true; stEl.textContent = "Lunas ✓"; stEl.style.background = "#065f46";
      tmEl.textContent = "Pembayaran lunas. Terima kasih!"; tmEl.className = "timer lunas";
      clearInterval(auto);
    } else if (st === "expired") {
      tmEl.textContent = "QR kedaluwarsa — buat pembayaran baru."; tmEl.className = "timer kadaluarsa";
    } else if (!silent) { stEl.textContent = "Menunggu pembayaran (" + st + ")"; }
  } catch(e){ if(!silent) tmEl.textContent = "Gagal cek status, coba lagi."; }
}
cek.addEventListener("click", function(){ cekStatus(false); });
if (sim) sim.addEventListener("click", async function(){
  sim.disabled = true;
  try {
    var r = await fetch("/api/payments/simulate", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: ref }) });
    var j = await r.json();
    if (j.ok) cekStatus(false); else { tmEl.textContent = "Simulasi gagal: " + (j.error || r.status); sim.disabled = false; }
  } catch(e){ tmEl.textContent = "Simulasi gagal: " + e.message; sim.disabled = false; }
});

// Render QR: URL provider (gambar) atau payload string (canvas lokal).
(function qr(){
  var box = document.getElementById("qr");
  var img = ${JSON.stringify(qrUrl || "")};
  var text = ${JSON.stringify(payment.qr_payload || "")};
  if (img && /^https?:/.test(img)) { box.innerHTML = ""; var im = document.createElement("img"); im.src = img; im.alt = "QRIS"; box.appendChild(im); return; }
  try {
    if (typeof qrcode === "function" && text) {
      var q = qrcode(0, "M"); q.addData(text); q.make();
      box.innerHTML = q.createImgTag(6, 8);
      return;
    }
  } catch(e){}
  box.innerHTML = ""; var p = document.createElement("p"); p.className = "hint";
  p.textContent = text || "QR tidak tersedia"; box.appendChild(p);
})();

var auto = setInterval(function(){ tick(); cekStatus(true); }, 5000);
tick(); cekStatus(true);
})();
</script>
</body></html>`;
}

// ---------- handler ----------

export async function handlePayments(request, env) {
  const url = new URL(request.url);
  const seg = url.pathname.split("/").filter(Boolean); // ["api","payments"|"webhooks", ...]
  const db = env.DB;
  if (!db) return json({ ok: false, error: "db_missing", message: "Binding D1 belum dikonfigurasi." }, 500);
  const method = request.method;
  const ip = clientIp(request);
  const provider = resolveProvider(env);

  try {
    // ===== Webhook (publik, verifikasi signature) =====

    // POST /api/webhooks/xendit
    if (seg.length === 3 && seg[1] === "webhooks" && seg[2] === "xendit" && method === "POST") {
      const v = verifyXendit(request, env);
      if (!v.ok) return json({ ok: false, error: "signature_tidak_valid" }, 401);
      const event = normalizeXendit(await readJson(request));
      const out = await settlePayment(db, event, { ip });
      return json({ ok: true, ...out });
    }

    // POST /api/webhooks/midtrans
    if (seg.length === 3 && seg[1] === "webhooks" && seg[2] === "midtrans" && method === "POST") {
      const body = await readJson(request);
      const v = await verifyMidtrans(body, env);
      if (!v.ok) return json({ ok: false, error: "signature_tidak_valid" }, 401);
      const out = await settlePayment(db, normalizeMidtrans(body), { ip });
      return json({ ok: true, ...out });
    }

    // POST /api/webhooks/simulated (sandbox lokal)
    if (seg.length === 3 && seg[1] === "webhooks" && seg[2] === "simulated" && method === "POST") {
      const v = verifySimulated(request, env);
      if (!v.ok) return json({ ok: false, error: "signature_tidak_valid" }, 401);
      const out = await settlePayment(db, normalizeSimulated(await readJson(request)), { ip });
      return json({ ok: true, ...out });
    }

    // ===== Simulasi bayar sandbox (login wajib, TANPA secret) =====
    // Hanya saat QRIS_PROVIDER=simulated. Jalur sah untuk tombol halaman
    // bayar dev + E2E lokal: bayar sandbox -> invoice paid.
    if (seg.length === 3 && seg[1] === "payments" && seg[2] === "simulate" && method === "POST") {
      if (provider !== "simulated") {
        return json({ ok: false, error: "bukan_mode_simulasi", message: "Simulasi hanya saat QRIS_PROVIDER=simulated." }, 403);
      }
      const caller = await needLogin(request, env);
      const body = await readJson(request);
      const ref = String(body.ref || body.provider_ref || "");
      if (!ref) throw err("REF_KOSONG", "Field 'ref' wajib diisi.", 400);
      const row = await db.prepare("SELECT invoice_id, user_id FROM payments WHERE provider_ref = ?").bind(ref).first();
      if (!row) throw err("PAYMENT_TIDAK_DITEMUKAN", `Payment ref '${ref}' tidak ditemukan.`, 404);
      const inv = await getInvoice(db, row.invoice_id);
      if (!inv) throw err("INVOICE_TIDAK_DITEMUKAN", "Invoice payment tidak ditemukan.", 404);
      needOwnerOrAdmin(caller, inv.user_id);
      if (!["unpaid", "overdue"].includes(inv.status)) {
        return json({ ok: true, already: true, invoice: inv });
      }
      const out = await settlePayment(db, {
        provider: "simulated",
        eventId: `sim-${ref}-${Date.now()}`,
        ref,
        status: "paid",
        amountIdr: inv.total_idr,
        raw: { simulated: true, via: "simulate-endpoint", by: caller.id },
      }, { ip });
      return json({ ok: true, ...out });
    }

    // ===== Buat/ambil QR bayar =====
    // POST /api/payments {invoiceId} — QR yang masih hidup dipakai ulang.
    if (seg.length === 2 && seg[1] === "payments" && method === "POST") {
      const caller = await needLogin(request, env);
      const body = await readJson(request);
      const invoiceId = Number(body.invoiceId || body.invoice_id);
      if (!Number.isInteger(invoiceId) || invoiceId < 1) throw err("id_invalid", "Field 'invoiceId' wajib integer.", 400);
      const inv = await getInvoice(db, invoiceId);
      if (!inv) throw err("INVOICE_TIDAK_DITEMUKAN", `Invoice #${invoiceId} tidak ditemukan.`, 404);
      needOwnerOrAdmin(caller, inv.user_id);
      if (!["unpaid", "overdue"].includes(inv.status)) {
        throw err("INVOICE_SUDAH_LUNAS", `Invoice ${inv.number} sudah ${inv.status}, tak perlu dibayar.`, 409);
      }

      // QR pending yang masih hidup -> pakai ulang (hemat charge provider).
      const existing = await latestPaymentForInvoice(db, inv.id);
      if (existing && existing.status === "pending") {
        return json({ ok: true, reused: true, payment: publicPayment(existing), invoice: inv, provider });
      }

      const charge = await createCharge({ invoice: inv, env });
      const r = await db
        .prepare(
          "INSERT INTO payments (invoice_id, user_id, provider, provider_ref, qr_payload, amount_idr, fee_idr, status, expires_at, raw_callback_json) VALUES (?,?,?,?,?,?,?,?,?,?)"
        )
        .bind(
          inv.id, inv.user_id, charge.provider, charge.ref,
          charge.qrPayload || charge.qrUrl || "", charge.amountIdr, charge.feeIdr || 0,
          "pending", charge.expiresAt, JSON.stringify({ qr_url: charge.qrUrl || "", created_via: "api/payments" })
        )
        .run();
      const pid = r.meta && r.meta.last_row_id;
      try {
        await db.prepare("INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, meta_json, ip) VALUES (?,?,?,?,?,?)")
          .bind(caller.id, "payment.created", "payment", String(pid), JSON.stringify({ ref: charge.ref, provider: charge.provider, invoice: inv.number }), ip)
          .run();
      } catch { /* audit gagal jangan batalkan charge */ }
      const row = await db.prepare("SELECT id, invoice_id, user_id, provider, provider_ref, qr_payload, amount_idr, fee_idr, status, expires_at, paid_at FROM payments WHERE id = ?").bind(pid).first();
      return json({ ok: true, reused: false, payment: { ...publicPayment(row), qr_url: charge.qrUrl || "" }, invoice: inv, provider: charge.provider }, 201);
    }

    // GET /api/payments/:ref — cek status (pemilik invoice atau admin).
    if (seg.length === 3 && seg[1] === "payments" && method === "GET") {
      const caller = await needLogin(request, env);
      const ref = decodeURIComponent(seg[2]);
      const row = await db.prepare("SELECT id, invoice_id, user_id, provider, provider_ref, qr_payload, amount_idr, fee_idr, status, expires_at, paid_at FROM payments WHERE provider_ref = ?").bind(ref).first();
      if (!row) throw err("PAYMENT_TIDAK_DITEMUKAN", `Payment ref '${ref}' tidak ditemukan.`, 404);
      const inv = await getInvoice(db, row.invoice_id);
      if (!inv) throw err("INVOICE_TIDAK_DITEMUKAN", "Invoice payment tidak ditemukan.", 404);
      needOwnerOrAdmin(caller, inv.user_id);
      // Tandai kedaluwarsa saat dibaca bila lewat masa berlaku.
      let payment = publicPayment(row);
      if (payment.status === "pending" && payment.expires_at && String(payment.expires_at) <= new Date().toISOString()) {
        await db.prepare("UPDATE payments SET status = ?, updated_at = ? WHERE id = ?").bind("expired", new Date().toISOString(), row.id).run();
        payment = { ...payment, status: "expired" };
      }
      return json({ ok: true, payment, invoice: { id: inv.id, number: inv.number, status: inv.status, total_idr: inv.total_idr } });
    }

    // GET /api/payments/by-invoice/:id — payment terbaru satu invoice (pemilik/admin).
    // Dipakai halaman bayar untuk lanjutkan QR hidup.
    if (seg.length === 4 && seg[1] === "payments" && seg[2] === "by-invoice" && method === "GET") {
      const caller = await needLogin(request, env);
      const inv = await getInvoice(db, Number(seg[3]));
      if (!inv) throw err("INVOICE_TIDAK_DITEMUKAN", "Invoice tidak ditemukan.", 404);
      needOwnerOrAdmin(caller, inv.user_id);
      const p = await latestPaymentForInvoice(db, inv.id);
      return json({ ok: true, payment: publicPayment(p), provider });
    }

    // GET /api/invoices/:id/pay — halaman bayar HTML (pemilik atau admin).
    // Membuat charge bila belum ada QR hidup, lalu render QR + countdown + cek status.
    if (seg.length === 4 && seg[1] === "invoices" && seg[3] === "pay" && method === "GET") {
      const caller = await needLogin(request, env);
      const inv = await getInvoice(db, Number(seg[2]));
      if (!inv) throw err("INVOICE_TIDAK_DITEMUKAN", "Invoice tidak ditemukan.", 404);
      needOwnerOrAdmin(caller, inv.user_id);
      if (inv.status === "paid") {
        return new Response(
          `<!doctype html><html lang="id"><head><meta charset="utf-8" /><title>Lunas — ${esc(inv.number)}</title></head>` +
          `<body style="font-family:system-ui;text-align:center;padding:48px"><h1>Lunas ✓</h1><p>Invoice ${esc(inv.number)} sudah dibayar.</p><p><a href="/invoices/">← Kembali</a></p></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }
      if (!["unpaid", "overdue"].includes(inv.status)) {
        throw err("INVOICE_TIDAK_BISA_DIBAYAR", `Invoice berstatus ${inv.status}.`, 409);
      }
      const existing = await latestPaymentForInvoice(db, inv.id);
      if (!existing || existing.status !== "pending") {
        const charge = await createCharge({ invoice: inv, env });
        const r = await db
          .prepare(
            "INSERT INTO payments (invoice_id, user_id, provider, provider_ref, qr_payload, amount_idr, fee_idr, status, expires_at, raw_callback_json) VALUES (?,?,?,?,?,?,?,?,?,?)"
          )
          .bind(
            inv.id, inv.user_id, charge.provider, charge.ref,
            charge.qrPayload || charge.qrUrl || "", charge.amountIdr, charge.feeIdr || 0,
            "pending", charge.expiresAt, JSON.stringify({ qr_url: charge.qrUrl || "", created_via: "pay-page" })
          )
          .run();
        const pid = r.meta && r.meta.last_row_id;
        try {
          await db.prepare("INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, meta_json, ip) VALUES (?,?,?,?,?,?)")
            .bind(caller.id, "payment.created", "payment", String(pid), JSON.stringify({ ref: charge.ref, provider: charge.provider, invoice: inv.number }), ip)
            .run();
        } catch { /* abaikan */ }
        const payRow = await db.prepare("SELECT id, invoice_id, user_id, provider, provider_ref, qr_payload, amount_idr, fee_idr, status, expires_at, paid_at FROM payments WHERE id = ?").bind(pid).first();
        let qrUrl = charge.qrUrl || "";
        const stored = await db.prepare("SELECT raw_callback_json FROM payments WHERE id = ?").bind(pid).first();
        try { qrUrl = (stored && JSON.parse(stored.raw_callback_json || "{}").qr_url) || qrUrl; } catch { /* abaikan */ }
        const payment = { ...publicPayment(payRow), qr_url: qrUrl };
        return new Response(renderPayHTML({ appName: env.APP_NAME, invoice: inv, payment, provider: charge.provider }), {
          status: 200, headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      let qrUrl2 = "";
      try {
        const raw = await db.prepare("SELECT raw_callback_json FROM payments WHERE id = ?").bind(existing.id).first();
        qrUrl2 = (raw && JSON.parse(raw.raw_callback_json || "{}").qr_url) || "";
      } catch { /* abaikan */ }
      const payment = { ...publicPayment(existing), qr_url: qrUrl2 };
      return new Response(renderPayHTML({ appName: env.APP_NAME, invoice: inv, payment, provider: existing.provider }), {
        status: 200, headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return json({ ok: false, error: "not_found" }, 404);
  } catch (e) {
    const status = Number(e.status) || 500;
    return json({ ok: false, error: e.code || "internal_error", message: String(e.message || e).slice(0, 300) }, status);
  }
}

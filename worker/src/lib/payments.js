// T6 — Adapter pembayaran QRIS (WS3): simulated | xendit | midtrans.
//
// Pemilihan provider via env.QRIS_PROVIDER (default "simulated"):
//   simulated  tanpa key — QR payload "QRIS-SIM:<ref>:<amount>", kedaluwarsa 30 mnt,
//              cocok untuk dev/test + halaman bayar lokal. Webhook: X-Webhook-Secret.
//   xendit     QR Code API (api.xendit.co/qr_codes) — butuh secret XENDIT_API_KEY.
//              Callback QR: header x-callback-token == XENDIT_CALLBACK_TOKEN.
//   midtrans   Core API charge payment_type=qris (api.midtrans.com / sandbox)
//              butuh MIDTRANS_SERVER_KEY. Notifikasi: signature SHA-512
//              order_id+status_code+gross_amount+ServerKey.
//
// Semua adapter mengembalikan bentuk Charge yang sama:
//   { ref, qrPayload, qrUrl, amountIdr, feeIdr, expiresAt }
//
// Catatan hemat free-tier: createCharge hanya dipanggil saat user membuka
// halaman bayar (bukan polling). Status dicek via GET /api/payments/:ref
// (baca D1 ringan) — bukan memanggil provider berulang.

const enc = new TextEncoder();

export const PROVIDERS = ["simulated", "xendit", "midtrans"];
export const PAY_TTL_MS = 30 * 60 * 1000; // QR kedaluwarsa 30 menit
export const SIM_FEE_IDR = 0;

export function resolveProvider(env) {
  const p = String(env.QRIS_PROVIDER || "simulated").toLowerCase();
  return PROVIDERS.includes(p) ? p : "simulated";
}

function isoIn(ms, fromMs = Date.now()) {
  return new Date(fromMs + ms).toISOString();
}

function randRef(prefix) {
  const rnd = crypto.getRandomValues(new Uint8Array(12));
  const hex = [...rnd].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${Date.now().toString(36)}-${hex.slice(0, 12)}`;
}

// ---------- simulated ----------

export function simulatedCharge({ invoice, ttlMs = PAY_TTL_MS, nowMs = Date.now() } = {}) {
  const ref = randRef("SIM");
  const amount = Number(invoice.total_idr) || 0;
  return {
    ref,
    qrPayload: `QRIS-SIM:${ref}:${amount}`,
    qrUrl: "",
    amountIdr: amount,
    feeIdr: SIM_FEE_IDR,
    expiresAt: isoIn(ttlMs, nowMs),
    raw: { simulated: true, invoice_number: invoice.number },
  };
}

// ---------- xendit (QR Code API) ----------

export function xenditChargeBody({ invoice, ref, ttlMs = PAY_TTL_MS, nowMs = Date.now() }) {
  const expires = new Date(nowMs + ttlMs);
  return {
    reference_id: ref,
    type: "DYNAMIC",
    currency: "IDR",
    amount: Number(invoice.total_idr) || 0,
    channel_code: "QRIS",
    expires_at: expires.toISOString(),
    metadata: { invoice_id: invoice.id, invoice_number: invoice.number },
  };
}

export async function xenditCreateCharge({ invoice, env, ttlMs, nowMs, doFetch = fetch }) {
  const key = env.XENDIT_API_KEY || "";
  if (!key) throw Object.assign(new Error("XENDIT_API_KEY belum diset."), { code: "PROVIDER_KEY_MISSING", status: 500 });
  const ref = randRef("XND");
  const body = xenditChargeBody({ invoice, ref, ttlMs, nowMs });
  const res = await doFetch("https://api.xendit.co/qr_codes", {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(`${key}:`),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw Object.assign(new Error(`Xendit charge gagal (${res.status}): ${t.slice(0, 200)}`), {
      code: "PROVIDER_CHARGE_GAGAL", status: 502,
    });
  }
  const j = await res.json();
  return {
    ref,
    qrPayload: j.qr_string || "",
    qrUrl: j.qr_url || j.qr_content_url || "",
    amountIdr: Number(invoice.total_idr) || 0,
    feeIdr: 0,
    expiresAt: j.expires_at || isoIn(ttlMs ?? PAY_TTL_MS, nowMs ?? Date.now()),
    raw: j,
  };
}

// ---------- midtrans (Core API charge QRIS) ----------

export function midtransChargeBody({ invoice, ref }) {
  return {
    payment_type: "qris",
    transaction_details: {
      order_id: ref,
      gross_amount: Number(invoice.total_idr) || 0,
    },
    metadata: { invoice_id: invoice.id, invoice_number: invoice.number },
  };
}

export async function midtransCreateCharge({ invoice, env, ttlMs, nowMs, doFetch = fetch }) {
  const key = env.MIDTRANS_SERVER_KEY || "";
  if (!key) throw Object.assign(new Error("MIDTRANS_SERVER_KEY belum diset."), { code: "PROVIDER_KEY_MISSING", status: 500 });
  const ref = randRef("MTM");
  const isProd = String(env.MIDTRANS_IS_PRODUCTION || "").toLowerCase() === "true";
  const base = isProd ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com";
  const res = await doFetch(`${base}/v2/charge`, {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(`${key}:`),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(midtransChargeBody({ invoice, ref })),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw Object.assign(new Error(`Midtrans charge gagal (${res.status}): ${t.slice(0, 200)}`), {
      code: "PROVIDER_CHARGE_GAGAL", status: 502,
    });
  }
  const j = await res.json();
  const action = (j.actions || []).find((a) => a.url) || {};
  return {
    ref,
    qrPayload: j.qr_string || "",
    qrUrl: action.url || "",
    amountIdr: Number(invoice.total_idr) || 0,
    feeIdr: 0,
    expiresAt: isoIn(ttlMs ?? PAY_TTL_MS, nowMs ?? Date.now()),
    raw: j,
  };
}

// ---------- facade ----------

export async function createCharge({ invoice, env, ttlMs, nowMs, doFetch } = {}) {
  const provider = resolveProvider(env);
  if (provider === "xendit") return { provider, ...(await xenditCreateCharge({ invoice, env, ttlMs, nowMs, doFetch })) };
  if (provider === "midtrans") return { provider, ...(await midtransCreateCharge({ invoice, env, ttlMs, nowMs, doFetch })) };
  return { provider: "simulated", ...simulatedCharge({ invoice, ttlMs, nowMs }) };
}

// ---------- verifikasi signature webhook ----------

export async function sha512Hex(s) {
  const d = await crypto.subtle.digest("SHA-512", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Xendit QR callback: header x-callback-token harus sama dengan secret.
// Return { ok, status } — 401 bila token salah (jangan bocorkan nilai).
export function verifyXendit(request, env) {
  const secret = env.XENDIT_CALLBACK_TOKEN || env.XENDIT_API_KEY || "";
  const got = request.headers.get("x-callback-token") || "";
  if (!secret || !got || got !== secret) return { ok: false, status: 401 };
  return { ok: true };
}

// Midtrans notifikasi: signature_key == SHA512(order_id+status_code+gross_amount+ServerKey).
export async function verifyMidtrans(body, env) {
  const key = env.MIDTRANS_SERVER_KEY || "";
  const orderId = String(body.order_id || "");
  const statusCode = String(body.status_code || "");
  const gross = String(body.gross_amount || "");
  const sig = String(body.signature_key || "").toLowerCase();
  if (!key || !orderId || !sig) return { ok: false, status: 401 };
  const expect = await sha512Hex(orderId + statusCode + gross + key);
  if (sig !== expect.toLowerCase()) return { ok: false, status: 401 };
  return { ok: true };
}

// Simulated: header X-Webhook-Secret == WEBHOOK_SECRET (atau SESSION_SECRET
// fallback dev). Tanpa secret yang cocok -> 401.
export function verifySimulated(request, env) {
  const secret = env.WEBHOOK_SECRET || env.SESSION_SECRET || "";
  const got = request.headers.get("x-webhook-secret") || "";
  if (!secret || !got || got !== secret) return { ok: false, status: 401 };
  return { ok: true };
}

// ---------- normalisasi payload webhook -> event kanonis ----------
//
// Event kanonis: { provider, eventId, ref, status: "paid"|"expired"|"failed", amountIdr, raw }
// status provider -> kanonis:
//   xendit QR callback: ACTIVE=bayar-menunggu, COMPLETED=paid, EXPIRED=expired
//   midtrans: settlement|capture=paid, expire=expired, cancel|deny=failure
export function normalizeXendit(body = {}) {
  const ref = String(body.qr_code?.reference_id || body.reference_id || body.external_id || "");
  const st = String(body.status || body.event || "").toUpperCase();
  const status = st === "COMPLETED" || st === "QR_CODE_COMPLETED" || st === "PAID" || st === "SETTLEMENT"
    ? "paid" : st === "EXPIRED" || st === "QR_CODE_EXPIRED" ? "expired" : null;
  return {
    provider: "xendit",
    eventId: String(body.id || body.event_id || body.callback_id || `${ref}:${st}`),
    ref,
    status,
    amountIdr: Number(body.amount ?? body.expected_amount ?? 0) || 0,
    raw: body,
  };
}

export function normalizeMidtrans(body = {}) {
  const st = String(body.transaction_status || "").toLowerCase();
  const status = st === "settlement" || st === "capture" ? "paid"
    : st === "expire" ? "expired"
    : st === "cancel" || st === "deny" || st === "failure" ? "failed" : null;
  return {
    provider: "midtrans",
    eventId: String(body.transaction_id || `${body.order_id}:${st}:${body.transaction_time || ""}`),
    ref: String(body.order_id || ""),
    status,
    amountIdr: Number(body.gross_amount || 0) || 0,
    raw: body,
  };
}

export function normalizeSimulated(body = {}) {
  const st = String(body.status || "").toLowerCase();
  const status = st === "paid" ? "paid" : st === "expired" ? "expired" : st === "failed" ? "failed" : null;
  return {
    provider: "simulated",
    eventId: String(body.event_id || ""),
    ref: String(body.ref || body.provider_ref || ""),
    status,
    amountIdr: Number(body.amount_idr || 0) || 0,
    raw: body,
  };
}

// ---------- aplikasi event webhook ke DB (inti auto-lunas, idempotent) ----------

const PAYMENT_COLS =
  "id, invoice_id, user_id, provider, provider_ref, qr_payload, amount_idr, fee_idr, status, expires_at, paid_at";

export function publicPayment(p) {
  if (!p) return null;
  return {
    id: p.id,
    invoice_id: p.invoice_id,
    provider: p.provider,
    provider_ref: p.provider_ref,
    qr_payload: p.qr_payload,
    amount_idr: p.amount_idr,
    fee_idr: p.fee_idr,
    status: p.status,
    expires_at: p.expires_at,
    paid_at: p.paid_at,
  };
}

async function auditPayment(db, { action, payment, meta = {}, ip = "" }) {
  await db
    .prepare("INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, meta_json, ip) VALUES (?,?,?,?,?,?)")
    .bind(payment.user_id ?? null, action, "payment", String(payment.id), JSON.stringify(meta), ip || "")
    .run();
}

// Terapkan satu event kanonis ke payment + invoice (+ order bila lunas).
// Idempotent dua lapis:
//   1. webhook_events UNIQUE(provider, event_id) -> replay = {duplicate:true}.
//   2. status akhir: invoice yang sudah lunas tidak di-mark ulang (tanpa audit ganda).
export async function settlePayment(db, event, { ip = "", nowIso = null } = {}) {
  const { markInvoicePaid, getInvoice, err } = await import("./invoices.js");
  const ref = String(event.ref || "");
  const eventId = String(event.eventId || "");
  if (!ref) throw err("REF_KOSONG", "Payment ref wajib diisi.", 400);
  if (!eventId) throw err("EVENT_ID_KOSONG", "Event ID webhook wajib diisi (idempotency).", 400);
  if (!event.status) return { ok: true, ignored: true, reason: "status_tidak_dikenal" };

  const pay = await db
    .prepare(`SELECT ${PAYMENT_COLS} FROM payments WHERE provider_ref = ?`)
    .bind(ref)
    .first();
  if (!pay) throw err("PAYMENT_TIDAK_DITEMUKAN", `Payment ref '${ref}' tidak ditemukan.`, 404);

  if (Number(event.amountIdr) > 0 && Number(event.amountIdr) !== Number(pay.amount_idr)) {
    throw err("NOMINAL_TIDAK_COCOK", `Nominal webhook (${event.amountIdr}) tidak cocok dengan payment (${pay.amount_idr}).`, 409);
  }

  // Kunci idempotency dulu: replay event yang sama berhenti di sini.
  try {
    await db
      .prepare("INSERT INTO webhook_events (provider, event_id, payment_ref, raw_json) VALUES (?,?,?,?)")
      .bind(event.provider, eventId, ref, JSON.stringify(event.raw ?? {}))
      .run();
  } catch (e) {
    if (/unique/i.test(String((e && e.message) || ""))) {
      const cur = await db.prepare(`SELECT ${PAYMENT_COLS} FROM payments WHERE provider_ref = ?`).bind(ref).first();
      return { ok: true, duplicate: true, payment: publicPayment(cur || pay) };
    }
    throw e;
  }

  const now = nowIso || new Date().toISOString();
  let invoice = null;

  if (event.status === "paid") {
    await db
      .prepare("UPDATE payments SET status = ?, paid_at = ?, raw_callback_json = ?, updated_at = ? WHERE id = ?")
      .bind("paid", now, JSON.stringify(event.raw ?? {}), now, pay.id)
      .run();
    await auditPayment(db, { action: "payment.paid", payment: pay, meta: { provider: event.provider, ref, event_id: eventId }, ip });

    // Auto-lunas invoice. Bila sudah lunas (webhook susulan dgn event_id beda),
    // jangan mark ulang — cukup baca + catat agar tanpa audit ganda.
    try {
      invoice = await markInvoicePaid(
        db, pay.invoice_id,
        { actorUserId: pay.user_id, ip, meta: { via: `webhook:${event.provider}`, ref, event_id: eventId } },
        now
      );
    } catch (e) {
      if (e && e.code === "TRANSISI_INVALID") {
        invoice = await getInvoice(db, pay.invoice_id);
        await auditPayment(db, { action: "payment.webhook_susulan", payment: pay, meta: { ref, event_id: eventId, invoice_status: invoice && invoice.status }, ip });
      } else throw e;
    }

    // Order terkait ikut lunas (bila masih menunggu bayar) — supaya konsisten.
    try {
      if (invoice && invoice.order_id != null) {
        const o = await db.prepare("SELECT id, status, user_id FROM orders WHERE id = ?").bind(invoice.order_id).first();
        if (o && (o.status === "pending" || o.status === "awaiting_payment")) {
          await db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").bind("paid", now, o.id).run();
        }
      }
    } catch { /* order opsional — jangan gagalkan pelunasan */ }
  } else if (event.status === "expired" || event.status === "failed" || event.status === "cancelled") {
    const to = event.status === "expired" ? "expired" : "failed";
    await db
      .prepare("UPDATE payments SET status = ?, paid_at = ?, raw_callback_json = ?, updated_at = ? WHERE id = ?")
      .bind(to, pay.paid_at, JSON.stringify(event.raw ?? {}), now, pay.id)
      .run();
    await auditPayment(db, { action: `payment.${to}`, payment: pay, meta: { provider: event.provider, ref, event_id: eventId }, ip });
  }

  const cur = await db.prepare(`SELECT ${PAYMENT_COLS} FROM payments WHERE provider_ref = ?`).bind(ref).first();
  return { ok: true, duplicate: false, payment: publicPayment(cur || { ...pay, status: event.status === "paid" ? "paid" : pay.status }), invoice };
}

// Payment tertunda terbaru untuk satu invoice (dipakai halaman bayar: lanjutkan
// QR yang masih hidup, bukan bikin charge baru tiap refresh).
export async function latestPaymentForInvoice(db, invoiceId, nowIso = null) {
  const now = nowIso || new Date().toISOString();
  const p = await db
    .prepare(`SELECT ${PAYMENT_COLS} FROM payments WHERE invoice_id = ? ORDER BY id DESC`)
    .bind(Number(invoiceId))
    .first();
  if (!p) return null;
  if (p.status === "pending" && p.expires_at && String(p.expires_at) <= now) {
    await db
      .prepare("UPDATE payments SET status = ?, paid_at = ?, raw_callback_json = ?, updated_at = ? WHERE id = ?")
      .bind("expired", p.paid_at, p.raw_callback_json || "{}", now, p.id)
      .run();
    return { ...p, status: "expired" };
  }
  return p;
}

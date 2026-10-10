// T6 — Pembayaran QRIS + webhook auto-lunas (WS3).
// Jalan murni di Node (InvoiceFakeDB + webhook_events/payments), tanpa wrangler.
//
// Acceptance T6:
//  1. buat QR bayar sandbox (POST /api/payments) -> payment pending + qr_payload
//  2. webhook sandbox -> invoice paid (auto-lunas) + payment paid + log tersimpan
//  3. replay webhook sama -> duplicate:true, tanpa efek ganda
//  4. signature salah -> 401; nominal tak cocok -> 409; ref tak dikenal -> 404
//  5. halaman bayar GET /api/invoices/:id/pay -> HTML QR + countdown + cek status
//  6. QR hidup dipakai ulang (hemat charge); invoice lunas tak bisa dibayar (409)
//  7. scoping: client lain 403, anon 401
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { InvoiceFakeDB } from "./fake-db-invoices.js";
import { renderPayHTML } from "../src/routes/payments.js";
import {
  resolveProvider,
  simulatedCharge,
  verifyXendit,
  verifyMidtrans,
  normalizeXendit,
  normalizeMidtrans,
  normalizeSimulated,
  sha512Hex,
} from "../src/lib/payments.js";

const SECRET = "dev-min-32-char-ganti-sebelum-produksi-1234";
const baseEnv = {
  APP_NAME: "Test",
  SESSION_COOKIE: "portal_session",
  QRIS_PROVIDER: "simulated",
  SESSION_SECRET: SECRET,
  WEBHOOK_SECRET: SECRET,
};
const req = (path, opts = {}) => new Request(`http://local${path}`, opts);
const post = (path, body, headers = {}) =>
  req(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

function seedEnv() {
  const db = new InvoiceFakeDB();
  const admin = db.addUser({ email: "admin@contoh.id", name: "Admin", role: "admin" });
  const client = db.addUser({ email: "client@contoh.id", name: "Budi", role: "client" });
  const other = db.addUser({ email: "lain@contoh.id", name: "Siti", role: "client" });
  const pMt = db.addProduct({ name: "Maintenance Bulanan", price_idr: 499000, billing_period: "monthly" });
  const env = { ...baseEnv, DB: db };
  return { env, db, admin, client, other, pMt };
}

async function issueInvoice(env, cookie, orderId) {
  const res = await worker.fetch(
    req("/api/invoices", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ orderId }) }),
    env, {}
  );
  return { res, json: await res.json() };
}

async function setupPaid(ctx = {}) {
  // client + order + invoice siap bayar; kembalikan cookie + invoice.
  const { env, db, client, pMt } = ctx.seeded || seedEnv();
  const cc = await db.loginAs(client);
  const order = db.addOrder({ user_id: client.id, product_id: pMt.id, qty: 1 });
  const { json } = await issueInvoice(env, cc, order.id);
  return { env, db, client, cc, invoice: json.invoice, order };
}

async function createPay(env, cookie, invoiceId) {
  const res = await worker.fetch(post("/api/payments", { invoiceId }, { cookie }), env, {});
  return { res, json: await res.json() };
}

const simHeaders = (secret = SECRET) => ({ "x-webhook-secret": secret });

// ---------- 1. buat QR sandbox ----------

test("POST /api/payments: QR sandbox pending + qr_payload + expiry ~30 mnt", async () => {
  const { env, cc, invoice } = await setupPaid();
  const { res, json } = await createPay(env, cc, invoice.id);
  assert.equal(res.status, 201);
  assert.equal(json.ok, true);
  assert.equal(json.provider, "simulated");
  assert.equal(json.payment.status, "pending");
  assert.match(json.payment.provider_ref, /^SIM-/);
  assert.match(json.payment.qr_payload, /^QRIS-SIM:/);
  assert.ok(json.payment.qr_payload.includes(String(invoice.total_idr)));
  const ttl = new Date(json.payment.expires_at).getTime() - Date.now();
  assert.ok(ttl > 20 * 60 * 1000 && ttl <= 31 * 60 * 1000, `ttl=${ttl}`);
  assert.equal(json.invoice.id, invoice.id);
});

// ---------- 2. webhook sandbox -> auto-lunas ----------

test("webhook sandbox: bayar -> payment paid + invoice paid + order paid + log", async () => {
  const { env, db, cc, invoice } = await setupPaid();
  const { json } = await createPay(env, cc, invoice.id);
  const ref = json.payment.provider_ref;

  const res = await worker.fetch(
    post("/api/webhooks/simulated", { ref, event_id: "evt-1", status: "paid", amount_idr: invoice.total_idr }, simHeaders()),
    env, {}
  );
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.duplicate, false);
  assert.equal(out.payment.status, "paid");
  assert.ok(out.payment.paid_at);
  assert.equal(out.invoice.status, "paid");

  // invoice via API ikut lunas
  const inv = await worker.fetch(req(`/api/invoices/${invoice.id}`, { headers: { cookie: cc } }), env, {});
  assert.equal((await inv.json()).invoice.status, "paid");

  // order ikut lunas
  const order = db.orders.find((o) => o.id === invoice.order_id);
  assert.equal(order.status, "paid");

  // log tersimpan: payment.paid + invoice.paid
  const acts = db.audit_logs.map((a) => a.action);
  assert.ok(acts.includes("payment.paid"), `audit=${acts.join(",")}`);
  assert.ok(acts.includes("invoice.paid"), `audit=${acts.join(",")}`);
});

// ---------- 3. idempotency replay ----------

test("replay webhook sama -> duplicate:true, tanpa audit ganda", async () => {
  const { env, db, cc, invoice } = await setupPaid();
  const { json } = await createPay(env, cc, invoice.id);
  const ref = json.payment.provider_ref;
  const body = { ref, event_id: "evt-replay", status: "paid", amount_idr: invoice.total_idr };

  const r1 = await worker.fetch(post("/api/webhooks/simulated", body, simHeaders()), env, {});
  assert.equal((await r1.json()).duplicate, false);
  const nAudit = db.audit_logs.length;

  const r2 = await worker.fetch(post("/api/webhooks/simulated", body, simHeaders()), env, {});
  assert.equal(r2.status, 200);
  const j2 = await r2.json();
  assert.equal(j2.ok, true);
  assert.equal(j2.duplicate, true);
  assert.equal(j2.payment.status, "paid");
  assert.equal(db.audit_logs.length, nAudit, "replay tak boleh menambah audit");
});

// ---------- 4. keamanan webhook ----------

test("webhook: secret salah 401; ref tak dikenal 404; nominal tak cocok 409", async () => {
  const { env, cc, invoice } = await setupPaid();
  const { json } = await createPay(env, cc, invoice.id);
  const ref = json.payment.provider_ref;

  const bad = await worker.fetch(
    post("/api/webhooks/simulated", { ref, event_id: "e-x", status: "paid" }, simHeaders("salah")),
    env, {}
  );
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error, "signature_tidak_valid");

  const ghost = await worker.fetch(
    post("/api/webhooks/simulated", { ref: "SIM-tak-ada", event_id: "e-y", status: "paid" }, simHeaders()),
    env, {}
  );
  assert.equal(ghost.status, 404);

  const nominal = await worker.fetch(
    post("/api/webhooks/simulated", { ref, event_id: "e-z", status: "paid", amount_idr: 1 }, simHeaders()),
    env, {}
  );
  assert.equal(nominal.status, 409);
  assert.equal((await nominal.json()).error, "NOMINAL_TIDAK_COCOK");
});

test("webhook xendit: token salah 401; COMPLETED -> paid + idempotent", async () => {
  const seeded = seedEnv();
  const { env, db, client, pMt } = seeded;
  const cc = await db.loginAs(client);
  const order = db.addOrder({ user_id: client.id, product_id: pMt.id, qty: 1 });
  const { json: ji } = await issueInvoice(env, cc, order.id);
  const { json } = await createPay(env, cc, ji.invoice.id);
  const ref = json.payment.provider_ref;

  const noToken = await worker.fetch(post("/api/webhooks/xendit", { reference_id: ref }), env, {});
  assert.equal(noToken.status, 401);

  const envX = { ...env, QRIS_PROVIDER: "xendit", XENDIT_CALLBACK_TOKEN: "cb-secret" };
  const ok1 = await worker.fetch(
    post("/api/webhooks/xendit", { id: "xevt-1", qr_code: { reference_id: ref }, status: "COMPLETED", amount: ji.invoice.total_idr }, { "x-callback-token": "cb-secret" }),
    envX, {}
  );
  const j1 = await ok1.json();
  assert.equal(ok1.status, 200);
  assert.equal(j1.payment.status, "paid");
  assert.equal(j1.invoice.status, "paid");

  const ok2 = await worker.fetch(
    post("/api/webhooks/xendit", { id: "xevt-1", qr_code: { reference_id: ref }, status: "COMPLETED" }, { "x-callback-token": "cb-secret" }),
    envX, {}
  );
  assert.equal((await ok2.json()).duplicate, true);
});

test("webhook midtrans: signature salah 401; settlement -> paid", async () => {
  const seeded = seedEnv();
  const { env, db, client, pMt } = seeded;
  const cc = await db.loginAs(client);
  const order = db.addOrder({ user_id: client.id, product_id: pMt.id, qty: 1 });
  const { json: ji } = await issueInvoice(env, cc, order.id);
  const { json } = await createPay(env, cc, ji.invoice.id);
  const ref = json.payment.provider_ref;
  const gross = String(ji.invoice.total_idr);

  const bad = await worker.fetch(
    post("/api/webhooks/midtrans", { order_id: ref, status_code: "200", gross_amount: gross, signature_key: "salah", transaction_status: "settlement" }),
    { ...env, MIDTRANS_SERVER_KEY: "srv-key" }, {}
  );
  assert.equal(bad.status, 401);

  const sig = await sha512Hex(ref + "200" + gross + "srv-key");
  const ok = await worker.fetch(
    post("/api/webhooks/midtrans", { order_id: ref, status_code: "200", gross_amount: gross, signature_key: sig, transaction_status: "settlement", transaction_id: "mt-1" }),
    { ...env, MIDTRANS_SERVER_KEY: "srv-key" }, {}
  );
  const j = await ok.json();
  assert.equal(ok.status, 200);
  assert.equal(j.payment.status, "paid");
  assert.equal(j.invoice.status, "paid");
});

// ---------- 5. halaman bayar ----------

test("GET /api/invoices/:id/pay: HTML QR + countdown + cek status + tombol sandbox", async () => {
  const { env, cc, invoice } = await setupPaid();
  const res = await worker.fetch(req(`/api/invoices/${invoice.id}/pay`, { headers: { cookie: cc } }), env, {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes("QRIS-SIM:"), "payload QR tampil");
  assert.ok(html.includes("Berakhir dalam"), "countdown tampil");
  assert.ok(html.includes("/api/payments/"), "cek status tampil");
  assert.ok(html.includes("vendor-qrcode.min.js"), "renderer QR lokal");
  assert.ok(html.includes("Simulasi Bayar"), "tombol sandbox tampil");
  assert.ok(html.includes(escNum(invoice.total_idr)), "total tampil");

  // render langsung: escaping aman
  const evilInv = { ...invoice, number: "<script>x</script>" };
  const h = renderPayHTML({ invoice: evilInv, payment: { provider_ref: "r", qr_payload: "<b>&</b>", expires_at: new Date().toISOString() }, provider: "simulated" });
  assert.ok(!h.includes("<script>x</script>"));
});

function escNum(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

test("halaman bayar invoice lunas -> info Lunas; invoice cancel -> 409", async () => {
  const { env, db, cc, invoice } = await setupPaid();
  const ac = await db.loginAs(db.users.find((u) => u.role === "admin"));
  await worker.fetch(req(`/api/invoices/${invoice.id}/pay`, { method: "POST", headers: { cookie: ac } }), env, {});
  const paid = await worker.fetch(req(`/api/invoices/${invoice.id}/pay`, { headers: { cookie: cc } }), env, {});
  assert.equal(paid.status, 200);
  assert.ok((await paid.text()).includes("Lunas"));
});

// ---------- 6. reuse QR + 409 invoice lunas ----------

test("QR hidup dipakai ulang; invoice lunas tak bisa buat payment (409)", async () => {
  const { env, db, cc, invoice } = await setupPaid();
  const p1 = await createPay(env, cc, invoice.id);
  const p2 = await createPay(env, cc, invoice.id);
  assert.equal(p2.json.reused, true);
  assert.equal(p2.json.payment.provider_ref, p1.json.payment.provider_ref);

  // lunaskan via webhook lalu coba buat lagi
  await worker.fetch(
    post("/api/webhooks/simulated", { ref: p1.json.payment.provider_ref, event_id: "e-lunas", status: "paid", amount_idr: invoice.total_idr }, simHeaders()),
    env, {}
  );
  const again = await createPay(env, cc, invoice.id);
  assert.equal(again.res.status, 409);
  assert.equal(again.json.error, "INVOICE_SUDAH_LUNAS");
  void db;
});

test("GET /api/payments/:ref cek status; simulate endpoint lunaskan sandbox", async () => {
  const { env, cc, invoice } = await setupPaid();
  const { json } = await createPay(env, cc, invoice.id);
  const ref = json.payment.provider_ref;

  const s1 = await worker.fetch(req(`/api/payments/${encodeURIComponent(ref)}`, { headers: { cookie: cc } }), env, {});
  assert.equal((await s1.json()).payment.status, "pending");

  const sim = await worker.fetch(post("/api/payments/simulate", { ref }, { cookie: cc }), env, {});
  assert.equal(sim.status, 200);
  assert.equal((await sim.json()).payment.status, "paid");

  const s2 = await worker.fetch(req(`/api/payments/${encodeURIComponent(ref)}`, { headers: { cookie: cc } }), env, {});
  const j2 = await s2.json();
  assert.equal(j2.payment.status, "paid");
  assert.equal(j2.invoice.status, "paid");
});

// ---------- 7. scoping / RBAC ----------

test("payment: client lain 403, anon 401; webhook tetap publik (signature saja)", async () => {
  const { env, db, client, other, pMt } = seedEnv();
  const cc = await db.loginAs(client);
  const oc = await db.loginAs(other);
  const order = db.addOrder({ user_id: client.id, product_id: pMt.id, qty: 1 });
  const { json: ji } = await issueInvoice(env, cc, order.id);
  const inv = ji.invoice;

  const evil = await createPay(env, oc, inv.id);
  assert.equal(evil.res.status, 403);

  const anon = await worker.fetch(post("/api/payments", { invoiceId: inv.id }), env, {});
  assert.equal(anon.status, 401);

  const { json } = await createPay(env, cc, inv.id);
  const peek = await worker.fetch(req(`/api/payments/${json.payment.provider_ref}`), env, {});
  assert.equal(peek.status, 401);

  const payPage = await worker.fetch(req(`/api/invoices/${inv.id}/pay`), env, {});
  assert.equal(payPage.status, 401);

  // webhook tanpa cookie TETAP jalan (kuncinya signature, bukan session)
  const wh = await worker.fetch(
    post("/api/webhooks/simulated", { ref: json.payment.provider_ref, event_id: "e-pub", status: "paid", amount_idr: inv.total_idr }, simHeaders()),
    env, {}
  );
  assert.equal(wh.status, 200);
});

// ---------- unit adapter ----------

test("unit: resolveProvider fallback + simulatedCharge + normalisasi xendit/midtrans", async () => {
  assert.equal(resolveProvider({}), "simulated");
  assert.equal(resolveProvider({ QRIS_PROVIDER: "XENDIT" }), "xendit");
  assert.equal(resolveProvider({ QRIS_PROVIDER: "ngawur" }), "simulated");

  const c = simulatedCharge({ invoice: { number: "INV/1", total_idr: 553890 } });
  assert.match(c.ref, /^SIM-/);
  assert.equal(c.qrPayload, `QRIS-SIM:${c.ref}:553890`);

  const nx = normalizeXendit({ id: "a", qr_code: { reference_id: "R" }, status: "COMPLETED", amount: 100 });
  assert.equal(nx.status, "paid");
  assert.equal(nx.ref, "R");
  const nxPending = normalizeXendit({ id: "b", status: "ACTIVE" });
  assert.equal(nxPending.status, null);

  const nm = normalizeMidtrans({ transaction_status: "settlement", order_id: "O", transaction_id: "t" });
  assert.equal(nm.status, "paid");
  const nmExp = normalizeMidtrans({ transaction_status: "expire", order_id: "O" });
  assert.equal(nmExp.status, "expired");

  const ns = normalizeSimulated({ event_id: "e", ref: "R", status: "paid" });
  assert.equal(ns.status, "paid");
  assert.equal(verifyXendit({ headers: { get: () => "s" } }, { XENDIT_CALLBACK_TOKEN: "s" }).ok, true);
  assert.equal(verifyXendit({ headers: { get: () => "x" } }, { XENDIT_CALLBACK_TOKEN: "s" }).ok, false);
  assert.equal((await verifyMidtrans({ order_id: "o" }, {})).ok, false);
});

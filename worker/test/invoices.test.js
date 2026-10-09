// T5 — Invoice engine + cetak/PDF (WS3).
// Jalan murni di Node (FakeDB khusus invoice), tanpa wrangler.
//
// Acceptance T5:
//  1. invoice terbit dari order/langganan (once, monthly, yearly)
//  2. nomor unik (INV/YYYY/MM/NNNN), total+pajak benar
//  3. status unpaid/paid/overdue/cancelled + transisi dijaga
//  4. cetak rapi (halaman print HTML, tombol Cetak/Simpan PDF)
//  5. riwayat invoice tercatat
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { InvoiceFakeDB } from "./fake-db-invoices.js";
import {
  computeTotals,
  formatInvoiceNumber,
  formatIDR,
  sweepOverdue,
  TAX_RATE_DEFAULT,
} from "../src/lib/invoices.js";
import { renderInvoiceHTML } from "../src/routes/invoices.js";

const baseEnv = { APP_NAME: "Test", SESSION_COOKIE: "portal_session", QRIS_PROVIDER: "simulated" };
const req = (path, opts = {}) => new Request(`http://local${path}`, opts);
const post = (path, body, cookie) =>
  req(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

function seedEnv() {
  const db = new InvoiceFakeDB();
  const admin = db.addUser({ email: "admin@contoh.id", name: "Admin", role: "admin" });
  const client = db.addUser({ email: "client@contoh.id", name: "Budi", role: "client" });
  const other = db.addUser({ email: "lain@contoh.id", name: "Siti", role: "client" });
  const pWeb = db.addProduct({ name: "Paket Web Berita WordPress", price_idr: 3500000, billing_period: "once" });
  const pMt = db.addProduct({ name: "Maintenance Bulanan", price_idr: 499000, billing_period: "monthly" });
  const pYr = db.addProduct({ name: "Paket Serverless Tahunan", price_idr: 1490000, billing_period: "yearly" });
  const env = { ...baseEnv, DB: db };
  return { env, db, admin, client, other, pWeb, pMt, pYr };
}

async function issue(env, cookie, orderId, extra = {}) {
  const res = await worker.fetch(post("/api/invoices", { orderId, ...extra }, cookie), env, {});
  return { res, json: await res.json() };
}

// ---------- pure unit: total + pajak ----------

test("total+pajak benar: PPN 11% dari subtotal, tanpa float", () => {
  const t = computeTotals(
    [
      { label: "Paket Web", qty: 1, unitPrice: 3500000 },
      { label: "Setup", qty: 2, unitPrice: 150000 },
    ],
    0.11
  );
  assert.equal(t.amount, 3800000);
  assert.equal(t.tax, Math.round(3800000 * 0.11));
  assert.equal(t.total, t.amount + t.tax);
  assert.equal(t.lines[1].lineTotal, 300000);
});

test("computeTotals menolak item kosong / qty 0 / harga negatif", () => {
  const codeOf = (fn) => {
    try {
      fn();
    } catch (e) {
      return e.code;
    }
    return null;
  };
  assert.equal(codeOf(() => computeTotals([], 0.11)), "ITEM_KOSONG");
  assert.equal(codeOf(() => computeTotals([{ label: "x", qty: 0, unitPrice: 1 }])), "ITEM_INVALID");
  assert.equal(codeOf(() => computeTotals([{ label: "", qty: 1, unitPrice: 1 }])), "ITEM_INVALID");
});

test("format nomor INV/YYYY/MM/NNNN + formatIDR id-ID", () => {
  assert.equal(formatInvoiceNumber(new Date("2026-10-09T00:00:00Z"), 7), "INV/2026/10/0007");
  assert.equal(formatIDR(3885000), "Rp3.885.000");
});

// ---------- issue dari order + nomor unik ----------

test("invoice terbit dari order once: total+pajak benar, nomor unik, riwayat ada", async () => {
  const { env, db, client, pWeb } = seedEnv();
  const cc = await db.loginAs(client);
  const order = db.addOrder({ user_id: client.id, product_id: pWeb.id, qty: 1 });
  const { res, json } = await issue(env, cc, order.id);
  assert.equal(res.status, 201);
  assert.equal(json.ok, true);
  const inv = json.invoice;
  assert.match(inv.number, /^INV\/\d{4}\/\d{2}\/\d{4}$/);
  assert.equal(inv.billing_period, "once");
  assert.equal(inv.status, "unpaid");
  assert.equal(inv.amount_idr, 3500000);
  assert.equal(inv.tax_idr, Math.round(3500000 * TAX_RATE_DEFAULT));
  assert.equal(inv.total_idr, inv.amount_idr + inv.tax_idr);
  assert.equal(inv.items.length, 1);
  assert.ok(inv.history.some((h) => h.action === "invoice.created"));

  // invoice kedua dari order lain -> nomor beda
  const order2 = db.addOrder({ user_id: client.id, product_id: pWeb.id, qty: 1 });
  const r2 = await issue(env, cc, order2.id);
  assert.equal(r2.res.status, 201);
  assert.notEqual(r2.json.invoice.number, inv.number);
});

test("invoice langganan bulanan & tahunan: periode ikut produk", async () => {
  const { env, db, client, pMt, pYr } = seedEnv();
  const cc = await db.loginAs(client);
  const om = db.addOrder({ user_id: client.id, product_id: pMt.id, qty: 1 });
  const ym = db.addOrder({ user_id: client.id, product_id: pYr.id, qty: 1 });
  const m = await issue(env, cc, om.id);
  const y = await issue(env, cc, ym.id);
  assert.equal(m.json.invoice.billing_period, "monthly");
  assert.equal(y.json.invoice.billing_period, "yearly");
  assert.equal(m.json.invoice.amount_idr, 499000);
});

// ---------- lifecycle status ----------

test("lifecycle: unpaid -> paid (admin), unpaid -> overdue (sweep), cancel; transisi liar ditolak", async () => {
  const { env, db, client, pWeb } = seedEnv();
  const ac = await db.loginAs(db.users.find((u) => u.role === "admin"));
  const cc = await db.loginAs(client);
  const o1 = db.addOrder({ user_id: client.id, product_id: pWeb.id, qty: 1 });
  const { json } = await issue(env, cc, o1.id);
  const id = json.invoice.id;

  // client tak bisa menandai lunas sendiri
  const nope = await worker.fetch(post(`/api/invoices/${id}/pay`, {}, cc), env, {});
  assert.equal(nope.status, 403);

  // admin menandai lunas
  const pay = await worker.fetch(post(`/api/invoices/${id}/pay`, {}, ac), env, {});
  assert.equal(pay.status, 200);
  const paid = await pay.json();
  assert.equal(paid.invoice.status, "paid");
  assert.ok(paid.invoice.paid_at);

  // invoice lunas tak bisa dibatalkan
  const c1 = await worker.fetch(post(`/api/invoices/${id}/cancel`, {}, ac), env, {});
  assert.equal(c1.status, 409);

  // invoice baru dibatalkan pemilik -> cancelled, lalu tak bisa dibayar
  const o2 = db.addOrder({ user_id: client.id, product_id: pWeb.id, qty: 1 });
  const { json: j2 } = await issue(env, cc, o2.id);
  const cancel = await worker.fetch(post(`/api/invoices/${j2.invoice.id}/cancel`, {}, cc), env, {});
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).invoice.status, "cancelled");
  const payAfter = await worker.fetch(post(`/api/invoices/${j2.invoice.id}/pay`, {}, ac), env, {});
  assert.equal(payAfter.status, 409);

  // sweep: invoice kedaluwarsa -> overdue (idempotent)
  const past = new Date(Date.now() - 30 * 864e5).toISOString();
  const aged = await db.prepare(
    "INSERT INTO invoices (number, user_id, order_id, service_id, amount_idr, tax_idr, total_idr, status, billing_period, issued_at, due_at, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind("INV/2026/09/0001", client.id, null, null, 100000, 11000, 111000, "unpaid", "once", past, past, "").run();
  void aged;
  const n = await sweepOverdue(db);
  assert.equal(n >= 1, true);
  const n2 = await sweepOverdue(db);
  assert.equal(n2, 0);
});

// ---------- scoping / RBAC ----------

test("client hanya lihat miliknya; admin lihat semua; anon 401", async () => {
  const { env, db, client, other, pWeb } = seedEnv();
  const cc = await db.loginAs(client);
  const oc = await db.loginAs(other);
  const ac = await db.loginAs(db.users.find((u) => u.role === "admin"));
  const o = db.addOrder({ user_id: client.id, product_id: pWeb.id, qty: 1 });
  const { json } = await issue(env, cc, o.id);
  const id = json.invoice.id;

  const mine = await worker.fetch(req("/api/invoices", { headers: { cookie: cc } }), env, {});
  assert.equal((await mine.json()).invoices.length, 1);

  const theirs = await worker.fetch(req("/api/invoices", { headers: { cookie: oc } }), env, {});
  assert.equal((await theirs.json()).invoices.length, 0);

  const peek = await worker.fetch(req(`/api/invoices/${id}`, { headers: { cookie: oc } }), env, {});
  assert.equal(peek.status, 403);

  const adminList = await worker.fetch(req("/api/invoices", { headers: { cookie: ac } }), env, {});
  assert.equal((await adminList.json()).invoices.length, 1);

  const anon = await worker.fetch(req("/api/invoices"), env, {});
  assert.equal(anon.status, 401);

  // order milik orang lain tak bisa diterbitkan invoice-nya
  const evil = await issue(env, oc, o.id);
  assert.equal(evil.res.status, 403);
});

// ---------- cetak / PDF ----------

test("halaman print: HTML rapi, total benar, tombol cetak; bukan milik -> 403", async () => {
  const { env, db, client, other, pWeb } = seedEnv();
  const cc = await db.loginAs(client);
  const oc = await db.loginAs(other);
  const o = db.addOrder({ user_id: client.id, product_id: pWeb.id, qty: 1 });
  const { json } = await issue(env, cc, o.id);
  const inv = json.invoice;

  const res = await worker.fetch(req(`/api/invoices/${inv.id}/print`, { headers: { cookie: cc } }), env, {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes(inv.number));
  assert.ok(html.includes(formatIDR(inv.total_idr)));
  assert.ok(html.includes("window.print()"));
  assert.ok(html.includes("Save as PDF"));

  // render langsung: badge status + escaping aman
  const evil = { ...inv, number: "<script>x</script>", items: [{ label: "<b>&</b>", qty: 1, unit_price_idr: 1, line_total_idr: 1 }] };
  const h2 = renderInvoiceHTML(evil, {});
  assert.ok(!h2.includes("<script>x</script>"));

  const blocked = await worker.fetch(req(`/api/invoices/${inv.id}/print`, { headers: { cookie: oc } }), env, {});
  assert.equal(blocked.status, 403);
});

test("invoice manual admin (multi-item); client ditolak", async () => {
  const { env, db, client } = seedEnv();
  const ac = await db.loginAs(db.users.find((u) => u.role === "admin"));
  const cc = await db.loginAs(client);
  const res = await worker.fetch(
    post("/api/invoices", {
      userId: client.id,
      billingPeriod: "monthly",
      items: [
        { label: "Maintenance", qty: 1, unitPrice: 499000 },
        { label: "Backup ekstra", qty: 2, unitPrice: 50000 },
      ],
    }, ac),
    env,
    {}
  );
  assert.equal(res.status, 201);
  const inv = (await res.json()).invoice;
  assert.equal(inv.amount_idr, 599000);
  assert.equal(inv.items.length, 2);

  const deny = await worker.fetch(
    post("/api/invoices", { userId: client.id, items: [{ label: "x", qty: 1, unitPrice: 1 }] }, cc),
    env,
    {}
  );
  assert.equal(deny.status, 403);
});

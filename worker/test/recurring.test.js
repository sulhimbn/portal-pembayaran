// T8 — Cron harian invoice berulang + reminder + audit (WS5+WS3).
// Jalan murni di Node (InvoiceFakeDB), tanpa wrangler.
//
// Acceptance T8:
//  1. cron trigger terdaftar (scheduled handler + `0 1 * * *` di wrangler.toml)
//  2. dry-run log benar (rencana TANPA menulis; hitung perpanjangan/overdue/reminder)
//  3. tidak duplikat invoice (invoice terbuka/order batal tak diterbitkan ulang)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { InvoiceFakeDB } from "./fake-db-invoices.js";
import { markInvoicePaid, createInvoice } from "../src/lib/invoices.js";
import { addPeriod, findRenewalCandidates, runRecurringCron } from "../src/lib/recurring.js";

const baseEnv = { APP_NAME: "Test", SESSION_COOKIE: "portal_session", QRIS_PROVIDER: "simulated" };
const req = (path, opts = {}) => new Request(`http://local${path}`, opts);
const post = (path, body, cookie) =>
  req(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });

function seedEnv() {
  const db = new InvoiceFakeDB();
  const admin = db.addUser({ email: "admin@contoh.id", name: "Admin", role: "admin" });
  const client = db.addUser({ email: "client@contoh.id", name: "Budi", role: "client" });
  const pMt = db.addProduct({ name: "Maintenance Bulanan", price_idr: 499000, billing_period: "monthly" });
  const pYr = db.addProduct({ name: "Serverless Tahunan", price_idr: 1490000, billing_period: "yearly" });
  const pOnce = db.addProduct({ name: "Paket Web Once", price_idr: 3500000, billing_period: "once" });
  return { env: { ...baseEnv, DB: db }, db, admin, client, pMt, pYr, pOnce };
}

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
const daysAhead = (n) => new Date(Date.now() + n * 864e5).toISOString();

// Langganan lunas yang sudah lewat 1 periode -> kandidat perpanjangan.
async function paidSubscription(db, { user, product, issuedAgoDays }) {
  const order = db.addOrder({ user_id: user.id, product_id: product.id, qty: 1 });
  const inv = await createInvoice(db, {
    userId: user.id,
    orderId: order.id,
    items: [{ label: product.name, qty: 1, unitPrice: product.price_idr }],
    billingPeriod: product.billing_period,
    issuedAt: daysAgo(issuedAgoDays),
    actorUserId: user.id,
  });
  await markInvoicePaid(db, inv.id);
  return { order, inv };
}

// ---------- periode kalender ----------

test("periode kalender: monthly +1 bulan, yearly +1 tahun (tepi bulan aman)", () => {
  // Tepi bulan: 31 Jan +1 bulan meluap ke 3 Mar (perilaku Date UTC) — tetap
  // deterministik sehingga cron tidak pernah macet pada tanggal terbit aneh.
  assert.equal(addPeriod("2026-01-31T00:00:00.000Z", "monthly").toISOString().slice(0, 10), "2026-03-03");
  const m = addPeriod("2026-10-09T00:00:00.000Z", "monthly");
  assert.equal(m.toISOString().slice(0, 10), "2026-11-09");
  const y = addPeriod("2026-10-09T00:00:00.000Z", "yearly");
  assert.equal(y.toISOString().slice(0, 10), "2027-10-09");
});

// ---------- scheduled handler + trigger ----------

test("cron trigger terdaftar: scheduled handler ada + crons 1x/hari di wrangler.toml", () => {
  assert.equal(typeof worker.scheduled, "function");
  const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /crons\s*=\s*\[/);
  assert.ok(toml.includes("0 1 * * *"), "trigger harian 0 1 * * * wajib ada");
});

// ---------- dry-run ----------

test("dry-run: log benar (rencana perpanjangan + overdue + reminder) TANPA menulis", async () => {
  const { db, client, pMt } = seedEnv();
  await paidSubscription(db, { user: client, product: pMt, issuedAgoDays: 40 }); // monthly lewat periode
  const beforeInvoices = db.invoices.length;
  const beforeAudit = db.audit_logs.length;

  const r = await runRecurringCron(db, { now: new Date(), dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.issued.length, 1, "satu perpanjangan direncanakan");
  assert.ok(r.issued[0].planned === true);
  assert.ok(r.summary.includes("dry-run"));
  assert.ok(r.summary.includes("perpanjangan=1"));
  assert.equal(db.invoices.length, beforeInvoices, "dry-run TIDAK boleh menulis invoice");
  assert.equal(db.audit_logs.length, beforeAudit, "dry-run TIDAK boleh menulis audit");
});

// ---------- jalan asli + anti-duplikat ----------

test("jalan asli: terbit 1 perpanjangan + sweep + reminder + audit; jalan ke-2 tidak duplikat", async () => {
  const { db, client, pMt } = seedEnv();
  const { order } = await paidSubscription(db, { user: client, product: pMt, issuedAgoDays: 40 });
  void order;

  const r1 = await runRecurringCron(db, { now: new Date(), dryRun: false });
  assert.equal(r1.ok, true);
  assert.equal(r1.dryRun, false);
  assert.equal(r1.issued.length, 1);
  assert.match(r1.issued[0].number, /^INV\/\d{4}\/\d{2}\/\d{4}$/);
  const baru = db.invoices.find((x) => x.number === r1.issued[0].number);
  assert.ok(baru, "invoice perpanjangan tersimpan");
  assert.equal(baru.status, "unpaid");
  assert.equal(baru.billing_period, "monthly");
  assert.ok(db.audit_logs.some((a) => a.action === "invoice.created" && String(a.entity_id) === String(baru.id)));
  assert.ok(db.audit_logs.some((a) => a.action === "invoice.cron_run"));

  // Jalan kedua di hari sama: invoice terbuka masih ada -> TIDAK terbit lagi.
  const r2 = await runRecurringCron(db, { now: new Date(), dryRun: false });
  assert.equal(r2.issued.length, 0, "tidak duplikat: order ber-invoice terbuka dilewati");
  assert.ok(r2.skipped.some((s) => s.reason === "invoice_terbuka_masih_ada"));
});

test("tidak diperpanjang: once, belum jatuh tempo, order batal", async () => {
  const { db, client, pMt, pOnce } = seedEnv();
  // once lunas -> bukan langganan
  const oOnce = db.addOrder({ user_id: client.id, product_id: pOnce.id, qty: 1 });
  const iOnce = await createInvoice(db, {
    userId: client.id, orderId: oOnce.id,
    items: [{ label: pOnce.name, qty: 1, unitPrice: pOnce.price_idr }],
    billingPeriod: "once", issuedAt: daysAgo(60), actorUserId: client.id,
  });
  await markInvoicePaid(db, iOnce.id);
  // monthly baru terbit 5 hari lalu -> periode masih berjalan
  await paidSubscription(db, { user: client, product: pMt, issuedAgoDays: 5 });
  // langganan lama tapi order dibatalkan
  const { order: oCancel } = await paidSubscription(db, { user: client, product: pMt, issuedAgoDays: 70 });
  oCancel.status = "cancelled";

  const { due, skipped } = await findRenewalCandidates(db, new Date());
  assert.equal(due.length, 0);
  assert.ok(skipped.some((s) => s.orderId === oCancel.id && s.reason === "order_dibatalkan"));
});

test("sweep overdue + reminder sekali per invoice per hari + audit", async () => {
  const { db, client, pMt } = seedEnv();
  // invoice kedaluwarsa kemarin -> akan di-sweep + di-reminder
  const inv = await createInvoice(db, {
    userId: client.id,
    items: [{ label: "Manual", qty: 1, unitPrice: 100000 }],
    issuedAt: daysAgo(10),
    dueDays: 1,
    actorUserId: client.id,
  });
  assert.equal(inv.status, "unpaid");

  const r1 = await runRecurringCron(db, { now: new Date(), dryRun: false });
  const after = db.invoices.find((x) => x.id === inv.id);
  assert.equal(after.status, "overdue");
  assert.ok(r1.swept >= 1);
  assert.ok(r1.reminders.some((x) => x.invoiceId === inv.id));
  const remLogs1 = db.audit_logs.filter((a) => a.action === "invoice.reminder" && String(a.entity_id) === String(inv.id));
  assert.equal(remLogs1.length, 1, "reminder dicatat sekali");

  // Jalan kedua hari sama: reminder TIDAK ditulis ulang (anti spam).
  const r2 = await runRecurringCron(db, { now: new Date(), dryRun: false });
  const remLogs2 = db.audit_logs.filter((a) => a.action === "invoice.reminder" && String(a.entity_id) === String(inv.id));
  assert.equal(remLogs2.length, 1);
  assert.equal(r2.remindedCount, 0);
});

test("reminder mencakup due_soon (<=3 hari) + overdue, berisi total", async () => {
  const { db, client } = seedEnv();
  await createInvoice(db, {
    userId: client.id,
    items: [{ label: "Segera", qty: 1, unitPrice: 50000 }],
    issuedAt: new Date().toISOString(),
    dueDays: 2,
    actorUserId: client.id,
  });
  const r = await runRecurringCron(db, { now: new Date(), dryRun: true });
  const soon = r.reminders.find((x) => x.kind === "due_soon");
  assert.ok(soon, "invoice jatuh tempo <=3 hari masuk reminder");
  assert.ok(soon.total > 0);

  // jauh di masa depan -> tidak di-reminder
  const far = await createInvoice(db, {
    userId: client.id,
    items: [{ label: "Nanti", qty: 1, unitPrice: 50000 }],
    issuedAt: new Date().toISOString(),
    dueDays: 30,
    actorUserId: client.id,
  });
  void far;
  const r2 = await runRecurringCron(db, { now: new Date(), dryRun: true });
  assert.ok(!r2.reminders.some((x) => x.invoiceId === far.id));
});

// ---------- endpoint admin cron-run ----------

test("POST /api/invoices/cron-run: admin dry-run default tanpa tulis; client 403; anon 401", async () => {
  const { env, db, admin, client, pMt } = seedEnv();
  const ac = await db.loginAs(admin);
  const cc = await db.loginAs(client);
  await paidSubscription(db, { user: client, product: pMt, issuedAgoDays: 40 });
  const n0 = db.invoices.length;

  const dry = await worker.fetch(post("/api/invoices/cron-run", {}, ac), env, {});
  assert.equal(dry.status, 200);
  const dj = await dry.json();
  assert.equal(dj.ok, true);
  assert.equal(dj.dryRun, true);
  assert.equal(dj.issued.length, 1);
  assert.ok(String(dj.summary).includes("dry-run"));
  assert.equal(db.invoices.length, n0, "dry-run endpoint TIDAK menulis");

  const real = await worker.fetch(post("/api/invoices/cron-run?dryRun=0", {}, ac), env, {});
  assert.equal(real.status, 200);
  const rj = await real.json();
  assert.equal(rj.dryRun, false);
  assert.equal(rj.issued.length, 1);
  assert.equal(db.invoices.length, n0 + 1);

  const deny = await worker.fetch(post("/api/invoices/cron-run", {}, cc), env, {});
  assert.equal(deny.status, 403);
  const anon = await worker.fetch(post("/api/invoices/cron-run", {}), env, {});
  assert.equal(anon.status, 401);
});

test("scheduled() memakai lib yang sama dan tahan tanpa DB", async () => {
  const { db, client, pMt } = seedEnv();
  await paidSubscription(db, { user: client, product: pMt, issuedAgoDays: 40 });
  const env = { ...baseEnv, DB: db };
  let waited = null;
  await worker.scheduled(
    { scheduledTime: Date.now(), cron: "0 1 * * *" },
    env,
    { waitUntil: (p) => { waited = p; } }
  );
  await waited;
  assert.equal(db.invoices.length, 2, "scheduled menerbitkan perpanjangan");

  let logged = "";
  const origErr = console.error;
  console.error = (...a) => { logged += a.join(" "); };
  await worker.scheduled({ scheduledTime: Date.now(), cron: "0 1 * * *" }, { ...baseEnv }, { waitUntil: (p) => p.catch(() => {}) });
  console.error = origErr;
  void logged;
});

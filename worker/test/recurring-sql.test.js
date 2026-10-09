// T8 — Verifikasi SQL nyata (node:sqlite) untuk cron invoice berulang.
//
// FakeDB (fake-db-invoices.js) meniru pola SQL lib, tapi test ini menjalankan
// SQL ASLI lib/recurring.js + lib/invoices.js terhadap SKEMA ASLI
// (migrations/0002 + 0003 + seeds/seed_products.sql) via SQLite bawaan Node.
// Menangkap error SQL yang FakeDB tak bisa tangkap (JOIN salah, kolom hilang,
// constraint, perbandingan TEXT tanggal).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { issueFromOrder, markInvoicePaid, listInvoices } from "../src/lib/invoices.js";
import { runRecurringCron, findRenewalCandidates } from "../src/lib/recurring.js";

const root = new URL("../../", import.meta.url);

// Shim D1 minimal di atas node:sqlite (prepare/bind/first/run/all + meta).
function d1(db) {
  return {
    prepare(sql) {
      const st = db.prepare(String(sql));
      const wrap = (params) => ({
        first: () => st.get(...params) ?? null,
        all: () => ({ results: st.all(...params) }),
        run: () => {
          const r = st.run(...params);
          return { success: true, meta: { last_row_id: Number(r.lastInsertRowid) || 0, changes: Number(r.changes) || 0 } };
        },
      });
      return { bind: (...p) => wrap(p), first: () => wrap([]).first(), all: () => wrap([]).all(), run: () => wrap([]).run() };
    },
  };
}

function freshDb() {
  const raw = new DatabaseSync(":memory:");
  // 0002 wajib (skema inti T8). 0003 katalog milik T4: opsional — T8 hanya
  // butuh kolom 0002, jadi test tetap hijau walau file itu belum ada /
  // berganti nama saat konflik 0003 ganda diselesaikan orkestrator.
  try {
    raw.exec(readFileSync(new URL("migrations/0002_schema_core.sql", root), "utf8"));
  } catch (e) {
    if (!String(e.message).includes("duplicate column")) throw e;
  }
  try {
    raw.exec(readFileSync(new URL("migrations/0003_catalog_services.sql", root), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT" && !String(e.message).includes("duplicate column")) throw e;
  }
  raw.exec(readFileSync(new URL("seeds/seed_products.sql", root), "utf8"));
  return d1(raw);
}

function addUser(db, email, role = "client") {
  const now = new Date().toISOString();
  const r = db.prepare(
    "INSERT INTO users (email, password_hash, name, phone, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(email, "x", "U", "", role, "active", now, now).run();
  return r.meta.last_row_id;
}

function productId(db, slug) {
  return db.prepare("SELECT id, billing_period, price_idr FROM products WHERE slug = ?").bind(slug).first();
}

function addOrder(db, userId, productIdVal, qty = 1) {
  const p = db.prepare("SELECT price_idr FROM products WHERE id = ?").bind(productIdVal).first();
  const r = db.prepare("INSERT INTO orders (user_id, product_id, qty, amount_idr, status) VALUES (?,?,?,?,?)")
    .bind(userId, productIdVal, qty, p.price_idr * qty, "pending").run();
  return r.meta.last_row_id;
}

test("SQL nyata: skema + seed terbaca (3 produk)", () => {
  const db = freshDb();
  const rows = db.prepare("SELECT slug, billing_period FROM products ORDER BY sort_order").all().results;
  assert.equal(rows.length, 3);
  assert.ok(rows.some((r) => r.slug === "maintenance-bulanan"));
});

test("SQL nyata: langganan lunas 40 hari lalu -> cron terbitkan 1 perpanjangan, tanpa duplikat", async () => {
  const db = freshDb();
  const uid = addUser(db, "budi@contoh.id");
  const prod = productId(db, "maintenance-bulanan");
  const oid = addOrder(db, uid, prod.id);
  const issuedAgo = new Date(Date.now() - 40 * 864e5).toISOString();
  const inv = await issueFromOrder(db, oid, { issuedAt: issuedAgo });
  assert.equal(inv.billing_period, "monthly");
  await markInvoicePaid(db, inv.id);

  const before = await listInvoices(db, {});
  const r1 = await runRecurringCron(db, { now: new Date(), dryRun: false });
  assert.equal(r1.ok, true);
  assert.equal(r1.issued.length, 1);
  const after = await listInvoices(db, {});
  assert.equal(after.length, before.length + 1);
  const baru = after.find((x) => x.number === r1.issued[0].number);
  assert.ok(baru);
  assert.equal(baru.billing_period, "monthly");
  assert.equal(baru.status, "unpaid");

  // Audit nyata tercatat.
  const audits = db.prepare("SELECT action FROM audit_logs").all().results.map((a) => a.action);
  assert.ok(audits.includes("invoice.created"));
  assert.ok(audits.includes("invoice.paid"));
  assert.ok(audits.includes("invoice.cron_run"));

  // Jalan ke-2: tidak duplikat.
  const r2 = await runRecurringCron(db, { now: new Date(), dryRun: false });
  assert.equal(r2.issued.length, 0);
  assert.equal((await listInvoices(db, {})).length, after.length);
});

test("SQL nyata: dry-run tanpa tulis; overdue tersweep + reminder teraudit", async () => {
  const db = freshDb();
  const uid = addUser(db, "siti@contoh.id");
  const prod = productId(db, "maintenance-bulanan");
  const oid = addOrder(db, uid, prod.id);
  const inv = await issueFromOrder(db, oid, { issuedAt: new Date(Date.now() - 40 * 864e5).toISOString() });
  await markInvoicePaid(db, inv.id);

  const n0 = (await listInvoices(db, {})).length;
  const a0 = db.prepare("SELECT COUNT(*) AS n FROM audit_logs").first().n;
  const dry = await runRecurringCron(db, { now: new Date(), dryRun: true });
  assert.equal(dry.issued.length, 1);
  assert.equal((await listInvoices(db, {})).length, n0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs").first().n, a0);

  // Invoice kedaluwarsa manual -> sweep jadi overdue + reminder sekali.
  const old = await issueFromOrder(db, oid, { issuedAt: new Date(Date.now() - 20 * 864e5).toISOString() });
  void old;
  const r = await runRecurringCron(db, { now: new Date(), dryRun: false });
  assert.ok(r.swept >= 1);
  const rem = db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'invoice.reminder'").first().n;
  assert.ok(rem >= 1);
  const r2 = await runRecurringCron(db, { now: new Date(), dryRun: false });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'invoice.reminder'").first().n, rem);
  void r2;
});

test("SQL nyata: kandidat hanya langganan lunas yang jatuh tempo (once dikecualikan)", async () => {
  const db = freshDb();
  const uid = addUser(db, "agus@contoh.id");
  const once = productId(db, "paket-web-berita-wp");
  const oOnce = addOrder(db, uid, once.id);
  const iOnce = await issueFromOrder(db, oOnce, { issuedAt: new Date(Date.now() - 90 * 864e5).toISOString() });
  await markInvoicePaid(db, iOnce.id);
  const { due } = await findRenewalCandidates(db, new Date());
  assert.equal(due.length, 0, "invoice once tidak diperpanjang");
});

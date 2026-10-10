// T7 — Panel admin lengkap (WS4).
// Jalan murni di Node (AdminFakeDB), tanpa wrangler.
//
// Acceptance T7:
//  1. admin approve order pending -> layanan AKTIF + input URL/login WP
//     (kredensial terenkripsi at-rest, respons MASKED, order -> processing)
//  2. layanan hasil approve terlihat MASKED di sisi client (servicePublic T4)
//  3. RBAC: anon 401, client 403 di semua /api/admin/*
//  4. CRUD: users / orders / services / payments / products (+ audit)
//  5. verifikasi manual invoice: pay/cancel via engine T5 (transisi dijaga)
//  6. kredensial tak pernah bocor mentah (respons/audit), akses baca dicatat
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { AdminFakeDB } from "./fake-db-admin.js";
import { maskUsername } from "../src/lib/credentials.js";

const baseEnv = {
  APP_NAME: "Test",
  SESSION_COOKIE: "portal_session",
  QRIS_PROVIDER: "simulated",
  ENCRYPTION_KEY: "kunci-uji-t7-minimal-32-karakter!!!",
};
const req = (path, opts = {}) => new Request(`http://local${path}`, opts);
const jreq = (path, method, body, cookie) =>
  req(path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function seedEnv() {
  const db = new AdminFakeDB();
  const admin = db.addUser({ email: "admin@contoh.id", name: "Admin", role: "admin" });
  const client = db.addUser({ email: "client@contoh.id", name: "Budi" });
  const other = db.addUser({ email: "lain@contoh.id", name: "Siti" });
  const pWeb = db.addProduct({
    slug: "paket-web-berita-wp", name: "Paket Web Berita WordPress",
    price_idr: 3500000, billing_period: "once", features: ["Domain .com"], sort_order: 10,
  });
  const pSrv = db.addProduct({
    slug: "paket-serverless", name: "Paket Serverless Cloudflare",
    price_idr: 149000, billing_period: "monthly", features: [], sort_order: 20,
  });
  return { env: { ...baseEnv, DB: db }, db, admin, client, other, pWeb, pSrv };
}

async function cookies(env, db, ...users) {
  const out = {};
  for (const u of users) out[u.email] = await db.loginAs(u);
  void env;
  return out;
}

async function orderBaru(env, cookie, body) {
  const res = await worker.fetch(jreq("/api/client/orders", "POST", body, cookie), env, {});
  return { res, json: await res.json() };
}

test("RBAC: anon 401 + client 403 di semua zona admin", async () => {
  const { env, db, client } = seedEnv();
  const cc = await db.loginAs(client);
  const paths = [
    "/api/admin/summary",
    "/api/admin/dashboard",
    "/api/admin/users",
    "/api/admin/orders",
    "/api/admin/services",
    "/api/admin/invoices",
    "/api/admin/payments",
    "/api/admin/products",
    "/api/admin/audit",
  ];
  for (const p of paths) {
    const anon = await worker.fetch(req(p), env, {});
    assert.equal(anon.status, 401, `anon ${p}`);
    assert.equal((await anon.json()).error, "login_dulu");
    const cli = await worker.fetch(req(p, { headers: { cookie: cc } }), env, {});
    assert.equal(cli.status, 403, `client ${p}`);
    assert.equal((await cli.json()).error, "admin_saja");
  }
  // Tulis juga ditolak untuk client.
  const w = await worker.fetch(jreq("/api/admin/orders/1/approve", "POST", {}, cc), env, {});
  assert.equal(w.status, 403);
});

test("dashboard: angka global + piutang + antrean pending", async () => {
  const { env, db, admin, client, pSrv } = seedEnv();
  const c = await cookies(env, db, admin, client);
  db.addOrder({ user_id: client.id, product_id: pSrv.id, status: "pending" });
  db.addOrder({ user_id: client.id, product_id: pSrv.id, status: "cancelled" });
  const res = await worker.fetch(req("/api/admin/dashboard", { headers: { cookie: c["admin@contoh.id"] } }), env, {});
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.dashboard.users, 3);
  assert.equal(j.dashboard.orders, 2);
  assert.equal(j.dashboard.orders_pending, 1);
  assert.equal(j.dashboard.services, 0);
  // Summary lama T3 tetap kompatibel.
  const s = await worker.fetch(req("/api/admin/summary", { headers: { cookie: c["admin@contoh.id"] } }), env, {});
  const sj = await s.json();
  assert.equal(sj.totals.users, 3);
  assert.ok(sj.dashboard);
});

test("ACCEPTANCE: approve order pending -> layanan aktif + URL/login WP (MASKED)", async () => {
  const { env, db, admin, client, pWeb } = seedEnv();
  const c = await cookies(env, db, admin, client);
  const ac = c["admin@contoh.id"];
  const cc = c["client@contoh.id"];

  const { res: or, json: oj } = await orderBaru(env, cc, { slug: "paket-web-berita-wp", domain: "BeritaKu.id" });
  assert.equal(or.status, 201);
  const orderId = oj.order.id;

  const ap = await worker.fetch(
    jreq(`/api/admin/orders/${orderId}/approve`, "POST", {
      label: "Web Berita Beritaku",
      site_url: "https://beritaku.id",
      admin_url: "https://beritaku.id/wp-admin",
      wp_username: "adminwp",
      wp_secret: "s3cr3t-rahasia",
      serverless_info: "Cloudflare Pages + D1",
      expires_at: "2027-10-09T00:00:00.000Z",
    }, ac),
    env,
    {}
  );
  assert.equal(ap.status, 201);
  const aj = await ap.json();
  assert.equal(aj.ok, true);
  assert.equal(aj.order_status, "processing");
  const svc = aj.service;
  // Respons admin aman: MASKED, tanpa kolom *_enc.
  assert.ok(!("wp_username_enc" in svc) && !("wp_secret_enc" in svc));
  assert.equal(svc.wp_username_masked, maskUsername("adminwp"));
  assert.equal(svc.has_wp_secret, true);
  assert.equal(svc.url, "https://beritaku.id");
  assert.equal(svc.wp_admin_url, "https://beritaku.id/wp-admin");
  assert.equal(svc.status, "active");

  // DB menyimpan ciphertext, bukan plaintext.
  const row = db.services.find((s) => s.order_id === orderId);
  assert.ok(row.wp_username_enc && !String(row.wp_username_enc).includes("adminwp"));
  assert.ok(row.wp_secret_enc && !String(row.wp_secret_enc).includes("s3cr3t"));
  assert.equal(row.wp_username_masked, maskUsername("adminwp"));

  // Audit approve ada — tanpa nilai rahasia.
  const audits = db.audit_logs.filter((a) => a.action === "admin.order_approved");
  assert.equal(audits.length, 1);
  const metaRaw = JSON.stringify(audits[0]);
  assert.ok(!metaRaw.includes("adminwp") && !metaRaw.includes("s3cr3t-rahasia"));

  // Layanan terlihat MASKED di sisi client (servicePublic T4, tak berubah).
  const list = await worker.fetch(req("/api/client/services", { headers: { cookie: cc } }), env, {});
  const lj = await list.json();
  assert.equal(lj.services.length, 1);
  assert.equal(lj.services[0].wp_username_masked, maskUsername("adminwp"));
  assert.ok(!JSON.stringify(lj.services[0]).includes("s3cr3t"));
  const detail = await worker.fetch(req(`/api/client/services/${svc.id}`, { headers: { cookie: cc } }), env, {});
  const dj = await detail.json();
  assert.equal(dj.service.url, "https://beritaku.id");
  assert.equal(dj.service.has_wp_secret, true);
});

test("approve: idempotent per order (409 bila sudah ada) + status tak valid ditolak", async () => {
  const { env, db, admin, client, pSrv } = seedEnv();
  const c = await cookies(env, db, admin, client);
  const ac = c["admin@contoh.id"];
  const { json } = await orderBaru(env, c["client@contoh.id"], { slug: "paket-serverless" });
  const id = json.order.id;

  const ok = await worker.fetch(jreq(`/api/admin/orders/${id}/approve`, "POST", { wp_username: "u1" }, ac), env, {});
  assert.equal(ok.status, 201);
  const dup = await worker.fetch(jreq(`/api/admin/orders/${id}/approve`, "POST", { wp_username: "u2" }, ac), env, {});
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).error, "LAYANAN_SUDAH_ADA");

  // Order cancelled tak bisa di-approve.
  const { json: j2 } = await orderBaru(env, c["client@contoh.id"], { slug: "paket-serverless" });
  await worker.fetch(jreq(`/api/client/orders/${j2.order.id}/cancel`, "POST", {}, c["client@contoh.id"]), env, {});
  const nope = await worker.fetch(jreq(`/api/admin/orders/${j2.order.id}/approve`, "POST", {}, ac), env, {});
  assert.equal(nope.status, 409);

  // URL jelek ditolak 400, bukan tersimpan.
  const { json: j3 } = await orderBaru(env, c["client@contoh.id"], { slug: "paket-serverless" });
  const bad = await worker.fetch(jreq(`/api/admin/orders/${j3.order.id}/approve`, "POST", { site_url: "bukan-url" }, ac), env, {});
  assert.equal(bad.status, 400);
});

test("CRUD admin: users/orders/services list+update + audit baca service", async () => {
  const { env, db, admin, client, pSrv } = seedEnv();
  const ac = await db.loginAs(admin);

  // users: suspend + promote
  const u = await worker.fetch(jreq(`/api/admin/users/${client.id}`, "PATCH", { status: "suspended" }, ac), env, {});
  assert.equal(u.status, 200);
  assert.equal((await u.json()).user.status, "suspended");
  const back = await worker.fetch(jreq(`/api/admin/users/${client.id}`, "PATCH", { status: "active", name: "Budi Baru" }, ac), env, {});
  assert.equal((await back.json()).user.name, "Budi Baru");
  const ul = await worker.fetch(req("/api/admin/users?status=active", { headers: { cookie: ac } }), env, {});
  assert.ok((await ul.json()).users.length >= 2);

  // orders: list filter + update status/notes
  db.addOrder({ user_id: client.id, product_id: pSrv.id, status: "pending", domain_requested: "toko.id" });
  const ol = await worker.fetch(req("/api/admin/orders?status=pending", { headers: { cookie: ac } }), env, {});
  assert.equal((await ol.json()).orders.length, 1);
  const oid = (await db.orders.at(-1)).id;
  const ou = await worker.fetch(jreq(`/api/admin/orders/${oid}`, "PATCH", { status: "processing", notes: "Prioritas" }, ac), env, {});
  assert.equal((await ou.json()).order.status, "processing");
  const od = await worker.fetch(req(`/api/admin/orders/${oid}`, { headers: { cookie: ac } }), env, {});
  assert.equal((await od.json()).order.notes, "Prioritas");

  // services: approve dulu lalu list + update kredensial (tetap terenkripsi)
  const ap = await worker.fetch(jreq(`/api/admin/orders/${oid}/approve`, "POST", { wp_username: "lama", wp_secret: "r1" }, ac), env, {});
  const sid = (await ap.json()).service.id;
  const su = await worker.fetch(
    jreq(`/api/admin/services/${sid}`, "PATCH", { wp_username: "baruwp", site_url: "https://baru.id", status: "suspended" }, ac),
    env,
    {}
  );
  assert.equal(su.status, 200);
  const suj = await su.json();
  assert.equal(suj.service.wp_username_masked, maskUsername("baruwp"));
  assert.equal(suj.service.status, "suspended");
  assert.ok(!JSON.stringify(suj).includes("baruwp") || JSON.stringify(suj).includes(maskUsername("baruwp")));
  const row = db.services.find((s) => s.id === sid);
  assert.ok(!String(row.wp_username_enc).includes("baruwp"));

  // Baca detail service oleh admin mencatat service.viewed.
  const before = db.audit_logs.filter((a) => a.action === "service.viewed" && String(a.entity_id) === String(sid)).length;
  await worker.fetch(req(`/api/admin/services/${sid}`, { headers: { cookie: ac } }), env, {});
  const after = db.audit_logs.filter((a) => a.action === "service.viewed" && String(a.entity_id) === String(sid)).length;
  assert.equal(after, before + 1);
});

test("verifikasi manual invoice: terbit dari order + pay/cancel (transisi dijaga)", async () => {
  const { env, db, admin, client, pSrv } = seedEnv();
  const c = await cookies(env, db, admin, client);
  const ac = c["admin@contoh.id"];
  const cc = c["client@contoh.id"];

  const { json } = await orderBaru(env, cc, { slug: "paket-serverless" });
  const created = await worker.fetch(jreq("/api/admin/invoices", "POST", { orderId: json.order.id }, ac), env, {});
  assert.equal(created.status, 201);
  const inv = (await created.json()).invoice;
  assert.match(inv.number, /^INV\/\d{4}\/\d{2}\/\d{4}$/);
  assert.equal(inv.status, "unpaid");

  // Invoice manual multi-item oleh admin.
  const manual = await worker.fetch(
    jreq("/api/admin/invoices", "POST", {
      userId: client.id, billingPeriod: "once",
      items: [{ label: "Setup", qty: 1, unitPrice: 100000 }],
    }, ac),
    env,
    {}
  );
  assert.equal(manual.status, 201);

  // Client tak boleh terbitkan invoice manual.
  const deny = await worker.fetch(
    jreq("/api/admin/invoices", "POST", { userId: client.id, items: [{ label: "x", qty: 1, unitPrice: 1 }] }, cc),
    env,
    {}
  );
  assert.equal(deny.status, 403);

  // Tandai lunas manual -> paid + paid_at.
  const pay = await worker.fetch(jreq(`/api/admin/invoices/${inv.id}/pay`, "POST", {}, ac), env, {});
  assert.equal(pay.status, 200);
  assert.equal((await pay.json()).invoice.status, "paid");

  // Lunas tak bisa dibatalkan (409 dari engine T5).
  const c1 = await worker.fetch(jreq(`/api/admin/invoices/${inv.id}/cancel`, "POST", {}, ac), env, {});
  assert.equal(c1.status, 409);

  // Batalkan invoice manual via verify generik.
  const mid = (await manual.json()).invoice.id;
  const v = await worker.fetch(jreq(`/api/admin/invoices/${mid}/verify`, "POST", { action: "cancel" }, ac), env, {});
  assert.equal((await v.json()).invoice.status, "cancelled");
});

test("pembayaran: list + tandai manual lunas (invoice ikut lunas) + produk-harga CRUD", async () => {
  const { env, db, admin, client, pSrv } = seedEnv();
  const ac = await db.loginAs(admin);

  const p = db.addPayment({ invoice_id: null, user_id: client.id, amount_idr: 553890, status: "pending" });
  const pl = await worker.fetch(req("/api/admin/payments?status=pending", { headers: { cookie: ac } }), env, {});
  assert.equal((await pl.json()).payments.length, 1);

  // Produk: buat + ubah harga + nonaktifkan.
  const cp = await worker.fetch(
    jreq("/api/admin/products", "POST", { slug: "paket-web-baru", name: "Paket Web Baru", price_idr: 999000, billing_period: "once" }, ac),
    env,
    {}
  );
  assert.equal(cp.status, 201);
  const pid = (await cp.json()).product.id;
  const up = await worker.fetch(jreq(`/api/admin/products/${pid}`, "PATCH", { price_idr: 1111000, is_active: 0 }, ac), env, {});
  assert.equal((await up.json()).product.price_idr, 1111000);
  const dup = await worker.fetch(
    jreq("/api/admin/products", "POST", { slug: "paket-web-baru", name: "Duplikat", price_idr: 1 }, ac),
    env,
    {}
  );
  assert.equal(dup.status, 409);

  // Payment tanpa invoice tak bisa ikut-lunaskan invoice (payment tetap ditandai).
  const mk = await worker.fetch(jreq(`/api/admin/payments/${p.id}/mark`, "POST", { status: "failed" }, ac), env, {});
  assert.equal(mk.status, 200);
  assert.equal((await mk.json()).payment.status, "failed");
});

// T4 — Katalog + order baru + layanan + detail operasional (WS2).
// Jalan murni di Node (FakeDB katalog), tanpa wrangler.
//
// Acceptance T4:
//  1. katalog produk aktif bisa dibaca client (login)
//  2. order website baru (paket+domain+kebutuhan) masuk sebagai 'pending'
//  3. layanan TIDAK muncul sebelum approve (list kosong setelah order),
//     muncul setelah baris service dibuat (simulasi approve admin/T7)
//  4. detail layanan MASKED: tanpa *_enc mentah, username termask,
//     ada url/wp-admin/status/expire/info serverless; owner lain 403, anon 401
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { CatalogFakeDB } from "./fake-db-catalog.js";
import { sha256Hex } from "../src/lib/session.js";
import { encryptSecret, decryptSecret, maskUsername } from "../src/lib/credentials.js";

const baseEnv = {
  APP_NAME: "Test",
  SESSION_COOKIE: "portal_session",
  QRIS_PROVIDER: "simulated",
  ENCRYPTION_KEY: "kunci-uji-t4-minimal-32-karakter!!",
};
const req = (path, opts = {}) => new Request(`http://local${path}`, opts);
const post = (path, body, cookie) =>
  req(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const cookieOf = (res) => (res.headers.get("set-cookie") || "").split(";")[0];

async function loginCookie(env, db, user) {
  // loginAs tanpa lewat route auth (PBKDF2 mahal di test): tulis session langsung.
  const token = `tok-${user.id}-${Math.random().toString(36).slice(2)}`;
  const token_hash = await sha256Hex(token);
  db.sessions.push({
    token_hash, user_id: user.id,
    expires_at: new Date(Date.now() + 7 * 864e5).toISOString(), ip: "", user_agent: "",
  });
  return `portal_session=${encodeURIComponent(token)}`;
}

function addUserDirect(db, { email, role = "client" }) {
  const id = db._seq.user++;
  const u = { id, email: email.toLowerCase(), name: "U", phone: "", role, status: "active" };
  db.users.push(u);
  return u;
}

function seedEnv() {
  const db = new CatalogFakeDB();
  const admin = addUserDirect(db, { email: "admin@contoh.id", role: "admin" });
  const client = addUserDirect(db, { email: "client@contoh.id" });
  const other = addUserDirect(db, { email: "lain@contoh.id" });
  db.addProduct({
    slug: "paket-web-berita-wp", name: "Paket Web Berita WordPress", price_idr: 3500000,
    billing_period: "once", features: ["Domain .com"], is_active: 1, sort_order: 10,
  });
  db.addProduct({
    slug: "paket-serverless", name: "Paket Serverless Cloudflare", price_idr: 149000,
    billing_period: "monthly", features: [], is_active: 1, sort_order: 20,
  });
  db.addProduct({
    slug: "paket-mati", name: "Paket Mati", price_idr: 1000, billing_period: "once",
    features: [], is_active: 0, sort_order: 99,
  });
  const env = { ...baseEnv, DB: db };
  return { env, db, admin, client, other };
}

async function orderBaru(env, cookie, body) {
  const res = await worker.fetch(post("/api/client/orders", body, cookie), env, {});
  return { res, json: await res.json() };
}

test("katalog: login wajib; hanya produk aktif; publik aman", async () => {
  const { env, db, client } = seedEnv();
  const anon = await worker.fetch(req("/api/catalog"), env, {});
  assert.equal(anon.status, 401);
  assert.equal((await anon.json()).error, "login_dulu");

  const cc = await loginCookie(env, db, client);
  const res = await worker.fetch(req("/api/catalog", { headers: { cookie: cc } }), env, {});
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.products.length, 2);
  assert.ok(j.products.every((p) => p.slug !== "paket-mati"));
  assert.ok(!("is_active" in j.products[0]));
  assert.ok("price_idr" in j.products[0] && "billing_period" in j.products[0]);
});

test("acceptance: order baru -> 'pending'; layanan kosong sebelum approve", async () => {
  const { env, db, client } = seedEnv();
  const cc = await loginCookie(env, db, client);

  const { res, json } = await orderBaru(env, cc, {
    slug: "paket-serverless",
    domain: "TokoSaya.com",
    requirements: "Company profile 5 halaman, warna biru.",
  });
  assert.equal(res.status, 201);
  assert.equal(json.ok, true);
  assert.equal(json.order.status, "pending");
  assert.equal(json.order.product.slug, "paket-serverless");
  assert.equal(json.order.domain_requested, "tokosaya.com");
  assert.equal(json.order.amount_idr, 149000);
  assert.ok(db.audit_logs.some((a) => a.action === "order.created"));

  // Belum ada layanan (approve milik T7 — bukan di sini)
  const svc = await worker.fetch(req("/api/client/services", { headers: { cookie: cc } }), env, {});
  assert.equal((await svc.json()).services.length, 0);
});

test("order: slug/produk tak dikenal 404; nonaktif 404; domain jelek 400", async () => {
  const { env, db, client } = seedEnv();
  const cc = await loginCookie(env, db, client);

  const miss = await orderBaru(env, cc, { slug: "tak-ada" });
  assert.equal(miss.res.status, 404);

  const mati = await orderBaru(env, cc, { slug: "paket-mati" });
  assert.equal(mati.res.status, 404);

  const bad = await orderBaru(env, cc, { slug: "paket-serverless", domain: "bukan domain!!" });
  assert.equal(bad.res.status, 400);
  assert.equal(bad.json.error, "DOMAIN_INVALID");
});

test("order milik sendiri: list/detail ter-scope; batal hanya pending; orang lain 403", async () => {
  const { env, db, client, other } = seedEnv();
  const cc = await loginCookie(env, db, client);
  const oc = await loginCookie(env, db, other);

  const { json } = await orderBaru(env, cc, { slug: "paket-serverless" });
  const id = json.order.id;

  const mine = await worker.fetch(req("/api/client/orders", { headers: { cookie: cc } }), env, {});
  assert.equal((await mine.json()).orders.length, 1);
  const theirs = await worker.fetch(req("/api/client/orders", { headers: { cookie: oc } }), env, {});
  assert.equal((await theirs.json()).orders.length, 0);

  const peek = await worker.fetch(req(`/api/client/orders/${id}`, { headers: { cookie: oc } }), env, {});
  assert.equal(peek.status, 403);

  const detail = await worker.fetch(req(`/api/client/orders/${id}`, { headers: { cookie: cc } }), env, {});
  const dj = await detail.json();
  assert.equal(dj.ok, true);
  assert.equal(dj.order.status, "pending");
  assert.deepEqual(dj.services, []);

  const cancel = await worker.fetch(post(`/api/client/orders/${id}/cancel`, {}, cc), env, {});
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).order.status, "cancelled");

  const again = await worker.fetch(post(`/api/client/orders/${id}/cancel`, {}, cc), env, {});
  assert.equal(again.status, 409);
});

test("acceptance layanan: muncul setelah approve (simulasi T7); detail MASKED penuh", async () => {
  const { env, db, client, other } = seedEnv();
  const cc = await loginCookie(env, db, client);
  const oc = await loginCookie(env, db, other);
  const envEnc = { ...env };

  const { json } = await orderBaru(env, cc, { slug: "paket-web-berita-wp", domain: "beritaku.id" });
  const orderId = json.order.id;
  const produk = db.products.find((p) => p.slug === "paket-web-berita-wp");

  // Simulasi approve admin (T7 menulis service; T4 hanya membaca):
  // kredensial disimpan TERENKRIPSI at-rest, bukan plaintext.
  const svc = db.addService({
    user_id: client.id,
    order_id: orderId,
    product_id: produk.id,
    label: "Web Berita Beritaku",
    domain: "beritaku.id",
    wp_url: "https://beritaku.id",
    wp_username_enc: await encryptSecret("adminwp", envEnc),
    wp_secret_enc: await encryptSecret("s3cr3t-rahasia", envEnc),
    wp_username_masked: maskUsername("adminwp"),
    site_url: "https://beritaku.id",
    admin_url: "https://beritaku.id/wp-admin",
    serverless_info: "Cloudflare Pages + D1 (id: portal-pembayaran-db)",
    status: "active",
    expires_at: "2027-10-09T00:00:00.000Z",
  });
  assert.ok(!String(svc.wp_username_enc).includes("adminwp"));
  assert.ok(!String(svc.wp_secret_enc).includes("s3cr3t"));

  const list = await worker.fetch(req("/api/client/services", { headers: { cookie: cc } }), env, {});
  const lj = await list.json();
  assert.equal(lj.services.length, 1);

  const got = await worker.fetch(req(`/api/client/services/${svc.id}`, { headers: { cookie: cc } }), env, {});
  assert.equal(got.status, 200);
  const s = (await got.json()).service;
  const raw = JSON.stringify(s);
  assert.ok(!raw.includes("adminwp") && !raw.includes("s3cr3t-rahasia"), "tanpa kredensial mentah");
  assert.ok(!("wp_username_enc" in s) && !("wp_secret_enc" in s), "tanpa kolom *_enc");
  assert.equal(s.url, "https://beritaku.id");
  assert.equal(s.wp_url, "https://beritaku.id");
  assert.equal(s.wp_admin_url, "https://beritaku.id/wp-admin");
  assert.equal(s.wp_username_masked, maskUsername("adminwp"));
  assert.equal(s.has_wp_secret, true);
  assert.equal(s.status, "active");
  assert.equal(s.expires_at, "2027-10-09T00:00:00.000Z");
  assert.equal(s.serverless.info, "Cloudflare Pages + D1 (id: portal-pembayaran-db)");
  assert.equal(s.product.name, "Paket Web Berita WordPress");

  // Bukan milik: 403. Anon: 401.
  const evil = await worker.fetch(req(`/api/client/services/${svc.id}`, { headers: { cookie: oc } }), env, {});
  assert.equal(evil.status, 403);
  const anon = await worker.fetch(req(`/api/client/services/${svc.id}`), env, {});
  assert.equal(anon.status, 401);
});

test("detail order menyertakan layanan hasil approve (MASKED)", async () => {
  const { env, db, client } = seedEnv();
  const cc = await loginCookie(env, db, client);
  const { json } = await orderBaru(env, cc, { slug: "paket-serverless" });
  const produk = db.products.find((p) => p.slug === "paket-serverless");
  db.addService({ user_id: client.id, order_id: json.order.id, product_id: produk.id, domain: "toko.id", status: "pending" });

  const d = await worker.fetch(req(`/api/client/orders/${json.order.id}`, { headers: { cookie: cc } }), env, {});
  const dj = await d.json();
  assert.equal(dj.services.length, 1);
  assert.ok(!("wp_username_enc" in dj.services[0]));
});

test("masking username + enkripsi roundtrip (kunci benar) / gagal (kunci beda)", async () => {
  assert.equal(maskUsername("adminwp"), "a•••p");
  assert.equal(maskUsername(""), "");
  assert.equal(maskUsername("ab"), "••");

  const ct = await encryptSecret("rahasia-x", baseEnv);
  assert.ok(!ct.includes("rahasia-x"));
  assert.equal(await decryptSecret(ct, baseEnv), "rahasia-x");
  await assert.rejects(decryptSecret(ct, { ...baseEnv, ENCRYPTION_KEY: "kunci-lain-yang-jelas-berbeda-000" }));
});

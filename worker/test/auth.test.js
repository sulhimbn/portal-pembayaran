// T3: auth DB + RBAC — register/login/logout/me/reset + guard client/admin.
// Jalan murni di Node (WebCrypto + FakeDB), tanpa wrangler.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { FakeDB } from "./fake-db.js";

const baseEnv = { APP_NAME: "Test", SESSION_COOKIE: "portal_session", QRIS_PROVIDER: "simulated" };
const req = (path, opts = {}) => new Request(`http://local${path}`, opts);
const post = (path, body, cookie) =>
  req(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const cookieOf = (res) => (res.headers.get("set-cookie") || "").split(";")[0];

async function register(env, body) {
  const res = await worker.fetch(post("/api/auth/register", body), env, {});
  return { res, json: await res.json(), cookie: cookieOf(res) };
}
async function login(env, body) {
  const res = await worker.fetch(post("/api/auth/login", body), env, {});
  return { res, json: await res.json(), cookie: cookieOf(res) };
}

test("register -> auto-login, me terbaca, duplikat ditolak 409", async () => {
  const env = { ...baseEnv, DB: new FakeDB() };
  const { res, json, cookie } = await register(env, {
    email: "Client@Contoh.id", password: "rahasia-kuat-1", name: "Budi",
  });
  assert.equal(res.status, 201);
  assert.equal(json.user.email, "client@contoh.id");
  assert.equal(json.user.role, "client");
  assert.match(cookie, /portal_session=/);

  const me = await worker.fetch(req("/api/auth/me", { headers: { cookie } }), env, {});
  const mej = await me.json();
  assert.equal(mej.user.email, "client@contoh.id");

  const dup = await register(env, { email: "client@contoh.id", password: "lain-lain-22" });
  assert.equal(dup.res.status, 409);
  assert.equal(dup.json.error, "email_sudah_terdaftar");
});

test("register selalu client — field role diabaikan", async () => {
  const env = { ...baseEnv, DB: new FakeDB() };
  const { json } = await register(env, { email: "nakal@x.id", password: "rahasia-kuat-1", role: "admin" });
  assert.equal(json.user.role, "client");
});

test("login salah -> 401 generik; suspended -> 403 akun_disuspend", async () => {
  const env = { ...baseEnv, DB: new FakeDB() };
  await register(env, { email: "a@b.id", password: "rahasia-kuat-1" });

  const bad = await login(env, { email: "a@b.id", password: "salah-salah" });
  assert.equal(bad.res.status, 401);
  assert.equal(bad.json.error, "email_atau_password_salah");

  const ghost = await login(env, { email: "tak@ada.id", password: "rahasia-kuat-1" });
  assert.equal(ghost.res.status, 401);
  assert.equal(ghost.json.error, "email_atau_password_salah");

  env.DB.users[0].status = "suspended";
  const susp = await login(env, { email: "a@b.id", password: "rahasia-kuat-1" });
  assert.equal(susp.res.status, 403);
  assert.equal(susp.json.error, "akun_disuspend");
});

test("logout mencabut session: me jadi null", async () => {
  const env = { ...baseEnv, DB: new FakeDB() };
  const { cookie } = await register(env, { email: "c@d.id", password: "rahasia-kuat-1" });
  const out = await worker.fetch(post("/api/auth/logout", {}, cookie), env, {});
  assert.equal(out.status, 200);
  const me = await worker.fetch(req("/api/auth/me", { headers: { cookie } }), env, {});
  assert.equal((await me.json()).user, null);
});

test("RBAC: client ditolak di /admin (403 admin_saja), admin lolos, anon 401", async () => {
  const env = { ...baseEnv, DB: new FakeDB() };
  const c = await register(env, { email: "client@x.id", password: "rahasia-kuat-1" });

  const anonAdmin = await worker.fetch(req("/api/admin/summary"), env, {});
  assert.equal(anonAdmin.status, 401);

  const clientAdmin = await worker.fetch(req("/api/admin/summary", { headers: { cookie: c.cookie } }), env, {});
  assert.equal(clientAdmin.status, 403);
  assert.equal((await clientAdmin.json()).error, "admin_saja");

  env.DB.setAdmin("client@x.id");
  const adminOk = await worker.fetch(req("/api/admin/summary", { headers: { cookie: c.cookie } }), env, {});
  assert.equal(adminOk.status, 200);
  const aj = await adminOk.json();
  assert.equal(aj.totals.users, 1);
});

test("scoping client: summary hanya milik sendiri; guard client wajib login", async () => {
  const env = { ...baseEnv, DB: new FakeDB() };
  const anon = await worker.fetch(req("/api/client/summary"), env, {});
  assert.equal(anon.status, 401);

  const a = await register(env, { email: "a@x.id", password: "rahasia-kuat-1" });
  const b = await register(env, { email: "b@x.id", password: "rahasia-kuat-1" });
  env.DB.addOrder(env.DB.users[0].id);
  env.DB.addOrder(env.DB.users[0].id);

  const sa = await worker.fetch(req("/api/client/summary", { headers: { cookie: a.cookie } }), env, {});
  const ja = await sa.json();
  assert.equal(ja.counts.orders, 2);
  assert.equal(ja.user_id, 1);

  const sb = await worker.fetch(req("/api/client/summary", { headers: { cookie: b.cookie } }), env, {});
  assert.equal((await sb.json()).counts.orders, 0);
});

test("reset password dasar: request -> confirm -> login baru; session lama mati", async () => {
  const env = { ...baseEnv, DB: new FakeDB() };
  const { cookie: oldCookie } = await register(env, { email: "r@x.id", password: "rahasia-lama-1" });

  const rr = await worker.fetch(post("/api/auth/reset/request", { email: "r@x.id" }), env, {});
  assert.equal(rr.status, 200);
  const rj = await rr.json();
  assert.ok(rj.reset_token, "token dasar dikembalikan di dev");

  const bad = await worker.fetch(post("/api/auth/reset/confirm", { token: "salah", password: "rahasia-baru-1" }), env, {});
  assert.equal(bad.status, 400);

  const ok = await worker.fetch(
    post("/api/auth/reset/confirm", { token: rj.reset_token, password: "rahasia-baru-1" }), env, {});
  assert.equal(ok.status, 200);

  const meOld = await worker.fetch(req("/api/auth/me", { headers: { cookie: oldCookie } }), env, {});
  assert.equal((await meOld.json()).user, null);

  const lama = await login(env, { email: "r@x.id", password: "rahasia-lama-1" });
  assert.equal(lama.res.status, 401);
  const baru = await login(env, { email: "r@x.id", password: "rahasia-baru-1" });
  assert.equal(baru.res.status, 200);
});

test("validasi: email jelek 400, password pendek 400", async () => {
  const env = { ...baseEnv, DB: new FakeDB() };
  const e1 = await register(env, { email: "bukan-email", password: "rahasia-kuat-1" });
  assert.equal(e1.res.status, 400);
  const e2 = await register(env, { email: "ok@x.id", password: "pendek" });
  assert.equal(e2.res.status, 400);
});

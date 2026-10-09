// Smoke test lokal tanpa wrangler: stub binding minimal, import worker langsung.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const env = { APP_NAME: "Test", SESSION_COOKIE: "portal_session", QRIS_PROVIDER: "simulated" };
const makeReq = (path, opts = {}) => new Request(`http://local${path}`, opts);

test("GET /api/health ok", async () => {
  const res = await worker.fetch(makeReq("/api/health"), env, {});
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
});

test("login placeholder + me", async () => {
  const login = await worker.fetch(
    makeReq("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.id" }) }),
    env,
    {}
  );
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assert.ok(setCookie && setCookie.includes("portal_session="));
  const me = await worker.fetch(makeReq("/api/auth/me", { headers: { cookie: setCookie.split(";")[0] } }), env, {});
  const j = await me.json();
  assert.equal(j.user.email, "a@b.id");
});

test("scheduled handler ada", () => {
  assert.equal(typeof worker.scheduled, "function");
});

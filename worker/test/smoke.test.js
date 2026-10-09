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

test("guard tanpa DB: zona proteksi balas login_dulu", async () => {
  for (const path of ["/api/client/summary", "/api/admin/summary"]) {
    const res = await worker.fetch(makeReq(path), env, {});
    assert.equal(res.status, 401);
    const j = await res.json();
    assert.equal(j.error, "login_dulu");
  }
});

test("scheduled handler ada", () => {
  assert.equal(typeof worker.scheduled, "function");
});

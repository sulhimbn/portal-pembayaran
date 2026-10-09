// GET /api/health — cek binding D1/R2 tanpa query berat (hemat free-tier).
export async function handleHealth(env) {
  const out = { ok: true, ts: new Date().toISOString(), bindings: {} };
  try {
    if (env.DB) {
      const r = await env.DB.prepare("SELECT 1 AS one").first();
      out.bindings.d1 = r && r.one === 1 ? "up" : "unexpected";
    } else out.bindings.d1 = "missing (placeholder T1)";
  } catch (e) {
    out.bindings.d1 = "error: " + String(e.message || e).slice(0, 120);
  }
  try {
    if (env.ASSETS) {
      await env.ASSETS.list({ limit: 1 });
      out.bindings.r2 = "up";
    } else out.bindings.r2 = "missing (placeholder T1)";
  } catch (e) {
    out.bindings.r2 = "error: " + String(e.message || e).slice(0, 120);
  }
  out.bindings.cron = "scheduled handler registered (lihat log cron)";
  out.qris_provider = env.QRIS_PROVIDER || "simulated";
  return out;
}

// Pages Function proxy: /api/* -> Worker API (same-origin untuk cookie sesi).
// Lokasi: frontend/functions/api/[[path]].js (Pages project root = frontend/).
// Set env var Pages: API_UPSTREAM = https://portal-pembayaran-api.<akun>.workers.dev
// (Pages -> Settings -> Environment Variables). Tanpa ini -> 500 api_upstream_belum_dikonfigurasi.
export async function onRequest(context) {
  const { request, env } = context;
  const upstream = (env.API_UPSTREAM || "").replace(/\/+$/, "");
  if (!upstream) {
    return new Response(JSON.stringify({ ok: false, error: "api_upstream_belum_dikonfigurasi" }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const url = new URL(request.url);
  const target = upstream + url.pathname + url.search;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  const init = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  const res = await fetch(target, init);
  const out = new Headers(res.headers);
  // Cookie dari Worker (Set-Cookie) diteruskan apa adanya — same-origin via Pages.
  return new Response(res.body, { status: res.status, headers: out });
}

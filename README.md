# Portal Pembayaran QRIS + Invoice (Cloudflare Free-Tier Native)

Portal client untuk jasa pembuatan/pengelolaan website: client login, lihat layanan,
order web baru, terima invoice langganan, bayar via QRIS otomatis. Admin kelola semua.
Berjalan native di Cloudflare gratis: Pages + Workers + D1 + R2 + Cron.

Bahasa UI: Indonesia.

## Struktur monorepo

  wrangler.toml          Konfig Worker API + binding D1/R2 + Cron (akar repo)
  frontend/              Pages (Vite dev, proxy /api -> Worker :8787)
    src/main.js          Login placeholder + cek /api/health
    public/             Aset statis
  worker/                API (Workers, nodejs_compat)
    src/index.js         Router + CORS + scheduled (cron) handler
    src/routes/health.js GET /api/health (cek D1/R2)
    src/routes/auth.js   Auth session placeholder (T1) -> DB di T3
    test/                Smoke test node:test
  migrations/            Migrasi D1 (T1 placeholder, T2 skema penuh)

## Prasyarat

- Node >= 20, npm >= 10
- `npx wrangler` (di-install sebagai devDependency worker)

## Dev lokal (acceptance T1)

  npm install
  npm run dev
    # web: frontend di http://127.0.0.1:5173
    # api: worker  di http://127.0.0.1:8787 (wrangler dev --local)

Terpisah bila perlu:

  npm run dev:frontend
  npm run dev:worker

Cek cepat tanpa wrangler:

  npm test --workspace=worker   # smoke test /api/health + login placeholder
  curl localhost:8787/api/health

## Cloudflare setup (ringkas; detail penuh di T10)

  npx wrangler login
  npx wrangler d1 create portal-pembayaran-db   # salin database_id ke wrangler.toml
  npm run db:migrate:local                      # verifikasi migrasi lokal
  # R2: buat bucket portal-pembayaran-assets (dashboard atau wrangler r2)
  npx wrangler secret put SESSION_SECRET        # min 32 char, wajib produksi
  # Pages: hubungkan repo, root frontend/, build `npm run build --workspace=frontend`

Secrets lain (T6): XENDIT_API_KEY atau MIDTRANS_SERVER_KEY, ENCRYPTION_KEY.

## Status scaffold (T1)

- [x] Struktur folder + wrangler (D1/R2/Cron) + frontend Vite + proxy
- [x] Auth session placeholder (cookie HMAC dev-only, tanpa DB)
- [x] Cron handler terdaftar (logika invoice di T8)
- [ ] T2: skema D1 penuh + seed produk
- [ ] T3: auth DB + RBAC

## Batas free-tier (ringkas)

Workers 100k req/hari, D1 5GB + 5jt row-read/hari, R2 10GB, Cron min 1/menit
( dipakai 1x/hari). Desain hemat query; PDF on-demand; cron 1x/hari.

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
  migrations/            Migrasi D1 (0001 placeholder T1, 0002 skema inti T2)
  seeds/                 Seed produk awal, idempotent (seed_products.sql)

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

## Skema D1 (T2)

Migrasi `migrations/0002_schema_core.sql` (0001 hanya placeholder T1).
Seed: `seeds/seed_products.sql` — 3 produk awal, idempotent (INSERT OR IGNORE).

Konvensi: uang = INTEGER rupiah (tanpa float); waktu = TEXT ISO-8601 UTC.
Kredensial WP client di `services` disimpan terenkripsi at-rest
(kolom `*_enc`, kunci via secret ENCRYPTION_KEY), bukan plaintext.

Diagram relasi:

  users --1:*-- orders --*:1-- products
   |              |
   |              +--1:*-- services --*:1-- products
   |              |             |
   +--1:*-- invoices --*:1------+
   |      |  |
   |      |  +--1:*-- payments
   |      +--1:*-- invoice_items
   |
   +--1:*-- sessions
   +--1:*-- audit_logs (sebagai actor)

Tabel: users, products, orders, services, invoices, invoice_items,
payments, sessions, audit_logs. `invoice_items`/`sessions` tabel
pendukung untuk T5 (rincian total) dan T3 (session DB).

Perintah:

  npm run db:migrate:local    # apply migrasi ke D1 lokal
  npm run db:seed:local       # seed 3 produk awal
  npm run db:products:local   # verifikasi seed terbaca
  npm run db:tables:local     # daftar tabel

## Status scaffold (T1)

- [x] Struktur folder + wrangler (D1/R2/Cron) + frontend Vite + proxy
- [x] Auth session placeholder (cookie HMAC dev-only, tanpa DB)
- [x] Cron handler terdaftar (logika invoice di T8)
- [x] T2: skema D1 penuh + seed produk (0002 + seeds/seed_products.sql)
- [ ] T3: auth DB + RBAC

## Batas free-tier (ringkas)

Workers 100k req/hari, D1 5GB + 5jt row-read/hari, R2 10GB, Cron min 1/menit
( dipakai 1x/hari). Desain hemat query; PDF on-demand; cron 1x/hari.

# Portal Pembayaran QRIS + Invoice (Cloudflare Free-Tier Native)

Portal client untuk jasa pembuatan/pengelolaan website: client login, lihat layanan,
order web baru, terima invoice langganan, bayar via QRIS otomatis. Admin kelola semua.
Berjalan native di Cloudflare gratis: Pages + Workers + D1 + R2 + Cron.

Bahasa UI: Indonesia.

## Struktur monorepo

  wrangler.toml          Konfig Worker API + binding D1/R2 + Cron (akar repo)
  frontend/              Pages (Vite dev, proxy /api -> Worker :8787)
    src/main.js          Login/register + guard tampilan client/admin (T3)
    admin/               Panel admin: dashboard, antrean approve, CRUD (T7)
    src/admin.js         Logika panel admin (T7)
    client/              Area client: katalog, order, layanan masked (T4)
    public/             Aset statis
  worker/                API (Workers, nodejs_compat)
    src/index.js         Router + CORS + guard /client/* + /admin/* + scheduled (cron)
    src/lib/password.js  Hash PBKDF2-SHA-256 + verify timing-safe (T3)
    src/lib/session.js   Session cookie DB + token hash SHA-256 (T3)
    src/lib/auth.js      requireUser/requireAdmin/ownership + audit (T3)
    src/routes/health.js GET /api/health (cek D1/R2)
    src/routes/auth.js   Auth DB: register/login/logout/me/reset (T3)
    test/                Smoke + auth RBAC test node:test (T3: 11 test)
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

## Auth + RBAC (T3)

Register/login client (PBKDF2-SHA-256, min 8 char), session cookie 7 hari
berbasis DB (`sessions`, token disimpan sebagai hash SHA-256), role
client/admin, reset password dasar (token 1 jam, session lama dicabut),
guard backend `/api/client/*` (wajib login, query di-scope user_id) dan
`/api/admin/*` (wajib admin: 401 anon, 403 client), audit login/register/reset.

Admin dibuat via SQL (register SELALU client):

  npx wrangler d1 execute DB --local --command="UPDATE users SET role='admin' WHERE email='anda@contoh.id';"

Reset password di sini mode dasar (token dikembalikan di respons agar bisa
diuji manual); produksi wajib kirim via email dan JANGAN expose token (T10).

Uji manual RBAC:

  1. Daftar 2 akun berbeda -> masing-masing `GET /api/client/summary`
     hanya hitung miliknya.
  2. Client `GET /api/admin/summary` -> 403 `admin_saja`; tanpa cookie -> 401.
  3. `UPDATE users SET role='admin'` -> login ulang -> `/api/admin/summary` 200.
  4. Reset: request -> confirm -> session lama mati, password baru jalan.

Otomatis: `npm test --workspace=worker` (11 test: auth, RBAC, scoping, reset).

## Invoice engine + cetak/PDF (T5)

Engine: `worker/src/lib/invoices.js` — nomor unik `INV/YYYY/MM/NNNN`,
langganan once/monthly/yearly (periode ikut produk), status
unpaid/paid/overdue/cancelled dengan transisi dijaga, PPN 11% default
(tanpa float, semua INTEGER rupiah), riwayat via `audit_logs`.

API (`/api/invoices`, auth session T3 — client: miliknya, admin: semua):

  POST /api/invoices {orderId}       terbit dari order/langganan (client atas
                                     miliknya, admin atas apa pun)
  POST /api/invoices {userId,items}  invoice manual multi-item (admin saja)
  GET  /api/invoices[?status][?userId(admin)]   daftar/riwayat
  GET  /api/invoices/:id             detail + items + riwayat
  GET  /api/invoices/:id/print       halaman cetak/PDF (HTML siap print,
                                     tombol Cetak -> Save as PDF)
  POST /api/invoices/:id/pay         tandai lunas manual (admin; T6 webhook
                                     memakai `markInvoicePaid()` langsung)
  POST /api/invoices/:id/cancel      batalkan (pemilik/admin)
  POST /api/invoices/sweep           tandai overdue (admin; dipakai cron T8
                                     via `sweepOverdue()`, idempotent)

Frontend: halaman `/invoices/` (daftar + filter status + tombol Cetak/PDF
per invoice), ditautkan dari Area Client; build multipage Vite
(entri `main` + `invoices` — T4/T7 menambah `/client/`, `/admin/`).
Cetak rapi: kop + badge status + tabel rincian + subtotal/pajak/total (Rp).

Uji manual:

  1. Client order produk monthly -> `POST /api/invoices {orderId}` ->
     nomor `INV/...`, `total = amount + round(amount*0.11)`.
  2. `GET /api/invoices/1/print` -> HTML ada nomor + total + window.print.
  3. Admin `POST /:id/pay` -> paid; client pay -> 403; paid -> cancel 409.
  4. Client lain `GET /:id` -> 403; anon -> 401.

Otomatis: `npm test --workspace=worker` (+9 test T5: total/pajak, terbit
once/monthly/yearly, lifecycle, scoping, print, invoice manual admin).

Untuk T6 (webhook): panggil `markInvoicePaid(db, id, {actorUserId, ip})`
dari `worker/src/lib/invoices.js` — JANGAN tandai via SQL mentah agar
transisi + audit + `paid_at` konsisten. Untuk T8 (cron): pakai
`createInvoice()` + `sweepOverdue()` dari lib yang sama.

## Pembayaran QRIS + webhook auto-lunas (T6)

Adapter: `worker/src/lib/payments.js` — `simulated` (tanpa key, QR
`QRIS-SIM:<ref>:<nominal>`, TTL 30 mnt) | `xendit` (QR Code API
`api.xendit.co/qr_codes`, callback `x-callback-token`) | `midtrans`
(Core API charge QRIS, notifikasi signature SHA-512
`order_id+status_code+gross_amount+ServerKey`). Pilih via
`QRIS_PROVIDER` (default `simulated`); tanpa key, adapter real
menolak dengan `PROVIDER_KEY_MISSING` (tetap aman di dev).

API (auth session T3 — client: miliknya, admin: semua; webhook publik
dengan verifikasi signature):

  POST /api/payments {invoiceId}   buat QR (QR hidup dipakai ulang) / 201
  GET  /api/payments/:ref          cek status bayar
  GET  /api/payments/by-invoice/:id payment terbaru satu invoice
  POST /api/payments/simulate {ref} simulasi lunas sandbox (login wajib,
                                   hanya bila QRIS_PROVIDER=simulated)
  GET  /api/invoices/:id/pay       halaman bayar HTML: QR + countdown +
                                   cek status tiap 5 dtk + tombol sandbox
  POST /api/webhooks/xendit        callback Xendit -> auto-lunas
  POST /api/webhooks/midtrans      notifikasi Midtrans -> auto-lunas
  POST /api/webhooks/simulated     webhook sandbox (X-Webhook-Secret)

Webhook idempotent dua lapis: `webhook_events` UNIQUE(provider,
event_id) -> replay jawab `{duplicate:true}` tanpa efek ganda; invoice
yang sudah lunas tidak di-mark ulang. Nominal tak cocok -> 409,
signature salah -> 401, ref tak dikenal -> 404. Saat lunas: payment
paid + invoice paid (via `markInvoicePaid`) + order terkait paid +
audit `payment.paid`/`invoice.paid` + payload mentah tersimpan di
`raw_callback_json`. Migrasi: `migrations/0003_payments_webhook.sql`.

Frontend: tombol "Bayar QRIS" di `/invoices/` (hanya unpaid/overdue);
QR digambar lokal via `frontend/public/vendor-qrcode.min.js` (tanpa
CDN, ramah offline/CSP).

Secrets produksi (`wrangler secret put`, JANGAN commit): `XENDIT_API_KEY`
+ `XENDIT_CALLBACK_TOKEN` (bila xendit), `MIDTRANS_SERVER_KEY` (bila
midtrans), `WEBHOOK_SECRET` (disarankan; fallback `SESSION_SECRET`
hanya dev).

Uji manual (sandbox, D1 lokal):

  1. Client order -> `POST /api/invoices {orderId}` -> `POST
     /api/payments {invoiceId}` -> `qr_payload: QRIS-SIM:<ref>:<total>`.
  2. Buka `GET /api/invoices/:id/pay` -> QR + countdown + cek status.
  3. `POST /api/webhooks/simulated` (header `X-Webhook-Secret`) ->
     invoice `paid`, payment `paid`, log `payment.paid` tersimpan.
  4. Kirim webhook sama lagi -> `duplicate:true`, audit tak bertambah.

Otomatis: `npm test --workspace=worker` (+12 test T6: charge sandbox,
auto-lunas + log, replay idempotent, signature/nominal/ref, halaman
bayar, reuse QR + 409, simulate, RBAC, unit adapter/normalisasi).

## Cron invoice berulang + reminder (T8)

Trigger: `wrangler.toml` `[triggers] crons = ["0 1 * * *"]` (1x/hari,
cukup di free-tier). Handler `scheduled()` di `worker/src/index.js`
menjalankan `runRecurringCron()` dari `worker/src/lib/recurring.js`:

  1. Sweep: invoice `unpaid` lewat jatuh tempo -> `overdue` (idempotent).
  2. Perpanjangan: invoice langganan LUNAS (`monthly`/`yearly`, tertaut
     order) yang periodenya habis (`issued_at` + 1 bulan/tahun kalender
     <= hari ini) -> terbitkan invoice baru via `issueFromOrder()`.
     Anti-duplikat: order ber-invoice terbuka / berstatus `cancelled` /
     periode `once` dilewati; nomor unik via constraint UNIQUE.
  3. Reminder: invoice belum lunas jatuh tempo <= 3 hari -> audit
     `invoice.reminder` sekali per invoice per hari (anti spam).
  4. Ringkasan jalan diaudit sebagai `invoice.cron_run`.

Manual/QA (admin saja, dipakai T9):

  POST /api/invoices/cron-run            dry-run (rencana saja, TANPA tulis)
  POST /api/invoices/cron-run?dryRun=0   jalan asli (sama seperti scheduled)

Respons: `{ ok, dryRun, swept, issued[], skipped[], reminders[],
remindedCount, summary }` — `summary` satu baris untuk wrangler logs.

## Katalog + order + layanan client (T4)

Engine: `worker/src/lib/catalog.js` (order pending + scoping miliknya) +
`worker/src/lib/credentials.js` (kredensial WP AES-GCM at-rest via
secret `ENCRYPTION_KEY`, tampil hanya masked — username `a•••p`,
secret tak pernah tampil).

API (auth session T3 — client: miliknya, anon 401, milik orang lain 403):

  GET  /api/catalog                  katalog produk AKTIF (login wajib)
  POST /api/client/orders {slug/productId, domain, requirements, qty, notes}
                                     order website baru -> SELALU `pending`
  GET  /api/client/orders[?status]   daftar order milik sendiri
  GET  /api/client/orders/:id        detail order + layanan hasil approve (masked)
  POST /api/client/orders/:id/cancel batal (miliknya; hanya pending/awaiting_payment)
  GET  /api/client/services[?status] daftar layanan milik sendiri (MASKED)
  GET  /api/client/services/:id      detail operasional: URL, wp-admin,
                                     username termaskir, info serverless,
                                     status, expire (MASKED + audit service.viewed)

Aturan: order baru TIDAK membuat baris service — layanan muncul setelah
admin approve (T7 menulis service terenkripsi; T4 hanya membaca). Approve/
CRUD operasional milik T7 (`/api/admin/*`) — bukan di sini. Migrasi aditif:
`migrations/0003_catalog_services.sql` (domain_requested, requirements,
wp_username_masked, site_url, admin_url, serverless_info).

Frontend: halaman `/client/` (katalog kartu + form order + tabel order
dengan filter status + tombol batal + tabel layanan + panel detail),
entry Vite `client` (build `dist/client/`); ditautkan dari beranda.

Uji manual (D1 lokal, port 8899):

  1. Anon `GET /api/catalog` -> 401; login -> 200 (hanya produk aktif).
  2. `POST /api/client/orders {slug, domain, requirements}` ->
     `pending`, `domain_requested` dinormalisasi lowercase.
  3. `GET /api/client/services` -> `[]` (belum approve).
  4. Tulis service terenkripsi (simulasi approve T7) ->
     `services[0]` masked: `url`, `wp_admin_url`, `wp_username_masked`,
     `has_wp_secret:true`, `serverless.info`, TANPA kolom `*_enc`.
  5. Client lain `GET /services/1` -> 403; anon -> 401.

Otomatis: `npm test --workspace=worker` (+7 test T4: katalog, order
pending, validasi, scoping + batal, layanan masked pasca-approve,
detail order, enkripsi roundtrip/gagal-kunci-beda).

Untuk T7 (approve): tulis service dengan `encryptSecret()` dari
`worker/src/lib/credentials.js` + isi `wp_username_masked` via
`maskUsername()` — JANGAN simpan kredensial plaintext agar konsisten
dengan masking T4.

## Status scaffold (T1)

- [x] Struktur folder + wrangler (D1/R2/Cron) + frontend Vite + proxy
- [x] Cron handler terdaftar (logika invoice di T8)
- [x] T2: skema D1 penuh + seed produk (0002 + seeds/seed_products.sql)
- [x] T3: auth DB + RBAC (PBKDF2 + session DB + guard /client /admin)
- [x] T5: invoice engine + cetak/PDF (lib + /api/invoices + /invoices/)
- [x] T6: QRIS Xendit/Midtrans + webhook auto-lunas + halaman bayar (payments.js + /api/payments + /api/webhooks/* + /:id/pay + 12 test)
- [x] T8: cron invoice berulang + reminder + audit (recurring.js + scheduled + /cron-run + 12 test)
- [x] T4: katalog + order pending + layanan masked + detail operasional (catalog.js + credentials.js + /api/catalog + /api/client/orders|services + /client/ + 7 test)

## Batas free-tier (ringkas)

Workers 100k req/hari, D1 5GB + 5jt row-read/hari, R2 10GB, Cron min 1/menit
( dipakai 1x/hari). Desain hemat query; PDF on-demand; cron 1x/hari.

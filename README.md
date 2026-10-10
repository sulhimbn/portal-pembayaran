# Portal Pembayaran QRIS + Invoice (Cloudflare Free-Tier Native)

Portal client untuk jasa pembuatan/pengelolaan website: client login, lihat layanan,
order web baru, terima invoice langganan, bayar via QRIS otomatis. Admin kelola semua.
Berjalan native di Cloudflare gratis: Pages + Workers + D1 + R2 + Cron.

Bahasa UI: Indonesia.

## Struktur monorepo

  wrangler.toml          Konfig Worker API + binding D1/R2 + Cron (akar repo)
  frontend/              Pages (Vite dev, proxy /api -> Worker :8787)
    functions/api/[[path]].js  Pages Function proxy /api -> Worker produksi (T10, env API_UPSTREAM)
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

## Deploy Cloudflare dari nol (T10)

Panduan ini membawa orang baru dari clone repo sampai produksi hidup
(Worker API + D1 + R2 + Cron + Pages + webhook QRIS). Estimasi 30-60 mnt.

Arsitektur produksi:

  Browser -> Pages (frontend/dist) -> /api/* (proxy _redirects) -> Worker
  Worker -> D1 (portal-pembayaran-db) + R2 (portal-pembayaran-assets)
  Cron 1x/hari 01:00 UTC (08:00 WIB) -> invoice berulang + reminder
  Xendit/Midtrans -> POST https://<worker>/api/webhooks/{xendit,midtrans}

### 0. Prasyarat

- Akun Cloudflare gratis (dash.cloudflare.com) — satu akun cukup untuk semua.
- Node >= 20, npm >= 10, git. Cek: `node -v && npm -v`.
- `wrangler` sudah tersedia sebagai devDependency worker
  (pakai via `npx wrangler`, tanpa install global).
- Clone + install:

  git clone https://github.com/sulhimbn/portal-pembayaran.git
  cd portal-pembayaran
  npm install

- Verifikasi lokal dulu (wajib hijau sebelum deploy):

  npm test --workspace=worker       # 59 test node:test (auth, invoice, QRIS, cron, katalog, admin)
  npm run build --workspace=frontend  # 4 halaman: /, /invoices/, /client/, /admin/
  npm run db:migrate:local          # migrasi jalan di D1 lokal
  npm run db:seed:local             # 3 produk awal

### 1. Login wrangler

  npx wrangler login   # buka browser, izinkan akses akun Cloudflare

Headless/CI (tanpa browser): buat API token di dasbor
(My Profile -> API Tokens, template "Edit Cloudflare Workers") lalu:

  export CLOUDFLARE_API_TOKEN="<token>"
  export CLOUDFLARE_ACCOUNT_ID="<account-id>"

### 2. D1: buat database + migrasi + seed (remote)

  npx wrangler d1 create portal-pembayaran-db --location=apac

(`--location=apac` = latensi terkecil untuk Indonesia.)
Salin `database_id` dari output ke `wrangler.toml`
(mengganti `placeholder-ganti-setelah-wrangler-d1-create`).

Catatan migrasi ganda `0003_*` (temuan T9): repo berisi
`0003_catalog_services.sql` (T4) + `0003_payments_webhook.sql` (T6).
Keduanya independen dan ter-apply berurutan alfabetis — sudah
diverifikasi di DB fresh: 12 tabel (users, products, orders, services,
invoices, invoice_items, payments, sessions, audit_logs,
webhook_events, _scaffold + sqlite_sequence). Bila suatu versi wrangler
menolak nomor ganda, rename `0003_payments_webhook.sql` menjadi
`0005_payments_webhook.sql` (JANGAN edit isi migrasi lama) lalu ulangi.

  npm run db:migrate:remote   # wrangler d1 migrations apply DB --remote
  npm run db:seed:remote      # 3 produk awal (idempotent, aman diulang)

Verifikasi seed:

  npx wrangler d1 execute DB --remote --command="SELECT slug, price_idr, billing_period FROM products;"
  # ekspektasi 3 baris: paket-web-berita-wp|3500000|once,
  # paket-serverless|149000|monthly, maintenance-bulanan|499000|monthly

### 3. R2: bucket aset

  npx wrangler r2 bucket create portal-pembayaran-assets

(Alternatif: dasbor Cloudflare -> R2 Object Storage -> Create bucket,
nama SAMA PERSIS `portal-pembayaran-assets` sesuai binding di
`wrangler.toml`.) Dipakai untuk logo/bukti bayar/PDF; health check
melaporkan `r2=up` bila binding cocok. Tanpa bucket, API tetap jalan
tapi `/api/health` melaporkan `r2` error.

### 4. Secrets produksi (JANGAN commit, JANGAN taruh di README)

Buat nilai acak (min 32 char untuk SESSION_SECRET):

  openssl rand -base64 48   # jalankan 3x untuk 3 secret berbeda

Wajib:

  npx wrangler secret put SESSION_SECRET    # min 32 char (fallback webhook sandbox + kontrak sesi)
  npx wrangler secret put WEBHOOK_SECRET    # header X-Webhook-Secret untuk /api/webhooks/simulated
  npx wrangler secret put ENCRYPTION_KEY    # AES-GCM kredensial WP client at-rest

Sesuai provider QRIS (`QRIS_PROVIDER` di `wrangler.toml [vars]`,
default `simulated`):

  # Bila QRIS_PROVIDER=xendit:
  npx wrangler secret put XENDIT_API_KEY
  npx wrangler secret put XENDIT_CALLBACK_TOKEN   # sama dengan token callback di dasbor Xendit
  # Bila QRIS_PROVIDER=midtrans:
  npx wrangler secret put MIDTRANS_SERVER_KEY
  # + set MIDTRANS_IS_PRODUCTION=true di [vars] bila sudah produksi (default sandbox)

Non-interaktif (CI): `echo -n "$NILAI" | npx wrangler secret put NAMA`.

PERINGATAN:
- Tanpa `ENCRYPTION_KEY`, worker memakai fallback dev yang JELAS bukan
  untuk produksi. Data yang terenkripsi dengan satu key TIDAK bisa dibuka
  setelah key diganti — tetapkan sekali, simpan di password manager.
- Tanpa `WEBHOOK_SECRET`, webhook sandbox fallback ke `SESSION_SECRET`
  (hanya untuk dev).
- `QRIS_PROVIDER=xendit|midtrans` tanpa key -> charge gagal
  `PROVIDER_KEY_MISSING` (aman, tapi pembayaran mati). Mulai dari `simulated`.

### 5. Deploy Worker + health check

  npm run deploy --workspace=worker   # wrangler deploy

Catat URL: `https://portal-pembayaran-api.<akun>.workers.dev`.
Penggantian `QRIS_PROVIDER`/vars lain di `wrangler.toml` butuh deploy
ulang (vars ikut terkirim saat deploy; secrets TIDAK perlu diulang).

  curl https://<worker>/api/health
  # ekspektasi: {"ok":true,"bindings":{"d1":"up","r2":"up",...},"qris_provider":"simulated"}

`d1`/`r2` harus `up`. Bila `missing`/error, binding di `wrangler.toml`
belum cocok (cek nama bucket / database_id).

### 6. Admin pertama

Register SELALU membuat role `client` (injeksi role diabaikan backend).
Daftarkan satu akun via frontend (atau `POST /api/auth/register`),
lalu promosikan via SQL:

  npx wrangler d1 execute DB --remote --command="UPDATE users SET role='admin' WHERE email='anda@contoh.id';"

Login ulang -> `GET /api/admin/summary` harus 200 (sebelumnya 403).

### 7. Deploy Pages + sambung API

Frontend memakai path relatif `/api/*`, jadi di produksi Pages harus
mem-proxy `/api` ke Worker (satu origin = cookie sesi `SameSite=Lax`
tetap terkirim; JANGAN fetch langsung ke `*.workers.dev` dari browser
karena cookie beda origin).

1. Dasbor Cloudflare -> Pages -> Create -> Connect to Git -> pilih repo.
2. Framework preset: None/Vite. Root directory: `frontend/`.
   Build command: `npm run build`. Output directory: `dist`.
   (Build menghasilkan 4 halaman: `/`, `/invoices/`, `/client/`, `/admin/`.
   Folder `frontend/functions/` ikut ter-deploy sebagai Pages Functions.)
3. Proxy API (WAJIB untuk cookie sesi): Pages Function
   `frontend/functions/api/[[path]].js` meneruskan `/api/*` ke Worker
   sehingga browser satu origin. Set env var Pages:
   Pages -> Settings -> Environment Variables -> `API_UPSTREAM` =
   `https://portal-pembayaran-api.<akun>.workers.dev` (tanpa `/api`).
   Tanpa ini `/api/*` menjawab 500 `api_upstream_belum_dikonfigurasi`.
   Tiap rute adalah file HTML nyata (multipage), jadi TIDAK perlu aturan
   SPA fallback.
4. Buka `https://<project>.pages.dev` -> Status API di beranda harus
   hijau; register/login harus jalan (cookie same-origin via proxy).

Domain sendiri (opsional): Pages -> Custom domains + Worker -> Routes
(mis. `api.domainanda.id/*`); ganti target `_redirects` ke domain API.

### 8. Webhook Xendit / Midtrans (auto-lunas)

Tetap di `simulated` sampai dua hal ini selesai, lalu ganti
`QRIS_PROVIDER` + deploy ulang.

Xendit (dasbor -> Settings -> Webhooks/Callback):
- Callback URL: `https://<worker>/api/webhooks/xendit`
- Token callback = nilai `XENDIT_CALLBACK_TOKEN`
  (header `x-callback-token`; salah -> 401, nominal beda -> 409,
  ref asing -> 404; replay event jawab `{duplicate:true}` tanpa efek ganda).

Midtrans (dasbor MAP -> Settings -> Configuration):
- Payment Notification URL: `https://<worker>/api/webhooks/midtrans`
- Finish/Unfinish/Error URL: `https://<pages>/invoices/`
- Signature = SHA-512(`order_id+status_code+gross_amount+ServerKey`).

Uji dengan mode `simulated` dulu dari halaman bayar
(`GET /api/invoices/:id/pay` -> tombol Simulasi Bayar), lalu kirim
webhook yang sama 2x untuk membuktikan idempotent sebelum go-live.

### 9. Cron invoice berulang + reminder

`wrangler.toml [triggers] crons = ["0 1 * * *"]` = 1x/hari 01:00 UTC
(08:00 WIB): sweep overdue -> terbitkan perpanjangan langganan lunas
yang periodenya habis (anti-duplikat) -> reminder H-3 (1x/hari) ->
audit `invoice.cron_run`. Cron AKTIF OTOMATIS saat Worker production
di-deploy (cek: Worker -> Triggers -> Cron). Catatan: cron TIDAK jalan
di preview deployment — uji manual via endpoint admin:

  POST /api/invoices/cron-run            # dry-run (rencana saja, tanpa tulis)
  POST /api/invoices/cron-run?dryRun=0   # jalan asli (sama seperti scheduled)

Pantau: `npx wrangler tail` (log `[cron] selesai: ...`).

### 10. Verifikasi end-to-end produksi (acceptance T10)

Orang baru yang mengikuti README sampai sini harus bisa mencentang semua:

- [ ] `/api/health` -> `d1=up`, `r2=up`.
- [ ] Register 2 akun -> masing-masing `/api/client/summary` hanya miliknya.
- [ ] Client `GET /api/admin/summary` -> 403; anon -> 401.
- [ ] Katalog tampil (login), order baru `pending`, domain ternormalisasi lowercase.
- [ ] Admin approve -> layanan muncul MASKED (tanpa kolom `*_enc` di respons).
- [ ] Invoice terbit (total + PPN 11% benar), nomor unik, halaman cetak OK.
- [ ] Halaman bayar QR tampil + countdown; webhook -> `paid`; replay ->
      `duplicate:true`, audit tak bertambah ganda.
- [ ] Webhook secret salah -> 401; nominal beda -> 409.
- [ ] `cron-run` dry-run -> rencana tanpa tulis; `dryRun=0` -> renewal 1x anti-duplikat.
- [ ] Tidak ada secret/kredensial di respons API mana pun.
- [ ] `git status` bersih: `.dev.vars`, `dist/`, `node_modules/`, `.wrangler/` tak ter-track.

### 11. Batas free-tier & operasi hemat

| Layanan | Batas gratis | Pemakaian portal |
|---|---|---|
| Workers | 100k req/hari | API ringan; status bayar dicek via D1, bukan hit provider berulang |
| D1 | 5 GB + 5 jt row-read/hari | 12 tabel; list admin 1 query/halaman; health hanya `SELECT 1` |
| R2 | 10 GB | Logo/bukti/PDF; PDF invoice on-demand (tombol cetak), bukan disimpan massal |
| Cron | min 1/menit | Dipakai 1x/hari 01:00 UTC — jauh di bawah batas |
| Pages | 500 build/bln | Rebuild hanya saat push (cek batas terbaru di dasbor) |

Bila mendekati batas: kurangi polling halaman bayar (default 5 dtk),
hemat query list, atau naik ke Workers Paid.

### 12. Keamanan produksi

- Semua secret via `wrangler secret put`; `.dev.vars` TIDAK PERNAH
  di-commit (sudah di `.gitignore`; `git status` harus bersih).
- `SESSION_SECRET` min 32 char, rotasi berkala; `ENCRYPTION_KEY` JANGAN
  diganti sembarangan (ciphertext lama menjadi yatim tak terbaca).
- Reset password masih MODE DASAR: token dikembalikan di respons API
  agar bisa diuji. Produksi serius: kirim token via email dan hapus dari
  respons (lihat `worker/src/routes/auth.js`, komentar `T10`).
- Webhook selalu verifikasi signature (401 bila salah); payload mentah
  tersimpan di `webhook_events.raw_json` untuk audit/forensik.
- Cookie sesi: `HttpOnly; SameSite=Lax; Secure` (otomatis di https),
  TTL 7 hari; reset password mencabut semua sesi lama.
- Kredensial WP client terenkripsi at-rest, tampil masked, akses
  diaudit. JANGAN log password di worker/test/audit.

### 13. Troubleshooting

| Gejala | Penyebab umum | Perbaikan |
|---|---|---|
| `database_id` masih placeholder | Lupa salin setelah `d1 create` | Isi `wrangler.toml`, deploy ulang |
| Migrasi 0003 ganda ditolak | Versi wrangler ketat nomor duplikat | Rename `0003_payments_webhook.sql` -> `0005_...`, ulangi migrate |
| health `d1`/`r2` error | Nama bucket / ID salah | Samakan dengan `wrangler.toml` |
| Cookie hilang di Pages | Fetch langsung ke workers.dev atau API_UPSTREAM kosong | Set `API_UPSTREAM` Pages + pastikan proxy Functions aktif (same-origin) |
| `PROVIDER_KEY_MISSING` | Provider real tanpa key | Set secret provider atau kembali `simulated` |
| Webhook 401 | Header/token salah | Samakan token dasbor provider dengan secret |
| Cron tak jalan | Diuji di preview deployment | Cron hanya di production; uji via `cron-run` |
| Build Pages gagal | Root dir salah | Root `frontend/`, build `npm run build`, output `dist` |

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
- [x] T10: deploy guide Cloudflare dari nol (README 14 langkah + Pages Function proxy /api + checklist acceptance + batas free-tier)

## Batas free-tier (ringkas)

Workers 100k req/hari, D1 5GB + 5jt row-read/hari, R2 10GB, Cron min 1/menit
( dipakai 1x/hari). Desain hemat query; PDF on-demand; cron 1x/hari.
Detail + tabel operasi: lihat langkah 11 di "Deploy Cloudflare dari nol (T10)".

# Portal Pembayaran QRIS — Panduan Agent

Hermes: saat kerja di repo ini, ikuti aturan di bawah. Bahasa UI: Indonesia.
Stack: Cloudflare free-tier native (Pages + Workers + D1 + R2 + Cron).

## 1. Struktur monorepo

  wrangler.toml          Worker API + binding D1/R2 + Cron (akar repo)
  frontend/              Pages (Vite). src/main.js, src/invoices.js,
                         public/client/, public/admin/, invoices/
  worker/src/index.js    Router + CORS + scheduled handler. HOTSPOT:
                         disentuh T3 dan T5 — edit minimal, jangan tulis ulang.
  worker/src/lib/        password.js, session.js, auth.js
                         (requireUser, requireAdmin, requireOwnership),
                         invoices.js ( dipakai T6/T8, jangan duplikat logika )
  worker/src/routes/     health.js, auth.js, invoices.js
  worker/test/           fake-db*.js + *.test.js (node:test)
  migrations/            Migrasi D1 berurut. seeds/ = seed SQL terpisah.

## 2. Perintah wajib

  npm install
  npm run dev                        # web :5173 + api :8787 (paralel)
  npm test --workspace=worker         # node:test, harus hijau sebelum done
  wrangler d1 migrations apply DB --local   # verifikasi migrasi lokal
  curl localhost:8787/api/health      # d1=up r2=up = sehat

E2E endpoint baru wajib via curl ke wrangler dev --local (bukti di handoff).

## 3. Aturan D1

- Satu perubahan skema = SATU file baru berurut (0003_....sql, dst).
- JANGAN edit file migrasi lama yang sudah ter-apply.
- Seed WAJIB idempotent (INSERT OR IGNORE); re-run tidak boleh duplikat.
- Pakai FK + CHECK constraint; seed produk: Paket Web Berita WP,
  Serverless, Maintenance.
- Hemat query: D1 gratis dibatasi (5 jt row-read/hari).

## 4. Secrets — JANGAN commit key

- JANGAN taruh API key, token, atau password di kode, README, atau git history.
- Lokal: `.dev.vars` (diignore). Produksi: `wrangler secret put`
  (SESSION_SECRET min 32 char, XENDIT_API_KEY atau MIDTRANS_SERVER_KEY,
  ENCRYPTION_KEY).
- `QRIS_PROVIDER=simulated` sampai key sandbox asli tersedia (butuh T6).

## 5. Kredensial WP/serverless milik client

- Wajib terenkripsi at-rest (ENCRYPTION_KEY). Tampil masked di UI.
- Hanya pemilik layanan + admin yang boleh baca. JANGAN log password
  di console worker, test, atau audit_logs. Catat akses di audit.

## 6. Branch + commit

- Branch: `feat-nama-fitur` (contoh: feat-invoice-qris).
- Pesan: `Tx: deskripsi` (contoh: `T6: adapter QRIS Xendit + webhook`).
- Satu kartu = satu commit fokus. Commit HANYA file milik task-mu;
  jangan `git add -A` bila ada perubahan task lain yang belum commit
  (pernah terjadi T3/T5 di worker/src/index.js — yang menabrak diawetkan).
- Sebelum complete: `git status` bersih dari file tak terkait.

## 7. Batas free-tier

- Workers 100k req/hari, D1 5 GB, R2 10 GB, Cron cukup 1x/hari
  (`0 1 * * *` untuk invoice berulang + reminder).
- PDF invoice generate on-demand (tombol cetak/window.print),
  bukan disimpan massal di R2.

## 8. Checklist sebelum declare done

- [ ] `node --test` hijau (tambah test untuk kode baru, bukan snapshot kosong)
- [ ] `wrangler dev --local` + curl endpoint baru OK (cantumkan bukti)
- [ ] RBAC: 401 anon, 403 salah peran, scoping per-user (untuk /api/client/*)
- [ ] Webhook (bila ada): signature palsu DITOLAK, double-delivery idempotent
- [ ] `git status` bersih, tidak ada secret, dist/node_modules/.wrangler tak ke-track
- [ ] Handoff ke task downstream di metadata (file hotspot, fungsi reuse)

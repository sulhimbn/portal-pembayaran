-- seeds/seed_products.sql — Seed produk awal (T2). Idempotent: aman dijalankan ulang.
-- Cara pakai: npm run db:seed:local   (produksi/remote: npm run db:seed:remote)

INSERT OR IGNORE INTO products
  (slug, name, description, price_idr, billing_period, features_json, is_active, sort_order)
VALUES
  ('paket-web-berita-wp', 'Paket Web Berita WordPress',
   'Jasa pembuatan website berita WordPress siap tayang: domain, setup hosting, tema berita, dan pelatihan kelola konten.',
   3500000, 'once',
   '["Domain .com 1 tahun","Setup hosting + SSL","Tema berita premium","3 halaman statis + blog","Pelatihan kelola konten","Garansi revisi 14 hari"]',
   1, 10),
  ('paket-serverless', 'Paket Serverless Cloudflare',
   'Hosting modern tanpa server di Cloudflare: cepat dan hemat, cocok untuk company profile dan landing page.',
   149000, 'monthly',
   '["Deploy Cloudflare Pages/Workers","Database D1 + storage R2","Monitoring uptime","Update keamanan rutin"]',
   1, 20),
  ('maintenance-bulanan', 'Maintenance Bulanan',
   'Perawatan rutin website Anda: backup, update, laporan bulanan, plus support prioritas.',
   499000, 'monthly',
   '["Backup mingguan","Update plugin dan tema","Laporan kesehatan bulanan","Support prioritas via chat"]',
   1, 30);

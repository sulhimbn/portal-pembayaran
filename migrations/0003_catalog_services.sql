-- 0003_catalog_services.sql — Kolom pendukung T4 (WS2): form order + detail operasional layanan.
-- Murni aditif (ADD COLUMN dengan DEFAULT) sehingga aman untuk DB yang sudah punya 0002.
--   orders:   domain_requested + requirements (pilihan domain + kebutuhan client di form order)
--   services: wp_username_masked (preview aman tanpa dekripsi), site_url + admin_url
--             (URL situs & wp-admin eksplisit), serverless_info (info serverless Cloudflare)

PRAGMA foreign_keys = ON;

-- ============ orders: kebutuhan form order website baru ============
ALTER TABLE orders ADD COLUMN domain_requested TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN requirements TEXT NOT NULL DEFAULT '';

-- ============ services: detail operasional + preview kredensial aman ============
ALTER TABLE services ADD COLUMN wp_username_masked TEXT NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN site_url TEXT NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN admin_url TEXT NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN serverless_info TEXT NOT NULL DEFAULT '';

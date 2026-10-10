-- 0004_admin_panel.sql — T7 (WS4): indeks panel admin.
-- Murni aditif (CREATE INDEX IF NOT EXISTS) sehingga aman untuk DB yang
-- sudah punya 0001/0002 + kedua 0003 (katalog T4 + payments T6).
-- JANGAN edit file migrasi lama. Kolom operasional layanan (site_url,
-- admin_url, serverless_info, wp_username_masked) sudah ada dari
-- 0003_catalog_services.sql T4 — di sini hanya indeks baca admin
-- (hemat D1: filter status/order/user tetap 1 query per list).

PRAGMA foreign_keys = ON;

-- Order: filter status + urut terbaru untuk antrean approve.
CREATE INDEX IF NOT EXISTS idx_orders_status_admin ON orders(status, id);

-- Layanan: lookup hasil approve per order + filter status.
CREATE INDEX IF NOT EXISTS idx_services_order ON services(order_id);
CREATE INDEX IF NOT EXISTS idx_services_status_admin ON services(status, id);

-- Invoice: tautan order/layanan + filter status untuk verifikasi manual.
CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status_admin ON invoices(status, id);

-- Pembayaran: riwayat bayar per client untuk panel admin.
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, status);

-- Audit: jejak aksi admin per pelaku.
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id, created_at);

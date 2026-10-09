-- T1 placeholder: tabel penanda agar `wrangler d1 migrations apply --local` terverifikasi jalan.
-- T2 mengganti dengan skema penuh: users, products, orders, services, invoices, payments, audit.
CREATE TABLE IF NOT EXISTS _scaffold (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO _scaffold (note) VALUES ('t1-scaffolding-ok');

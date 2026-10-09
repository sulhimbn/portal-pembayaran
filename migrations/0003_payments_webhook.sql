-- 0003_payments_webhook.sql — T6 (WS3): idempotency webhook + index lookup payment.
-- payments sudah ada di 0002. Webhook QRIS (Xendit/Midtrans/simulated) wajib
-- idempotent: replay event yang sama -> duplicate:true tanpa efek ganda.
-- Kunci: UNIQUE(provider, event_id) di webhook_events + provider_ref UNIQUE di payments.

-- Jejak setiap event webhook yang sudah diproses (kunci idempotency).
CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'simulated'
    CHECK (provider IN ('simulated', 'xendit', 'midtrans')),
  event_id TEXT NOT NULL,
  payment_ref TEXT NOT NULL DEFAULT '',
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (provider, event_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_payment_ref ON webhook_events(payment_ref);

-- Lookup cepat webhook -> payment via provider_ref (kolom + UNIQUE sudah di 0002).
CREATE INDEX IF NOT EXISTS idx_payments_provider_ref ON payments(provider_ref);
CREATE INDEX IF NOT EXISTS idx_payments_invoice_status ON payments(invoice_id, status);

// T5 — FakeDB khusus invoice (terpisah dari fake-db.js milik T3 agar tidak tabrakan).
// Stub D1 minimal untuk node:test: users, sessions, products, orders, services,
// invoices, invoice_items, audit_logs. Mendukung pola SQL persis di lib/invoices.js
// + lookup auth/session + lookup print/billedTo.

import { sha256Hex } from "../src/lib/session.js";

export class InvoiceFakeDB {
  constructor() {
    this.users = [];
    this.sessions = [];
    this.products = [];
    this.orders = [];
    this.services = [];
    this.invoices = [];
    this.invoice_items = [];
    this.audit_logs = [];
    this.payments = [];
    this.webhook_events = [];
    this._seq = { user: 1, product: 1, order: 1, service: 1, invoice: 1, item: 1, audit: 1, payment: 1, webhook: 1 };
  }

  addUser({ email, name = "User", role = "client", status = "active" }) {
    const id = this._seq.user++;
    const u = { id, email: email.toLowerCase(), name, phone: "", role, status };
    this.users.push(u);
    return u;
  }

  addProduct({ name, price_idr, billing_period = "once" }) {
    const id = this._seq.product++;
    const p = { id, name, price_idr, billing_period };
    this.products.push(p);
    return p;
  }

  addOrder({ user_id, product_id, qty = 1, status = "pending" }) {
    const id = this._seq.order++;
    const o = { id, user_id, product_id, qty, status };
    this.orders.push(o);
    return o;
  }

  async loginAs(user) {
    const token = `tok-${user.id}-${Math.random().toString(36).slice(2)}`;
    const token_hash = await sha256Hex(token);
    this.sessions.push({
      token_hash,
      user_id: user.id,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    });
    return `portal_session=${encodeURIComponent(token)}`;
  }

  prepare(sql) {
    const q = String(sql).replace(/\s+/g, " ").trim();
    const low = q.toLowerCase();
    const self = this;
    return {
      bind(...params) {
        return {
          async first() {
            return self._first(low, params);
          },
          async run() {
            return self._run(low, params);
          },
          async all() {
            return self._all(low, params);
          },
        };
      },
      async first() {
        return self._first(low, []);
      },
      async run() {
        return self._run(low, []);
      },
      async all() {
        return self._all(low, []);
      },
    };
  }

  _first(low, p) {
    // SELECT MAX(id) AS maxId FROM invoices
    if (low.includes("select max(id)")) {
      const max = this.invoices.reduce((m, r) => Math.max(m, r.id), 0);
      return { maxId: max };
    }
    // SELECT id FROM invoices WHERE number = ?
    if (low.startsWith("select id from invoices where number")) {
      const hit = this.invoices.find((r) => r.number === p[0]);
      return hit ? { id: hit.id } : null;
    }
    // SELECT ... FROM invoices WHERE id = ?
    if (low.includes("from invoices where id =")) {
      return this.invoices.find((r) => r.id === p[0]) || null;
    }
    // items by invoice
    if (low.includes("from invoice_items where invoice_id")) {
      const rows = this.invoice_items.filter((r) => r.invoice_id === p[0]).sort((a, b) => a.id - b.id);
      return rows[0] || null;
    }
    // audit history single-first (dipakai via all; first tak dipakai)
    if (low.includes("from audit_logs where entity")) {
      const rows = this.audit_logs
        .filter((r) => r.entity === "invoice" && String(r.entity_id) === String(p[0]))
        .sort((a, b) => b.id - a.id);
      return rows[0] || null;
    }
    // orders JOIN products (issueFromOrder)
    if (low.includes("from orders o join products p")) {
      const o = this.orders.find((x) => x.id === p[0]);
      if (!o) return null;
      const pr = this.products.find((x) => x.id === o.product_id);
      if (!pr) return null;
      return {
        order_id: o.id,
        user_id: o.user_id,
        qty: o.qty,
        order_status: o.status,
        product_name: pr.name,
        product_price: pr.price_idr,
        product_period: pr.billing_period,
      };
    }
    // service by order
    if (low.includes("from services where order_id")) {
      const rows = this.services.filter((s) => s.order_id === p[0]).sort((a, b) => b.id - a.id);
      return rows[0] ? { id: rows[0].id } : null;
    }
    // owner lookup
    if (low === "select user_id from orders where id = ?") {
      const o = this.orders.find((x) => x.id === p[0]);
      return o ? { user_id: o.user_id } : null;
    }
    // billedTo
    if (low.includes("select name, email from users where id")) {
      const u = this.users.find((x) => x.id === p[0]);
      return u ? { name: u.name, email: u.email } : null;
    }
    // payment by provider_ref (T6)
    if (low.includes("from payments where provider_ref =")) {
      return this.payments.find((r) => r.provider_ref === p[0]) || null;
    }
    // payment by id (T6)
    if (low.includes("from payments where id =")) {
      const row = this.payments.find((r) => r.id === p[0]);
      if (!row) return null;
      if (low.includes("raw_callback_json") && !low.includes(",")) return { raw_callback_json: row.raw_callback_json };
      return row;
    }
    // latest payment per invoice (T6: ORDER BY id DESC)
    if (low.includes("from payments where invoice_id =")) {
      const rows = this.payments.filter((r) => r.invoice_id === p[0]).sort((a, b) => b.id - a.id);
      return rows[0] || null;
    }
    // payment lookup ringan: invoice_id + user_id by ref (T6 simulate)
    if (low.includes("select invoice_id, user_id from payments where provider_ref")) {
      const row = this.payments.find((r) => r.provider_ref === p[0]);
      return row ? { invoice_id: row.invoice_id, user_id: row.user_id } : null;
    }
    // order by id ringan (T6 settle: update status paid)
    if (low.includes("select id, status, user_id from orders where id")) {
      const o = this.orders.find((x) => x.id === p[0]);
      return o ? { id: o.id, status: o.status, user_id: o.user_id } : null;
    }
    // session lookup (T3)
    if (low.includes("from sessions where token_hash")) {
      return this.sessions.find((s) => s.token_hash === p[0]) || null;
    }
    // user by id (T3)
    if (low.includes("from users where id =")) {
      const u = this.users.find((x) => x.id === p[0]);
      if (!u) return null;
      return { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role, status: u.status };
    }
    // order by id (renewal candidates)
    if (low.includes("from orders where id = ?")) {
      return this.orders.find((x) => x.id === p[0]) || null;
    }
    // product by id
    if (low.includes("from products where id = ?")) {
      return this.products.find((x) => x.id === p[0]) || null;
    }
    // reminder audit hari ini (invoice.reminder + created_at >= ?)
    if (low.includes("from audit_logs where action = 'invoice.reminder'")) {
      const dayStart = String(p[0] || "");
      const rows = this.audit_logs.filter(
        (r) => r.action === "invoice.reminder" && String(r.created_at) >= dayStart
      );
      return rows[0] || null;
    }
    // COUNT global (admin summary T3) — abaikan di sini
    return null;
  }

  _all(low, p) {
    // renewal candidates: paid langganan + JOIN (1 baris per invoice lunas)
    if (low.includes("from invoices i left join orders")) {
      const limit = Number(p[0]) || 200;
      const rows = this.invoices
        .filter((r) => ["monthly", "yearly"].includes(r.billing_period) && r.status === "paid" && r.order_id != null)
        .sort((a, b) => a.id - b.id)
        .slice(0, limit)
        .map((r) => {
          const o = this.orders.find((x) => x.id === r.order_id);
          const pr = o ? this.products.find((x) => x.id === o.product_id) : null;
          return {
            id: r.id, number: r.number, order_id: r.order_id, service_id: r.service_id,
            user_id: r.user_id, billing_period: r.billing_period, issued_at: r.issued_at,
            order_status: o ? o.status : null, order_qty: o ? o.qty : 1,
            product_name: pr ? pr.name : "Langganan", product_price: pr ? pr.price_idr : 0,
          };
        });
      return { results: rows };
    }
    // order terbuka (unpaid/overdue) — DISTINCT anti-duplikat
    if (low.includes("select distinct order_id from invoices")) {
      const seen = new Set();
      for (const r of this.invoices) {
        if (["unpaid", "overdue"].includes(r.status) && r.order_id != null) seen.add(Number(r.order_id));
      }
      return { results: [...seen].map((order_id) => ({ order_id })) };
    }
    // kandidat overdue (dry-run count): id saja
    if (low.startsWith("select id from invoices where status = 'unpaid'")) {
      const cmp = String(p[0] || "");
      const rows = this.invoices.filter((r) => r.status === "unpaid" && r.due_at < cmp);
      return { results: rows.map((r) => ({ id: r.id })) };
    }
    // reminder: invoice belum lunas, jatuh tempo <= horizon
    if (low.includes("from invoices where status in ('unpaid','overdue')")) {
      const horizon = String(p[0] || "");
      const limit = Number(p[1]) || 200;
      const rows = this.invoices
        .filter((r) => ["unpaid", "overdue"].includes(r.status) && r.due_at <= horizon)
        .sort((a, b) => (a.due_at < b.due_at ? -1 : 1))
        .slice(0, limit)
        .map((r) => ({ id: r.id, number: r.number, user_id: r.user_id, total_idr: r.total_idr, status: r.status, due_at: r.due_at }));
      return { results: rows };
    }
    // reminder-tercatat hari ini (entity_id saja)
    if (low.includes("select entity_id from audit_logs")) {
      const dayStart = String(p[0] || "");
      const rows = this.audit_logs.filter(
        (r) => r.action === "invoice.reminder" && String(r.created_at) >= dayStart
      );
      return { results: rows.map((r) => ({ entity_id: r.entity_id })) };
    }
    // items list
    if (low.includes("from invoice_items where invoice_id")) {
      const rows = this.invoice_items.filter((r) => r.invoice_id === p[0]).sort((a, b) => a.id - b.id);
      return { results: rows };
    }
    // audit history list (T6: entity payment juga dipakai settlePayment via auditPayment;
    // history invoice tetap difilter entity=invoice agar T5 tak berubah)
    if (low.includes("from audit_logs where entity")) {
      const limit = Number(p[1]) || 50;
      const rows = this.audit_logs
        .filter((r) => r.entity === "invoice" && String(r.entity_id) === String(p[0]))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
      return { results: rows };
    }
    // list invoices (dengan/tanpa filter)
    if (low.includes("from invoices")) {
      let rows = [...this.invoices];
      let i = 0;
      if (low.includes("user_id = ?")) {
        const uid = p[i++];
        rows = rows.filter((r) => r.user_id === uid);
      }
      if (low.includes("status = ?") && !low.includes("status = 'unpaid'")) {
        const st = p[i++];
        rows = rows.filter((r) => r.status === st);
      }
      rows.sort((a, b) => b.id - a.id);
      const limit = Number(p[i++]);
      const offset = Number(p[i++]);
      const lim = Number.isFinite(limit) ? limit : rows.length;
      const off = Number.isFinite(offset) ? offset : 0;
      return { results: rows.slice(off, off + lim) };
    }
    const one = this._first(low, p);
    return { results: one ? [one] : [] };
  }

  _run(low, p) {
    // INSERT invoices (12 kolom)
    if (low.startsWith("insert into invoices")) {
      const [number, user_id, order_id, service_id, amount_idr, tax_idr, total_idr, status, billing_period, issued_at, due_at, notes] = p;
      if (this.invoices.some((r) => r.number === number)) {
        throw new Error("UNIQUE constraint failed: invoices.number");
      }
      const id = this._seq.invoice++;
      const now = new Date().toISOString();
      this.invoices.push({
        id, number, user_id, order_id, service_id, amount_idr, tax_idr, total_idr,
        status, billing_period, issued_at, due_at, paid_at: null, notes, created_at: now, updated_at: now,
      });
      return { success: true, meta: { last_row_id: id } };
    }
    // INSERT invoice_items
    if (low.startsWith("insert into invoice_items")) {
      const [invoice_id, label, qty, unit_price_idr, line_total_idr] = p;
      const id = this._seq.item++;
      this.invoice_items.push({ id, invoice_id, label, qty, unit_price_idr, line_total_idr });
      return { success: true, meta: { last_row_id: id } };
    }
    // INSERT audit_logs
    if (low.startsWith("insert into audit_logs")) {
      const id = this._seq.audit++;
      const [actor_user_id, action, entity, entity_id, meta_json, ip] = p;
      this.audit_logs.push({
        id, actor_user_id, action, entity, entity_id, meta_json, ip,
        created_at: new Date().toISOString(),
      });
      return { success: true, meta: { last_row_id: id } };
    }
    // UPDATE status+paid_at (single)
    if (low.startsWith("update invoices set status = ?")) {
      const [to, paid_at, updated_at, id] = p;
      const r = this.invoices.find((x) => x.id === id);
      if (r) {
        r.status = to;
        r.paid_at = paid_at;
        r.updated_at = updated_at;
      }
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    // UPDATE sweep overdue
    if (low.includes("set status = 'overdue'")) {
      const [now, cmp] = p;
      let changes = 0;
      for (const r of this.invoices) {
        if (r.status === "unpaid" && r.due_at < cmp) {
          r.status = "overdue";
          r.updated_at = now;
          changes++;
        }
      }
      return { success: true, meta: { changes } };
    }
    // INSERT payments (T6: 10 kolom)
    if (low.startsWith("insert into payments")) {
      const [invoice_id, user_id, provider, provider_ref, qr_payload, amount_idr, fee_idr, status, expires_at, raw_callback_json] = p;
      if (provider_ref && this.payments.some((r) => r.provider_ref === provider_ref)) {
        throw new Error("UNIQUE constraint failed: payments.provider_ref");
      }
      const id = this._seq.payment++;
      const now = new Date().toISOString();
      this.payments.push({
        id, invoice_id, user_id, provider, provider_ref, qr_payload, amount_idr, fee_idr,
        status, expires_at, paid_at: null, raw_callback_json,
        created_at: now, updated_at: now,
      });
      return { success: true, meta: { last_row_id: id } };
    }
    // INSERT webhook_events (T6 idempotency: UNIQUE provider+event_id)
    if (low.startsWith("insert into webhook_events")) {
      const [provider, event_id, payment_ref, raw_json] = p;
      if (this.webhook_events.some((r) => r.provider === provider && r.event_id === event_id)) {
        throw new Error("UNIQUE constraint failed: webhook_events.provider, webhook_events.event_id");
      }
      const id = this._seq.webhook++;
      this.webhook_events.push({ id, provider, event_id, payment_ref, raw_json, created_at: new Date().toISOString() });
      return { success: true, meta: { last_row_id: id } };
    }
    // UPDATE payments -> paid/expired/failed (T6 settle)
    if (low.startsWith("update payments set status = ?")) {
      const [to, paid_at, raw, updated_at, id] = p;
      const r = this.payments.find((x) => x.id === id);
      if (r) {
        r.status = to;
        r.paid_at = paid_at;
        r.raw_callback_json = raw;
        r.updated_at = updated_at;
      }
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    // UPDATE payments kedaluwarsa saat dibaca (T6 GET status)
    if (low.startsWith("update payments set status = ?, updated_at = ?")) {
      const [to, updated_at, id] = p;
      const r = this.payments.find((x) => x.id === id);
      if (r) {
        r.status = to;
        r.updated_at = updated_at;
      }
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    // UPDATE orders -> paid (T6 settle auto-lunas order)
    if (low.startsWith("update orders set status = ?")) {
      const [to, updated_at, id] = p;
      const o = this.orders.find((x) => x.id === id);
      if (o) {
        o.status = to;
        o.updated_at = updated_at;
      }
      return { success: true, meta: { changes: o ? 1 : 0 } };
    }
    // sessions insert (loginAs langsung, tak lewat SQL) + DELETE expired (T3) — no-op aman
    if (low.startsWith("delete from sessions")) {
      return { success: true, meta: {} };
    }
    return { success: true, meta: {} };
  }
}

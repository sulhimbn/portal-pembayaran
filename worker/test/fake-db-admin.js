// T7 — FakeDB khusus panel admin (terpisah dari fake-db.js T3,
// fake-db-catalog.js T4, fake-db-invoices.js T5 agar tak tabrakan).
// Stub D1 minimal untuk node:test: users, sessions, products, orders,
// services, invoices, invoice_items, payments, audit_logs.
// Mendukung pola SQL persis di lib/admin.js + routes/admin.js +
// engine yang di-reuse (catalog/invoices/credentials/auth/session).

import { sha256Hex } from "../src/lib/session.js";

export class AdminFakeDB {
  constructor() {
    this.users = [];
    this.sessions = [];
    this.products = [];
    this.orders = [];
    this.services = [];
    this.invoices = [];
    this.invoice_items = [];
    this.payments = [];
    this.audit_logs = [];
    this._seq = { user: 1, product: 1, order: 1, service: 1, invoice: 1, item: 1, payment: 1, audit: 1 };
  }

  addUser({ email, name = "User", phone = "", role = "client", status = "active" }) {
    const id = this._seq.user++;
    const now = new Date().toISOString();
    const u = { id, email: String(email).toLowerCase(), name, phone, role, status, created_at: now, updated_at: now };
    this.users.push(u);
    return u;
  }

  addProduct({ slug, name, description = "", price_idr, billing_period = "once", features = [], is_active = 1, sort_order = 0 }) {
    const id = this._seq.product++;
    const p = { id, slug, name, description, price_idr, billing_period, features_json: JSON.stringify(features), is_active, sort_order };
    this.products.push(p);
    return p;
  }

  addOrder({ user_id, product_id, qty = 1, status = "pending", notes = "", domain_requested = "", requirements = "" }) {
    const id = this._seq.order++;
    const now = new Date().toISOString();
    const prod = this.products.find((p) => p.id === product_id);
    const o = {
      id, user_id, product_id, qty, amount_idr: (prod ? prod.price_idr : 0) * qty,
      status, notes, domain_requested, requirements, created_at: now, updated_at: now,
    };
    this.orders.push(o);
    return o;
  }

  addPayment({ invoice_id, user_id, provider = "simulated", provider_ref = null, amount_idr = 0, status = "pending" }) {
    const id = this._seq.payment++;
    const now = new Date().toISOString();
    const p = {
      id, invoice_id, user_id, provider,
      provider_ref: provider_ref || `SIM-${id}-${Date.now()}`,
      qr_payload: `qr-${id}`, amount_idr, fee_idr: 0, status,
      expires_at: new Date(Date.now() + 30 * 60e3).toISOString(), paid_at: null,
      created_at: now, updated_at: now,
    };
    this.payments.push(p);
    return p;
  }

  async loginAs(user) {
    const token = `tok-${user.id}-${Math.random().toString(36).slice(2)}`;
    const token_hash = await sha256Hex(token);
    this.sessions.push({ token_hash, user_id: user.id, expires_at: new Date(Date.now() + 7 * 864e5).toISOString(), ip: "", user_agent: "" });
    return `portal_session=${encodeURIComponent(token)}`;
  }

  _joinOrder(o) {
    const p = this.products.find((x) => x.id === o.product_id);
    const u = this.users.find((x) => x.id === o.user_id);
    return {
      id: o.id, user_id: o.user_id, product_id: o.product_id, qty: o.qty,
      amount_idr: o.amount_idr, status: o.status, notes: o.notes,
      domain_requested: o.domain_requested, requirements: o.requirements,
      created_at: o.created_at, updated_at: o.updated_at,
      user_email: u ? u.email : null, user_name: u ? u.name : null,
      product_slug: p ? p.slug : null, product_name: p ? p.name : null,
      product_price: p ? p.price_idr : null, product_period: p ? p.billing_period : null,
      // Field bentuk issueFromOrder (invoices.js) — objek gabungan agar
      // pola SQL yang sama bisa dipakai dua konsumen berbeda.
      order_id: o.id, order_status: o.status,
    };
  }

  _joinService(s) {
    const p = this.products.find((x) => x.id === s.product_id);
    const u = this.users.find((x) => x.id === s.user_id);
    return {
      ...s,
      has_wp_secret: String(s.wp_secret_enc || "").length > 0,
      user_email: u ? u.email : null, user_name: u ? u.name : null,
      product_slug: p ? p.slug : null, product_name: p ? p.name : null,
      product_period: p ? p.billing_period : null,
    };
  }

  prepare(sql) {
    const q = String(sql).replace(/\s+/g, " ").trim();
    const low = q.toLowerCase();
    const self = this;
    return {
      bind(...params) {
        return {
          async first() { return self._first(low, params); },
          async run() { return self._run(low, params, q); },
          async all() { return self._all(low, params); },
        };
      },
      async first() { return self._first(low, []); },
      async run() { return self._run(low, [], q); },
      async all() { return self._all(low, []); },
    };
  }

  _first(low, p) {
    if (low.startsWith("select 1 as one")) return { one: 1 };
    // COUNT global dashboard
    if (low.startsWith("select count(*) as n from")) {
      const table = (low.split("select count(*) as n from")[1] || "").trim().split(" ")[0];
      let rows = this[table] || [];
      if (low.includes("where status = 'pending'")) rows = rows.filter((r) => r.status === "pending");
      else if (low.includes("where status = 'active'")) rows = rows.filter((r) => r.status === "active");
      else if (low.includes("where status = 'unpaid' or status = 'overdue'")) {
        rows = rows.filter((r) => r.status === "unpaid" || r.status === "overdue");
      }
      return { n: rows.length };
    }
    // SUM piutang dashboard
    if (low.includes("coalesce(sum(total_idr)")) {
      const s = this.invoices
        .filter((r) => r.status === "unpaid" || r.status === "overdue")
        .reduce((a, r) => a + Number(r.total_idr || 0), 0);
      return { s };
    }
    if (low.includes("select max(id)")) {
      return { maxId: this.invoices.reduce((m, r) => Math.max(m, r.id), 0) };
    }
    if (low.startsWith("select id from invoices where number")) {
      const hit = this.invoices.find((r) => r.number === p[0]);
      return hit ? { id: hit.id } : null;
    }
    if (low.includes("from sessions where token_hash")) {
      return this.sessions.find((s) => s.token_hash === p[0]) || null;
    }
    if (low.includes("from users where id =")) {
      const u = this.users.find((x) => x.id === p[0]);
      if (!u) return null;
      if (low.startsWith("select email ")) return { email: u.email };
      if (low.startsWith("select name, email ")) return { name: u.name, email: u.email };
      if (low.startsWith("select id, email, role, status ")) {
        return { id: u.id, email: u.email, role: u.role, status: u.status };
      }
      return { ...u };
    }
    if (low.startsWith("select * from users where email")) {
      const u = this.users.find((x) => x.email.toLowerCase() === String(p[0] || "").toLowerCase());
      return u ? { ...u } : null;
    }
    if (low === "select id from users where email = ?") {
      const u = this.users.find((x) => x.email.toLowerCase() === String(p[0] || "").toLowerCase());
      return u ? { id: u.id } : null;
    }
    if (low.includes("from products where slug = ?")) {
      return this.products.find((x) => x.slug === p[0]) || null;
    }
    if (low.includes("from products where id = ?")) {
      if (low.startsWith("select id, slug ")) {
        const r = this.products.find((x) => x.id === p[0]);
        return r ? { id: r.id, slug: r.slug } : null;
      }
      return this.products.find((x) => x.id === p[0]) || null;
    }
    // Order JOIN produk by id (dipakai getOrder T4 + issueFromOrder T5 — objek gabungan).
    if (low.includes("from orders o join products p") && low.includes("where o.id = ?")) {
      const o = this.orders.find((x) => x.id === p[0]);
      return o ? this._joinOrder(o) : null;
    }
    if (low === "select user_id from orders where id = ?") {
      const o = this.orders.find((x) => x.id === p[0]);
      return o ? { user_id: o.user_id } : null;
    }
    // Service JOIN by id
    if (low.includes("from services s left join products p") && low.includes("where s.id = ?")) {
      const s = this.services.find((x) => x.id === p[0]);
      return s ? this._joinService(s) : null;
    }
    // Cek layanan per order (approve anti-duplikat + tautan invoice)
    if (low.startsWith("select id from services where order_id")) {
      const rows = this.services.filter((s) => s.order_id === p[0]).sort((a, b) => b.id - a.id);
      return rows[0] ? { id: rows[0].id } : null;
    }
    if (low.includes("from invoices where id =")) {
      return this.invoices.find((r) => r.id === p[0]) || null;
    }
    // Payment by id (detail admin / mark manual)
    if (low.includes("from payments py") && low.includes("where py.id = ?")) {
      const r = this.payments.find((x) => x.id === p[0]);
      if (!r) return null;
      const u = this.users.find((x) => x.id === r.user_id);
      return { ...r, user_email: u ? u.email : null };
    }
    if (low.startsWith("select id, invoice_id, user_id, status from payments where id = ?")) {
      const r = this.payments.find((x) => x.id === p[0]);
      return r ? { id: r.id, invoice_id: r.invoice_id, user_id: r.user_id, status: r.status } : null;
    }
    if (low.includes("from payments where id = ?")) {
      return this.payments.find((x) => x.id === p[0]) || null;
    }
    return null;
  }

  _all(low, p) {
    // Daftar produk (katalog + admin)
    if (low.includes("from products") && !low.includes("where id") && !low.includes("where slug")) {
      let rows = [...this.products];
      if (low.includes("is_active")) rows = rows.filter((r) => r.is_active === 1);
      rows.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
      return { results: rows };
    }
    // Layanan per order (detail order client T4 + detail order admin T7)
    if (low.includes("from services s") && low.includes("where s.order_id")) {
      const rows = this.services
        .filter((s) => s.order_id === p[0])
        .sort((a, b) => b.id - a.id)
        .map((s) => this._joinService(s));
      return { results: rows };
    }
    // Daftar layanan admin (JOIN user; filter status/user/order/q; limit/offset opsional)
    if (low.includes("from services s") && low.includes("left join users u")) {
      let rows = [...this.services];
      let i = 0;
      if (low.includes("and s.status = ?") || low.includes("where s.status = ?")) { const v = p[i++]; rows = rows.filter((s) => s.status === v); }
      if (low.includes("s.user_id = ?")) { const v = p[i++]; rows = rows.filter((s) => s.user_id === v); }
      if (low.includes("s.order_id = ?")) { const v = p[i++]; rows = rows.filter((s) => s.order_id === v); }
      if (low.includes("u.email like ?")) {
        const q = String(p[i++] || "").replace(/%/g, "").toLowerCase();
        const q2 = String(p[i++] || "").replace(/%/g, "").toLowerCase();
        const q3 = String(p[i++] || "").replace(/%/g, "").toLowerCase();
        rows = rows.filter((s) => {
          const u = this.users.find((x) => x.id === s.user_id);
          const hay = `${(u && u.email) || ""} ${s.domain || ""} ${s.label || ""}`.toLowerCase();
          return hay.includes(q) || hay.includes(q2) || hay.includes(q3);
        });
      }
      rows = rows.sort((a, b) => b.id - a.id).map((s) => this._joinService(s));
      if (low.includes("limit ?")) {
        const limit = Number(p[i++]);
        const offset = Number(p[i++]);
        rows = rows.slice(Number.isFinite(offset) ? offset : 0, (Number.isFinite(offset) ? offset : 0) + (Number.isFinite(limit) ? limit : rows.length));
      }
      return { results: rows };
    }
    // Daftar layanan milik user (jalur client T4)
    if (low.includes("from services s left join products p") && low.includes("where s.user_id")) {
      let rows = this.services.filter((s) => s.user_id === p[0]);
      let i = 1;
      if (low.includes("and s.status = ?")) { const v = p[i++]; rows = rows.filter((s) => s.status === v); }
      rows = rows.sort((a, b) => b.id - a.id).map((s) => this._joinService(s));
      const limit = Number(p[i++]);
      const offset = Number(p[i++]);
      return { results: rows.slice(Number.isFinite(offset) ? offset : 0, (Number.isFinite(offset) ? offset : 0) + (Number.isFinite(limit) ? limit : rows.length)) };
    }
    // Daftar order admin (JOIN user+produk; filter status/user/q)
    if (low.includes("from orders o left join users u")) {
      let rows = [...this.orders];
      let i = 0;
      if (low.includes("o.status = ?")) { const v = p[i++]; rows = rows.filter((o) => o.status === v); }
      if (low.includes("o.user_id = ?")) { const v = p[i++]; rows = rows.filter((o) => o.user_id === v); }
      if (low.includes("u.email like ?")) {
        const q = String(p[i++] || "").replace(/%/g, "").toLowerCase();
        const q2 = String(p[i++] || "").replace(/%/g, "").toLowerCase();
        rows = rows.filter((o) => {
          const u = this.users.find((x) => x.id === o.user_id);
          return `${(u && u.email) || ""} ${o.domain_requested || ""}`.toLowerCase().includes(q) ||
            `${(u && u.email) || ""} ${o.domain_requested || ""}`.toLowerCase().includes(q2);
        });
      }
      rows = rows.sort((a, b) => b.id - a.id).map((o) => this._joinOrder(o));
      const limit = Number(p[i++]);
      const offset = Number(p[i++]);
      return { results: rows.slice(Number.isFinite(offset) ? offset : 0, (Number.isFinite(offset) ? offset : 0) + (Number.isFinite(limit) ? limit : rows.length)) };
    }
    // Daftar order milik user (jalur client T4)
    if (low.includes("from orders o join products p") && low.includes("where o.user_id")) {
      let rows = this.orders.filter((o) => o.user_id === p[0]);
      let i = 1;
      if (low.includes("and o.status = ?")) { const v = p[i++]; rows = rows.filter((o) => o.status === v); }
      rows = rows.sort((a, b) => b.id - a.id).map((o) => this._joinOrder(o));
      const limit = Number(p[i++]);
      const offset = Number(p[i++]);
      return { results: rows.slice(Number.isFinite(offset) ? offset : 0, (Number.isFinite(offset) ? offset : 0) + (Number.isFinite(limit) ? limit : rows.length)) };
    }
    // Daftar payment admin
    if (low.includes("from payments py")) {
      let rows = [...this.payments];
      let i = 0;
      if (low.includes("py.status = ?")) { const v = p[i++]; rows = rows.filter((r) => r.status === v); }
      if (low.includes("py.user_id = ?")) { const v = p[i++]; rows = rows.filter((r) => r.user_id === v); }
      if (low.includes("py.invoice_id = ?")) { const v = p[i++]; rows = rows.filter((r) => r.invoice_id === v); }
      rows = rows.sort((a, b) => b.id - a.id).map((r) => {
        const u = this.users.find((x) => x.id === r.user_id);
        const inv = this.invoices.find((x) => x.id === r.invoice_id);
        return { ...r, user_email: u ? u.email : null, invoice_number: inv ? inv.number : null };
      });
      const limit = Number(p[i++]);
      const offset = Number(p[i++]);
      return { results: rows.slice(Number.isFinite(offset) ? offset : 0, (Number.isFinite(offset) ? offset : 0) + (Number.isFinite(limit) ? limit : rows.length)) };
    }
    // Daftar user admin (filter role/status/q)
    if (low.includes("from users") && low.includes("order by id desc limit")) {
      let rows = [...this.users];
      let i = 0;
      if (low.includes("role = ?")) { const v = p[i++]; rows = rows.filter((u) => u.role === v); }
      if (low.includes("status = ?")) { const v = p[i++]; rows = rows.filter((u) => u.status === v); }
      if (low.includes("email like ?")) {
        const q = String(p[i++] || "").replace(/%/g, "").toLowerCase();
        String(p[i++] || "");
        rows = rows.filter((u) => `${u.email} ${u.name || ""}`.toLowerCase().includes(q));
      }
      rows = rows.sort((a, b) => b.id - a.id);
      const limit = Number(p[i++]);
      const offset = Number(p[i++]);
      return { results: rows.slice(Number.isFinite(offset) ? offset : 0, (Number.isFinite(offset) ? offset : 0) + (Number.isFinite(limit) ? limit : rows.length)) };
    }
    // Item invoice
    if (low.includes("from invoice_items where invoice_id")) {
      return { results: this.invoice_items.filter((r) => r.invoice_id === p[0]).sort((a, b) => a.id - b.id) };
    }
    // Riwayat audit satu invoice (historyForInvoice T5)
    if (low.includes("from audit_logs where entity = 'invoice' and entity_id")) {
      const rows = this.audit_logs
        .filter((r) => r.entity === "invoice" && String(r.entity_id) === String(p[0]))
        .sort((a, b) => b.id - a.id)
        .slice(0, Number(p[1]) || 50);
      return { results: rows };
    }
    // Daftar audit admin (filter entity/action)
    if (low.includes("from audit_logs")) {
      let rows = [...this.audit_logs];
      let i = 0;
      if (low.includes("entity = ?")) rows = rows.filter((r) => r.entity === p[i++]);
      if (low.includes("action = ?")) rows = rows.filter((r) => r.action === p[i++]);
      rows = rows.sort((a, b) => b.id - a.id);
      const limit = Number(p[i++]);
      const offset = Number(p[i++]);
      return { results: rows.slice(Number.isFinite(offset) ? offset : 0, (Number.isFinite(offset) ? offset : 0) + (Number.isFinite(limit) ? limit : rows.length)) };
    }
    // Daftar invoice (jalur T5 dipakai ulang admin)
    if (low.includes("from invoices")) {
      let rows = [...this.invoices];
      let i = 0;
      if (low.includes("user_id = ?")) rows = rows.filter((r) => r.user_id === p[i++]);
      if (low.includes("status = ?") && !low.includes("status = 'unpaid'")) rows = rows.filter((r) => r.status === p[i++]);
      rows.sort((a, b) => b.id - a.id);
      const limit = Number(p[i++]);
      const offset = Number(p[i++]);
      return { results: rows.slice(Number.isFinite(offset) ? offset : 0, (Number.isFinite(offset) ? offset : 0) + (Number.isFinite(limit) ? limit : rows.length)) };
    }
    const one = this._first(low, p);
    return { results: one ? [one] : [] };
  }

  _run(low, p, q) {
    // INSERT orders (createOrder T4: 8 kolom)
    if (low.startsWith("insert into orders")) {
      const [user_id, product_id, qty, amount_idr, status, notes, domain_requested, requirements] = p;
      const id = this._seq.order++;
      const now = new Date().toISOString();
      this.orders.push({ id, user_id, product_id, qty, amount_idr, status, notes, domain_requested, requirements, created_at: now, updated_at: now });
      return { success: true, meta: { last_row_id: id } };
    }
    if (low.startsWith("update orders set status")) {
      const [to, updated_at, id] = p;
      const r = this.orders.find((x) => x.id === id);
      if (r) { r.status = to; r.updated_at = updated_at; }
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (low.startsWith("update orders set notes")) {
      const [notes, updated_at, id] = p;
      const r = this.orders.find((x) => x.id === id);
      if (r) { r.notes = notes; r.updated_at = updated_at; }
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    // INSERT services (approve T7: 16 kolom)
    if (low.startsWith("insert into services")) {
      const [user_id, order_id, product_id, label, domain, wp_url, wp_username_enc, wp_secret_enc,
        wp_username_masked, site_url, admin_url, serverless_info, status, expires_at, created_at, updated_at] = p;
      const id = this._seq.service++;
      const s = {
        id, user_id, order_id, product_id, label, domain, wp_url, wp_username_enc, wp_secret_enc,
        wp_username_masked, site_url, admin_url, serverless_info, status, expires_at,
        created_at, updated_at,
      };
      this.services.push(s);
      return { success: true, meta: { last_row_id: id } };
    }
    // UPDATE services dinamis (adminUpdateService T7)
    if (low.startsWith("update services set")) {
      const setPart = q.slice("UPDATE services SET ".length + (q.toLowerCase().indexOf("update services set ") >= 0 ? 0 : 0));
      const whereIdx = setPart.toLowerCase().lastIndexOf(" where id = ?");
      const cols = setPart.slice(0, whereIdx).split(",").map((s) => s.split("=")[0].trim().toLowerCase());
      const id = p[p.length - 1];
      const r = this.services.find((x) => x.id === id);
      if (r) cols.forEach((c, i) => { r[c] = p[i]; });
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    // UPDATE users (adminUpdateUser T7)
    if (low.startsWith("update users set")) {
      const m = low.match(/^update users set (\w+) = \?, updated_at = \? where id = \?$/);
      const [val, updated_at, id] = p;
      const r = this.users.find((x) => x.id === id);
      if (r && m) { r[m[1]] = val; r.updated_at = updated_at; }
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    // INSERT invoices (12 kolom, T5)
    if (low.startsWith("insert into invoices")) {
      const [number, user_id, order_id, service_id, amount_idr, tax_idr, total_idr, status, billing_period, issued_at, due_at, notes] = p;
      if (this.invoices.some((r) => r.number === number)) throw new Error("UNIQUE constraint failed: invoices.number");
      const id = this._seq.invoice++;
      const now = new Date().toISOString();
      this.invoices.push({
        id, number, user_id, order_id, service_id, amount_idr, tax_idr, total_idr,
        status, billing_period, issued_at, due_at, paid_at: null, notes, created_at: now, updated_at: now,
      });
      return { success: true, meta: { last_row_id: id } };
    }
    if (low.startsWith("insert into invoice_items")) {
      const [invoice_id, label, qty, unit_price_idr, line_total_idr] = p;
      const id = this._seq.item++;
      this.invoice_items.push({ id, invoice_id, label, qty, unit_price_idr, line_total_idr });
      return { success: true, meta: { last_row_id: id } };
    }
    if (low.startsWith("update invoices set status = ?")) {
      const [to, paid_at, updated_at, id] = p;
      const r = this.invoices.find((x) => x.id === id);
      if (r) { r.status = to; r.paid_at = paid_at; r.updated_at = updated_at; }
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    // INSERT products (10 kolom, T7) + UNIQUE slug
    if (low.startsWith("insert into products")) {
      const [slug, name, description, price_idr, billing_period, features_json, is_active, sort_order, created_at, updated_at] = p;
      if (this.products.some((r) => r.slug === slug)) throw new Error("UNIQUE constraint failed: products.slug");
      const id = this._seq.product++;
      this.products.push({ id, slug, name, description, price_idr, billing_period, features_json, is_active, sort_order, created_at, updated_at });
      return { success: true, meta: { last_row_id: id } };
    }
    // UPDATE products dinamis (adminUpdateProduct T7)
    if (low.startsWith("update products set")) {
      const whereIdx = low.lastIndexOf(" where id = ?");
      const cols = low.slice("update products set ".length, whereIdx).split(",").map((s) => s.split("=")[0].trim());
      const id = p[p.length - 1];
      const r = this.products.find((x) => x.id === id);
      if (r) cols.forEach((c, i) => { r[c] = p[i]; });
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    // UPDATE payments manual (adminMarkPayment T7)
    if (low.startsWith("update payments set status = ?")) {
      const [to, paid_at, updated_at, id] = p;
      const r = this.payments.find((x) => x.id === id);
      if (r) { r.status = to; r.paid_at = paid_at; r.updated_at = updated_at; }
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (low.startsWith("insert into audit_logs")) {
      const id = this._seq.audit++;
      const [actor_user_id, action, entity, entity_id, meta_json, ip] = p;
      this.audit_logs.push({ id, actor_user_id, action, entity, entity_id, meta_json, ip, created_at: new Date().toISOString() });
      return { success: true, meta: { last_row_id: id } };
    }
    return { success: true, meta: {} };
  }
}

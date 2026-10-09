// T4 — FakeDB khusus katalog/order/layanan (terpisah dari fake-db.js milik T3
// dan fake-db-invoices.js milik T5 agar tidak tabrakan dengan task paralel).
// Stub D1 minimal untuk node:test: users, sessions, products, orders, services,
// audit_logs. Mendukung pola SQL persis di lib/catalog.js + routes/catalog.js
// + auth/session milik T3. Kolom 0003 (domain_requested, wp_username_masked,
// site_url, admin_url, serverless_info) selalu ada di baris FakeDB.

export class CatalogFakeDB {
  constructor() {
    this.users = [];
    this.sessions = [];
    this.products = [];
    this.orders = [];
    this.services = [];
    this.audit_logs = [];
    this._seq = { user: 1, product: 1, order: 1, service: 1, audit: 1 };
  }

  addProduct({
    slug, name, description = "", price_idr, billing_period = "once",
    features = [], is_active = 1, sort_order = 0,
  }) {
    const id = this._seq.product++;
    const p = {
      id, slug, name, description, price_idr, billing_period,
      features_json: JSON.stringify(features), is_active, sort_order,
    };
    this.products.push(p);
    return p;
  }

  addService({
    user_id, order_id = null, product_id = null, label = "", domain = "",
    wp_url = "", wp_username_enc = "", wp_secret_enc = "", wp_username_masked = "",
    site_url = "", admin_url = "", serverless_info = "",
    status = "active", expires_at = null,
  }) {
    const id = this._seq.service++;
    const now = new Date().toISOString();
    const s = {
      id, user_id, order_id, product_id, label, domain, wp_url,
      wp_username_enc, wp_secret_enc, wp_username_masked,
      site_url, admin_url, serverless_info, status, expires_at,
      created_at: now, updated_at: now,
    };
    this.services.push(s);
    return s;
  }

  setAdmin(email) {
    const u = this.users.find((x) => x.email.toLowerCase() === String(email).toLowerCase());
    if (u) u.role = "admin";
    return u;
  }

  _joinOrder(o) {
    const p = this.products.find((x) => x.id === o.product_id);
    return {
      id: o.id, user_id: o.user_id, product_id: o.product_id, qty: o.qty,
      amount_idr: o.amount_idr, status: o.status, notes: o.notes,
      domain_requested: o.domain_requested, requirements: o.requirements,
      created_at: o.created_at, updated_at: o.updated_at,
      product_slug: p ? p.slug : null, product_name: p ? p.name : null,
      product_price: p ? p.price_idr : null, product_period: p ? p.billing_period : null,
    };
  }

  _joinService(s) {
    const p = this.products.find((x) => x.id === s.product_id);
    return {
      ...s,
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
          async run() { return self._run(low, params); },
          async all() { return self._all(low, params); },
        };
      },
      async first() { return self._first(low, []); },
      async run() { return self._run(low, []); },
      async all() { return self._all(low, []); },
    };
  }

  _findUserByEmail(email) {
    const e = String(email || "").toLowerCase();
    return this.users.find((u) => u.email.toLowerCase() === e) || null;
  }

  _first(low, p) {
    if (low.startsWith("select 1 as one")) return { one: 1 };
    // Session lookup (T3)
    if (low.includes("from sessions where token_hash")) {
      return this.sessions.find((s) => s.token_hash === p[0]) || null;
    }
    // User by id
    if (low.includes("from users where id =")) {
      const u = this.users.find((x) => x.id === p[0]);
      if (!u) return null;
      if (low.startsWith("select *")) return { ...u };
      return { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role, status: u.status };
    }
    // Register exists check
    if (low === "select id from users where email = ?") {
      const u = this._findUserByEmail(p[0]);
      return u ? { id: u.id } : null;
    }
    // Login lookup
    if (low.startsWith("select * from users where email")) {
      const u = this._findUserByEmail(p[0]);
      return u ? { ...u } : null;
    }
    // Produk by id / slug
    if (low.includes("from products where id = ?")) {
      return this.products.find((x) => x.id === p[0]) || null;
    }
    if (low.includes("from products where slug = ?")) {
      return this.products.find((x) => x.slug === p[0]) || null;
    }
    // Order JOIN by id
    if (low.includes("from orders o join products p") && low.includes("where o.id = ?")) {
      const o = this.orders.find((x) => x.id === p[0]);
      return o ? this._joinOrder(o) : null;
    }
    // Service JOIN by id
    if (low.includes("from services s left join products p") && low.includes("where s.id = ?")) {
      const s = this.services.find((x) => x.id === p[0]);
      return s ? this._joinService(s) : null;
    }
    return null;
  }

  _all(low, p) {
    // Daftar produk (katalog)
    if (low.includes("from products")) {
      let rows = [...this.products];
      if (low.includes("is_active")) rows = rows.filter((r) => r.is_active === 1);
      rows.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
      return { results: rows };
    }
    // Layanan per order (detail order)
    if (low.includes("from services s left join products p") && low.includes("where s.order_id")) {
      const rows = this.services
        .filter((s) => s.order_id === p[0])
        .sort((a, b) => b.id - a.id)
        .map((s) => this._joinService(s));
      return { results: rows };
    }
    // Daftar layanan milik user
    if (low.includes("from services s left join products p") && low.includes("where s.user_id")) {
      let rows = this.services.filter((s) => s.user_id === p[0]);
      let i = 1;
      if (low.includes("and s.status = ?")) rows = rows.filter((s) => s.status === p[i++]);
      rows = rows.sort((a, b) => b.id - a.id).map((s) => this._joinService(s));
      const limit = Number(p[i++]);
      const offset = Number(p[i++]);
      const lim = Number.isFinite(limit) ? limit : rows.length;
      const off = Number.isFinite(offset) ? offset : 0;
      return { results: rows.slice(off, off + lim) };
    }
    // Daftar order milik user
    if (low.includes("from orders o join products p") && low.includes("where o.user_id")) {
      let rows = this.orders.filter((o) => o.user_id === p[0]);
      let i = 1;
      if (low.includes("and o.status = ?")) rows = rows.filter((o) => o.status === p[i++]);
      rows = rows.sort((a, b) => b.id - a.id).map((o) => this._joinOrder(o));
      const limit = Number(p[i++]);
      const offset = Number(p[i++]);
      const lim = Number.isFinite(limit) ? limit : rows.length;
      const off = Number.isFinite(offset) ? offset : 0;
      return { results: rows.slice(off, off + lim).map((r) => ({ ...r })) };
    }
    const one = this._first(low, p);
    return { results: one ? [one] : [] };
  }

  _run(low, p) {
    // INSERT users (register T3): [email, hash, name, phone, created, updated]
    if (low.startsWith("insert into users")) {
      const [email, password_hash, name, phone, created_at, updated_at] = p;
      const id = this._seq.user++;
      this.users.push({
        id, email, password_hash, name, phone,
        role: "client", status: "active",
        email_verified_at: null, reset_token_hash: null, reset_expires_at: null,
        created_at, updated_at,
      });
      return { success: true, meta: { last_row_id: id } };
    }
    if (low.startsWith("insert into sessions")) {
      const [token_hash, user_id, expires_at, ip, user_agent] = p;
      this.sessions.push({ token_hash, user_id, expires_at, ip, user_agent });
      return { success: true, meta: {} };
    }
    if (low.startsWith("delete from sessions where token_hash")) {
      this.sessions = this.sessions.filter((s) => s.token_hash !== p[0]);
      return { success: true, meta: {} };
    }
    if (low.startsWith("delete from sessions where user_id")) {
      this.sessions = this.sessions.filter((s) => s.user_id !== p[0]);
      return { success: true, meta: {} };
    }
    // INSERT orders (T4): 8 kolom
    if (low.startsWith("insert into orders")) {
      const [user_id, product_id, qty, amount_idr, status, notes, domain_requested, requirements] = p;
      const id = this._seq.order++;
      const now = new Date().toISOString();
      this.orders.push({
        id, user_id, product_id, qty, amount_idr, status, notes,
        domain_requested, requirements, created_at: now, updated_at: now,
      });
      return { success: true, meta: { last_row_id: id } };
    }
    // UPDATE orders SET status (cancel T4)
    if (low.startsWith("update orders set status")) {
      const [to, updated_at, id] = p;
      const r = this.orders.find((x) => x.id === id);
      if (r) { r.status = to; r.updated_at = updated_at; }
      return { success: true, meta: { changes: r ? 1 : 0 } };
    }
    if (low.startsWith("insert into audit_logs")) {
      const id = this._seq.audit++;
      const [actor_user_id, action, entity, entity_id, meta_json, ip] = p;
      this.audit_logs.push({
        id, actor_user_id, action, entity, entity_id, meta_json, ip,
        created_at: new Date().toISOString(),
      });
      return { success: true, meta: { last_row_id: id } };
    }
    return { success: true, meta: {} };
  }
}

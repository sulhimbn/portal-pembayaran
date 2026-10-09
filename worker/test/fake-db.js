// FakeDB — stub D1 minimal untuk node:test (tanpa wrangler).
// Mendukung pola SQL yang dipakai auth T3 + summary client/admin.

export class FakeDB {
  constructor() {
    this.users = [];
    this.sessions = [];
    this.audit_logs = [];
    this.orders = [];
    this.services = [];
    this.invoices = [];
    this._userSeq = 1;
  }

  // Helper langsung untuk test (bypass API).
  addOrder(userId) {
    this.orders.push({ user_id: userId });
  }
  setAdmin(email) {
    const u = this.users.find((x) => x.email.toLowerCase() === String(email).toLowerCase());
    if (u) u.role = "admin";
    return u;
  }

  prepare(sql) {
    const q = String(sql).replace(/\s+/g, " ").trim();
    const low = q.toLowerCase();
    const self = this;
    return {
      bind(...params) {
        return {
          async first() {
            return self._first(low, q, params);
          },
          async run() {
            return self._run(low, q, params);
          },
          async all() {
            const one = await self._first(low, q, params);
            return { results: one ? [one] : [] };
          },
        };
      },
      async first() {
        return self._first(low, q, []);
      },
      async run() {
        return self._run(low, q, []);
      },
      async all() {
        const one = await self._first(low, q, []);
        return { results: one ? [one] : [] };
      },
    };
  }

  _findUserByEmail(email) {
    const e = String(email || "").toLowerCase();
    return this.users.find((u) => u.email.toLowerCase() === e) || null;
  }

  _first(low, q, p) {
    // SELECT 1 AS one (health)
    if (low.startsWith("select 1 as one")) return { one: 1 };

    // Session lookup
    if (low.includes("from sessions where token_hash")) {
      return this.sessions.find((s) => s.token_hash === p[0]) || null;
    }
    // User by id (public fields)
    if (low.includes("from users where id =")) {
      const u = this.users.find((x) => x.id === p[0]);
      if (!u) return null;
      if (low.startsWith("select *")) return { ...u };
      return { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role, status: u.status };
    }
    // User id-only by email (register exists check)
    if (low === "select id from users where email = ?") {
      const u = this._findUserByEmail(p[0]);
      return u ? { id: u.id } : null;
    }
    // Full user by email (login)
    if (low.startsWith("select * from users where email")) {
      const u = this._findUserByEmail(p[0]);
      return u ? { ...u } : null;
    }
    // Reset lookup
    if (low.includes("from users where reset_token_hash")) {
      return this.users.find((u) => u.reset_token_hash === p[0]) || null;
    }
    // COUNT(*) ... WHERE user_id = ?
    let m = low.match(/select count\(\*\) as n from (\w+) where user_id = \?/);
    if (m) {
      const table = m[1];
      const rows = this[table] || [];
      return { n: rows.filter((r) => r.user_id === p[0]).length };
    }
    // COUNT(*) global
    m = low.match(/select count\(\*\) as n from (\w+)$/);
    if (m) {
      const table = m[1].replace(/;$/, "");
      return { n: (this[table] || []).length };
    }
    return null;
  }

  _run(low, q, p) {
    // INSERT users
    if (low.startsWith("insert into users")) {
      const [email, password_hash, name, phone, created_at, updated_at] = p;
      const id = this._userSeq++;
      this.users.push({
        id, email, password_hash, name, phone,
        role: "client", status: "active",
        email_verified_at: null, reset_token_hash: null, reset_expires_at: null,
        created_at, updated_at,
      });
      return { success: true, meta: { last_row_id: id } };
    }
    // INSERT sessions
    if (low.startsWith("insert into sessions")) {
      const [token_hash, user_id, expires_at, ip, user_agent] = p;
      this.sessions.push({ token_hash, user_id, expires_at, ip, user_agent });
      return { success: true, meta: {} };
    }
    // DELETE session by token
    if (low.startsWith("delete from sessions where token_hash")) {
      this.sessions = this.sessions.filter((s) => s.token_hash !== p[0]);
      return { success: true, meta: {} };
    }
    // DELETE sessions by user (reset confirm)
    if (low.startsWith("delete from sessions where user_id")) {
      this.sessions = this.sessions.filter((s) => s.user_id !== p[0]);
      return { success: true, meta: {} };
    }
    // UPDATE reset request
    if (low.includes("set reset_token_hash = ?")) {
      const [hash, exp, updated, id] = p;
      const u = this.users.find((x) => x.id === id);
      if (u) { u.reset_token_hash = hash; u.reset_expires_at = exp; u.updated_at = updated; }
      return { success: true, meta: {} };
    }
    // UPDATE reset confirm
    if (low.includes("set password_hash = ?")) {
      const [hash, updated, id] = p;
      const u = this.users.find((x) => x.id === id);
      if (u) {
        u.password_hash = hash;
        u.reset_token_hash = null;
        u.reset_expires_at = null;
        u.updated_at = updated;
      }
      return { success: true, meta: {} };
    }
    // INSERT audit
    if (low.startsWith("insert into audit_logs")) {
      this.audit_logs.push({ params: p });
      return { success: true, meta: {} };
    }
    return { success: true, meta: {} };
  }
}

// T7 — Halaman /admin/: dashboard angka global, antrean approve order,
// CRUD client/order/layanan/invoice/pembayaran/produk-harga + verifikasi
// manual + input kredensial operasional (site_url, admin_url, wp_username,
// wp_secret, serverless_info, status, expires_at).
// Guard tampilan saja; backend menegakkan requireAdmin (anon 401, client 403).

const $ = (s) => document.querySelector(s);

const STATUS_ORDER = {
  pending: "Menunggu verifikasi",
  awaiting_payment: "Menunggu bayar",
  paid: "Dibayar",
  processing: "Diproses",
  completed: "Selesai",
  cancelled: "Dibatalkan",
};

const STATUS_LAYANAN = {
  pending: "Menunggu",
  active: "Aktif",
  suspended: "Ditangguhkan",
  expired: "Kedaluwarsa",
};

const STATUS_INVOICE = {
  unpaid: "Belum bayar",
  paid: "Lunas",
  overdue: "Jatuh tempo",
  cancelled: "Dibatalkan",
};

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

function tanggal(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
  } catch {
    return String(iso);
  }
}

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  let j = {};
  try {
    j = await r.json();
  } catch {
    j = {};
  }
  return { status: r.status, json: j };
}

function post(path, body) {
  return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
}

function patch(path, body) {
  return api(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
}

// ---------- dashboard ----------

async function muatDashboard() {
  const box = $("#ringkasan");
  const { status, json } = await api("/api/admin/summary");
  if (status !== 200 || !json.ok) {
    box.innerHTML = "<p>Gagal memuat ringkasan.</p>";
    return;
  }
  const d = json.dashboard || {};
  const t = json.totals || {};
  box.innerHTML =
    `<div class="stat"><b>${t.users ?? "—"}</b><span>Client</span></div>` +
    `<div class="stat"><b>${t.orders ?? "—"}</b><span>Order</span></div>` +
    `<div class="stat"><b>${t.invoices ?? "—"}</b><span>Invoice</span></div>` +
    `<div class="stat"><b>${d.pendingOrders ?? "—"}</b><span>Antre approve</span></div>` +
    `<div class="stat"><b>${d.unpaidInvoices ?? "—"}</b><span>Belum bayar</span></div>` +
    `<div class="stat"><b>${rupiah(d.piutang ?? 0)}</b><span>Piutang</span></div>`;
}

// ---------- antrean approve ----------

async function muatAntrean() {
  const box = $("#antrean");
  const { status, json } = await api("/api/admin/orders?status=pending&limit=50");
  if (status !== 200 || !json.ok) {
    box.innerHTML = "<p>Gagal memuat antrean.</p>";
    return;
  }
  const rows = json.orders || [];
  if (rows.length === 0) {
    box.innerHTML = "<p>Tidak ada order menunggu. Kerja bagus.</p>";
    return;
  }
  box.innerHTML = rows
    .map(
      (o) =>
        `<div class="row"><div><b>#${o.id}</b> ${esc(o.product_name || "")} — ${esc(o.user_email || "user #" + o.user_id)}` +
        `<br /><span class="hint">${esc(o.domain || "")} · ${esc(o.notes || "")}</span></div>` +
        `<div><button data-approve="${o.id}" type="button">Setujui</button></div></div>`
    )
    .join("");
  box.querySelectorAll("[data-approve]").forEach((b) =>
    b.addEventListener("click", () => bukaApprove(Number(b.dataset.approve)))
  );
}

let orderAktif = null;

async function bukaApprove(id) {
  const { json } = await api(`/api/admin/orders/${id}`);
  const o = json.order;
  if (!o) {
    $("#approveMsg").textContent = "Order tidak ditemukan.";
    return;
  }
  orderAktif = o;
  $("#approveCard").hidden = false;
  $("#approveInfo").innerHTML =
    `<b>Order #${o.id}</b> — ${esc(o.product_name || "")}<br />` +
    `<span class="hint">Client: ${esc(o.user_email || "user #" + o.user_id)} · Domain: ${esc(o.domain || "—")}</span>`;
  $("#approveMsg").textContent = "";
  $("#approveCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function kirimApprove(ev) {
  ev.preventDefault();
  if (!orderAktif) return;
  const body = {
    site_url: $("#aSite").value.trim(),
    admin_url: $("#aAdminUrl").value.trim(),
    wp_username: $("#aWpUser").value.trim(),
    wp_secret: $("#aWpSecret").value,
    serverless_info: $("#aServerless").value.trim(),
    status: $("#aStatus").value,
    expires_at: $("#aExpire").value ? new Date($("#aExpire").value).toISOString() : null,
  };
  Object.keys(body).forEach((k) => {
    if (body[k] === "" || body[k] == null) delete body[k];
  });
  $("#approveMsg").textContent = "Menyimpan…";
  const { status, json } = await post(`/api/admin/orders/${orderAktif.id}/approve`, body);
  if (status === 201 && json.ok) {
    const s = json.service || {};
    $("#approveMsg").textContent = `Layanan #${s.id} aktif. Kredensial tersimpan terenkripsi, tampil termaskir di sisi client.`;
    orderAktif = null;
    await muatAntrean();
    await muatDashboard();
  } else {
    $("#approveMsg").textContent = `Gagal: ${json.error || json.message || status}`;
  }
}

// ---------- tabel generik ----------

async function muatTabel(path, boxId, render) {
  const box = $(boxId);
  const { status, json } = await api(path);
  if (status !== 200 || !json.ok) {
    box.innerHTML = "<p>Gagal memuat.</p>";
    return;
  }
  box.innerHTML = render(json);
}

// ---------- boot ----------

async function boot() {
  const me = await (await fetch("/api/auth/me")).json();
  if (!me.user) {
    $("#guardMsg").textContent = "Belum login — kembali ke / untuk masuk.";
    return;
  }
  if (me.user.role !== "admin") {
    $("#guardMsg").textContent = `Akses ditolak: ${me.user.email} bukan admin (backend juga menolak /api/admin/* dengan 403).`;
    return;
  }
  $("#badge").textContent = `${me.user.email} (admin)`;
  $("#guardCard").hidden = true;
  document.querySelectorAll("[data-need-admin]").forEach((el) => {
    el.hidden = false;
  });
  await muatDashboard();
  await muatAntrean();
  await muatTabel("/api/admin/services?limit=20", "#layananBaru", (j) => {
    const rows = j.services || [];
    if (!rows.length) return "<p>Belum ada layanan.</p>";
    return rows
      .map((s) => `<div class="row"><div><b>#${s.id}</b> ${esc(s.site_url || s.product_name || "")} — ${esc(s.status || "")}</div></div>`)
      .join("");
  });
  await muatTabel("/api/admin/invoices?status=unpaid&limit=20", "#invoiceBaru", (j) => {
    const rows = j.invoices || [];
    if (!rows.length) return "<p>Tidak ada invoice belum bayar.</p>";
    return rows
      .map(
        (v) =>
          `<div class="row"><div><b>${esc(v.number)}</b> — ${rupiah(v.total_idr)} · jatuh tempo ${tanggal(v.due_at)}</div>` +
          `<div><a href="/invoices/">Buka</a></div></div>`
      )
      .join("");
  });
  await muatTabel("/api/admin/payments?limit=20", "#bayarBaru", (j) => {
    const rows = j.payments || j.rows || [];
    if (!rows.length) return "<p>Belum ada pembayaran.</p>";
    return rows
      .map((p) => `<div class="row"><div><b>#${p.id}</b> ${esc(p.provider_ref || "")} — ${rupiah(p.amount_idr)} (${esc(p.status)})</div></div>`)
      .join("");
  });
  $("#approveForm").addEventListener("submit", kirimApprove);
  $("#tutupApprove").addEventListener("click", () => {
    $("#approveCard").hidden = true;
    orderAktif = null;
  });
}

boot();

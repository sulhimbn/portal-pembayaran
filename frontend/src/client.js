// T4 — Halaman /client/: katalog paket, form order website baru
// (paket + domain + kebutuhan), daftar order, daftar layanan + detail
// operasional (URL, wp-admin, username termaskir, info serverless,
// status, expire). Guard tampilan saja; backend tetap menegakkan
// session + ownership (client: miliknya, admin: boleh semua; anon: 401).

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

// ---------- katalog ----------

let katalogCache = [];

async function muatKatalog() {
  const box = $("#katalog");
  const { status, json } = await api("/api/catalog");
  if (status === 401 || !json.ok) {
    box.innerHTML = "<p>Gagal memuat katalog.</p>";
    return;
  }
  katalogCache = json.products || [];
  const sel = $("#fPaket");
  sel.innerHTML = "";
  for (const p of katalogCache) {
    const o = document.createElement("option");
    o.value = p.slug;
    o.textContent = `${p.name} — ${rupiah(p.price_idr)}${p.billing_period === "once" ? "" : "/" + p.billing_period}`;
    sel.appendChild(o);
  }
  if (katalogCache.length === 0) {
    box.innerHTML = "<p>Belum ada paket aktif.</p>";
    return;
  }
  box.innerHTML = "";
  for (const p of katalogCache) {
    const d = document.createElement("div");
    d.className = "produk";
    const fitur = (p.features || []).map((f) => `<li>${esc(f)}</li>`).join("");
    d.innerHTML =
      `<h3></h3><p class="harga"></p><p class="desk"></p>` +
      (fitur ? `<ul>${fitur}</ul>` : "") +
      `<button type="button">Pesan</button>`;
    d.querySelector("h3").textContent = p.name;
    d.querySelector(".harga").textContent =
      `${rupiah(p.price_idr)}${p.billing_period === "once" ? " (sekali bayar)" : " /" + p.billing_period}`;
    d.querySelector(".desk").textContent = p.description || "";
    d.querySelector("button").addEventListener("click", () => {
      sel.value = p.slug;
      $("#orderFormCard").scrollIntoView({ behavior: "smooth" });
      $("#fDomain").focus();
    });
    box.appendChild(d);
  }
}

// ---------- order ----------

async function kirimOrder(e) {
  e.preventDefault();
  const out = $("#orderMsg");
  out.textContent = "Mengirim…";
  const { status, json } = await api("/api/client/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slug: $("#fPaket").value,
      domain: $("#fDomain").value,
      requirements: $("#fKebutuhan").value,
      qty: Number($("#fQty").value || 1),
      notes: $("#fCatatan").value,
    }),
  });
  if (status === 201 && json.ok) {
    out.textContent = `Order #${json.order.id} tercatat sebagai “Menunggu verifikasi”. Layanan muncul setelah admin menyetujui.`;
    $("#fDomain").value = "";
    $("#fKebutuhan").value = "";
    $("#fCatatan").value = "";
    muatOrder();
  } else {
    out.textContent = "Gagal: " + (json.error || json.message || `HTTP ${status}`);
  }
}

async function muatOrder() {
  const box = $("#orderList");
  box.innerHTML = "<p>Memuat…</p>";
  const f = $("#orderFilter").value;
  const q = f ? `?status=${encodeURIComponent(f)}` : "";
  const { status, json } = await api(`/api/client/orders${q}`);
  if (status === 401) {
    box.innerHTML = "<p>Sesi habis. Masuk ulang dari beranda.</p>";
    return;
  }
  if (!json.ok) {
    box.innerHTML = `<p>Gagal memuat: ${esc(json.error || status)}</p>`;
    return;
  }
  const rows = json.orders || [];
  if (rows.length === 0) {
    box.innerHTML = "<p>Belum ada order. Pilih paket di atas untuk order pertama.</p>";
    return;
  }
  const t = document.createElement("table");
  t.innerHTML = "<thead><tr><th>ID</th><th>Paket</th><th>Domain</th><th class=\"r\">Nominal</th><th>Status</th><th></th></tr></thead>";
  const tb = document.createElement("tbody");
  for (const o of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>#${o.id}</td><td></td><td></td><td class="r">${rupiah(o.amount_idr)}</td>` +
      `<td><span class="pill order-${esc(o.status)}">${esc(STATUS_ORDER[o.status] || o.status)}</span></td>`;
    tr.children[1].textContent = o.product?.name || "—";
    tr.children[2].textContent = o.domain_requested || "—";
    const td = document.createElement("td");
    if (o.status === "pending" || o.status === "awaiting_payment") {
      const b = document.createElement("button");
      b.textContent = "Batalkan";
      b.addEventListener("click", async () => {
        if (!confirm(`Batalkan order #${o.id}?`)) return;
        const r = await api(`/api/client/orders/${o.id}/cancel`, { method: "POST" });
        if (r.json.ok) muatOrder();
        else alert("Gagal batal: " + (r.json.error || r.status));
      });
      td.appendChild(b);
    }
    tr.appendChild(td);
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  box.innerHTML = "";
  box.appendChild(t);
}

// ---------- layanan ----------

async function muatLayanan() {
  const box = $("#layananList");
  box.innerHTML = "<p>Memuat…</p>";
  const { status, json } = await api("/api/client/services");
  if (status === 401) {
    box.innerHTML = "<p>Sesi habis. Masuk ulang dari beranda.</p>";
    return;
  }
  if (!json.ok) {
    box.innerHTML = `<p>Gagal memuat: ${esc(json.error || status)}</p>`;
    return;
  }
  const rows = json.services || [];
  if (rows.length === 0) {
    box.innerHTML = "<p>Belum ada layanan. Layanan muncul setelah admin menyetujui order Anda.</p>";
    return;
  }
  const t = document.createElement("table");
  t.innerHTML = "<thead><tr><th>Layanan</th><th>URL</th><th>Status</th><th>Kedaluwarsa</th><th></th></tr></thead>";
  const tb = document.createElement("tbody");
  for (const s of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td></td><td></td>` +
      `<td><span class="pill svc-${esc(s.status)}">${esc(STATUS_LAYANAN[s.status] || s.status)}</span></td>` +
      `<td>${esc(tanggal(s.expires_at))}</td>`;
    tr.children[0].textContent = s.label || s.domain || `#${s.id}`;
    const link = document.createElement("a");
    if (s.url) {
      link.href = s.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = s.domain || s.url;
      tr.children[1].appendChild(link);
    } else {
      tr.children[1].textContent = "—";
    }
    const td = document.createElement("td");
    const b = document.createElement("button");
    b.textContent = "Detail";
    b.addEventListener("click", () => muatDetailLayanan(s.id));
    td.appendChild(b);
    tr.appendChild(td);
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  box.innerHTML = "";
  box.appendChild(t);
}

async function muatDetailLayanan(id) {
  const box = $("#layananDetail");
  box.innerHTML = "<p>Memuat…</p>";
  $("#layananDetailCard").hidden = false;
  const { status, json } = await api(`/api/client/services/${id}`);
  if (!json.ok) {
    box.innerHTML = `<p>Gagal memuat: ${esc(json.error || status)}</p>`;
    return;
  }
  const s = json.service;
  const rows = [
    ["Layanan", s.label || s.domain || `#${s.id}`],
    ["URL situs", s.url || "—"],
    ["wp-admin", s.wp_admin_url || "—"],
    ["Username WP", s.wp_username_masked || "—"],
    ["Password WP", s.has_wp_secret ? "Tersimpan aman (hubungi admin untuk akses)" : "—"],
    ["Paket", s.product?.name || "—"],
    ["Periode", s.product?.billing_period || "—"],
    ["Info serverless", s.serverless?.info || "—"],
    ["Status", STATUS_LAYANAN[s.status] || s.status],
    ["Kedaluwarsa", tanggal(s.expires_at)],
  ];
  const dl = document.createElement("dl");
  dl.className = "detail";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    if ((k === "URL situs" || k === "wp-admin") && v !== "—") {
      const a = document.createElement("a");
      a.href = v;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = v;
      dd.appendChild(a);
    } else {
      dd.textContent = v;
    }
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  box.innerHTML = "";
  box.appendChild(dl);
  $("#layananDetailCard").scrollIntoView({ behavior: "smooth" });
}

// ---------- boot + guard ----------

async function boot() {
  let me = null;
  try {
    me = (await api("/api/auth/me")).json.user || null;
  } catch {
    $("#guardMsg").textContent = "Worker belum jalan (npm run dev:worker).";
    return;
  }
  if (!me) {
    $("#guardMsg").textContent = "Belum login — kembali ke beranda untuk masuk.";
    return;
  }
  $("#badge").textContent = `${me.email} (${me.role})`;
  $("#guardCard").hidden = true;
  for (const id of ["#katalogCard", "#orderFormCard", "#orderListCard", "#layananCard"]) {
    $(id).hidden = false;
  }
  $("#orderForm").addEventListener("submit", kirimOrder);
  $("#orderFilter").addEventListener("change", muatOrder);
  $("#tutupDetail").addEventListener("click", () => {
    $("#layananDetailCard").hidden = true;
  });
  await muatKatalog();
  await muatOrder();
  await muatLayanan();
}

boot();

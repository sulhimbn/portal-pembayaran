// T5 — Halaman /invoices/: daftar + riwayat invoice client, filter status,
// tautan cetak/PDF per invoice. Guard tampilan saja; backend tetap
// menegakkan session + ownership (client: miliknya, admin: semua).

const $ = (s) => document.querySelector(s);

const STATUS = { unpaid: "Belum Bayar", paid: "Lunas", overdue: "Jatuh Tempo", cancelled: "Dibatalkan" };

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

function tanggal(iso) {
  try {
    return new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
  } catch {
    return String(iso || "-");
  }
}

async function api(path) {
  const r = await fetch(path);
  let j = {};
  try {
    j = await r.json();
  } catch {}
  return { status: r.status, json: j };
}

async function muat(filter = "") {
  const box = $("#daftar");
  box.innerHTML = "<p>Memuat…</p>";
  const q = filter ? `?status=${encodeURIComponent(filter)}` : "";
  let me = null;
  try {
    me = (await api("/api/auth/me")).json.user || null;
  } catch {
    box.innerHTML = "<p>Worker belum jalan (npm run dev:worker).</p>";
    return;
  }
  if (!me) {
    box.innerHTML = '<p>Belum login. <a href="/">Masuk dulu</a>.</p>';
    return;
  }
  const { status, json } = await api(`/api/invoices${q}`);
  if (status === 401) {
    box.innerHTML = '<p>Sesi habis. <a href="/">Masuk ulang</a>.</p>';
    return;
  }
  if (!json.ok) {
    box.innerHTML = `<p>Gagal memuat: ${json.error || status}</p>`;
    return;
  }
  const rows = json.invoices || [];
  $("#ringkas").textContent =
    rows.length === 0 ? "Belum ada invoice." : `${rows.length} invoice${filter ? ` — ${STATUS[filter] || filter}` : ""}.`;
  if (rows.length === 0) {
    box.innerHTML = "";
    return;
  }
  const t = document.createElement("table");
  t.innerHTML = `<thead><tr><th>Nomor</th><th>Terbit</th><th>Jatuh tempo</th><th class="r">Total</th><th>Status</th><th></th></tr></thead>`;
  const tb = document.createElement("tbody");
  for (const inv of rows) {
    const tr = document.createElement("tr");
    const b = document.createElement("button");
    b.textContent = "Cetak / PDF";
    b.addEventListener("click", () => window.open(`/api/invoices/${inv.id}/print`, "_blank", "noopener"));
    tr.innerHTML =
      `<td></td><td>${tanggal(inv.issued_at)}</td><td>${tanggal(inv.due_at)}</td>` +
      `<td class="r">${rupiah(inv.total_idr)}</td><td><span class="pill ${inv.status}">${STATUS[inv.status] || inv.status}</span></td>`;
    tr.children[0].textContent = inv.number;
    const td = document.createElement("td");
    td.appendChild(b);
    // T6: tombol Bayar QRIS untuk invoice yang masih bisa dibayar.
    if (inv.status === "unpaid" || inv.status === "overdue") {
      const bayar = document.createElement("button");
      bayar.textContent = "Bayar QRIS";
      bayar.style.marginLeft = "8px";
      bayar.addEventListener("click", () => window.open(`/api/invoices/${inv.id}/pay`, "_blank", "noopener"));
      td.appendChild(bayar);
    }
    tr.appendChild(td);
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  box.innerHTML = "";
  box.appendChild(t);
}

$("#filter").addEventListener("change", (e) => muat(e.target.value));
muat();

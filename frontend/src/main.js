// T3: login/register client + guard tampilan client/admin + reset password dasar.
// Backend (/api/*) adalah penegak keamanan; ini hanya UX —
// user tak berhak tetap ditolak 401/403 oleh Worker.

const $ = (s) => document.querySelector(s);
const authMsg = (t, ok = false) => {
  const el = $("#authMsg");
  el.textContent = t;
  el.style.color = ok ? "#15803d" : "#b91c1c";
};

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  let j = {};
  try {
    j = await r.json();
  } catch {}
  return { status: r.status, json: j };
}

function showForm(which) {
  $("#loginForm").hidden = which !== "login";
  $("#registerForm").hidden = which !== "register";
  $("#resetForm").hidden = which !== "reset";
  $("#tabLogin").classList.toggle("active", which === "login");
  $("#tabRegister").classList.toggle("active", which === "register");
}

async function refreshMe() {
  let user = null;
  try {
    const { json } = await api("/api/auth/me");
    user = json.user || null;
  } catch {
    $("#userBadge").textContent = "Worker belum jalan (npm run dev:worker)";
    return;
  }
  const logged = !!user;
  $("#authCard").hidden = logged;
  $("#logoutBtn").hidden = !logged;
  $("#userBadge").textContent = logged ? `Login: ${user.email} (${user.role})` : "Belum login";
  if (!logged) return;

  // Zona client: tampil untuk semua user login.
  $("#clientCard").hidden = false;
  try {
    const { json } = await api("/api/client/summary");
    $("#clientSummary").textContent = json.ok
      ? `Order: ${json.counts.orders}, Layanan: ${json.counts.services}, Invoice: ${json.counts.invoices}`
      : `Gagal memuat (${json.error || "？"})`;
  } catch {
    $("#clientSummary").textContent = "Gagal memuat ringkasan.";
  }

  // Zona admin: hanya role admin (backend tetap menolak non-admin dengan 403).
  if (user.role === "admin") {
    $("#adminCard").hidden = false;
    try {
      const { json } = await api("/api/admin/summary");
      $("#adminSummary").textContent = json.ok
        ? `User: ${json.totals.users}, Order: ${json.totals.orders}, Invoice: ${json.totals.invoices}`
        : `Gagal memuat (${json.error || "？"})`;
    } catch {
      $("#adminSummary").textContent = "Gagal memuat ringkasan.";
    }
  } else {
    $("#adminCard").hidden = true;
  }
}

$("#tabLogin").addEventListener("click", () => showForm("login"));
$("#tabRegister").addEventListener("click", () => showForm("register"));
$("#forgotLink").addEventListener("click", (e) => {
  e.preventDefault();
  showForm("reset");
});
$("#backToLogin").addEventListener("click", (e) => {
  e.preventDefault();
  showForm("login");
});

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { status, json } = await api("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: $("#loginEmail").value, password: $("#loginPassword").value }),
  });
  if (status === 200 && json.ok) {
    authMsg("");
    $("#loginPassword").value = "";
    refreshMe();
  } else {
    authMsg("Gagal masuk: " + (json.error || `HTTP ${status}`));
  }
});

$("#registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { status, json } = await api("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: $("#regEmail").value,
      password: $("#regPassword").value,
      name: $("#regName").value,
      phone: $("#regPhone").value,
    }),
  });
  if ((status === 201 || status === 200) && json.ok) {
    authMsg(`Terdaftar sebagai ${json.user.email}.`, true);
    $("#regPassword").value = "";
    refreshMe();
  } else {
    authMsg("Gagal daftar: " + (json.error || `HTTP ${status}`));
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  $("#clientCard").hidden = true;
  $("#adminCard").hidden = true;
  showForm("login");
  refreshMe();
});

$("#resetReqBtn").addEventListener("click", async (e) => {
  e.preventDefault();
  const { json } = await api("/api/auth/reset/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: $("#resetEmail").value }),
  });
  const out = $("#resetTokenOut");
  if (json.reset_token) {
    out.hidden = false;
    out.textContent = `Token (mode dasar/dev): ${json.reset_token}`;
  } else {
    out.hidden = false;
    out.textContent = "Jika email terdaftar, token dikirim (mode dasar: cek respons API).";
  }
});

$("#resetConfirmBtn").addEventListener("click", async (e) => {
  e.preventDefault();
  const { status, json } = await api("/api/auth/reset/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: $("#resetToken").value.trim(), password: $("#resetPassword").value }),
  });
  if (status === 200 && json.ok) {
    authMsg("Kata sandi diganti. Silakan masuk.", true);
    showForm("login");
    refreshMe();
  } else {
    authMsg("Gagal reset: " + (json.error || `HTTP ${status}`));
  }
});

$("#cekApi").addEventListener("click", async () => {
  try {
    const r = await fetch("/api/health");
    $("#apiOut").textContent = JSON.stringify(await r.json(), null, 2);
  } catch (err) {
    $("#apiOut").textContent = "Gagal: " + err.message;
  }
});

showForm("login");
refreshMe();

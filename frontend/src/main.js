// Scaffold frontend (T1): login placeholder + cek /api/health via proxy Vite.
const $ = (s) => document.querySelector(s);

async function refreshMe() {
  try {
    const r = await fetch("/api/auth/me");
    const j = await r.json();
    $("#userBadge").textContent = j.user ? `Login: ${j.user.email} (${j.user.role})` : "Belum login (mode scaffold)";
  } catch {
    $("#userBadge").textContent = "Worker belum jalan (npm run dev:worker)";
  }
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#email").value;
  const r = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const j = await r.json();
  alert(j.ok ? `Masuk sebagai ${j.user.email}` : `Gagal: ${j.error}`);
  refreshMe();
});

$("#cekApi").addEventListener("click", async () => {
  try {
    const r = await fetch("/api/health");
    $("#apiOut").textContent = JSON.stringify(await r.json(), null, 2);
  } catch (err) {
    $("#apiOut").textContent = "Gagal: " + err.message;
  }
});

refreshMe();

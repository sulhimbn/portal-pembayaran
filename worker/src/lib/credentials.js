// T4 — Kredensial operasional layanan (WS2): enkripsi at-rest + tampilan masked.
//
// Kolom services.wp_*_enc menyimpan ciphertext AES-GCM (format "v1:iv_b64:ct_b64"),
// kunci dari secret ENCRYPTION_KEY (via wrangler secret put; T10 wajib set di
// produksi). Tanpa kunci (dev), dipakai fallback yang JELAS bukan untuk produksi.
// Aturan baca: jalur client (/api/client/services*) TIDAK PERNAH mengembalikan
// nilai mentah — hanya masked/flag. Jalur admin (T7) memakai encryptSecret()
// saat menyimpan + kolom wp_username_masked untuk preview tanpa dekripsi.

const enc = new TextEncoder();
const dec = new TextDecoder();

const DEV_FALLBACK_NOTE = "dev-fallback-bukan-untuk-produksi";

function b64encode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < b.length; i += CH) {
    s += String.fromCharCode(...b.subarray(i, i + CH));
  }
  return btoa(s);
}

function b64decode(s) {
  const bin = atob(String(s || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(env) {
  const secret = (env && env.ENCRYPTION_KEY) || "";
  const material = secret ? `portal-kredensial-v1:${secret}` : `portal-kredensial-v1:${DEV_FALLBACK_NOTE}`;
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(material));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function keyIsConfigured(env) {
  return !!((env && env.ENCRYPTION_KEY) || "");
}

// Enkripsi satu nilai rahasia (username/wp secret). Return string "v1:iv:ct".
export async function encryptSecret(plaintext, env) {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(String(plaintext ?? "")));
  return `v1:${b64encode(iv)}:${b64encode(ct)}`;
}

// Dekripsi payload encryptSecret. Throw bila format salah / kunci beda.
export async function decryptSecret(payload, env) {
  const parts = String(payload || "").split(":");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("format_enkripsi_invalid");
  const key = await importKey(env);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(parts[1]) },
    key,
    b64decode(parts[2])
  );
  return dec.decode(pt);
}

// Masking username untuk tampil: "b***i" (huruf pertama+terakhir saja).
// Nilai kosong -> "", sangat pendek (<=2) -> "••".
export function maskUsername(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  if (s.length <= 2) return "••";
  return `${s[0]}•••${s[s.length - 1]}`;
}

// Secret (password/wp secret) TIDAK PERNAH ditampilkan — hanya status ada/tidak.
export function secretPresent(v) {
  return !!String(v || "");
}

export function secretMask() {
  return "••••••••";
}

function trimSlash(u) {
  return String(u || "").replace(/\/+$/, "");
}

// Bentuk publik SATU layanan untuk jalur client: aman (tanpa *_enc mentah).
// usernamePlain opsional: hasil decrypt wp_username_enc (bila kunci tersedia);
// bila null, pakai kolom wp_username_masked (ditulis admin/T7), fallback "•••".
export function servicePublic(row, { usernamePlain = null } = {}) {
  const wpUrl = String(row.wp_url || "");
  const siteUrl = String(row.site_url || "");
  const adminUrl = String(row.admin_url || "");
  const url = siteUrl || wpUrl || (row.domain ? `https://${row.domain}` : "");
  const wpAdminUrl = adminUrl || (wpUrl ? `${trimSlash(wpUrl)}/wp-admin` : null);
  const masked =
    usernamePlain != null
      ? maskUsername(usernamePlain)
      : String(row.wp_username_masked || "") || (secretPresent(row.wp_username_enc) ? "•••" : "");
  const produk = String(row.product_name || "");
  const periode = String(row.product_period || "");
  const info = String(row.serverless_info || "");
  return {
    id: row.id,
    label: row.label || "",
    domain: row.domain || "",
    url,
    wp_url: wpUrl,
    wp_admin_url: wpAdminUrl,
    wp_username_masked: masked,
    has_wp_secret: secretPresent(row.wp_secret_enc),
    status: row.status,
    expires_at: row.expires_at || null,
    order_id: row.order_id ?? null,
    product: {
      id: row.product_id ?? null,
      slug: row.product_slug || null,
      name: produk || null,
      billing_period: periode || null,
    },
    serverless: {
      info: info || null,
      produk: produk || null,
      periode: periode || null,
    },
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

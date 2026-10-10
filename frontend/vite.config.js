import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
  preview: { port: 4173 },
  build: {
    rollupOptions: {
      // Multipage: beranda + invoice client (T5) + area client (T4) + panel admin (T7).
      input: {
        main: resolve(root, "index.html"),
        invoices: resolve(root, "invoices/index.html"),
        client: resolve(root, "client/index.html"),
        admin: resolve(root, "admin/index.html"),
      },
    },
  },
});

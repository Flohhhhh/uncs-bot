import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/admin/",
  plugins: [react()],
  build: { outDir: "../../dist/src/admin/public", emptyOutDir: true },
  // The preview server is an isolated Nest app with simulated game/storage providers.
  server: {
    host: "127.0.0.1",
    port: 4319,
    strictPort: true,
    proxy: { "/admin/api": "http://127.0.0.1:4320", "/admin/auth": "http://127.0.0.1:4320" },
  },
});

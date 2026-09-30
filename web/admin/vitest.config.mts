import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["web/admin/src/**/*.test.{ts,tsx}"],
    setupFiles: ["web/admin/src/test/setup.ts"],
    restoreMocks: true,
  },
});

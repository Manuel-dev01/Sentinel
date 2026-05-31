import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** Unit tests for pure helpers (format math + enum mirrors). No DOM / wagmi needed. */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});

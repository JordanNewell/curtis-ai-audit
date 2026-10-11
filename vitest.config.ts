import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/stubs/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    // .mjs tests exist to import bin/ scripts (plain Node ESM) alongside TS modules
    include: ["tests/**/*.test.ts", "tests/**/*.test.mjs"],
    environment: "node",
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Os testes de gates rodam "npm run" de verdade num fixture — folga para máquinas lentas.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

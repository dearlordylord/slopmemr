import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Only the Node runtime bootstrap and export barrel are process shells.
      // Their built artifact is checked by installed-witness, not imported into the test worker.
      exclude: ["src/**/*.test.ts", "src/cli/main.ts", "src/index.ts", "src/**/fixtures/**"],
      reporter: ["json", "html"]
    }
  }
})

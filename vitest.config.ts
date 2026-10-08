import { defineConfig } from "vitest/config"

export default defineConfig({
  // Vitest runs tests in the SSR environment, which reads its own conditions.
  resolve: { conditions: ["@questline/source"] },
  ssr: { resolve: { conditions: ["@questline/source"] } },
  test: { include: ["packages/*/test/**/*.test.ts"] },
})

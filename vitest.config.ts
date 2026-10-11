import { defineConfig } from "vitest/config"

export default defineConfig({
  // Vitest runs tests in the SSR environment, which reads its own conditions.
  resolve: { conditions: ["@questline/source"] },
  ssr: { resolve: { conditions: ["@questline/source"] } },
  // Every server test starts its own PGlite and runs every migration: under a full parallel run, a cold start alone
  // can pass the default 5 seconds.
  test: { include: ["packages/*/test/**/*.test.ts"], testTimeout: 30_000 },
})

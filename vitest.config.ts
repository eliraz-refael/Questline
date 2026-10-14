import { defineConfig } from "vitest/config"

export default defineConfig({
  // Vitest runs tests in the SSR environment, which reads its own conditions.
  resolve: { conditions: ["@pathofdev/source"] },
  ssr: { resolve: { conditions: ["@pathofdev/source"] } },
  // Every server test starts its own PGlite and runs every migration: under a full parallel run, a cold start alone
  // can pass the default 5 seconds.
  // The mod's own tests run under `claude plugin test`, which takes every *.test.ts in the mod: its properties, which
  // need fast-check, are *.prop.ts and run here.
  test: { include: ["packages/*/test/**/*.test.ts", "packages/mod/test/**/*.prop.ts"], testTimeout: 30_000 },
})

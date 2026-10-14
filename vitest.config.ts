import type { UserWorkspaceConfig } from "vitest/config"
import { defineConfig } from "vitest/config"

export default defineConfig({
  // Vitest runs tests in the SSR environment, which reads its own conditions.
  resolve: { conditions: ["@pathofdev/source"] },
  ssr: { resolve: { conditions: ["@pathofdev/source"] } },
  test: {
    // Every server test starts its own PGlite and runs every migration: under a full parallel run, a cold start alone
    // can pass the default 5 seconds.
    testTimeout: 30_000,
    projects: [
      { extends: true, test: { name: "packages", include: ["packages/*/test/**/*.test.ts"] } },
      // The mod's own tests run under `claude plugin test`, which takes every *.test.ts in the mod: its properties,
      // which need fast-check, are *.prop.ts and run here. The mod's tsconfig extends the claude-code API's, which the
      // engine lays only where it loaded the mod, so the transform reads no tsconfig. Vite's types leave `tsconfig` out
      // of `oxc`, but its transform takes it, and false reads none.
      {
        extends: true,
        oxc: { tsconfig: false } as unknown as NonNullable<UserWorkspaceConfig["oxc"]>,
        test: { name: "mod", include: ["packages/mod/test/**/*.prop.ts"] },
      },
    ],
  },
})

import { defineConfig, type ViteUserConfig } from "vitest/config";

/**
 * Shared Vitest defaults for all workspace apps/packages (BRD 13).
 * Data factories for domain entities arrive with Phase 1 slices.
 *
 * ⚠️ `ViteUserConfig`, NOT `UserConfig`. Vitest 3 already exports both — the
 * latter carries `@deprecated Use ViteUserConfig instead` — and Vitest 4 REMOVES
 * it, which is the whole of why the v4 bump (#43) failed to build. Spelling it
 * the new way works on 3 and 4 alike, so the upgrade stops being a big-bang
 * change and becomes a version number.
 */
export function defineTestConfig(overrides: ViteUserConfig = {}): ViteUserConfig {
  return defineConfig({
    /**
     * ⚠️ `...overrides` FIRST, then `test`. THE OTHER ORDER SILENTLY DISCARDS
     * EVERY SHARED DEFAULT.
     *
     * This used to end `test: { ...overrides.test }, ...overrides` — and because
     * `overrides` carries its own `test` key, that second spread REPLACED the
     * merged object wholesale. Any package passing a `test` block (apps/api
     * passes four settings) lost `include`, `exclude` and `environment`
     * entirely and ran on Vitest's own defaults.
     *
     * It went unnoticed because Vitest 3's defaults were close enough to ours to
     * behave. Vitest 4's are not, and that is how it surfaced.
     */
    ...overrides,
    test: {
      include: ["test/**/*.spec.ts", "src/**/*.spec.ts"],
      /**
       * ⚠️ BUILD OUTPUT IS NOT A TEST SUITE, and from Vitest 4 you have to say so.
       *
       * Vitest 3's `defaultExclude` covered `**\/dist/**`; Vitest 4's is only
       * `node_modules` and `.git`, and its default include matches compiled
       * `.spec.js` as readily as `.spec.ts`. Specs live beside the code in
       * `src/`, so `pnpm build` emits a `.spec.js` for each one — and on Vitest 4
       * those got collected and failed as CommonJS ("Vitest cannot be imported in
       * a CommonJS module using require()"). Eight phantom failures, on a run
       * where all 610 real tests passed.
       *
       * It only bites after a build, which is why CI never showed it: #43 failed
       * at the build step and never reached the tests.
       */
      exclude: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
      environment: "node",
      ...overrides.test,
    },
  });
}

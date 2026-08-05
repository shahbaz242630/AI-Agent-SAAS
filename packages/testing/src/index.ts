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
    test: {
      include: ["test/**/*.spec.ts", "src/**/*.spec.ts"],
      environment: "node",
      ...overrides.test,
    },
    ...overrides,
  });
}

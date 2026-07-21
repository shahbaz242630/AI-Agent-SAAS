import { defineConfig, type UserConfig } from "vitest/config";

/**
 * Shared Vitest defaults for all workspace apps/packages (BRD 13).
 * Data factories for domain entities arrive with Phase 1 slices.
 */
export function defineTestConfig(overrides: UserConfig = {}): UserConfig {
  return defineConfig({
    test: {
      include: ["test/**/*.spec.ts", "src/**/*.spec.ts"],
      environment: "node",
      ...overrides.test,
    },
    ...overrides,
  });
}

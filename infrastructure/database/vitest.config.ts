import { defineTestConfig } from "@eva/testing";

export default defineTestConfig({
  test: {
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // All specs share one test database — run serially.
    fileParallelism: false,
  },
});

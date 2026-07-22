import swc from "unplugin-swc";
import { defineTestConfig } from "@eva/testing";

export default defineTestConfig({
  // NestJS DI relies on design:paramtypes metadata, which esbuild cannot
  // emit — transform test sources with SWC instead (standard NestJS+vitest
  // setup).
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // All specs share one test database — run serially (same as @eva/database).
    fileParallelism: false,
  },
});

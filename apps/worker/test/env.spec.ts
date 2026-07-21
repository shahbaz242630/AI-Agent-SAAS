import { describe, expect, it } from "vitest";
import { loadEnv } from "@eva/configuration";
import { workerEnvSchema } from "../src/config/env.js";

describe("worker env validation", () => {
  it("applies documented defaults for an empty environment", () => {
    const env = loadEnv(workerEnvSchema, {});
    expect(env.WORKER_PORT).toBe(3002);
    expect(env.NODE_ENV).toBe("development");
  });
});

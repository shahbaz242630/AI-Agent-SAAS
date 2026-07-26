import { describe, expect, it } from "vitest";
import { loadEnv } from "@eva/configuration";
import { workerEnvSchema } from "../src/config/env.js";

const validEnv = {
  API_BASE_URL: "http://localhost:3001",
  INTERNAL_API_SECRET: "test-only-internal-secret-0123456789abcdef",
};

describe("worker env validation", () => {
  it("applies documented defaults when the required vars are set", () => {
    const env = loadEnv(workerEnvSchema, validEnv);
    expect(env.NODE_ENV).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.TRIGGER_PROJECT_REF).toBeUndefined();
    expect(env.API_BASE_URL).toBe("http://localhost:3001");
    expect(env.INTERNAL_API_SECRET).toBe(validEnv.INTERNAL_API_SECRET);
  });

  it("rejects a missing INTERNAL_API_SECRET", () => {
    expect(() => loadEnv(workerEnvSchema, { API_BASE_URL: validEnv.API_BASE_URL })).toThrow(
      /INTERNAL_API_SECRET/,
    );
  });

  it("rejects an INTERNAL_API_SECRET shorter than 32 chars", () => {
    expect(() =>
      loadEnv(workerEnvSchema, { ...validEnv, INTERNAL_API_SECRET: "too-short" }),
    ).toThrow(/INTERNAL_API_SECRET/);
  });

  it("rejects a missing or invalid API_BASE_URL", () => {
    expect(() =>
      loadEnv(workerEnvSchema, { INTERNAL_API_SECRET: validEnv.INTERNAL_API_SECRET }),
    ).toThrow(/API_BASE_URL/);
    expect(() => loadEnv(workerEnvSchema, { ...validEnv, API_BASE_URL: "not-a-url" })).toThrow(
      /API_BASE_URL/,
    );
  });
});

import { describe, expect, it } from "vitest";
import { loadEnv } from "@eva/configuration";
import { apiEnvSchema } from "../src/config/env.js";

describe("api env validation", () => {
  it("applies documented defaults for an empty environment", () => {
    const env = loadEnv(apiEnvSchema, {});
    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("coerces PORT from string and rejects invalid values", () => {
    expect(loadEnv(apiEnvSchema, { PORT: "4000" }).PORT).toBe(4000);
    expect(() => loadEnv(apiEnvSchema, { PORT: "not-a-number" })).toThrow();
  });

  it("rejects an invalid NODE_ENV", () => {
    expect(() => loadEnv(apiEnvSchema, { NODE_ENV: "staging-ish" })).toThrow();
  });
});

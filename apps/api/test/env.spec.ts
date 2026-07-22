import { describe, expect, it } from "vitest";
import { loadEnv } from "@eva/configuration";
import { apiEnvSchema } from "../src/config/env.js";

const REQUIRED_ENV = { SUPABASE_URL: "https://test.supabase.local" };

describe("api env validation", () => {
  it("applies documented defaults for a minimal environment", () => {
    const env = loadEnv(apiEnvSchema, { ...REQUIRED_ENV });
    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.SUPABASE_ANON_KEY).toBe("");
    expect(env.APP_DATABASE_URL).toBe("postgresql://eva_app:eva_app@localhost:5432/eva");
  });

  it("requires SUPABASE_URL and validates it as a URL", () => {
    expect(() => loadEnv(apiEnvSchema, {})).toThrow();
    expect(() => loadEnv(apiEnvSchema, { SUPABASE_URL: "not-a-url" })).toThrow();
  });

  it("coerces PORT from string and rejects invalid values", () => {
    expect(loadEnv(apiEnvSchema, { ...REQUIRED_ENV, PORT: "4000" }).PORT).toBe(4000);
    expect(() => loadEnv(apiEnvSchema, { ...REQUIRED_ENV, PORT: "not-a-number" })).toThrow();
  });

  it("rejects an invalid NODE_ENV", () => {
    expect(() => loadEnv(apiEnvSchema, { ...REQUIRED_ENV, NODE_ENV: "staging-ish" })).toThrow();
  });
});

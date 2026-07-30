import { describe, expect, it } from "vitest";
import { loadEnv } from "@eva/configuration";
import { apiEnvSchema } from "../src/config/env.js";

const REQUIRED_ENV = {
  SUPABASE_URL: "https://test.supabase.local",
  INTERNAL_API_SECRET: "test-internal-secret-0123456789abcdef", // gitleaks:allow — fake test fixture
  TOKEN_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
  OAUTH_STATE_SECRET: "test-oauth-state-secret-0123456789abcdef", // gitleaks:allow — fake test fixture
  MICROSOFT_CLIENT_ID: "test-microsoft-client-id",
  MICROSOFT_CLIENT_SECRET: "test-microsoft-client-secret", // gitleaks:allow — fake test fixture
  MICROSOFT_OAUTH_REDIRECT_URI: "http://localhost:3001/integrations/microsoft/callback",
};

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

  it("requires INTERNAL_API_SECRET with at least 32 characters (Slice 1.5 internal endpoints)", () => {
    const { INTERNAL_API_SECRET: _omitted, ...withoutSecret } = REQUIRED_ENV;
    expect(() => loadEnv(apiEnvSchema, withoutSecret)).toThrow();
    expect(() =>
      loadEnv(apiEnvSchema, { ...REQUIRED_ENV, INTERNAL_API_SECRET: "too-short" }),
    ).toThrow();
  });

  it("coerces PORT from string and rejects invalid values", () => {
    expect(loadEnv(apiEnvSchema, { ...REQUIRED_ENV, PORT: "4000" }).PORT).toBe(4000);
    expect(() => loadEnv(apiEnvSchema, { ...REQUIRED_ENV, PORT: "not-a-number" })).toThrow();
  });

  it("rejects an invalid NODE_ENV", () => {
    expect(() => loadEnv(apiEnvSchema, { ...REQUIRED_ENV, NODE_ENV: "staging-ish" })).toThrow();
  });

  it("requires TOKEN_ENCRYPTION_KEY to be 32 base64-decoded bytes (Slice 1.6)", () => {
    expect(() =>
      loadEnv(apiEnvSchema, { ...REQUIRED_ENV, TOKEN_ENCRYPTION_KEY: "dG9vLXNob3J0" }),
    ).toThrow();
  });

  it("defaults MICROSOFT_TENANT to common (multi-tenant, ruling 3)", () => {
    expect(loadEnv(apiEnvSchema, { ...REQUIRED_ENV }).MICROSOFT_TENANT).toBe("common");
  });

  it("requires the Microsoft OAuth env vars (Slice 1.6)", () => {
    const { MICROSOFT_CLIENT_ID: _a, ...noClientId } = REQUIRED_ENV;
    expect(() => loadEnv(apiEnvSchema, noClientId)).toThrow();
    const { MICROSOFT_OAUTH_REDIRECT_URI: _b, ...noRedirect } = REQUIRED_ENV;
    expect(() => loadEnv(apiEnvSchema, noRedirect)).toThrow();
  });
});

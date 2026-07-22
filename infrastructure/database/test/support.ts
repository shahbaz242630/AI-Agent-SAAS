/**
 * Shared test support: one disposable test database per run (BRD 13 —
 * database integration tests run against a real Postgres, never mocks).
 */
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://eva:eva@localhost:5432/eva_test";

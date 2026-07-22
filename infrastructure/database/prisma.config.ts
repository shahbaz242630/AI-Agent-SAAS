import { defineConfig } from "prisma/config";

/**
 * Prisma 7 configuration. The CLI no longer auto-loads .env, so local dev
 * defaults to the Docker Compose database; CI/staging/production set
 * DATABASE_URL via platform env management (BRD 9.10).
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://eva:eva@localhost:5432/eva",
  },
});

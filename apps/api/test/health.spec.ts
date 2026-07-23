import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { healthResponseSchema, readinessResponseSchema } from "@eva/validation";
import type { PrismaService } from "../src/common/database/prisma.service.js";
import { HealthService } from "../src/modules/monitoring/health.service.js";
import { createTestApp } from "./support.js";

describe("HealthService", () => {
  it("returns a health payload matching the shared contract", () => {
    const service = new HealthService({} as PrismaService);
    const health = service.getHealth();

    expect(healthResponseSchema.parse(health)).toEqual(health);
    expect(health.status).toBe("ok");
    expect(health.service).toBe("eva-api");
  });

  it("returns an ISO-8601 UTC timestamp", () => {
    const { timestamp } = new HealthService({} as PrismaService).getHealth();
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });

  describe("getReadiness", () => {
    it("reports database up when the connectivity probe succeeds", async () => {
      const prisma = { db: { $queryRaw: () => Promise.resolve([{ "?column?": 1 }]) } };
      const service = new HealthService(prisma as unknown as PrismaService);

      const readiness = await service.getReadiness();

      expect(readinessResponseSchema.parse(readiness)).toEqual(readiness);
      expect(readiness.status).toBe("ok");
      expect(readiness.checks.database).toBe("up");
    });

    it("reports database down when the connectivity probe fails", async () => {
      const prisma = {
        db: {
          $queryRaw: () => Promise.reject(new Error("connection refused — secret.internal:5432")),
        },
      };
      const service = new HealthService(prisma as unknown as PrismaService);

      const readiness = await service.getReadiness();

      expect(readinessResponseSchema.parse(readiness)).toEqual(readiness);
      expect(readiness.status).toBe("error");
      expect(readiness.checks.database).toBe("down");
      // The failure detail must not leak into the payload (BRD 14).
      expect(JSON.stringify(readiness)).not.toContain("secret.internal");
    });
  });
});

describe("GET /health/ready", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("is public and reports a ready database against the test Postgres", async () => {
    const response = await request(app.getHttpServer()).get("/health/ready");

    expect(response.status).toBe(200);
    expect(readinessResponseSchema.parse(response.body)).toEqual(response.body);
    expect(response.body.checks.database).toBe("up");
  });
});

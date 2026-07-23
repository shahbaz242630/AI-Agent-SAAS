import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";

/**
 * API rate limiting (BRD 13, Slice 0.4): a single client may not hammer the
 * API. The public /health endpoint is the cheapest way to exercise the global
 * guard. Requests are sent sequentially so the test doesn't overload the CI
 * test server (avoiding ECONNRESET).
 */
describe("rate limiting (@nestjs/throttler)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("allows traffic up to the per-minute limit", async () => {
    for (let i = 0; i < 50; i++) {
      const response = await request(app.getHttpServer()).get("/health");
      expect(response.status).toBe(200);
    }
  });

  it("rejects requests beyond the per-minute limit with 429", async () => {
    const responses: request.Response[] = [];
    for (let i = 0; i < 60; i++) {
      responses.push(await request(app.getHttpServer()).get("/health"));
    }

    const throttled = responses.filter((r) => r.status === 429);
    // 50 already used + 60 new = 110 against a limit of 100.
    expect(throttled.length).toBeGreaterThanOrEqual(10);
    for (const response of throttled) {
      expect(response.body.statusCode).toBe(429);
    }
  });
});

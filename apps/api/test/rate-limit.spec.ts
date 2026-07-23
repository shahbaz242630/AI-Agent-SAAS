import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";

/**
 * API rate limiting (BRD 13, Slice 0.4): a single client may not hammer the
 * API. The public /health endpoint is the cheapest way to exercise the global
 * guard — one burst beyond the limit must start returning 429.
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
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => request(app.getHttpServer()).get("/health")),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
  });

  it("rejects requests beyond the per-minute limit with 429", async () => {
    const responses = await Promise.all(
      Array.from({ length: 60 }, () => request(app.getHttpServer()).get("/health")),
    );

    const throttled = responses.filter((r) => r.status === 429);
    // The first 50 requests above plus 60 here = 110 against a limit of 100.
    expect(throttled.length).toBeGreaterThanOrEqual(10);
    for (const response of throttled) {
      expect(response.body.statusCode).toBe(429);
    }
  });
});

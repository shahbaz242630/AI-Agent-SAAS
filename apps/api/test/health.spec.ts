import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "@eva/validation";
import { HealthService } from "../src/modules/monitoring/health.service.js";

describe("HealthService", () => {
  it("returns a health payload matching the shared contract", () => {
    const service = new HealthService();
    const health = service.getHealth();

    expect(healthResponseSchema.parse(health)).toEqual(health);
    expect(health.status).toBe("ok");
    expect(health.service).toBe("eva-api");
  });

  it("returns an ISO-8601 UTC timestamp", () => {
    const { timestamp } = new HealthService().getHealth();
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });
});

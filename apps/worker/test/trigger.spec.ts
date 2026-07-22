import { describe, expect, it } from "vitest";
import { exampleHeartbeat } from "../src/trigger/example-heartbeat.js";

describe("example heartbeat task (Phase 0 Trigger.dev skeleton)", () => {
  it("registers a scheduled task with the expected id", () => {
    expect(exampleHeartbeat.id).toBe("example-heartbeat");
  });
});

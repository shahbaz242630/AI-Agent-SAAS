import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerEnv } from "../src/config/env.js";

// External boundary: tests must never let Sentry events leave CI.
vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
}));

import * as Sentry from "@sentry/node";
import { initSentry } from "../src/config/sentry.js";

const baseEnv: WorkerEnv = {
  NODE_ENV: "production",
  LOG_LEVEL: "info",
  TRIGGER_PROJECT_REF: "proj_test",
  SENTRY_DSN_WORKER: "https://public@o0.ingest.de.sentry.io/0",
};

describe("worker initSentry (BRD 14)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not initialise Sentry when no DSN is configured", () => {
    initSentry({ ...baseEnv, SENTRY_DSN_WORKER: "" });

    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("never initialises Sentry in the test environment — no events leave CI", () => {
    initSentry({ ...baseEnv, NODE_ENV: "test" });

    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("initialises with PII-safe options when configured", () => {
    initSentry(baseEnv);

    expect(Sentry.init).toHaveBeenCalledOnce();
    expect(vi.mocked(Sentry.init).mock.calls[0]?.[0]).toMatchObject({
      dsn: baseEnv.SENTRY_DSN_WORKER,
      environment: "production",
      sendDefaultPii: false,
    });
  });
});

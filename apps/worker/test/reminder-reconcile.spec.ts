import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reminderReconcile, runReminderReconcile } from "../src/trigger/reminder-reconcile.js";

// 32+ chars to satisfy the env schema; a test value, never a real secret.
const TEST_SECRET = "test-only-internal-secret-0123456789abcdef";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("reminder-reconcile scheduled task (Slice 1.5)", () => {
  beforeEach(() => {
    vi.stubEnv("API_BASE_URL", "http://localhost:3001");
    vi.stubEnv("INTERNAL_API_SECRET", TEST_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("registers a scheduled task with the expected id", () => {
    expect(reminderReconcile.id).toBe("reminder-reconcile");
  });

  it("POSTs to the API reconcile endpoint with the internal secret and an empty body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { processed: 3, failed: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await runReminderReconcile();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:3001/internal/reminders/reconcile", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      body: "{}",
    });
  });

  it("returns the parsed reconcile summary on 2xx (it becomes the task run output)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { processed: 5, failed: [] })),
    );

    await expect(runReminderReconcile()).resolves.toEqual({ processed: 5, failed: [] });
  });

  it("does not throw on a partial-failure 200 — the API already isolated those orgs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { processed: 4, failed: ["org_aaa"] })),
    );

    await expect(runReminderReconcile()).resolves.toEqual({ processed: 4, failed: ["org_aaa"] });
  });

  it("throws on non-2xx so Trigger.dev retries — status only, never the response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(500, { echoed: "must-not-leak" })),
    );

    const error = await runReminderReconcile().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("500");
    expect((error as Error).message).not.toContain("must-not-leak");
    expect((error as Error).message).not.toContain(TEST_SECRET);
  });
});

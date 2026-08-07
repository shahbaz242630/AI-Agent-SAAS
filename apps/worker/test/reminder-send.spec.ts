import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMINDER_SEND_CRON, reminderSend, runReminderSend } from "../src/trigger/reminder-send.js";
import { REMINDER_RECONCILE_CRON } from "../src/trigger/reminder-reconcile.js";

// 32+ chars to satisfy the env schema; a test value, never a real secret.
const TEST_SECRET = "test-only-internal-secret-0123456789abcdef";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const EMPTY_RESULT = {
  sent: 0,
  failed: 0,
  held: 0,
  heldReasons: {},
  organisationsFailed: [],
};

describe("reminder-send scheduled task (Slice 1.7)", () => {
  beforeEach(() => {
    vi.stubEnv("API_BASE_URL", "http://localhost:3001");
    vi.stubEnv("INTERNAL_API_SECRET", TEST_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("registers a scheduled task with the expected id", () => {
    expect(reminderSend.id).toBe("reminder-send");
  });

  it("POSTs to the API send endpoint with the internal secret and an empty body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, EMPTY_RESULT));
    vi.stubGlobal("fetch", fetchMock);

    await runReminderSend();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:3001/internal/reminders/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": TEST_SECRET,
      },
      body: "{}",
    });
  });

  it("returns the parsed send summary on 2xx (it becomes the task run output)", async () => {
    const body = {
      sent: 12,
      failed: 1,
      held: 3,
      heldReasons: { no_working_mailbox: 3 },
      organisationsFailed: [],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, body)));

    await expect(runReminderSend()).resolves.toEqual(body);
  });

  /**
   * A held reminder is an expected state — a dead mailbox, a rate limit — not
   * a task failure. Throwing would retry the whole sweep for no reason and
   * bury the real signal under red task runs.
   */
  it("does not throw when reminders were held or an organisation failed", async () => {
    const body = {
      sent: 0,
      failed: 0,
      held: 5,
      heldReasons: { no_working_mailbox: 4, provider_deferred: 1 },
      organisationsFailed: ["org_aaa"],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, body)));

    await expect(runReminderSend()).resolves.toEqual(body);
  });

  it("throws on non-2xx so Trigger.dev retries — status only, never the response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(503, { echoed: "must-not-leak" })),
    );

    const error = await runReminderSend().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("503");
    expect((error as Error).message).not.toContain("must-not-leak");
    expect((error as Error).message).not.toContain(TEST_SECRET);
  });

  /**
   * ⚠️ ORDER IS LOAD-BEARING. Reconcile is what turns due rows into `ready`;
   * a send scheduled before it would find nothing on its first pass of the day.
   * Asserted rather than commented, because a cron string is exactly the kind
   * of value that gets "tidied" later by someone who does not know why.
   */
  it("sends only AFTER the daily reconcile, and more than once for held retries", () => {
    const hourOf = (cron: string) => cron.split(" ")[1] ?? "";

    const reconcileHour = Number(hourOf(REMINDER_RECONCILE_CRON));
    const sendHours = hourOf(REMINDER_SEND_CRON).split(",").map(Number);

    // More than one run a day is what lets a held reminder go out the same day.
    expect(sendHours.length).toBeGreaterThan(1);
    for (const hour of sendHours) {
      expect(Number.isNaN(hour)).toBe(false);
      expect(hour).toBeGreaterThan(reconcileHour);
    }
  });
});

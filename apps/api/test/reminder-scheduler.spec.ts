import { describe, expect, it } from "vitest";
import { DEFAULT_REMINDER_STEPS } from "@eva/types";
import type { ReminderActionType, ReminderStepKey } from "@eva/types";
import { todayInTimezone } from "../src/modules/invoices/invoice-status.js";
import type { ComputedAction, ScheduleStep } from "../src/modules/reminders/reminder-scheduler.js";
import {
  applyContactSpacing,
  computeInvoiceSchedule,
  uuidv5,
} from "../src/modules/reminders/reminder-scheduler.js";

const DAY_MS = 86_400_000;

/** UTC-midnight Date for an ISO calendar day. */
function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** The six default BRD 4.1 stages as ScheduleStep fixtures (id = key). */
function defaultSteps(
  overrides: Partial<Record<ReminderStepKey, Partial<ScheduleStep>>> = {},
): ScheduleStep[] {
  return DEFAULT_REMINDER_STEPS.map((s) => ({
    id: s.key,
    key: s.key,
    offsetDays: s.offsetDays,
    actionType: s.actionType,
    enabled: true,
    ...overrides[s.key],
  }));
}

function byStep(actions: ComputedAction[], key: ReminderStepKey): ComputedAction {
  const action = actions.find((a) => a.reminderStepId === key);
  if (!action) throw new Error(`no action for step ${key}`);
  return action;
}

/**
 * Slice 1.5 scheduling engine units (plan §6): default offsets, catch-up
 * collapse (plan §7.5, escalation survival ruled in §7.10), DST boundaries,
 * BRD 4.1 3-day per-contact spacing, uuidv5 idempotency keys. Pure
 * functions — no database involved.
 */

describe("uuidv5 (RFC 4122 §4.3, plan §4: zero new dependencies)", () => {
  it("matches the RFC DNS-namespace test vector", () => {
    expect(uuidv5("python.org")).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });

  it("is deterministic for the same input", () => {
    expect(uuidv5("invoice:step:2026-03-12")).toBe(uuidv5("invoice:step:2026-03-12"));
  });

  it("produces different keys for different inputs", () => {
    expect(uuidv5("invoice-a:step:2026-03-12")).not.toBe(uuidv5("invoice-b:step:2026-03-12"));
    expect(uuidv5("invoice:step:2026-03-12")).not.toBe(uuidv5("invoice:step:2026-03-13"));
  });

  it("produces a different key under a different namespace", () => {
    expect(uuidv5("python.org", "6ba7b811-9dad-11d1-80b4-00c04fd430c8")).not.toBe(
      uuidv5("python.org"),
    );
  });
});

describe("computeInvoiceSchedule (plan §3/§7.4)", () => {
  it("lands every default offset on the expected calendar day from a known dueDate", () => {
    const dueDate = day("2026-03-15");
    const today = day("2026-03-01"); // before every raw date — nothing missed
    const actions = computeInvoiceSchedule({
      invoiceId: "inv-1",
      dueDate,
      steps: defaultSteps(),
      today,
    });

    expect(actions).toHaveLength(DEFAULT_REMINDER_STEPS.length);
    expect(byStep(actions, "pre_due_3").scheduledDate).toEqual(day("2026-03-12"));
    expect(byStep(actions, "due_date").scheduledDate).toEqual(day("2026-03-15"));
    expect(byStep(actions, "overdue_7").scheduledDate).toEqual(day("2026-03-22"));
    expect(byStep(actions, "overdue_14").scheduledDate).toEqual(day("2026-03-29"));
    expect(byStep(actions, "overdue_30").scheduledDate).toEqual(day("2026-04-14"));
    expect(byStep(actions, "final_escalation").scheduledDate).toEqual(day("2026-04-21"));
    // All future → pending; action types pass through from the step.
    expect(actions.every((a) => a.status === "pending")).toBe(true);
    expect(byStep(actions, "overdue_7").actionType).toBe("email");
    expect(byStep(actions, "final_escalation").actionType).toBe("internal_escalation");
  });

  it("excludes disabled steps", () => {
    const actions = computeInvoiceSchedule({
      invoiceId: "inv-1",
      dueDate: day("2026-03-15"),
      steps: defaultSteps({ overdue_14: { enabled: false } }),
      today: day("2026-03-01"),
    });
    expect(actions).toHaveLength(DEFAULT_REMINDER_STEPS.length - 1);
    expect(actions.find((a) => a.reminderStepId === "overdue_14")).toBeUndefined();
  });

  it("catch-up collapse: all steps missed — latest missed EMAIL + the missed escalation both survive today, ready (plan §7.10)", () => {
    const today = day("2026-05-10");
    const dueDate = addDays(today, -40); // even final_escalation (+37) is missed
    const actions = computeInvoiceSchedule({
      invoiceId: "inv-1",
      dueDate,
      steps: defaultSteps(),
      today,
    });

    // Exactly TWO rows for today: the 30-day email (latest missed email —
    // never a same-day 7+14+30 burst) AND the escalation (the human handover
    // still fires even when every email stage was missed).
    expect(actions).toHaveLength(2);
    expect(byStep(actions, "overdue_30")).toMatchObject({
      scheduledDate: today,
      status: "ready",
    });
    expect(byStep(actions, "final_escalation")).toMatchObject({
      scheduledDate: today,
      status: "ready",
    });
  });

  it("catch-up collapse: escalation missed with NO missed email — only the escalation collapses to today (plan §7.10)", () => {
    const dueDate = day("2026-03-15");
    const today = addDays(dueDate, 40); // final_escalation (+37) missed; the only email step (+90) is future
    const actions = computeInvoiceSchedule({
      invoiceId: "inv-1",
      dueDate,
      steps: defaultSteps({
        pre_due_3: { enabled: false },
        due_date: { enabled: false },
        overdue_7: { enabled: false },
        overdue_14: { enabled: false },
        overdue_30: { offsetDays: 90 },
      }),
      today,
    });

    expect(actions).toHaveLength(2);
    expect(byStep(actions, "final_escalation")).toMatchObject({
      scheduledDate: today,
      status: "ready",
    });
    // No email collapse happened — the future email keeps its raw date.
    expect(byStep(actions, "overdue_30")).toMatchObject({
      scheduledDate: addDays(dueDate, 90),
      status: "pending",
    });
  });

  it("catch-up collapse: mixed past+future — missed collapse to today, futures intact (plan §7.5)", () => {
    const dueDate = day("2026-03-15");
    const today = addDays(dueDate, 34); // 5 steps missed, final_escalation still future
    const actions = computeInvoiceSchedule({
      invoiceId: "inv-1",
      dueDate,
      steps: defaultSteps(),
      today,
    });

    // The overdue_30 reminder (latest missed) fires today — not a 7+14+30 burst.
    expect(actions).toHaveLength(2);
    expect(byStep(actions, "overdue_30")).toMatchObject({ scheduledDate: today, status: "ready" });
    expect(byStep(actions, "final_escalation")).toMatchObject({
      scheduledDate: addDays(dueDate, 37),
      status: "pending",
    });
  });

  it("nothing missed: every step keeps its raw date as pending", () => {
    const dueDate = day("2026-03-15");
    const actions = computeInvoiceSchedule({
      invoiceId: "inv-1",
      dueDate,
      steps: defaultSteps(),
      today: addDays(dueDate, -10),
    });
    expect(actions).toHaveLength(DEFAULT_REMINDER_STEPS.length);
    expect(actions.every((a) => a.status === "pending")).toBe(true);
    for (const step of DEFAULT_REMINDER_STEPS) {
      expect(byStep(actions, step.key).scheduledDate).toEqual(addDays(dueDate, step.offsetDays));
    }
  });

  it("a step landing exactly today is NOT missed and is ready", () => {
    const dueDate = day("2026-03-15");
    const today = addDays(dueDate, 7); // overdue_7 rawDate == today
    const actions = computeInvoiceSchedule({
      invoiceId: "inv-1",
      dueDate,
      steps: defaultSteps(),
      today,
    });

    // pre_due_3 + due_date missed → collapse to due_date (latest missed), today.
    expect(actions).toHaveLength(5);
    expect(byStep(actions, "due_date")).toMatchObject({ scheduledDate: today, status: "ready" });
    // overdue_7 kept its own rawDate — it happens to also be today, and is ready.
    expect(byStep(actions, "overdue_7")).toMatchObject({ scheduledDate: today, status: "ready" });
    expect(byStep(actions, "overdue_14").status).toBe("pending");
  });

  it("idempotency key: uuidv5 of invoiceId:reminderStepId:yyyyMmDd(scheduledDate) (BRD 4.1)", () => {
    const actions = computeInvoiceSchedule({
      invoiceId: "inv-1",
      dueDate: day("2026-03-15"),
      steps: defaultSteps(),
      today: day("2026-03-01"),
    });
    expect(byStep(actions, "pre_due_3").idempotencyKey).toBe(uuidv5("inv-1:pre_due_3:2026-03-12"));
    expect(byStep(actions, "final_escalation").idempotencyKey).toBe(
      uuidv5("inv-1:final_escalation:2026-04-21"),
    );
  });

  it("idempotency key stability: same inputs produce identical keys across calls", () => {
    const input = {
      invoiceId: "inv-1",
      dueDate: day("2026-03-15"),
      steps: defaultSteps(),
      today: day("2026-03-01"),
    };
    expect(computeInvoiceSchedule(input)).toEqual(computeInvoiceSchedule(input));
  });

  it("idempotency keys differ between invoices and between steps", () => {
    const base = { dueDate: day("2026-03-15"), steps: defaultSteps(), today: day("2026-03-01") };
    const a = computeInvoiceSchedule({ ...base, invoiceId: "inv-1" });
    const b = computeInvoiceSchedule({ ...base, invoiceId: "inv-2" });
    expect(byStep(a, "overdue_7").idempotencyKey).not.toBe(byStep(b, "overdue_7").idempotencyKey);
    const keys = a.map((action) => action.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not mutate its inputs", () => {
    const dueDate = day("2026-03-15");
    const today = day("2026-03-01");
    const steps = defaultSteps();
    computeInvoiceSchedule({ invoiceId: "inv-1", dueDate, steps, today });
    expect(dueDate).toEqual(day("2026-03-15"));
    expect(today).toEqual(day("2026-03-01"));
    expect(steps.map((s) => s.enabled)).toEqual(DEFAULT_REMINDER_STEPS.map(() => true));
  });
});

describe("computeInvoiceSchedule across DST boundaries (plan §6, risk 2)", () => {
  // 2026 UK clock changes: BST starts Sun 2026-03-29 01:00 UTC, ends Sun
  // 2026-10-25 01:00 UTC. `today` comes from todayInTimezone (1.2 derivation,
  // reused — not duplicated); scheduling itself is pure UTC-day arithmetic.

  it("spring forward: an instant after the BST change schedules on the correct org-local day", () => {
    // 08:00 UTC on 2026-03-29 is 09:00 BST — org-local today is the 29th.
    const today = todayInTimezone("Europe/London", new Date("2026-03-29T08:00:00Z"));
    expect(today).toEqual(day("2026-03-29"));
    const actions = computeInvoiceSchedule({
      invoiceId: "inv-1",
      dueDate: addDays(today, -7),
      steps: defaultSteps(),
      today,
    });
    expect(byStep(actions, "overdue_7")).toMatchObject({
      scheduledDate: day("2026-03-29"),
      status: "ready",
    });
  });

  it("spring forward: a late-evening instant before the change stays on the pre-change day", () => {
    // 23:30 UTC on 2026-03-28 is 23:30 GMT (clocks not yet forward) — the 28th.
    const today = todayInTimezone("Europe/London", new Date("2026-03-28T23:30:00Z"));
    expect(today).toEqual(day("2026-03-28"));
    const actions = computeInvoiceSchedule({
      invoiceId: "inv-1",
      dueDate: addDays(today, 3),
      steps: defaultSteps(),
      today,
    });
    // pre_due_3 lands exactly today, across the upcoming clock change.
    expect(byStep(actions, "pre_due_3")).toMatchObject({
      scheduledDate: day("2026-03-28"),
      status: "ready",
    });
  });

  it("autumn back: an instant after the GMT change schedules on the correct org-local day", () => {
    // 08:00 UTC on 2026-10-25 is 08:00 GMT (clocks went back 01:00 UTC) — the 25th.
    const today = todayInTimezone("Europe/London", new Date("2026-10-25T08:00:00Z"));
    expect(today).toEqual(day("2026-10-25"));
    const actions = computeInvoiceSchedule({
      invoiceId: "inv-1",
      dueDate: addDays(today, -7),
      steps: defaultSteps(),
      today,
    });
    expect(byStep(actions, "overdue_7")).toMatchObject({
      scheduledDate: day("2026-10-25"),
      status: "ready",
    });
  });

  it("autumn back: a late-UTC instant still in BST belongs to the next org-local day", () => {
    // 23:30 UTC on 2026-10-24 is 00:30 BST on the 25th — org-local today is the 25th.
    const today = todayInTimezone("Europe/London", new Date("2026-10-24T23:30:00Z"));
    expect(today).toEqual(day("2026-10-25"));
    const actions = computeInvoiceSchedule({
      invoiceId: "inv-1",
      dueDate: addDays(today, -30),
      steps: defaultSteps(),
      today,
    });
    expect(byStep(actions, "overdue_30")).toMatchObject({
      scheduledDate: day("2026-10-25"),
      status: "ready",
    });
  });
});

describe("applyContactSpacing (BRD 4.1: minimum 3 days between reminders to the same contact)", () => {
  function action(
    stepId: string,
    iso: string,
    actionType: ReminderActionType = "email",
  ): ComputedAction {
    return {
      reminderStepId: stepId,
      actionType,
      scheduledDate: day(iso),
      status: "pending",
      idempotencyKey: uuidv5(`inv:${stepId}:${iso}`),
    };
  }

  const CONTEXT = { invoiceId: "inv-1", today: day("2026-03-15") };

  it("leaves candidates unchanged when nothing conflicts", () => {
    const candidates = [action("a", "2026-03-12"), action("b", "2026-03-15")];
    const spaced = applyContactSpacing(candidates, [], CONTEXT);
    expect(spaced.map((a) => a.scheduledDate)).toEqual([day("2026-03-12"), day("2026-03-15")]);
  });

  it("defers a conflicting candidate day-by-day to the first clear day", () => {
    const spaced = applyContactSpacing([action("a", "2026-03-15")], [day("2026-03-15")], CONTEXT);
    expect(spaced[0]!.scheduledDate).toEqual(day("2026-03-18"));
  });

  it("counts occupied dates just AFTER the candidate as conflicts too", () => {
    // 03-15..03-19 are all within 3 days of the occupied 03-17 → first clear is 03-20.
    const spaced = applyContactSpacing([action("a", "2026-03-15")], [day("2026-03-17")], CONTEXT);
    expect(spaced[0]!.scheduledDate).toEqual(day("2026-03-20"));
  });

  it("defers past a chain of occupied dates", () => {
    const spaced = applyContactSpacing(
      [action("a", "2026-03-15")],
      [day("2026-03-15"), day("2026-03-18")],
      CONTEXT,
    );
    expect(spaced[0]!.scheduledDate).toEqual(day("2026-03-21"));
  });

  it("spaces multiple colliding candidates in ascending date order", () => {
    const spaced = applyContactSpacing(
      [action("b", "2026-03-15"), action("a", "2026-03-15")],
      [],
      CONTEXT,
    );
    expect(spaced.map((a) => a.scheduledDate)).toEqual([day("2026-03-15"), day("2026-03-18")]);
  });

  it("spaces same-invoice conflicts (collapsed step + exactly-today step)", () => {
    const dueDate = day("2026-03-15");
    const today = addDays(dueDate, 7); // due_date collapses to today; overdue_7 lands today
    const computed = computeInvoiceSchedule({
      invoiceId: "inv-1",
      dueDate,
      steps: defaultSteps(),
      today,
    });
    const spaced = applyContactSpacing(computed, [], { invoiceId: "inv-1", today });
    // First candidate in ascending order keeps today — untouched pass-through.
    expect(spaced.find((a) => a.reminderStepId === "overdue_7")).toBe(
      computed.find((a) => a.reminderStepId === "overdue_7"),
    );
    // The collapsed due_date action defers by 3 — fully re-derived for the final date.
    const deferred = spaced.find((a) => a.reminderStepId === "due_date")!;
    expect(deferred.scheduledDate).toEqual(day("2026-03-25"));
    expect(deferred.status).toBe("pending"); // 03-25 > today
    expect(deferred.idempotencyKey).toBe(uuidv5("inv-1:due_date:2026-03-25"));
    // Futures intact.
    expect(spaced.find((a) => a.reminderStepId === "overdue_14")!.scheduledDate).toEqual(
      addDays(dueDate, 14),
    );
  });

  it("never shifts a candidate backward", () => {
    const spaced = applyContactSpacing([action("a", "2026-03-22")], [day("2026-03-19")], CONTEXT);
    expect(spaced[0]!.scheduledDate).toEqual(day("2026-03-22")); // exactly 3 days clear
  });

  it("honours a custom minGapDays", () => {
    const spaced = applyContactSpacing(
      [action("a", "2026-03-15")],
      [day("2026-03-15")],
      CONTEXT,
      7,
    );
    expect(spaced[0]!.scheduledDate).toEqual(day("2026-03-22"));
  });

  it("re-derives status and idempotencyKey from the FINAL date when (and only when) a candidate shifts", () => {
    const shifted: ComputedAction = {
      reminderStepId: "a",
      actionType: "email",
      scheduledDate: day("2026-03-15"), // == today → ready
      status: "ready",
      idempotencyKey: uuidv5("inv-1:a:2026-03-15"),
    };
    const spaced = applyContactSpacing([shifted], [day("2026-03-15")], CONTEXT);
    expect(spaced[0]).toEqual({
      reminderStepId: "a",
      actionType: "email",
      scheduledDate: day("2026-03-18"),
      status: "pending", // final date is after today
      idempotencyKey: uuidv5("inv-1:a:2026-03-18"), // final date, same uuidv5 formula
    });
  });

  it("passes an unshifted candidate through untouched (identity)", () => {
    const candidate: ComputedAction = {
      reminderStepId: "a",
      actionType: "email",
      scheduledDate: day("2026-03-15"),
      status: "ready",
      idempotencyKey: uuidv5("inv-1:a:2026-03-15"),
    };
    const spaced = applyContactSpacing([candidate], [], CONTEXT);
    expect(spaced[0]).toBe(candidate);
  });

  it("does not mutate the input array or candidate objects", () => {
    const candidates = [action("a", "2026-03-15"), action("b", "2026-03-15")].map((c) =>
      Object.freeze(c),
    );
    const frozenInput = Object.freeze([...candidates]);
    const spaced = applyContactSpacing(
      frozenInput as ComputedAction[],
      [day("2026-03-16")],
      CONTEXT,
    );
    expect(candidates[0]!.scheduledDate).toEqual(day("2026-03-15"));
    expect(candidates[1]!.scheduledDate).toEqual(day("2026-03-15"));
    expect(spaced).toHaveLength(2);
    expect(spaced).not.toBe(frozenInput);
  });
});

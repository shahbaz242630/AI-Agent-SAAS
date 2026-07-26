import { createHash } from "node:crypto";
import type { ReminderActionType, ReminderStepKey, ScheduledActionStatus } from "@eva/types";

/**
 * Slice 1.5 reminder scheduling engine (plan §3) — pure, deterministic
 * functions; no Nest, no database. The caller computes org-local "today" via
 * `todayInTimezone` (modules/invoices/invoice-status.ts) and `due_date` is a
 * @db.Date column (UTC midnight), so all day arithmetic here is pure UTC
 * millisecond math (86_400_000 ms/day) — no timezone logic is duplicated.
 */

const DAY_MS = 86_400_000;

/** One enabled/disabled stage of an org's reminder sequence (plan §3). */
export interface ScheduleStep {
  id: string; // reminder_steps.id
  key: ReminderStepKey;
  offsetDays: number;
  actionType: ReminderActionType;
  enabled: boolean;
}

export interface ComputedAction {
  reminderStepId: string;
  actionType: ReminderActionType;
  /** UTC-midnight Date of the org-local calendar day. */
  scheduledDate: Date;
  /** ready when scheduledDate <= today. */
  status: Extract<ScheduledActionStatus, "pending" | "ready">;
  /** uuidv5 — see computeInvoiceSchedule. */
  idempotencyKey: string;
}

/** YYYY-MM-DD of a UTC-midnight Date (idempotency-key date component). */
function yyyyMmDd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The single derivation of `status` (ready when scheduledDate <= today) and
 * the BRD 4.1 idempotency key (uuidv5 of invoice + step + date) for a FINAL
 * scheduledDate — shared by computeInvoiceSchedule and applyContactSpacing so
 * a spacing-deferred date is re-derived identically to a freshly computed one.
 */
function deriveForDate(
  invoiceId: string,
  stepId: string,
  scheduledDate: Date,
  todayMs: number,
): Pick<ComputedAction, "status" | "idempotencyKey"> {
  return {
    status: (scheduledDate.getTime() <= todayMs ? "ready" : "pending") as ComputedAction["status"],
    idempotencyKey: uuidv5(`${invoiceId}:${stepId}:${yyyyMmDd(scheduledDate)}`),
  };
}

/**
 * Catch-up collapse + offsets (plan §3/§7.5; escalation survival ruled in
 * plan §7.10). One ComputedAction per enabled step at `dueDate + offsetDays`
 * (pure UTC-day arithmetic), EXCEPT missed steps (rawDate < today): the
 * missed EMAIL steps collapse to only the latest missed email step,
 * scheduled for today — a 40-day-overdue invoice gets the 30-day reminder
 * today, never a same-day 7+14+30 burst. A missed `internal_escalation`
 * step ALSO survives, scheduled for today alongside it (the human handover
 * still fires even when every email stage was missed); if no email step was
 * missed, only the escalation collapses to today. Steps landing exactly
 * today are NOT missed. The deterministic idempotency key (uuidv5 of
 * invoice + step + date) backs the unique (invoice, step, scheduled_date)
 * constraint — the BRD 4.1 duplicate-prevention mechanism.
 */
export function computeInvoiceSchedule(input: {
  invoiceId: string;
  /** Invoice due_date — UTC midnight. */
  dueDate: Date;
  steps: ReadonlyArray<ScheduleStep>;
  /** Org-local today as a UTC-midnight Date (from todayInTimezone). */
  today: Date;
}): ComputedAction[] {
  const { invoiceId, dueDate, steps, today } = input;
  const todayMs = today.getTime();
  const raw = steps
    .filter((step) => step.enabled)
    .map((step) => ({ step, rawMs: dueDate.getTime() + step.offsetDays * DAY_MS }));

  const survivors = raw.filter((r) => r.rawMs >= todayMs);
  const missed = raw.filter((r) => r.rawMs < todayMs);
  // Latest missed EMAIL step collapses to today (a same-offset tie keeps
  // both — deterministic; the 3-day spacing pass separates them).
  const missedEmails = missed.filter((r) => r.step.actionType === "email");
  if (missedEmails.length > 0) {
    const latestMissedMs = Math.max(...missedEmails.map((r) => r.rawMs));
    for (const r of missedEmails) {
      if (r.rawMs === latestMissedMs) survivors.push({ step: r.step, rawMs: todayMs });
    }
  }
  // A missed escalation is never collapsed away (plan §7.10).
  for (const r of missed) {
    if (r.step.actionType === "internal_escalation")
      survivors.push({ step: r.step, rawMs: todayMs });
  }

  return survivors
    .map(({ step, rawMs }) => {
      const scheduledDate = new Date(rawMs);
      return {
        reminderStepId: step.id,
        actionType: step.actionType,
        scheduledDate,
        ...deriveForDate(invoiceId, step.id, scheduledDate, todayMs),
      };
    })
    .sort((a, b) => a.scheduledDate.getTime() - b.scheduledDate.getTime());
}

/** RFC 4122 Appendix C namespace UUID for DNS (referenced from §4.3) — the uuidv5 default (plan §3). */
const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/**
 * RFC 4122 §4.3 name-based UUID (SHA-1), implemented on node:crypto so the
 * slice adds zero runtime dependencies (plan §4). Deterministic: the same
 * value+namespace always yields the same UUID — this backs the BRD 4.1
 * duplicate-prevention idempotency key.
 */
export function uuidv5(value: string, namespace: string = DNS_NAMESPACE): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const digest = createHash("sha1").update(namespaceBytes).update(value, "utf8").digest();
  // Set version (5) and variant (RFC 4122) bits on the first 16 hash bytes.
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * BRD 4.1: minimum 3 days between reminders to the same contact. Candidates
 * are processed in ascending scheduledDate order; each is deferred day-by-day
 * until it is ≥ minGapDays clear of every occupied date AND every already-
 * placed candidate (placed candidates join the occupied set). Dates only ever
 * shift forward, never backward. The input array is not mutated.
 *
 * When (and only when) a candidate's date shifts, its `status` and
 * `idempotencyKey` are re-derived from the FINAL date via the same
 * `deriveForDate` derivation computeInvoiceSchedule uses — so every returned
 * action is internally consistent and insert-ready. Unshifted candidates pass
 * through untouched.
 */
export function applyContactSpacing(
  candidates: ComputedAction[],
  occupiedDates: ReadonlyArray<Date>,
  context: { invoiceId: string; today: Date },
  minGapDays = 3,
): ComputedAction[] {
  const gapMs = minGapDays * DAY_MS;
  const todayMs = context.today.getTime();
  const occupied = occupiedDates.map((d) => d.getTime());
  const ordered = [...candidates].sort(
    (a, b) => a.scheduledDate.getTime() - b.scheduledDate.getTime(),
  );
  return ordered.map((candidate) => {
    let dateMs = candidate.scheduledDate.getTime();
    while (occupied.some((o) => Math.abs(dateMs - o) < gapMs)) {
      dateMs += DAY_MS;
    }
    occupied.push(dateMs);
    if (dateMs === candidate.scheduledDate.getTime()) return candidate;
    const scheduledDate = new Date(dateMs);
    return {
      ...candidate,
      scheduledDate,
      ...deriveForDate(context.invoiceId, candidate.reminderStepId, scheduledDate, todayMs),
    };
  });
}

"use client";

import { useActionState } from "react";
import { setModule, type MailboxActionState } from "../actions";

const INITIAL_STATE: MailboxActionState = {};

const PRIMARY =
  "rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60";
const SECONDARY =
  "rounded-[var(--radius-card)] bg-background px-4 py-2 text-sm font-medium hover:opacity-80 disabled:opacity-60";

/**
 * Turning one product on or off, and setting its seats.
 *
 * One form, two submit buttons carrying their own `intent` — so changing seats
 * does not require switching the product off and on again, which an earlier
 * draft of this component accidentally demanded.
 *
 * The buttons submit an INTENT rather than the raw `enabled` value they used
 * to, because the two are not the same question. The seats input lives in this
 * same form, so every submit carries a seat count; without an intent the
 * action cannot tell "buy a seat" from "turn the product on" and reports both
 * as an enable. Found on staging, 2026-08-02.
 *
 * Errors render verbatim from the API rather than being replaced with our own
 * wording: it is the only side that knows which prerequisite is missing or how
 * many mailboxes are in the way, and a customer can only act on the specific
 * answer. Same reasoning as defect F4.
 */
export function ModuleControls({
  organisationId,
  moduleKey,
  enabled,
  seats,
  seatsUsed,
  blocked,
}: {
  organisationId: string;
  moduleKey: string;
  enabled: boolean;
  seats: number;
  /** Units in use, or null for a product with nothing countable yet. */
  seatsUsed: number | null;
  /** True when a prerequisite product is missing — the API would refuse. */
  blocked: boolean;
}) {
  const [state, formAction, pending] = useActionState(setModule, INITIAL_STATE);
  const showSeats = enabled && seatsUsed !== null;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="moduleKey" value={moduleKey} />

      <div className="flex flex-wrap items-end gap-3">
        {showSeats && (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${moduleKey}-seats`} className="text-xs font-medium">
              Mailbox seats
            </label>
            <input
              id={`${moduleKey}-seats`}
              name="seats"
              type="number"
              /**
               * ⚠️ `min` is 1 — the DATABASE's rule (CHECK seats >= 1) — and
               * deliberately NOT `seatsUsed`.
               *
               * It used to be `Math.max(seatsUsed, 1)`, and the comment said the
               * API refuses a lower number anyway "so there is no reason to let
               * someone type it first". That reasoning had it backwards: the
               * browser refused FIRST, so the request never reached the API and
               * the customer got a bare native tooltip — "Value must be greater
               * than or equal to 2" — instead of the server's message, which
               * names how many mailboxes to disconnect AND how many clients
               * would be re-routed if they did.
               *
               * This is the same defect slice 1.6a recorded in §0e, where it was
               * written down as a lesson about TESTING (the server guard could
               * not be reached) rather than fixed as a defect the customer
               * meets. Seen again on staging 2026-08-02, now with a Task 7
               * message behind it that nobody could ever have read.
               *
               * The rule "you cannot have fewer seats than mailboxes" belongs to
               * the server, which owns the count and can explain the cost. The
               * browser should only enforce what is true regardless of state.
               */
              min={1}
              max={1000}
              defaultValue={seats}
              className="w-24 rounded-[var(--radius-card)] border border-muted-foreground/30 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </div>
        )}

        {showSeats && (
          <button type="submit" name="intent" value="seats" disabled={pending} className={PRIMARY}>
            {pending ? "Saving…" : "Save seats"}
          </button>
        )}

        <button
          type="submit"
          name="intent"
          value={enabled ? "disable" : "enable"}
          disabled={pending || blocked}
          className={enabled ? SECONDARY : PRIMARY}
        >
          {enabled ? "Turn off" : "Turn on"}
        </button>
      </div>

      {(state.error ?? state.success) && (
        <p
          role={state.error ? "alert" : "status"}
          className={`text-sm ${state.error ? "text-danger" : "text-success"}`}
        >
          {state.error ?? state.success}
        </p>
      )}
    </form>
  );
}

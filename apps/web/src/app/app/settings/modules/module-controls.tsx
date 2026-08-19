"use client";

import { useActionState, useState } from "react";
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
  productName,
  enabled,
  endsAt,
  seats,
  seatsUsed,
  blocked,
}: {
  organisationId: string;
  moduleKey: string;
  /** As a customer reads it — never the database key. */
  productName: string;
  enabled: boolean;
  /** When a product switched off mid-period actually stops, already formatted.
   *  Null today: there is no billing period until Paddle is wired. */
  endsAt: string | null;
  seats: number;
  /** Units in use, or null for a product with nothing countable yet. */
  seatsUsed: number | null;
  /** True when a prerequisite product is missing — the API would refuse. */
  blocked: boolean;
}) {
  const [state, formAction, pending] = useActionState(setModule, INITIAL_STATE);
  /**
   * Whether the "are you sure" panel is open.
   *
   * ⚠️ RENDERED AS `enabled && confirming`, NOT SYNCED WITH AN EFFECT. The first
   * cut reset this in a `useEffect` on `enabled`, which lint rightly refused —
   * setting state inside an effect triggers a cascading render, and it was
   * solving a problem that only existed because the panel was not gated on
   * `enabled` in the first place. Deriving costs nothing and cannot get out of
   * step; the enable button clears the flag so turning a product back on does
   * not reopen the panel.
   */
  const [confirming, setConfirming] = useState(false);
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

        {/* Turning ON is one click. Turning OFF is the one that costs
            something, so it asks — see `confirming` below. */}
        {!enabled && (
          <button
            type="submit"
            name="intent"
            value="enable"
            onClick={() => setConfirming(false)}
            disabled={pending || blocked}
            className={PRIMARY}
          >
            Turn on
          </button>
        )}

        {enabled && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={pending}
            className={SECONDARY}
          >
            Turn off
          </button>
        )}
      </div>

      {/**
       * ⚠️ THE SCREEN, NOT THE TERMS PAGE, IS THE CHARGEBACK DEFENCE.
       *
       * Founder ruling 2026-08-19: switching a product off stops the bill from
       * the next cycle. A dispute is won by what the customer was shown AT THE
       * MOMENT THEY CLICKED — the terms page is blocked on company registration
       * and nobody reads it anyway.
       *
       * ⚠️ THE WORDING FOLLOWS `endsAt`, IT DOES NOT ASSUME IT. There is no
       * billing period to compute from until Paddle is wired, so today this
       * says "stops now" — which is exactly what the API does. When Paddle sets
       * a period end it will say "stays on until <date>". Promising a date
       * nothing can keep is the defect this whole slice exists to remove.
       */}
      {enabled && confirming && (
        <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-border bg-background px-4 py-3">
          <p className="text-sm">
            <span className="font-semibold">
              {productName} stops {endsAt ? "on " : "now"}
            </span>
            {endsAt && <span className="font-semibold">{endsAt}</span>}. Eva will not use it again
            until you turn it back on. <span className="font-semibold">Your records stay</span> —
            nothing is deleted.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              name="intent"
              value="disable"
              disabled={pending}
              className={PRIMARY}
            >
              {pending ? "Turning off…" : `Turn off ${productName}`}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className={SECONDARY}
            >
              Keep it on
            </button>
          </div>
        </div>
      )}

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

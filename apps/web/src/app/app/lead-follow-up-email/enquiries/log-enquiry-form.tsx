"use client";

import { useActionState, useState } from "react";
import { PrimaryAction, PrimaryButton } from "@/components/ui";
import {
  MANUAL_LEAD_SOURCES,
  leadSourceHint,
  leadSourceLabel,
} from "@/products/lead-follow-up/lead-book";
import { logEnquiry, type LeadActionState } from "./actions";

/**
 * Logging an enquiry that arrived by phone (Slice 3.1a).
 *
 * ⚠️ THIS IS NOT FILLER WHILE WE WAIT FOR EVA TO READ A MAILBOX. "Missed call"
 * and "existing client asking about something new" are eligible sources in the
 * BRD and are manual by their nature — no mailbox reader will ever pick them
 * up. It is also the only way to put a real enquiry in front of Eva today, so
 * it is how we dogfood the product before 3.1b exists.
 *
 * ⚠️ EVERY FIELD RE-READS WHAT WAS SUBMITTED. React 19 resets an uncontrolled
 * form once its action returns, so without `defaultValue` a refusal empties
 * everything the person typed — including the field being complained about.
 * Learned on the invoice form; the same trap, the same fix.
 */

const FIELD =
  "rounded-[var(--radius-card)] border border-input-border bg-surface px-3 py-2 text-sm";
const LABEL = "flex flex-col gap-1 text-sm";

export function LogEnquiryForm({
  organisationId,
  timezone,
  /**
   * "Now", already formatted for a `datetime-local` box in the organisation's
   * timezone.
   *
   * ⚠️ COMPUTED ON THE SERVER AND PASSED IN, NOT READ FROM THE BROWSER'S CLOCK.
   * The rest of the product reports time in the organisation's zone, and a form
   * that opens on the laptop's zone would disagree with the screen it writes
   * to — for anyone travelling, or any business whose staff are not where the
   * business is.
   */
  nowValue,
}: {
  organisationId: string;
  timezone: string;
  nowValue: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<LeadActionState, FormData>(logEnquiry, {});
  const [source, setSource] = useState<string>(MANUAL_LEAD_SOURCES[0]);

  if (!open) {
    return (
      <div className="flex w-full flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <PrimaryAction onClick={() => setOpen(true)}>Log an enquiry</PrimaryAction>
          {state.success && <p className="text-sm text-success">{state.success}</p>}
        </div>
      </div>
    );
  }

  return (
    <form
      action={formAction}
      className="flex w-full flex-col gap-4 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-5"
    >
      <input type="hidden" name="organisationId" value={organisationId} />
      {/* The zone the times on this form are written in. The server cannot
          infer it — see `wallClockToInstant`. */}
      <input type="hidden" name="timezone" value={timezone} />

      <div className="flex flex-col gap-1">
        <h2 className="font-display text-lg font-semibold">Log an enquiry</h2>
        <p className="text-sm text-muted-foreground">
          Someone got in touch and it did not arrive by email. Record it here so Eva has it, and so
          there is proof of them contacting you first.
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="pb-1 text-sm font-medium">How did they get in touch?</legend>
        <div className="flex flex-wrap gap-2">
          {MANUAL_LEAD_SOURCES.map((option) => (
            <label
              key={option}
              className={`cursor-pointer rounded-[var(--radius-card)] px-3 py-1.5 text-xs font-semibold ${
                source === option
                  ? "bg-primary text-primary-foreground"
                  : "border border-input-border bg-surface hover:bg-chip-hover"
              }`}
            >
              <input
                type="radio"
                name="source"
                value={option}
                checked={source === option}
                onChange={() => setSource(option)}
                className="sr-only"
              />
              {leadSourceLabel(option)}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {leadSourceHint(source as (typeof MANUAL_LEAD_SOURCES)[number])}
        </p>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className={LABEL}>
          Their name
          <input name="contactName" defaultValue="" className={FIELD} placeholder="Optional" />
        </label>
        <label className={LABEL}>
          {/* ⚠️ NAMED AS A REQUIREMENT, NOT AS TWO OPTIONAL FIELDS. A lead with
              neither is refused by the API and by a CHECK constraint, so saying
              "optional" beside both would be a form that lies. */}
          When did it come in?
          <input
            type="datetime-local"
            name="receivedAt"
            defaultValue={nowValue}
            required
            className={FIELD}
          />
        </label>
        <label className={LABEL}>
          Email address
          <input type="email" name="contactEmail" defaultValue="" className={FIELD} />
        </label>
        <label className={LABEL}>
          Phone number
          <input name="contactPhone" defaultValue="" className={FIELD} />
        </label>
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">
        One of the two is enough — Eva needs some way to answer them.
      </p>

      <label className={LABEL}>
        What did they ask for?
        <textarea
          name="enquiry"
          defaultValue=""
          rows={3}
          className={FIELD}
          placeholder="In their words where you have them — this is kept as the evidence behind the enquiry."
        />
      </label>

      {state.error && <p className="text-sm text-danger">{state.error}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <PrimaryButton disabled={pending}>{pending ? "Saving…" : "Log it"}</PrimaryButton>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-[var(--radius-control)] border border-input-border bg-surface px-4 py-2 text-[13px] font-semibold hover:bg-chip-hover"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

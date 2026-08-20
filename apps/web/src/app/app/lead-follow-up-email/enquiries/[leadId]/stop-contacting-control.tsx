"use client";

import { useActionState, useState } from "react";
import { stopContacting, type LeadActionState } from "../actions";

/**
 * "Do not contact me again" (Slice 3.1a).
 *
 * ⚠️ TWO STEPS, AND NOT AS FRICTION FOR ITS OWN SAKE. This writes the
 * suppression list on every channel held for this person, permanently, across
 * every product — BRD §4.3 requires exactly that. There is no undo, so a single
 * click next to ordinary record fields is a mis-click waiting to remove
 * somebody a business is mid-conversation with. The confirm names WHO, because
 * "are you sure?" is a question nobody reads.
 *
 * ⚠️ NOT A `confirm()` DIALOG. A browser modal blocks everything and is
 * unstyleable; more to the point the rest of this product confirms inline, and
 * a second pattern for the most consequential action on the screen is where a
 * customer's habits stop helping them.
 */
export function StopContactingControl({
  organisationId,
  leadId,
  who,
}: {
  organisationId: string;
  leadId: string;
  who: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<LeadActionState, FormData>(
    stopContacting,
    {},
  );

  if (state.success) {
    return <p className="text-sm font-medium">{state.success}</p>;
  }

  if (!confirming) {
    return (
      <div className="flex flex-col gap-2">
        <div>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="cursor-pointer rounded-[var(--radius-control)] border border-danger-border bg-surface px-4 py-2 text-[13px] font-semibold text-danger hover:bg-danger-tint"
          >
            Record a do-not-contact request
          </button>
        </div>
        {state.error && <p className="text-sm text-danger">{state.error}</p>}
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="leadId" value={leadId} />
      <p className="text-sm font-medium">
        {`Stop contacting ${who}, on every channel, permanently?`}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="cursor-pointer rounded-[var(--radius-control)] bg-danger px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-default disabled:opacity-60"
        >
          {pending ? "Recording…" : "Yes, stop contacting them"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="cursor-pointer rounded-[var(--radius-control)] border border-input-border bg-surface px-4 py-2 text-[13px] font-semibold hover:bg-chip-hover"
        >
          Cancel
        </button>
      </div>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
    </form>
  );
}

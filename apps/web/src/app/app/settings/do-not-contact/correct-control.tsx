"use client";

import { useActionState, useState } from "react";
import { PrimaryButton } from "@/components/ui";
import { correctSuppression, type CorrectionState } from "./actions";

/**
 * "This was recorded in error" (2026-08-21).
 *
 * ⚠️ IT OPENS CLOSED, AND THE OPEN STATE IS A QUESTION, NOT A FORM. Undoing a
 * do-not-contact is the one action on this screen and it must not be one click
 * away from a mis-click of its own — that is the defect it exists to fix.
 *
 * ⚠️ THE WORDING DRAWS THE LINE THE CODE CANNOT. We have no way to tell a
 * mis-click from a person who genuinely asked and was then forgotten about, so
 * the screen has to. It says what this is for, says what it is not for, and
 * makes somebody write down which one it was.
 *
 * ⚠️ THE FIELD RE-READS WHAT WAS SUBMITTED. React 19 resets an uncontrolled
 * form once its action returns, so without `defaultValue` a refusal empties the
 * box — including the field being complained about. Learned on the invoice
 * form, then again on the enquiry form.
 */
export function CorrectControl({
  organisationId,
  channel,
  value,
}: {
  organisationId: string;
  channel: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<CorrectionState, FormData>(
    correctSuppression,
    {},
  );

  if (state.success) {
    return <p className="text-sm text-success">{state.success}</p>;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-[var(--radius-control)] border border-input-border bg-surface px-3 py-1.5 text-xs font-semibold hover:bg-chip-hover"
      >
        Recorded in error?
      </button>
    );
  }

  return (
    <form action={formAction} className="flex w-full max-w-xl flex-col gap-3">
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="value" value={value} />

      {/*
        ⚠️ THE TWO SENTENCES ARE THE SAFEGUARD. "Only if this should never have
        been recorded" and "not if they asked" are the whole distinction, and
        nothing in the database can enforce it — the person reading this is the
        only check there is.
      */}
      <div className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-danger/40 bg-surface px-4 py-3">
        <p className="text-sm font-semibold">Only if this should never have been recorded.</p>
        <p className="text-sm text-muted-foreground">
          If this person actually asked not to be contacted, leave it alone — that request stands
          forever, and this is not the way to change your mind about it. Use this when the entry was
          a mistake: the wrong row, the wrong person, a slip of the mouse.
        </p>
        <p className="text-sm text-muted-foreground">
          Nothing is deleted. The original entry stays on the record along with your reason and your
          name, so it is always clear what happened.
        </p>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        What went wrong?
        <textarea
          name="reason"
          defaultValue=""
          rows={2}
          required
          className="rounded-[var(--radius-card)] border border-input-border bg-surface px-3 py-2 text-sm"
          placeholder="Clicked it on the wrong enquiry — they never asked."
        />
      </label>

      {state.error && <p className="text-sm text-danger">{state.error}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <PrimaryButton disabled={pending}>
          {pending ? "Recording…" : "Record it as an error"}
        </PrimaryButton>
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

"use client";

import { useActionState } from "react";
import { startProduct, type StartProductState } from "./actions";

const INITIAL_STATE: StartProductState = {};

/**
 * "Switch on" on the hub — the control that makes the first screen a choice
 * rather than an inventory of what you do not have.
 *
 * ⚠️ IT DOES NOT ASK "ARE YOU SURE". Switching a product ON takes nothing away
 * and nothing is billed yet; the confirmation panel on the settings screen
 * exists because switching OFF is the direction that can cost somebody
 * something. Asking twice for a harmless action teaches people to click
 * through the question that matters.
 *
 * Errors render verbatim from the API — it is the only side that knows which
 * prerequisite or permission is missing (defect F4, slice 1.6).
 */
export function StartProductButton({
  organisationId,
  moduleKey,
  productName,
}: {
  organisationId: string;
  moduleKey: string;
  /** As a customer reads it — never the database key. */
  productName: string;
}) {
  const [state, formAction, pending] = useActionState(startProduct, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="moduleKey" value={moduleKey} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {/* The product is named in the label, not just beside it: with five
            rows of identical buttons, "Switch on" alone is ambiguous to anyone
            using a screen reader, who hears the button without the row. */}
        <span aria-hidden="true">{pending ? "Switching on…" : "Switch on"}</span>
        <span className="sr-only">
          {pending ? `Switching on ${productName}…` : `Switch on ${productName}`}
        </span>
      </button>
      {/* ⚠️ `danger`, NOT `destructive`. There is no `destructive` token —
          Tailwind emits nothing for it, and the message renders as plain
          unstyled text that typechecks and passes the gate. Recorded in
          `invoice-controls.tsx` after it hid the OVERDUE badge. */}
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}

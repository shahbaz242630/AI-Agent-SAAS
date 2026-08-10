"use client";

import { useActionState } from "react";
import { PrimaryButton } from "@/components/ui";
import { createOrganisationForOnboarding, type CreateOrganisationState } from "../actions";

const INITIAL_STATE: CreateOrganisationState = {};

/**
 * Step one: name the business.
 *
 * The subheading is the whole point of this component existing separately from
 * the plain organisation form. Nothing in the codebase has ever blocked a sole
 * trader — there is no business-email check and no domain validation anywhere —
 * but the old placeholder ("e.g. Slough Plumbing Ltd") quietly told a freelancer
 * they were in the wrong place. Eva is for them too, so it should say so.
 *
 * ⚠️ THE QUESTION IS THE INPUT'S REAL `<label>`, not a caption above it. It is
 * set as the pane's subheading and the design draws no other label, so making it
 * a paragraph would leave the only field on the screen with no accessible name
 * at all — announced as "edit text, blank" to anyone using a screen reader.
 */
export function OrganisationStep() {
  const [state, formAction, pending] = useActionState(
    createOrganisationForOnboarding,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="flex flex-1 flex-col pt-1">
      <label htmlFor="name" className="text-[13.5px] text-muted-foreground">
        What should we call your business?
      </label>

      <div className="flex flex-col gap-1.5 pt-[22px]">
        <input
          id="name"
          name="name"
          type="text"
          required
          autoFocus
          maxLength={200}
          placeholder="e.g. Slough Plumbing Ltd, or Sara Ahmed"
          className="w-full max-w-[380px] rounded-[var(--radius-control)] border border-input-border bg-surface px-3.5 py-[11px] text-sm outline-none focus:border-primary"
        />
        <p className="max-w-[380px] text-[12.5px] leading-[1.5] text-faint">
          Working for yourself? Register under your own name — Eva is built for sole traders and
          freelancers too.
        </p>
      </div>

      {state.error && (
        <p role="alert" className="pt-4 text-[13px] text-danger">
          {state.error}
        </p>
      )}

      <div className="min-h-8 flex-1" />

      <div className="flex justify-end">
        <PrimaryButton disabled={pending}>{pending ? "Saving…" : "Continue"}</PrimaryButton>
      </div>
    </form>
  );
}

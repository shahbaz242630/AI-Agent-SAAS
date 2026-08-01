"use client";

import { useActionState } from "react";
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
 */
export function OrganisationStep() {
  const [state, formAction, pending] = useActionState(
    createOrganisationForOnboarding,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="name" className="text-sm font-medium">
          What should we call your business?
        </label>
        <p className="text-sm text-muted-foreground">
          Working for yourself? Register under your own name — Eva is built for sole traders and
          freelancers too.
        </p>
        <input
          id="name"
          name="name"
          type="text"
          required
          autoFocus
          maxLength={200}
          placeholder="e.g. Slough Plumbing Ltd, or Sara Ahmed"
          className="mt-1 w-full max-w-sm rounded-[var(--radius-card)] border border-muted-foreground/30 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        />
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {pending ? "Saving…" : "Continue"}
        </button>
      </div>
    </form>
  );
}

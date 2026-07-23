"use client";

import { useActionState } from "react";
import { createOrganisation, type CreateOrganisationState } from "../../actions";

const INITIAL_STATE: CreateOrganisationState = {};

export function OrganisationForm() {
  const [state, formAction, pending] = useActionState(createOrganisation, INITIAL_STATE);

  return (
    <form action={formAction} className="flex w-full max-w-sm flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="name" className="text-sm font-medium">
          Organisation name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          maxLength={200}
          placeholder="e.g. Slough Plumbing Ltd"
          className="rounded-[var(--radius-card)] border border-muted-foreground/30 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        />
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {pending ? "Creating…" : "Create organisation"}
      </button>
    </form>
  );
}

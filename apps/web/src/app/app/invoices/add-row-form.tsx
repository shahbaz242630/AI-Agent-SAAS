"use client";

import { useActionState, useState } from "react";
import { CURRENCY_SUGGESTIONS } from "@/lib/currencies";
import { addBookRow, type AddRowState } from "./add-row-actions";

/**
 * Typing a row straight into the book (slice 1.6c).
 *
 * ⚠️ ONE FORM FOR CLIENT, CONTACT AND INVOICE. The founder's complaint was the
 * journey — "add first client, then another step add invoice, then set up
 * chaser". Splitting these fields across screens is that journey wearing a
 * different coat, so they are one form and one request.
 *
 * ⚠️ EVERY FIELD RE-READS WHAT WAS SUBMITTED. React 19 resets an uncontrolled
 * form once its action returns, so without `defaultValue` a refusal empties
 * everything — including the field being complained about.
 */

const FIELD = "rounded-[var(--radius-card)] border border-muted-foreground/20 px-3 py-2 text-sm";
const LABEL = "flex flex-col gap-1 text-sm";

// Suggestions only, never a restriction — and one list, shared with the
// per-client add form. See `lib/currencies.ts`.

export function AddRowForm({
  organisationId,
  defaultCurrency,
}: {
  organisationId: string;
  /**
   * The organisation's currency default (task 13). Required rather than
   * defaulted to "GBP" here: a silent fallback in a component is invisible, and
   * the whole point of task 13 is that a Dubai business stops being handed
   * sterling. `lib/currencies.ts` owns the fallback, in one place.
   */
  defaultCurrency: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<AddRowState, FormData>(addBookRow, {});
  const sent = state.values;

  if (!open) {
    return (
      <div className="flex w-full max-w-6xl flex-col gap-2">
        <div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-[var(--radius-card)] bg-muted px-4 py-2 text-sm font-medium hover:opacity-80"
          >
            Add a row
          </button>
        </div>
        {state.success && <p className="text-sm text-success">{state.success}</p>}
      </div>
    );
  }

  return (
    <form
      action={action}
      className="flex w-full max-w-6xl flex-col gap-3 rounded-[var(--radius-card)] bg-muted px-6 py-5"
    >
      <input type="hidden" name="organisationId" value={organisationId} />
      <p className="text-sm font-medium">A client and their invoice, in one go</p>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className={LABEL}>
          Client name
          <input
            name="clientName"
            required
            maxLength={200}
            defaultValue={sent?.clientName ?? ""}
            className={FIELD}
          />
          {/* Said out loud, because silently reusing a client would look like a
              bug and silently creating a second one would be worse. */}
          <span className="text-xs text-muted-foreground">
            If you already have a client with this name, the invoice goes to them.
          </span>
        </label>

        <label className={LABEL}>
          Who to chase
          <input
            name="contactName"
            maxLength={200}
            placeholder="Name"
            defaultValue={sent?.contactName ?? ""}
            className={FIELD}
          />
        </label>

        <label className={LABEL}>
          Their email
          <input
            name="contactEmail"
            type="email"
            maxLength={320}
            defaultValue={sent?.contactEmail ?? ""}
            className={FIELD}
          />
          <span className="text-xs text-muted-foreground">
            Without this, Eva has nobody to write to.
          </span>
        </label>

        <label className={LABEL}>
          Their phone
          <input
            name="contactPhone"
            type="tel"
            placeholder="+44 7700 900123"
            defaultValue={sent?.contactPhone ?? ""}
            className={FIELD}
          />
          <span className="text-xs text-muted-foreground">
            Include the country code. Not used yet — it is for calling later.
          </span>
        </label>

        <label className={LABEL}>
          Invoice number
          <input
            name="invoiceNumber"
            required
            maxLength={50}
            defaultValue={sent?.invoiceNumber ?? ""}
            className={FIELD}
          />
        </label>

        <div className="flex gap-2">
          <label className={`${LABEL} flex-1`}>
            Amount
            {/* text, not number: a number input drops what it cannot parse in
                the browser's own locale, before our parser ever sees it. */}
            <input
              name="amount"
              required
              type="text"
              inputMode="decimal"
              placeholder="1234.56"
              autoComplete="off"
              defaultValue={sent?.amount ?? ""}
              className={FIELD}
            />
          </label>
          <label className={LABEL}>
            Currency
            <select
              name="currency"
              defaultValue={sent?.currency ?? defaultCurrency}
              className={FIELD}
            >
              {/* The organisation's default may be a code the suggestion list
                  does not carry, and it must still be selectable — the list is
                  a convenience, not a whitelist (founder ruling). */}
              {!CURRENCY_SUGGESTIONS.includes(
                defaultCurrency as (typeof CURRENCY_SUGGESTIONS)[number],
              ) && <option value={defaultCurrency}>{defaultCurrency}</option>}
              {CURRENCY_SUGGESTIONS.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className={LABEL}>
          Invoice date
          <input
            name="issueDate"
            type="date"
            defaultValue={sent?.issueDate ?? ""}
            className={FIELD}
          />
        </label>

        <label className={LABEL}>
          Due date
          <input
            name="dueDate"
            type="date"
            required
            defaultValue={sent?.dueDate ?? ""}
            className={FIELD}
          />
        </label>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Should Eva chase this one?</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="status"
            value="draft"
            defaultChecked={sent?.status !== "active"}
          />
          Not yet — save it as a draft
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="status"
            value="active"
            defaultChecked={sent?.status === "active"}
          />
          Yes — starting three days before it falls due
        </label>
      </fieldset>

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.success && <p className="text-sm text-success">{state.success}</p>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {pending ? "Adding…" : "Add to the book"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-[var(--radius-card)] px-4 py-2 text-sm font-medium text-muted-foreground"
        >
          Close
        </button>
      </div>
    </form>
  );
}

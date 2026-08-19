"use client";

import { useActionState, useState, type ReactNode } from "react";
import { PrimaryAction } from "@/components/ui";
import { ClientPicker, type PickableClient } from "./client-picker";
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
  clients,
  children,
}: {
  organisationId: string;
  /**
   * Every client this organisation already has, for the picker.
   *
   * ⚠️ AN EMPTY LIST IS A WORKING STATE, NOT A BROKEN ONE. A brand new
   * account has no clients, and the page deliberately swallows a failed
   * fetch rather than taking the screen down — in both cases the picker
   * falls back to plain typing, which is exactly what it did before.
   */
  clients: PickableClient[];
  /**
   * The other way into the book, rendered on the same row as this form's own
   * trigger — today that is "Upload a spreadsheet".
   *
   * ⚠️ PASSED IN RATHER THAN BUILT HERE. Who may upload is a permission
   * (`imports:write`) and it is NOT the same permission as who may type a row
   * (`invoices:write`). The page owns that decision; this component owns only
   * where the control sits.
   */
  children?: ReactNode;
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

  return (
    <div className="flex w-full max-w-6xl flex-col gap-3">
      {/* ⚠️ BOTH WAYS INTO THE BOOK BELONG ON ONE ROW. Typing an invoice and
          uploading a spreadsheet answer the same question — "how do I get an
          invoice into Eva" — but they sat on different rows at opposite ends
          of the screen, which reads as two unrelated features rather than two
          answers to one question. Founder, 2026-08-18, walking the screen. */}
      <div className="flex flex-wrap items-center gap-2">
        <PrimaryAction onClick={() => setOpen(!open)} expanded={open}>
          Add invoice
        </PrimaryAction>
        {children}
      </div>

      {/* The confirmation belongs to the collapsed state: with the form open,
          its own copy of this line is already in view above the buttons. */}
      {!open && state.success && <p className="text-sm text-success">{state.success}</p>}

      {open && (
        <form
          action={action}
          className="flex w-full flex-col gap-3 rounded-[var(--radius-card)] bg-muted px-6 py-5"
        >
          <input type="hidden" name="organisationId" value={organisationId} />
          <p className="text-sm font-medium">A client and their invoice, in one go</p>

          <div className="grid gap-3 sm:grid-cols-3">
            {/* ⚠️ A PICKER, NOT A TEXT BOX. It used to say "if you already have
                a client with this name, the invoice goes to them" — true, and
                useless to somebody with two clients of the same name. See
                `client-picker.tsx` for why that sentence had to become a
                choice. */}
            <ClientPicker clients={clients} defaultName={sent?.clientName ?? ""} />

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
      )}
    </div>
  );
}

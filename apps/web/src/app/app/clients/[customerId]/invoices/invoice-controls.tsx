"use client";

import { useActionState, useState } from "react";
import { createInvoice, type InvoiceActionState } from "./actions";

/**
 * Adding an invoice (slice 1.6c, task 3).
 *
 * Collapsed behind a button, the `AddClientForm` precedent: the list is what
 * people come here to read, and a permanently open form pushes it below the
 * fold for the majority of visits that are not adding anything.
 */

const FIELD_CLASS =
  "rounded-[var(--radius-card)] border border-muted-foreground/20 px-3 py-2 text-sm";
const LABEL_CLASS = "flex flex-col gap-1 text-sm";

/**
 * Suggestions only — NOT a restriction. The input accepts any three-letter ISO
 * code, because a hard-coded list is a decision about which markets we serve,
 * and this is a convenience widget. It covers the three exponent groups and the
 * markets named so far: 2-digit, the 3-digit Gulf currencies, and 0-digit Asia.
 */
const CURRENCY_SUGGESTIONS = [
  "GBP",
  "AED",
  "USD",
  "EUR",
  "SAR",
  "QAR",
  "KWD",
  "BHD",
  "OMR",
  "JPY",
  "KRW",
  "VND",
];

interface ContactOption {
  id: string;
  name: string;
}

export function AddInvoiceForm({
  organisationId,
  customerId,
  clientName,
  contacts,
  defaultCurrency,
}: {
  organisationId: string;
  customerId: string;
  clientName: string;
  contacts: ContactOption[];
  defaultCurrency: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<InvoiceActionState, FormData>(createInvoice, {});

  if (!open) {
    return (
      <div className="flex w-full max-w-4xl flex-col gap-2">
        <div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Add an invoice
          </button>
        </div>
        {/* The result survives the form closing, so a success message is still
            read after the list refreshes underneath it. */}
        {state.success && <p className="text-sm text-success">{state.success}</p>}
      </div>
    );
  }

  /**
   * ⚠️ EVERY FIELD RE-READS WHAT WAS SUBMITTED. React 19 resets an uncontrolled
   * form once the action returns, so without these `defaultValue`s a refusal
   * empties the whole form — telling someone their amount has too many decimals
   * while deleting the amount. `values` is absent on success, so a saved
   * invoice leaves the form blank for the next one.
   */
  const sent = state.values;

  return (
    <form action={action} className="flex w-full max-w-4xl flex-col gap-3">
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="customerId" value={customerId} />
      <p className="text-sm font-medium">{`New invoice for ${clientName}`}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className={LABEL_CLASS}>
          Invoice number
          <input
            name="invoiceNumber"
            required
            maxLength={50}
            defaultValue={sent?.invoiceNumber ?? ""}
            className={FIELD_CLASS}
          />
        </label>

        <label className={LABEL_CLASS}>
          Currency
          <input
            name="currency"
            required
            defaultValue={sent?.currency ?? defaultCurrency}
            list="currency-suggestions"
            maxLength={3}
            pattern="[A-Za-z]{3}"
            /* `uppercase` is presentation only — the action uppercases the
               value it actually sends, because a CSS transform does not change
               what the form posts. */
            className={`${FIELD_CLASS} uppercase`}
          />
          <datalist id="currency-suggestions">
            {CURRENCY_SUGGESTIONS.map((code) => (
              <option key={code} value={code} />
            ))}
          </datalist>
        </label>

        <label className={LABEL_CLASS}>
          Amount
          {/*
            ⚠️ type="text", NOT type="number", and that is deliberate.

            A number input silently drops what it cannot parse in the browser's
            OWN locale, so on a machine set to a comma-decimal locale the value
            can arrive empty or altered before our parser ever sees it. It also
            offers spinners on money and rejects a leading zero. Text keeps
            exactly what was typed, and `parseAmountInput` — the one shared
            implementation — decides whether it is an amount.

            inputMode gets the numeric keypad on a phone without any of that.
          */}
          <input
            name="amount"
            required
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="1234.56"
            defaultValue={sent?.amount ?? ""}
            className={FIELD_CLASS}
          />
          <span className="text-xs text-muted-foreground">
            Use a full stop for decimals. How many are allowed depends on the currency.
          </span>
        </label>

        <label className={LABEL_CLASS}>
          Invoice date
          <input
            name="issueDate"
            type="date"
            defaultValue={sent?.issueDate ?? ""}
            className={FIELD_CLASS}
          />
        </label>

        <label className={LABEL_CLASS}>
          Due date
          <input
            name="dueDate"
            type="date"
            required
            defaultValue={sent?.dueDate ?? ""}
            className={FIELD_CLASS}
          />
        </label>

        {contacts.length > 0 && (
          <label className={LABEL_CLASS}>
            Send reminders to
            <select name="contactId" defaultValue={sent?.contactId ?? ""} className={FIELD_CLASS}>
              <option value="">Nobody in particular</option>
              {contacts.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Is this invoice already with the client?</legend>
        {/* The consequence is stated on the option itself, the 1.6b precedent of
            naming the cost before the click — "active" starts the chase. */}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="status"
            value="draft"
            defaultChecked={sent?.status !== "active"}
          />
          Not yet — save it as a draft, and don&apos;t chase it
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="status"
            value="active"
            defaultChecked={sent?.status === "active"}
          />
          Yes — Eva should chase it from its due date
        </label>
      </fieldset>

      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.success && <p className="text-sm text-success">{state.success}</p>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save invoice"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-[var(--radius-card)] px-4 py-2 text-sm font-medium text-muted-foreground"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

"use client";

import { useActionState, useState } from "react";
import { CURRENCY_SUGGESTIONS } from "@/lib/currencies";
import {
  availableInvoiceActions,
  canRecordPayment,
  chaseBlockedLine,
  invoiceActionConfirmLabel,
  invoiceActionConsequence,
  invoiceActionLabel,
  isBeingChased,
  isInvoiceActionIrreversible,
  type InvoiceLifecycleAction,
} from "@/products/invoice-follow-up/invoice-lifecycle";
import {
  invoiceEditBlockedReason,
  invoiceStatusLabel,
  invoiceStatusTone,
  isInvoiceEditable,
  type InvoiceStatusTone,
} from "@/products/invoice-follow-up/invoice-status";
import { amountInputValue, dateInputValue, formatDueDate, formatMoney } from "@/lib/money";
import {
  createInvoice,
  recordPayment,
  runInvoiceAction,
  updateInvoice,
  type InvoiceActionState,
  type PaymentActionState,
  type SubmittedInvoice,
} from "./actions";

/**
 * The invoice list and everything you can do to a row (slice 1.6c, tasks 1–4).
 *
 * ⚠️ NOTHING HERE COMPUTES MONEY OR TIME. Every amount, balance and status
 * arrives derived from the API — the balance because a third number can
 * disagree with the other two, and the status because `overdue` depends on the
 * ORGANISATION's timezone. Derive either here and an invoice changes meaning
 * when the reader travels (traps 1 and 2).
 */

const FIELD_CLASS =
  "rounded-[var(--radius-card)] border border-muted-foreground/20 px-3 py-2 text-sm";
const LABEL_CLASS = "flex flex-col gap-1 text-sm";
const BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60";
const SMALL_BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-muted px-3 py-1.5 text-xs font-medium hover:opacity-80 disabled:opacity-60";
const DANGER_BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-danger px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60";

const INITIAL_STATE: InvoiceActionState = {};

// Suggestions only, never a restriction — and one list, shared with the book's
// own add-a-row form. See `lib/currencies.ts`.

interface ContactOption {
  id: string;
  name: string;
}

export interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  description: string | null;
  amountMinorUnits: number;
  amountPaidMinorUnits: number;
  /** `amount - paid`, clamped at zero. Derived by the API, never stored. */
  outstandingMinorUnits: number;
  currency: string;
  issueDate: string;
  dueDate: string;
  contactId: string | null;
  /** The STORED status — what the state machine will act on. */
  status: string;
  /** Stored status, or due_soon/due_today/overdue for Active rows. */
  displayStatus: string;
  /**
   * Why Eva could not email a reminder for this invoice, with its STATUS SET
   * ASIDE — null when nothing is in the way. Derived by the API from the
   * scheduler's own rules, so the screen cannot invent a different answer.
   */
  chaseBlockedReason: string | null;
}

function Feedback({ state }: { state: InvoiceActionState }) {
  if (!state.error && !state.success) return null;
  return (
    <p
      role={state.error ? "alert" : "status"}
      className={`text-sm ${state.error ? "text-danger" : "text-success"}`}
    >
      {state.error ?? state.success}
    </p>
  );
}

/**
 * The fields an invoice is made of, shared by raising one and editing one.
 *
 * ⚠️ SHARED DELIBERATELY. The amount input carries three decisions that took a
 * defect each to learn (text not number, echo the submitted value back, decimals
 * belong to the currency). A second copy for the edit form would start as a
 * duplicate and end as a disagreement — and the disagreement would be about how
 * much somebody owes.
 *
 * `sent` always wins over `invoice`: it is what the customer typed on a
 * submission we refused, and the whole point is not to throw it away.
 */
function InvoiceFields({
  sent,
  invoice,
  contacts,
  defaultCurrency,
}: {
  sent: SubmittedInvoice | undefined;
  /** The invoice being edited, or undefined when raising a new one. */
  invoice?: InvoiceRow;
  contacts: ContactOption[];
  defaultCurrency: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className={LABEL_CLASS}>
        Invoice number
        <input
          name="invoiceNumber"
          required
          maxLength={50}
          defaultValue={sent?.invoiceNumber ?? invoice?.invoiceNumber ?? ""}
          className={FIELD_CLASS}
        />
      </label>

      <label className={LABEL_CLASS}>
        Currency
        <input
          name="currency"
          required
          defaultValue={sent?.currency ?? invoice?.currency ?? defaultCurrency}
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
          defaultValue={
            sent?.amount ??
            (invoice ? amountInputValue(invoice.amountMinorUnits, invoice.currency) : "")
          }
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
          defaultValue={sent?.issueDate ?? (invoice ? dateInputValue(invoice.issueDate) : "")}
          className={FIELD_CLASS}
        />
      </label>

      <label className={LABEL_CLASS}>
        Due date
        <input
          name="dueDate"
          type="date"
          required
          defaultValue={sent?.dueDate ?? (invoice ? dateInputValue(invoice.dueDate) : "")}
          className={FIELD_CLASS}
        />
      </label>

      {contacts.length > 0 && (
        <label className={LABEL_CLASS}>
          Send reminders to
          {/* ⚠️ The marker travels WITH the picker. Its absence is what tells
              `updateInvoice` that this form never offered a recipient, so an
              edit by someone whose role cannot read contacts leaves the
              existing one alone instead of silently clearing it. */}
          <input type="hidden" name="contactPicker" value="on" />
          <select
            name="contactId"
            defaultValue={sent?.contactId ?? invoice?.contactId ?? ""}
            className={FIELD_CLASS}
          >
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
  );
}

/**
 * Adding an invoice (task 3).
 *
 * Collapsed behind a button, the `AddClientForm` precedent: the list is what
 * people come here to read, and a permanently open form pushes it below the
 * fold for the majority of visits that are not adding anything.
 */
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
  const [state, action, pending] = useActionState<InvoiceActionState, FormData>(
    createInvoice,
    INITIAL_STATE,
  );

  if (!open) {
    return (
      <div className="flex w-full max-w-4xl flex-col gap-2">
        <div>
          <button type="button" onClick={() => setOpen(true)} className={BUTTON_CLASS}>
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

      <InvoiceFields sent={sent} contacts={contacts} defaultCurrency={defaultCurrency} />

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
          Yes — Eva should chase it, starting three days before it falls due
        </label>
      </fieldset>

      <Feedback state={state} />

      <div className="flex gap-3">
        <button type="submit" disabled={pending} className={BUTTON_CLASS}>
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

/**
 * The list, with what each row can do (tasks 1 and 4).
 *
 * The panels — confirm, and edit — render BELOW the table rather than inside a
 * cell: a table cell is the wrong shape for a paragraph and a form, and nesting
 * a form inside the row would fight the layout at every width.
 */
export function InvoiceTable({
  organisationId,
  customerId,
  invoices,
  contacts,
  canWrite,
}: {
  organisationId: string;
  customerId: string;
  invoices: InvoiceRow[];
  contacts: ContactOption[];
  /**
   * Whether this person holds `invoices:write` here (slice 1.6c, task 8).
   *
   * ⚠️ REQUIRED, NOT OPTIONAL WITH A `true` DEFAULT. A defaulted-open flag is
   * how a new caller silently ships the write controls to a read-only role —
   * the failure mode would be invisible until somebody clicked. Making it
   * required means a screen that forgets it does not compile.
   */
  canWrite: boolean;
}) {
  const [asked, setAsked] = useState<{
    invoiceId: string;
    action: InvoiceLifecycleAction;
  } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  /**
   * ONE action state for every lifecycle button, held here rather than inside
   * the confirm panel — the panel closes itself the moment the action succeeds
   * (see below), and a message that dies with the thing that produced it is a
   * click with no visible outcome.
   *
   * It can therefore outlive the panel it came from. That is safe only because
   * every sentence `invoice-lifecycle.ts` produces NAMES ITS INVOICE, so a
   * lingering "INV-1001 is paused" cannot be misread as being about the row
   * somebody has since opened.
   */
  const [lifecycleState, lifecycleAction, lifecyclePending] = useActionState<
    InvoiceActionState,
    FormData
  >(runInvoiceAction, INITIAL_STATE);

  /**
   * ⚠️ BOTH PANELS ARE LOOKED UP AGAINST THE CURRENT LIST, AND RENDER ONLY IF
   * STILL VALID — never from the id alone.
   *
   * This is what closes them. A successful pause revalidates the page, the row
   * comes back as `paused`, and `pause` is no longer among its available
   * actions — so the panel disappears because it has become untrue, not because
   * anything told it to. The same check handles the invoice being changed in
   * another tab, and the 1.6b crash where an id outlived the row it named.
   */
  let openPanel: { invoice: InvoiceRow; action: InvoiceLifecycleAction } | null = null;
  if (asked && canWrite) {
    const invoice = invoices.find((row) => row.id === asked.invoiceId);
    if (invoice && availableInvoiceActions(invoice.status).includes(asked.action)) {
      openPanel = { invoice, action: asked.action };
    }
  }

  /**
   * ⚠️ `canWrite` IS CHECKED ON THE PANELS TOO, not only on the buttons that
   * open them. Hiding a button leaves whatever opened it still reachable — a
   * stale `useState` across a re-render, or a role changed in another tab —
   * and a form that appears for someone who cannot submit it is a click that
   * can only fail. The API refuses it either way; this stops us offering it.
   */
  const editingInvoice =
    editing && canWrite
      ? (invoices.find((row) => row.id === editing && isInvoiceEditable(row.status)) ?? null)
      : null;

  // Closes itself the same way: once an invoice is settled it can take no more
  // payments, so the panel stops being valid and disappears.
  const payingInvoice =
    paying && canWrite
      ? (invoices.find((row) => row.id === paying && canRecordPayment(row.status)) ?? null)
      : null;

  return (
    <section className="flex w-full max-w-4xl flex-col gap-3">
      <Feedback state={lifecycleState} />

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-muted text-left text-muted-foreground">
              <th className="px-3 py-2 font-medium">Invoice</th>
              <th className="px-3 py-2 font-medium">Due</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              {/* The balance sits beside the amount deliberately: Eva chases what
                  is LEFT, and a list that shows only the total is the reason a
                  part-payment had no correct answer before this slice. */}
              <th className="px-3 py-2 text-right font-medium">Outstanding</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => (
              <tr key={invoice.id} className="border-b border-muted/50 align-top">
                <td className="px-3 py-3">
                  <span className="font-medium">{invoice.invoiceNumber}</span>
                  {invoice.description && (
                    <span className="block text-xs text-muted-foreground">
                      {invoice.description}
                    </span>
                  )}
                </td>
                <td className="px-3 py-3 whitespace-nowrap">{formatDueDate(invoice.dueDate)}</td>
                <td className="px-3 py-3 text-right whitespace-nowrap">
                  {formatMoney(invoice.amountMinorUnits, invoice.currency)}
                </td>
                <td className="px-3 py-3 text-right whitespace-nowrap">
                  {/*
                    ⚠️ BOLD ONLY WHEN EVA IS ACTUALLY CHASING IT. A cancelled
                    invoice still has an arithmetic balance — amount minus paid —
                    and the demo book's cancelled INV-1003 was showing £320.00 in
                    the same weight as live debt under a column headed
                    Outstanding. Nobody is collecting it. The number stays,
                    because it is true; the emphasis goes, because the claim it
                    was making was not.
                  */}
                  <span
                    className={
                      isBeingChased(invoice.status, invoice.chaseBlockedReason) &&
                      invoice.outstandingMinorUnits > 0
                        ? "font-medium"
                        : "text-muted-foreground"
                    }
                  >
                    {formatMoney(invoice.outstandingMinorUnits, invoice.currency)}
                  </span>
                  {/* Shown only when part of it has actually been paid, so the
                      common case stays quiet and the exception is obvious. */}
                  {invoice.amountPaidMinorUnits > 0 && (
                    <span className="block text-xs text-muted-foreground">
                      {`${formatMoney(invoice.amountPaidMinorUnits, invoice.currency)} paid`}
                    </span>
                  )}
                </td>
                <td className="px-3 py-3">
                  <StatusBadge status={invoice.displayStatus} />
                  {/*
                    ⚠️ THE LINE THIS PRODUCT WAS MISSING. A badge reading Active
                    or Overdue states that Eva is on it. In five separate cases
                    she is not — no recipient, a removed contact, a contact with
                    no email address, one who unsubscribed, or no working mailbox
                    — and until now every one of those looked identical to a
                    healthy chase. Silent for Draft/Paused/Cancelled, where the
                    badge beside it already explains itself.
                  */}
                  {chaseBlockedLine(invoice.status, invoice.chaseBlockedReason) && (
                    <span className="mt-1 block max-w-[16rem] text-xs whitespace-normal text-danger">
                      {chaseBlockedLine(invoice.status, invoice.chaseBlockedReason)}
                    </span>
                  )}
                </td>
                <td className="px-3 py-3">
                  {/* Nothing at all for a read-only role — the reason is said
                      once above the table rather than repeated on every row. */}
                  <div className="flex flex-wrap gap-2">
                    {canWrite && isInvoiceEditable(invoice.status) && (
                      <button
                        type="button"
                        onClick={() => setEditing(editing === invoice.id ? null : invoice.id)}
                        className={SMALL_BUTTON_CLASS}
                      >
                        {editing === invoice.id ? "Close" : "Edit"}
                      </button>
                    )}
                    {/* First, because it is the commonest thing that happens to
                        an invoice: somebody pays it. */}
                    {canWrite && canRecordPayment(invoice.status) && (
                      <button
                        type="button"
                        onClick={() => setPaying(paying === invoice.id ? null : invoice.id)}
                        className={SMALL_BUTTON_CLASS}
                      >
                        {paying === invoice.id ? "Close" : "Record a payment"}
                      </button>
                    )}
                    {/*
                      ⚠️ FROM `status`, NOT `displayStatus`. An overdue invoice
                      is STORED as active — `overdue` is derived for the badge —
                      and the state machine only knows the stored one.
                      (`availableInvoiceActions` normalises the derived statuses
                      anyway, so this cannot go wrong quietly; it is written the
                      right way round so nobody has to rely on that.)
                    */}
                    {canWrite &&
                      availableInvoiceActions(invoice.status).map((action) => (
                        <button
                          key={action}
                          type="button"
                          onClick={() => setAsked({ invoiceId: invoice.id, action })}
                          className={SMALL_BUTTON_CLASS}
                        >
                          {invoiceActionLabel(action)}
                        </button>
                      ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/*
        ⚠️ NO TOTAL ROW, AND THAT IS DELIBERATE (trap 3b). Currency is per
        invoice, so a column of AED and GBP cannot honestly be added up. A
        confident wrong total is worse than no total. When a total is wanted it
        has to group by currency — that is the org-wide list in task 9.
      */}

      {openPanel && (
        <ConfirmLifecycle
          /* Keyed so switching row or action rebuilds the panel rather than
             re-using the previous one's rendered state. */
          key={`${openPanel.invoice.id}:${openPanel.action}`}
          organisationId={organisationId}
          customerId={customerId}
          invoice={openPanel.invoice}
          action={openPanel.action}
          formAction={lifecycleAction}
          pending={lifecyclePending}
          onDismiss={() => setAsked(null)}
        />
      )}

      {payingInvoice && (
        <RecordPaymentForm
          key={payingInvoice.id}
          organisationId={organisationId}
          customerId={customerId}
          invoice={payingInvoice}
          onClose={() => setPaying(null)}
        />
      )}

      {editingInvoice && (
        <EditInvoiceForm
          key={editingInvoice.id}
          organisationId={organisationId}
          customerId={customerId}
          invoice={editingInvoice}
          contacts={contacts}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

/**
 * What this button is about to do, said before it is clicked (the 1.6b
 * disconnect precedent).
 *
 * The sentence comes from `invoice-lifecycle.ts` and is checked against the
 * scheduler, not written from memory — pausing cancels the queued reminders
 * rather than holding them, and resuming starts a fresh schedule rather than
 * continuing the old one. Both are surprises worth having before the click
 * rather than after.
 */
function ConfirmLifecycle({
  organisationId,
  customerId,
  invoice,
  action,
  formAction,
  pending,
  onDismiss,
}: {
  organisationId: string;
  customerId: string;
  invoice: InvoiceRow;
  action: InvoiceLifecycleAction;
  formAction: (formData: FormData) => void;
  pending: boolean;
  onDismiss: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-muted px-6 py-4">
      <p className="text-sm">
        {invoiceActionConsequence(action, {
          invoiceNumber: invoice.invoiceNumber,
          // The API's answer, not "does it have a contact id" — that was one of
          // five ways a chase goes silent, and the screen believed it was all.
          chaseBlockedReason: invoice.chaseBlockedReason,
        })}
      </p>
      <div className="flex flex-wrap gap-2">
        {/* Its own form, so the confirm button is the only thing that submits —
            an inline two-step rather than window.confirm(), which freezes the
            page for browser automation and states nothing where the user is
            looking. */}
        <form action={formAction}>
          <input type="hidden" name="organisationId" value={organisationId} />
          <input type="hidden" name="customerId" value={customerId} />
          <input type="hidden" name="invoiceId" value={invoice.id} />
          <input type="hidden" name="invoiceNumber" value={invoice.invoiceNumber} />
          <input type="hidden" name="action" value={action} />
          <button
            type="submit"
            disabled={pending}
            className={isInvoiceActionIrreversible(action) ? DANGER_BUTTON_CLASS : BUTTON_CLASS}
          >
            {pending ? "Working…" : invoiceActionConfirmLabel(action)}
          </button>
        </form>
        <button type="button" onClick={onDismiss} disabled={pending} className={SMALL_BUTTON_CLASS}>
          Leave it as it is
        </button>
      </div>
    </div>
  );
}

/**
 * Recording a payment (task 6).
 *
 * ⚠️ THE AMOUNT DEFAULTS TO THE WHOLE BALANCE, because that is what usually
 * happens — a client pays what they owe, and the common case should be one
 * click. A part payment is then an edit of a filled field rather than a blank
 * box to work out.
 *
 * ⚠️ AND IT IS PRE-FILLED WITH THE BALANCE, NOT THE INVOICE TOTAL. On an
 * invoice that has already been part paid those are different numbers, and
 * defaulting to the total would quietly record an overpayment every time
 * somebody accepted the default on a second instalment.
 */
function RecordPaymentForm({
  organisationId,
  customerId,
  invoice,
  onClose,
}: {
  organisationId: string;
  customerId: string;
  invoice: InvoiceRow;
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState<PaymentActionState, FormData>(recordPayment, {});

  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-muted px-6 py-4"
    >
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="invoiceId" value={invoice.id} />
      {/* The invoice's OWN currency decides how many decimals the amount may
          have — 3 for a Kuwaiti invoice, 0 for a Japanese one. It travels with
          the form rather than being looked up again. */}
      <input type="hidden" name="currency" value={invoice.currency} />

      <p className="text-sm font-medium">{`Record a payment against ${invoice.invoiceNumber}`}</p>
      <p className="text-sm text-muted-foreground">
        {`${formatMoney(invoice.outstandingMinorUnits, invoice.currency)} is outstanding on a total of ${formatMoney(invoice.amountMinorUnits, invoice.currency)}.`}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className={LABEL_CLASS}>
          Amount received
          <input
            name="amount"
            required
            type="text"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={
              state.amount ?? amountInputValue(invoice.outstandingMinorUnits, invoice.currency)
            }
            className={FIELD_CLASS}
          />
          <span className="text-xs text-muted-foreground">
            {`In ${invoice.currency}. Enter less than the full amount if they have only paid part of it.`}
          </span>
        </label>

        <label className={LABEL_CLASS}>
          Date received
          <input
            name="paidAt"
            type="date"
            defaultValue={dateInputValue(new Date())}
            className={FIELD_CLASS}
          />
          <span className="text-xs text-muted-foreground">
            Used to work out how long this client takes to pay.
          </span>
        </label>
      </div>

      <Feedback state={state} />

      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className={BUTTON_CLASS}>
          {pending ? "Recording…" : "Record payment"}
        </button>
        <button type="button" onClick={onClose} disabled={pending} className={SMALL_BUTTON_CLASS}>
          Close
        </button>
      </div>
    </form>
  );
}

/**
 * Editing a draft (task 4).
 *
 * Reached only from a draft's own Edit button, because `PATCH` is draft-only
 * and offering the form anywhere else produces a 400 nobody can act on (trap
 * 4). `invoiceEditBlockedReason` still renders here as a belt-and-braces
 * explanation rather than a blank panel, for the case where the invoice changed
 * under the form.
 */
function EditInvoiceForm({
  organisationId,
  customerId,
  invoice,
  contacts,
  onClose,
}: {
  organisationId: string;
  customerId: string;
  invoice: InvoiceRow;
  contacts: ContactOption[];
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState<InvoiceActionState, FormData>(
    updateInvoice,
    INITIAL_STATE,
  );
  const blocked = invoiceEditBlockedReason(invoice.status);

  if (blocked) {
    return (
      <div className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-muted px-6 py-4">
        <p className="text-sm">{blocked}</p>
        <div>
          <button type="button" onClick={onClose} className={SMALL_BUTTON_CLASS}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-muted px-6 py-4"
    >
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="invoiceId" value={invoice.id} />
      <p className="text-sm font-medium">{`Edit ${invoice.invoiceNumber}`}</p>

      <InvoiceFields
        sent={state.values}
        invoice={invoice}
        contacts={contacts}
        defaultCurrency={invoice.currency}
      />

      <p className="text-xs text-muted-foreground">
        Only a draft can be changed. Once you start chasing it, the client has the invoice — so the
        numbers stop being ours alone to edit.
      </p>

      <Feedback state={state} />

      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className={BUTTON_CLASS}>
          {pending ? "Saving…" : "Save changes"}
        </button>
        <button type="button" onClick={onClose} disabled={pending} className={SMALL_BUTTON_CLASS}>
          Close
        </button>
      </div>
    </form>
  );
}

/**
 * ⚠️ ONLY TOKENS THAT EXIST IN `packages/design-system/tokens.css`.
 *
 * The first version used `bg-destructive/10 text-destructive`. There is no
 * `destructive` token — the palette calls it `danger` — so Tailwind emitted
 * nothing at all and OVERDUE, the one status that should shout, rendered as
 * plain unstyled text while "Paid" carried a badge. It typechecked, it passed
 * the gate, and it was only visible by looking at the screen.
 */
const TONE_CLASSES: Record<InvoiceStatusTone, string> = {
  urgent: "bg-danger/10 text-danger",
  attention: "bg-warning/10 text-warning",
  positive: "bg-success/10 text-success",
  neutral: "bg-muted text-foreground",
  muted: "bg-muted text-muted-foreground",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-[var(--radius-card)] px-2 py-1 text-xs font-medium ${TONE_CLASSES[invoiceStatusTone(status)]}`}
    >
      {invoiceStatusLabel(status)}
    </span>
  );
}

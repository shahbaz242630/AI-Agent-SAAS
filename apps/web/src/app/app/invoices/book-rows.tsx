"use client";

import Link from "next/link";
import { Fragment, useActionState, useState } from "react";
import {
  recordPayment,
  runInvoiceAction,
  type InvoiceActionState,
  type PaymentActionState,
} from "../clients/[customerId]/invoices/actions";
import { ageingBucketLabel, chaseTimingLine } from "@/lib/invoice-book";
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
} from "@/lib/invoice-lifecycle";
import {
  invoiceStatusLabel,
  invoiceStatusTone,
  type InvoiceStatusTone,
} from "@/lib/invoice-status";
import { amountInputValue, dateInputValue, formatDueDate, formatMoney } from "@/lib/money";

/**
 * The book's rows, and what you can do to one without leaving the screen
 * (slice 1.6c).
 *
 * ⚠️ THE RULES AND THE WORDS COME FROM `lib/invoice-lifecycle.ts`, and the
 * writes from the SAME server actions the per-client screen uses. Only the
 * layout differs — this table needs a full-width panel under the row, the
 * client's page puts one under the table. **Never restate a rule or a sentence
 * here**: this project has already watched two copies of one rule disagree
 * within an hour of the original changing.
 */

const SMALL_BUTTON =
  "rounded-[var(--radius-control)] border border-input-border bg-surface px-2.5 py-1 text-xs font-semibold hover:bg-chip-hover disabled:opacity-60";
const PRIMARY_BUTTON =
  "rounded-[var(--radius-control)] bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-[var(--shadow-primary)] disabled:opacity-60";
const DANGER_BUTTON =
  "rounded-[var(--radius-control)] bg-danger px-4 py-2 text-[13px] font-semibold text-primary-foreground disabled:opacity-60";
const FIELD =
  "rounded-[var(--radius-control)] border border-input-border bg-surface px-3 py-2 text-sm";

export interface BookRow {
  id: string;
  invoiceNumber: string;
  description: string | null;
  amountMinorUnits: number;
  amountPaidMinorUnits: number;
  outstandingMinorUnits: number;
  currency: string;
  dueDate: string;
  status: string;
  displayStatus: string;
  chaseBlockedReason: string | null;
  ageingBucket: string;
  lastChasedOn: string | null;
  nextChaseOn: string | null;
  customer: { id: string; name: string; reference: string | null };
  contact: { id: string; name: string; email: string | null; phone: string | null } | null;
}

/** Which panel, if any, is open — and for which row. */
type OpenPanel =
  | { kind: "lifecycle"; invoiceId: string; action: InvoiceLifecycleAction }
  | { kind: "payment"; invoiceId: string }
  | null;

export function BookRows({
  organisationId,
  rows,
  canWrite,
}: {
  organisationId: string;
  rows: BookRow[];
  /**
   * Whether this person holds `invoices:write` here (slice 1.6c, task 8).
   *
   * ⚠️ REQUIRED, NOT DEFAULTED TO `true`. A flag that defaults open is how a
   * new caller ships the write controls to a read-only role without noticing;
   * required means forgetting it does not compile.
   */
  canWrite: boolean;
}) {
  const [panel, setPanel] = useState<OpenPanel>(null);
  /**
   * ONE action state for every lifecycle button in the table, held here so the
   * message survives the panel closing — and it does close itself, because a
   * paused invoice no longer offers `pause` (see below).
   *
   * Safe to outlive its panel only because every sentence NAMES ITS INVOICE.
   */
  const [lifecycleState, lifecycleAction, lifecyclePending] = useActionState<
    InvoiceActionState,
    FormData
  >(runInvoiceAction, {});

  /**
   * ⚠️ LOOKED UP AGAINST THE CURRENT ROWS AND RENDERED ONLY IF STILL VALID.
   * This is what closes a panel: a successful pause revalidates the page, the
   * row comes back `paused`, `pause` leaves its available actions, and the
   * panel disappears because it has become untrue rather than because anything
   * told it to. It also handles the invoice changing in another tab.
   */
  let open: { row: BookRow; panel: NonNullable<OpenPanel> } | null = null;
  /* ⚠️ `canWrite` GATES THE PANEL, not just the buttons that open it. Hiding a
     button leaves whatever opened it reachable — stale state across a
     re-render, or a role changed in another tab — and a form somebody cannot
     submit is a click that can only fail. */
  if (panel && canWrite) {
    const row = rows.find((candidate) => candidate.id === panel.invoiceId);
    if (row) {
      const stillValid =
        panel.kind === "payment"
          ? canRecordPayment(row.status)
          : availableInvoiceActions(row.status).includes(panel.action);
      if (stillValid) open = { row, panel };
    }
  }

  return (
    <>
      {lifecycleState.error && (
        <tr>
          <td colSpan={8} className="px-3 py-2 text-sm text-danger" role="alert">
            {lifecycleState.error}
          </td>
        </tr>
      )}
      {lifecycleState.success && (
        <tr>
          <td colSpan={8} className="px-3 py-2 text-sm text-success" role="status">
            {lifecycleState.success}
          </td>
        </tr>
      )}

      {rows.map((row) => {
        const chased = isBeingChased(row.status, row.chaseBlockedReason);
        const isOpen = open?.row.id === row.id;
        return (
          /* ⚠️ THE KEY GOES ON THE FRAGMENT, not the first `<tr>`. A row can
             render TWO elements — itself and its open panel — so React needs
             the key on the thing the map returns, or it reconciles the wrong
             row when one is added above another. */
          <Fragment key={row.id}>
            <tr className="border-b border-hairline align-top hover:bg-row-hover">
              <td className="px-3 py-3">
                <Link
                  href={`/app/clients/${row.customer.id}/invoices`}
                  className="font-medium text-primary hover:underline"
                >
                  {row.customer.name}
                </Link>
                {row.contact?.email && (
                  <span className="block text-xs text-muted-foreground">{row.contact.email}</span>
                )}
                {row.contact?.phone && (
                  <span className="block text-xs text-muted-foreground">{row.contact.phone}</span>
                )}
              </td>
              <td className="px-3 py-3">
                <span className="font-medium">{row.invoiceNumber}</span>
                {row.description && (
                  <span className="block text-xs text-muted-foreground">{row.description}</span>
                )}
              </td>
              <td className="px-3 py-3 whitespace-nowrap">
                {formatDueDate(row.dueDate)}
                <span className="block text-xs text-muted-foreground">
                  {ageingBucketLabel(row.ageingBucket)}
                </span>
              </td>
              <td className="px-3 py-3 text-right whitespace-nowrap">
                {formatMoney(row.amountMinorUnits, row.currency)}
              </td>
              <td className="px-3 py-3 text-right whitespace-nowrap">
                {/* Bold only when Eva is really collecting it — a cancelled
                    invoice's arithmetic balance is not money anybody is
                    working on. */}
                <span
                  className={
                    chased && row.outstandingMinorUnits > 0
                      ? "font-medium"
                      : "text-muted-foreground"
                  }
                >
                  {formatMoney(row.outstandingMinorUnits, row.currency)}
                </span>
                {row.amountPaidMinorUnits > 0 && (
                  <span className="block text-xs text-muted-foreground">
                    {`${formatMoney(row.amountPaidMinorUnits, row.currency)} paid`}
                  </span>
                )}
              </td>
              <td className="px-3 py-3">
                <StatusBadge status={row.displayStatus} />
                {chaseBlockedLine(row.status, row.chaseBlockedReason) && (
                  <span className="mt-1 block max-w-[14rem] text-xs whitespace-normal text-danger">
                    {chaseBlockedLine(row.status, row.chaseBlockedReason)}
                  </span>
                )}
              </td>
              <td className="px-3 py-3 text-xs whitespace-nowrap text-muted-foreground">
                {chaseTimingLine({
                  isChased: chased,
                  lastChasedOn: row.lastChasedOn,
                  nextChaseOn: row.nextChaseOn,
                  formatDate: (value) => formatDueDate(value),
                })}
              </td>
              <td className="px-3 py-3">
                {/* Empty for a read-only role — the reason is said once above
                    the table rather than repeated on every row of the book. */}
                <div className="flex flex-wrap gap-1">
                  {/* First, because it is the commonest thing that happens to an
                      invoice: somebody pays it. */}
                  {canWrite && canRecordPayment(row.status) && (
                    <button
                      type="button"
                      onClick={() =>
                        setPanel(
                          isOpen && panel?.kind === "payment"
                            ? null
                            : { kind: "payment", invoiceId: row.id },
                        )
                      }
                      className={SMALL_BUTTON}
                    >
                      Payment
                    </button>
                  )}
                  {/* ⚠️ FROM `status`, NOT `displayStatus` — an overdue invoice
                      is STORED as active. `availableInvoiceActions` normalises
                      the derived statuses anyway, so this cannot go wrong
                      quietly; it is written the right way round regardless. */}
                  {canWrite &&
                    availableInvoiceActions(row.status).map((action) => (
                      <button
                        key={action}
                        type="button"
                        onClick={() => setPanel({ kind: "lifecycle", invoiceId: row.id, action })}
                        className={SMALL_BUTTON}
                      >
                        {invoiceActionLabel(action)}
                      </button>
                    ))}
                </div>
              </td>
            </tr>

            {isOpen && open && (
              <tr className="border-b border-hairline">
                <td colSpan={8} className="px-3 pb-4">
                  {open.panel.kind === "lifecycle" ? (
                    <LifecyclePanel
                      key={`${row.id}:${open.panel.action}`}
                      organisationId={organisationId}
                      row={row}
                      action={open.panel.action}
                      formAction={lifecycleAction}
                      pending={lifecyclePending}
                      onDismiss={() => setPanel(null)}
                    />
                  ) : (
                    <PaymentPanel
                      key={`${row.id}:payment`}
                      organisationId={organisationId}
                      row={row}
                      onClose={() => setPanel(null)}
                    />
                  )}
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * What this button is about to do, said before it is clicked (the 1.6b
 * disconnect precedent). The sentence is `invoice-lifecycle.ts`'s, checked
 * against the scheduler — pausing cancels the queued reminders rather than
 * holding them, and cancelling cannot be undone.
 */
function LifecyclePanel({
  organisationId,
  row,
  action,
  formAction,
  pending,
  onDismiss,
}: {
  organisationId: string;
  row: BookRow;
  action: InvoiceLifecycleAction;
  formAction: (formData: FormData) => void;
  pending: boolean;
  onDismiss: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-border bg-muted px-5 py-4">
      <p className="text-sm">
        {invoiceActionConsequence(action, {
          invoiceNumber: row.invoiceNumber,
          chaseBlockedReason: row.chaseBlockedReason,
        })}
      </p>
      <div className="flex flex-wrap gap-2">
        <form action={formAction}>
          <input type="hidden" name="organisationId" value={organisationId} />
          <input type="hidden" name="customerId" value={row.customer.id} />
          <input type="hidden" name="invoiceId" value={row.id} />
          <input type="hidden" name="invoiceNumber" value={row.invoiceNumber} />
          <input type="hidden" name="action" value={action} />
          <button
            type="submit"
            disabled={pending}
            className={isInvoiceActionIrreversible(action) ? DANGER_BUTTON : PRIMARY_BUTTON}
          >
            {pending ? "Working…" : invoiceActionConfirmLabel(action)}
          </button>
        </form>
        <button type="button" onClick={onDismiss} disabled={pending} className={SMALL_BUTTON}>
          Leave it as it is
        </button>
      </div>
    </div>
  );
}

/**
 * Recording money against a row without leaving the book.
 *
 * ⚠️ PRE-FILLED WITH THE BALANCE, NOT THE TOTAL. On an invoice already part
 * paid those differ, and defaulting to the total would quietly record an
 * overpayment every time somebody accepted the default on a second instalment.
 */
function PaymentPanel({
  organisationId,
  row,
  onClose,
}: {
  organisationId: string;
  row: BookRow;
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState<PaymentActionState, FormData>(recordPayment, {});

  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-muted px-5 py-4"
    >
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="customerId" value={row.customer.id} />
      <input type="hidden" name="invoiceId" value={row.id} />
      {/* The invoice's OWN currency decides how many decimals are allowed. */}
      <input type="hidden" name="currency" value={row.currency} />

      <p className="text-sm font-medium">{`Record a payment against ${row.invoiceNumber}`}</p>
      <p className="text-sm text-muted-foreground">
        {`${formatMoney(row.outstandingMinorUnits, row.currency)} is outstanding on a total of ${formatMoney(row.amountMinorUnits, row.currency)}.`}
      </p>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Amount received
          <input
            name="amount"
            required
            type="text"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={state.amount ?? amountInputValue(row.outstandingMinorUnits, row.currency)}
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Date received
          <input
            name="paidAt"
            type="date"
            defaultValue={dateInputValue(new Date())}
            className={FIELD}
          />
        </label>
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.success && (
        <p role="status" className="text-sm text-success">
          {state.success}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className={PRIMARY_BUTTON}>
          {pending ? "Recording…" : "Record payment"}
        </button>
        <button type="button" onClick={onClose} disabled={pending} className={SMALL_BUTTON}>
          Close
        </button>
      </div>
    </form>
  );
}

/**
 * ⚠️ ONLY TOKENS THAT EXIST IN `packages/design-system/tokens.css` — there is
 * no `destructive`, the palette calls it `danger`, and an unknown Tailwind
 * class produces no CSS and no error anywhere.
 */
const TONE_CLASSES: Record<InvoiceStatusTone, string> = {
  urgent: "bg-danger-tint text-danger",
  attention: "bg-warning-tint text-warning-strong",
  positive: "bg-success-tint text-success",
  neutral: "border border-input-border bg-surface text-foreground",
  muted: "bg-neutral-tint text-muted-foreground",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-[var(--radius-pill)] px-2.5 py-[3px] text-[11.5px] font-semibold ${TONE_CLASSES[invoiceStatusTone(status)]}`}
    >
      {invoiceStatusLabel(status)}
    </span>
  );
}

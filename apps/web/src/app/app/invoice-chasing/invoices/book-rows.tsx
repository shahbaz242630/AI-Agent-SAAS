"use client";

import Link from "next/link";
import { Fragment, useActionState, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  recordPayment,
  runInvoiceAction,
  updateContact,
  type ContactActionState,
  type InvoiceActionState,
  type PaymentActionState,
} from "../../clients/[customerId]/invoices/actions";
import { ageingBucketLabel, chaseTimingLine } from "@/products/invoice-follow-up/invoice-book";
import {
  availableInvoiceActions,
  canRecordPayment,
  chaseBlockedLine,
  draftBlockedLine,
  invoiceActionConfirmLabel,
  invoiceActionConsequence,
  invoiceActionLabel,
  isBeingChased,
  isInvoiceActionIrreversible,
  type InvoiceLifecycleAction,
} from "@/products/invoice-follow-up/invoice-lifecycle";
import {
  invoiceStatusLabel,
  invoiceStatusTone,
  type InvoiceStatusTone,
} from "@/products/invoice-follow-up/invoice-status";
import { amountInputValue, dateInputValue, formatDueDate, formatMoney } from "@/lib/money";

/**
 * The book's rows, and what you can do to one without leaving the screen
 * (slice 1.6c).
 *
 * ⚠️ THE RULES AND THE WORDS COME FROM `products/invoice-follow-up/invoice-lifecycle.ts`, and the
 * writes from the SAME server actions the per-client screen uses. Only the
 * layout differs — this table needs a full-width panel under the row, the
 * client's page puts one under the table. **Never restate a rule or a sentence
 * here**: this project has already watched two copies of one rule disagree
 * within an hour of the original changing.
 */

/**
 * ⚠️ `whitespace-nowrap` IS LOAD-BEARING (2026-08-11). Without it "Pause
 * chasing" and "Cancel invoice" broke onto two lines inside their own buttons,
 * and three of those stacked turned every row of the book into a 110px block.
 * A table whose rows are three lines tall stops being a table.
 */
const SMALL_BUTTON =
  "rounded-[var(--radius-control)] border border-input-border bg-surface px-2.5 py-1 text-xs font-semibold whitespace-nowrap hover:bg-chip-hover disabled:opacity-60";
const PRIMARY_BUTTON =
  "rounded-[var(--radius-control)] bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-[var(--shadow-primary)] disabled:opacity-60";
const DANGER_BUTTON =
  "rounded-[var(--radius-control)] bg-danger px-4 py-2 text-[13px] font-semibold text-primary-foreground disabled:opacity-60";
/**
 * The drawer that opens under a row — payment, a confirm step, a contact.
 *
 * ⚠️ IT HAD TO STOP LOOKING LIKE A GREY SLAB (founder, 2026-08-18: "the
 * information which shows on the table looks really ugly, it show like a table
 * or boxes"). It was a flat tinted rectangle with a sentence and some inputs
 * loose inside it, at the same radius as the card it sat in, with nothing
 * joining it to the row it belonged to.
 *
 * ⚠️ THE LEFT EDGE IS WHAT TIES IT TO THE ROW, borrowed from `AlertCard` in the
 * shared UI, which uses the same 3px rule to carry severity. Amber for the
 * ordinary panels; danger only where the action cannot be undone, so the colour
 * means the same thing here as it does everywhere else.
 */
const panelClass = (tone?: "danger"): string =>
  `flex flex-col gap-3.5 rounded-[var(--radius-panel)] border border-l-[3px] bg-muted px-5 py-4 shadow-[var(--shadow-panel)] ${
    tone === "danger" ? "border-danger-border border-l-danger" : "border-border border-l-accent"
  }`;

/**
 * ⚠️ `font-normal` ON THE FIELD IS LOAD-BEARING. The label wraps the input, so
 * an input with no weight of its own inherits the label's semibold and every
 * typed value comes out bolder than the page around it.
 */
const LABEL = "flex flex-col gap-1.5 text-[13px] font-semibold text-label";
const FIELD =
  "rounded-[var(--radius-control)] border border-input-border bg-surface px-3 py-2 text-sm font-normal text-foreground outline-none focus:border-primary";

/**
 * How many columns the book has — Client, Email, Phone, Invoice, Due, Amount,
 * Outstanding, Status, Chasing, Actions.
 *
 * ⚠️ IT MUST MATCH THE `<th>` COUNT IN `page.tsx`, which owns the header row.
 * Every full-width row in this file spans it, so a number that drifts low
 * leaves a message short of the right edge and a number that drifts high adds
 * a phantom column to the table's own width. It was written inline as `8` in
 * three places until the client cell became three columns on 2026-08-18.
 */
const BOOK_COLUMNS = 10;

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

/**
 * Which panel, if any, is open — and for which row.
 *
 * ⚠️ CHOOSING AN ACTION AND CONFIRMING IT ARE TWO DIFFERENT THINGS, and only
 * the second one is a panel. The overflow list used to be a third kind here,
 * unfolded under the row, because `overflow-x-auto` clips an absolutely
 * positioned menu — see `RowMenu`, which solves that with a portal instead
 * (founder, 2026-08-18). The confirm step stayed a panel on purpose: it
 * carries a sentence about what is about to happen, and a sentence that
 * matters is not something to hide inside a menu.
 */
type OpenPanel =
  | { kind: "lifecycle"; invoiceId: string; action: InvoiceLifecycleAction }
  | { kind: "payment"; invoiceId: string }
  /**
   * ⚠️ GATED ON A DIFFERENT PERMISSION FROM THE OTHER TWO. Correcting the
   * person Eva writes to is `contacts:write`; everything else on this row is
   * `invoices:write`. They are genuinely separable roles, so this panel is
   * checked against its own flag and never against `canWrite`.
   */
  | { kind: "contact"; invoiceId: string }
  | null;

export function BookRows({
  organisationId,
  rows,
  canWrite,
  canEditContacts,
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
  /**
   * Whether this person holds `contacts:write` here.
   *
   * ⚠️ REQUIRED, AND NOT THE SAME FLAG AS `canWrite`. A finance role may edit
   * invoices; whether it may edit the client's people is a separate grant, and
   * folding the two together would either hide a control somebody is allowed to
   * use or show one the API will refuse.
   */
  canEditContacts: boolean;
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
  if (panel) {
    const row = rows.find((candidate) => candidate.id === panel.invoiceId);
    if (row) {
      const stillValid =
        panel.kind === "contact"
          ? /* No contact means nothing to correct — the recipient is chosen on
               the client's own screen, and only while the invoice is a draft. */
            canEditContacts && row.contact !== null
          : canWrite &&
            (panel.kind === "payment"
              ? canRecordPayment(row.status)
              : availableInvoiceActions(row.status).includes(panel.action));
      if (stillValid) open = { row, panel };
    }
  }

  return (
    <>
      {lifecycleState.error && (
        <tr>
          <td colSpan={BOOK_COLUMNS} className="px-3 py-2 text-sm text-danger" role="alert">
            {lifecycleState.error}
          </td>
        </tr>
      )}
      {lifecycleState.success && (
        <tr>
          <td colSpan={BOOK_COLUMNS} className="px-3 py-2 text-sm text-success" role="status">
            {lifecycleState.success}
          </td>
        </tr>
      )}

      {rows.map((row) => {
        const chased = isBeingChased(row.status, row.chaseBlockedReason);
        const isOpen = open?.row.id === row.id;
        /**
         * ⚠️ BUILT FROM TWO PERMISSIONS, AND THE MENU EXISTS IF EITHER GIVES IT
         * SOMETHING. Deriving the button from `availableInvoiceActions` alone —
         * as it did before contact editing — hid the whole menu from a role
         * that may fix an address but not pause a chase, and from every invoice
         * too far through its life to have any lifecycle actions left.
         */
        const menuItems = [
          ...(canEditContacts && row.contact
            ? [
                {
                  key: "contact",
                  /* Named for the thing it changes. "Edit" alone, on a row that
                     is mostly an invoice, reads as "edit the invoice" — which
                     is the one thing this does not do. */
                  label: "Edit contact details",
                  onSelect: () => setPanel({ kind: "contact", invoiceId: row.id }),
                },
              ]
            : []),
          /* ⚠️ FROM `status`, NOT `displayStatus` — an overdue invoice is STORED
             as active. `availableInvoiceActions` normalises the derived
             statuses anyway, so this cannot go wrong quietly; it is written the
             right way round regardless. */
          ...(canWrite
            ? availableInvoiceActions(row.status).map((action) => ({
                key: action,
                label: invoiceActionLabel(action),
                /* Cancelling cannot be undone, and the menu says so in red
                   before the confirm step says so in words. */
                danger: isInvoiceActionIrreversible(action),
                onSelect: () => setPanel({ kind: "lifecycle", invoiceId: row.id, action }),
              }))
            : []),
        ];
        return (
          /* ⚠️ THE KEY GOES ON THE FRAGMENT, not the first `<tr>`. A row can
             render TWO elements — itself and its open panel — so React needs
             the key on the thing the map returns, or it reconciles the wrong
             row when one is added above another. */
          <Fragment key={row.id}>
            <tr className="border-b border-hairline align-top hover:bg-row-hover">
              {/* ⚠️ THREE COLUMNS, NOT ONE CELL WITH THREE LINES (founder,
                  2026-08-18, walking the screen). The client, the address Eva
                  writes to and the number a person would ring are three
                  separate facts about three separate records — a customer and
                  its contact — and stacking them in one cell said they were one
                  thing you had to change all at once. It costs table width,
                  which this table can least afford; that is a real trade and
                  the founder made it knowingly. */}
              <td className="px-3 py-3.5">
                <Link
                  href={`/app/clients/${row.customer.id}/invoices`}
                  className="font-medium text-link hover:underline"
                >
                  {row.customer.name}
                </Link>
              </td>
              <td className="px-3 py-3.5 text-sm text-muted-foreground">
                {row.contact?.email ?? <MissingValue />}
              </td>
              <td className="px-3 py-3.5 text-sm whitespace-nowrap text-muted-foreground">
                {row.contact?.phone ?? <MissingValue />}
              </td>
              {/* An invoice number is an identifier and must never break across
                  lines: "INV-" over "2041" is unreadable and unsearchable. */}
              <td className="px-3 py-3.5 whitespace-nowrap">
                <span className="font-medium">{row.invoiceNumber}</span>
                {row.description && (
                  <span className="block text-xs whitespace-normal text-muted-foreground">
                    {row.description}
                  </span>
                )}
              </td>
              <td className="px-3 py-3.5 whitespace-nowrap">
                {formatDueDate(row.dueDate)}
                {/* ⚠️ THE AGEING IS THE SCAN SIGNAL ON THIS SCREEN, and it was
                    the same grey as everything else. Late money is the reason
                    the book exists; it now reads as late. `current` stays quiet
                    — colouring "Not due yet" would spend the alarm on the one
                    state that is fine. */}
                <span
                  className={`block text-xs ${
                    row.ageingBucket === "current" ? "text-muted-foreground" : "text-danger"
                  }`}
                >
                  {ageingBucketLabel(row.ageingBucket)}
                </span>
              </td>
              <td className="px-3 py-3.5 text-right whitespace-nowrap">
                {formatMoney(row.amountMinorUnits, row.currency)}
              </td>
              <td className="px-3 py-3.5 text-right whitespace-nowrap">
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
              <td className="px-3 py-3.5">
                <StatusBadge status={row.displayStatus} />
                {chaseBlockedLine(row.status, row.chaseBlockedReason) && (
                  <span className="mt-1 block max-w-[14rem] text-xs whitespace-normal text-danger">
                    {chaseBlockedLine(row.status, row.chaseBlockedReason)}
                  </span>
                )}
                {/* ⚠️ AMBER, NOT RED, AND THAT IS THE DIFFERENCE BETWEEN THE
                    TWO LINES. Red means Eva is failing right now. A draft is
                    not failing — nobody asked her to chase it yet — but its
                    recipient is already wrong, and finding that out one invoice
                    at a time while activating twenty of them is the thing this
                    exists to prevent. */}
                {draftBlockedLine(row.status, row.chaseBlockedReason) && (
                  <span className="mt-1 block max-w-[14rem] text-xs whitespace-normal text-warning-strong">
                    {draftBlockedLine(row.status, row.chaseBlockedReason)}
                  </span>
                )}
              </td>
              <td className="px-3 py-3.5 text-xs whitespace-nowrap text-muted-foreground">
                {chaseTimingLine({
                  isChased: chased,
                  lastChasedOn: row.lastChasedOn,
                  nextChaseOn: row.nextChaseOn,
                  formatDate: (value) => formatDueDate(value),
                })}
              </td>
              {/*
               * ⚠️ PINNED TO THE RIGHT EDGE. This table is wider than its
               * container by design (the spec asks for `overflow-x:auto` and a
               * 960px minimum), which is fine for detail you read — and not
               * fine for the controls you press. Before this, paying an invoice
               * meant scrolling sideways to find the button. Sticky keeps the
               * actions on screen while Client, Due and Chasing scroll beneath.
               * The background must stay opaque or the rows show through.
               */}
              <td className="sticky right-0 bg-surface px-3 py-3.5 shadow-[var(--shadow-sticky-edge)]">
                {/* Empty for a read-only role — the reason is said once above
                    the table rather than repeated on every row of the book.

                    ⚠️ ONE ROW, NOT WRAPPED. `flex-wrap` here stacked the three
                    actions vertically, because the column is the narrowest one
                    in the table and always will be. The table already scrolls
                    horizontally at 960px, so the actions are allowed the width
                    they need; the ROW HEIGHT is the scarce resource, not the
                    column. */}
                <div className="flex items-center justify-end gap-1.5">
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
                  {menuItems.length > 0 && (
                    <RowMenu
                      label={`More actions for invoice ${row.invoiceNumber}`}
                      items={menuItems}
                    />
                  )}
                </div>
              </td>
            </tr>

            {isOpen && open && (
              <tr className="border-b border-hairline">
                <td colSpan={BOOK_COLUMNS} className="px-3 pb-4">
                  {/* ⚠️ THE CONTACT CHECK IS NESTED, NOT `&&`-ed INTO THIS ARM.
                      Written as `kind === "contact" && row.contact ?`, an
                      invoice whose contact vanished would fail this test, fail
                      the lifecycle one, and fall through to the PAYMENT form —
                      a state `stillValid` already prevents, which is exactly
                      why it would never be noticed if it ever stopped. */}
                  {open.panel.kind === "contact" ? (
                    row.contact ? (
                      <ContactPanel
                        key={`${row.id}:contact`}
                        organisationId={organisationId}
                        row={row}
                        contact={row.contact}
                        onClose={() => setPanel(null)}
                      />
                    ) : null
                  ) : open.panel.kind === "lifecycle" ? (
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
 * What this drawer is and what it is about to do.
 *
 * ⚠️ ONE HEADING FOR ALL THREE, so a payment, a confirm step and a contact edit
 * cannot end up three different sizes of "important". The title carries the
 * invoice number because the drawer opens under a row in a table of twenty, and
 * a panel that does not name its subject is a panel you have to scroll up from
 * to be sure.
 */
function PanelHeading({ title, detail }: { title: string; detail?: string | undefined }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="font-display text-[15px] leading-snug font-semibold">{title}</p>
      {detail && <p className="text-[13px] leading-relaxed text-muted-foreground">{detail}</p>}
    </div>
  );
}

/**
 * Correcting the person Eva writes to, without touching the invoice.
 *
 * ⚠️ THIS EDITS A CONTACT, AND THE INVOICE IS ONLY HERE TO SAY WHOSE. The
 * founder's instinct on 2026-08-18 was that fixing one wrong detail should not
 * mean re-entering an invoice, and the data already agreed: the customer, the
 * contact and the invoice are three records. This form writes to exactly one of
 * them.
 *
 * ⚠️ IT WORKS ON A LIVE INVOICE, DELIBERATELY. The invoice's own figures lock
 * once Eva starts chasing (BRD 4.1) because they were sent to somebody. An
 * address is the opposite: a wrong one matters MOST once chasing has started,
 * because that is when it is silently failing.
 */
function ContactPanel({
  organisationId,
  row,
  contact,
  onClose,
}: {
  organisationId: string;
  row: BookRow;
  contact: NonNullable<BookRow["contact"]>;
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState<ContactActionState, FormData>(updateContact, {});
  const sent = state.values;

  return (
    <form action={action} className={panelClass()}>
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="customerId" value={row.customer.id} />
      <input type="hidden" name="contactId" value={contact.id} />

      {/* Said out loud, because the row this drawer opens under is an invoice
          and everything else you can do from that row changes the invoice. */}
      <PanelHeading
        title={`Who Eva writes to about ${row.invoiceNumber}`}
        detail={`This changes ${contact.name}'s details for ${row.customer.name} everywhere — not just on this invoice. The invoice itself is not touched.`}
      />

      <div className="flex flex-wrap gap-3">
        <label className={LABEL}>
          Contact name
          <input
            name="name"
            required
            maxLength={200}
            defaultValue={sent?.name ?? contact.name}
            className={FIELD}
          />
        </label>
        <label className={LABEL}>
          Email
          <input
            name="email"
            type="email"
            maxLength={320}
            defaultValue={sent?.email ?? contact.email ?? ""}
            className={FIELD}
          />
          {/* ⚠️ EMPTY IS A REAL INSTRUCTION HERE, not a no-op. The action sends
              null for a blank box, so this has to warn BEFORE the save rather
              than explain afterwards. */}
          <span className="text-xs text-muted-foreground">
            Clear this and Eva stops chasing — there would be nobody to write to.
          </span>
        </label>
        <label className={LABEL}>
          Phone
          <input
            name="phone"
            type="tel"
            maxLength={50}
            defaultValue={sent?.phone ?? contact.phone ?? ""}
            className={FIELD}
          />
          <span className="text-xs text-muted-foreground">
            Not used yet — it is for calling later.
          </span>
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

      <div className="flex gap-3">
        <button type="submit" disabled={pending} className={PRIMARY_BUTTON}>
          {pending ? "Saving…" : "Save contact"}
        </button>
        <button type="button" onClick={onClose} disabled={pending} className={SMALL_BUTTON}>
          Close
        </button>
      </div>
    </form>
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
    <div className={panelClass(isInvoiceActionIrreversible(action) ? "danger" : undefined)}>
      <PanelHeading
        title={`${invoiceActionLabel(action)} — ${row.invoiceNumber}`}
        detail={invoiceActionConsequence(action, {
          invoiceNumber: row.invoiceNumber,
          chaseBlockedReason: row.chaseBlockedReason,
        })}
      />
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
    <form action={action} className={panelClass()}>
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="customerId" value={row.customer.id} />
      <input type="hidden" name="invoiceId" value={row.id} />
      {/* The invoice's OWN currency decides how many decimals are allowed. */}
      <input type="hidden" name="currency" value={row.currency} />

      <PanelHeading
        title={`Record a payment against ${row.invoiceNumber}`}
        detail={`${formatMoney(row.outstandingMinorUnits, row.currency)} is outstanding on a total of ${formatMoney(row.amountMinorUnits, row.currency)}.`}
      />

      <div className="flex flex-wrap gap-3">
        <label className={LABEL}>
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
        <label className={LABEL}>
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

/**
 * A fact nobody has filled in yet.
 *
 * ⚠️ A DASH, NOT AN EMPTY CELL. Blank reads as "the screen failed to load this"
 * — and on the email column, blank is the one thing worth noticing, because an
 * invoice with no address is an invoice Eva cannot chase. The Status column
 * already says so in words; this only has to look deliberate.
 */
function MissingValue() {
  return (
    <span className="text-faint" title="Not set">
      —
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-[var(--radius-pill)] px-2.5 py-[3px] text-[11.5px] font-semibold ${TONE_CLASSES[invoiceStatusTone(status)]}`}
    >
      {invoiceStatusLabel(status)}
    </span>
  );
}

/**
 * The row overflow, as a menu that floats above the page (founder, 2026-08-18,
 * walking the screen: *"this should fold into a drop down not show up below"*).
 *
 * ⚠️ IT IS PORTALLED TO `document.body`, AND THAT IS THE WHOLE POINT. The
 * earlier version of this was a panel unfolded under the row, chosen on
 * 2026-08-11 because the table lives in `overflow-x-auto` and that clips any
 * absolutely-positioned child — a menu rendered inside the cell is cropped at
 * the edge of the scroll box no matter how it is stacked. A portal leaves the
 * clipping container entirely, so the menu is laid out against the viewport and
 * nothing can crop it. This is the only reason the fix needs a portal at all;
 * do not "simplify" it back into the cell.
 *
 * ⚠️ IT CLOSES ON SCROLL RATHER THAN FOLLOWING THE BUTTON. Fixed coordinates
 * are measured once, when it opens. Tracking the trigger through both the
 * page's scroll and the table's own sideways scroll is a lot of machinery to
 * keep a menu glued to a button somebody has stopped looking at; a menu that
 * quietly gets out of the way is the better answer and cannot ever be seen
 * hanging in the wrong place.
 */
function RowMenu({
  label,
  items,
}: {
  label: string;
  items: { key: string; label: string; danger?: boolean | undefined; onSelect: () => void }[];
}) {
  /**
   * The open menu's viewport coordinates — and `null` for "closed", so there is
   * one piece of state rather than two that can disagree.
   *
   * ⚠️ MEASURED IN THE CLICK, NOT IN AN EFFECT. Measuring after render would
   * mean setting state from inside an effect, which paints the menu once at the
   * wrong place and once at the right one. The button is already laid out when
   * it is clicked, so the honest moment to read its box is then.
   */
  const [menu, setMenu] = useState<{ top: number; right: number } | null>(null);
  const open = menu !== null;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const toggle = () => {
    if (menu) {
      setMenu(null);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) return;
    const box = trigger.getBoundingClientRect();
    /* Right-aligned to the trigger: this button is pinned to the right edge of
       the table, so a left-aligned menu would open off the screen. */
    setMenu({ top: box.bottom + 6, right: Math.max(8, window.innerWidth - box.right) });
  };

  useEffect(() => {
    if (!open) return;
    const close = () => setMenu(null);
    /* `true` — capture. The table's own scroll container never bubbles a scroll
       event to the window, so a listener on the bubble phase would miss exactly
       the scroll this menu is most likely to be wrongly positioned by. */
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenu(null);
      /* Escape must give the keyboard back to the button it came from, or the
         next Tab starts from the top of the document. */
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  /* Focus lands on the first item, so the menu is usable without a mouse. */
  useEffect(() => {
    if (menu) menuRef.current?.querySelector("button")?.focus();
  }, [menu]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        /* The invoice number is in the name because a screen reader hears
           twenty of these and no column header. */
        aria-label={label}
        className={`${SMALL_BUTTON} px-2 leading-none`}
      >
        <span aria-hidden>···</span>
      </button>
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            style={{ top: menu.top, right: menu.right }}
            className="fixed z-50 flex min-w-[13rem] flex-col rounded-[var(--radius-card)] border border-border bg-surface py-1.5 shadow-[var(--shadow-panel)]"
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  item.onSelect();
                }}
                className={`px-4 py-2 text-left text-[13px] font-medium whitespace-nowrap hover:bg-chip-hover ${
                  item.danger ? "text-danger" : ""
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

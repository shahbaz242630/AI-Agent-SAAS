"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import {
  addClient,
  assignClients,
  removeClient,
  updateClient,
  type ClientActionState,
} from "./actions";

/**
 * Must match `MAX_CLIENTS_PER_ALLOCATION` in `@eva/types`, which the API
 * enforces. Duplicated rather than imported because `apps/web` deliberately
 * does not depend on the shared packages — it redeclares every contract shape
 * it uses (slice 1.6 ruling 1, thin UI).
 *
 * Drift is mild and self-announcing: if the API bound dropped below this, a
 * select-all would surface the validation pipe's raw message again, which is
 * the defect this constant exists to prevent.
 */
const MAX_CLIENTS_PER_ALLOCATION = 500;

const INITIAL_STATE: ClientActionState = {};

const BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60";
const SMALL_BUTTON_CLASS =
  "rounded-[var(--radius-control)] border border-input-border bg-surface px-3 py-1.5 text-xs font-semibold hover:bg-chip-hover disabled:opacity-60";
const DANGER_BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-danger px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60";
const FIELD_CLASS =
  "w-full rounded-[var(--radius-control)] border border-input-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary";

interface ClientRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  reference: string | null;
  emailAccountId: string | null;
}

interface MailboxRow {
  id: string;
  emailAddress: string;
  isPrimary: boolean;
  healthStatus: "active" | "auth_expired" | "error" | null;
  allocatedClientCount: number;
}

interface AllocationRow {
  customerId: string;
  emailAccountId: string | null;
  resolvedEmailAddress: string | null;
  isFallback: boolean;
}

function Feedback({ state }: { state: ClientActionState }) {
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
 * Add a client.
 *
 * `emailAccountId` is a hidden field carrying the mailbox whose book is being
 * viewed. That is the whole of the founder's "assign this email to the new
 * business": you are already inside trade@'s screen, so trade@ chases what you
 * add. Empty on the all-clients view, which means unallocated — chased from the
 * default (ruling 1), which is normal rather than a gap.
 */
export function AddClientForm({
  organisationId,
  emailAccountId,
  mailboxAddress,
  existing,
}: {
  organisationId: string;
  emailAccountId: string | null;
  mailboxAddress: string | null;
  /**
   * Every client in the organisation, for the duplicate check.
   *
   * ⚠️ ALL OF THEM, NEVER THE VISIBLE ONES. Inside a mailbox's book the table
   * shows only that mailbox's clients — so checking against what is on screen
   * would miss a same-named client filed under a different mailbox, which is
   * exactly the duplicate hardest to notice afterwards.
   */
  existing: ClientRow[];
}) {
  const [state, action, pending] = useActionState(addClient, INITIAL_STATE);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  /** Ticked to say "yes, a different client of the same name" — see below. */
  const [acknowledged, setAcknowledged] = useState(false);

  /**
   * ⚠️ CLEARED WHEN AN ADD SUCCEEDS, DURING RENDER RATHER THAN IN AN EFFECT.
   * React empties an uncontrolled form once its action returns, but this field
   * is controlled so it would keep the name — and the client it just created
   * would then match it and warn about a duplicate of itself. Comparing the
   * last success we handled is React's own way of adjusting state to a change,
   * and it avoids setting state from an effect.
   */
  const [lastSuccess, setLastSuccess] = useState(state.success);
  if (state.success !== lastSuccess) {
    setLastSuccess(state.success);
    setName("");
    setAcknowledged(false);
  }

  /**
   * ⚠️ A WARNING, NOT A BLOCK, AND THE FOUNDER IS RIGHT ABOUT WHY (2026-08-18):
   * *"two companies might have same names.. or even when a freelancer wants to
   * add an individual"*. Two clients called Imran Khalid are an ordinary fact
   * about the world, so refusing would be wrong. What is NOT ordinary is
   * creating the second one without noticing, which is how a book quietly ends
   * up chasing the wrong person.
   */
  const duplicates = useMemo(() => {
    const wanted = name.trim().toLowerCase();
    return wanted === "" ? [] : existing.filter((client) => client.name.toLowerCase() === wanted);
  }, [existing, name]);
  const mustAcknowledge = duplicates.length > 0 && !acknowledged;

  if (!open) {
    return (
      <div className="flex w-full max-w-4xl flex-col gap-2">
        <div>
          <button type="button" onClick={() => setOpen(true)} className={BUTTON_CLASS}>
            Add a client
          </button>
        </div>
        <Feedback state={state} />
      </div>
    );
  }

  return (
    <form
      action={action}
      className="flex w-full flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-4"
    >
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="emailAccountId" value={emailAccountId ?? ""} />
      <p className="text-sm font-medium">
        {mailboxAddress
          ? `New client, chased from ${mailboxAddress}`
          : "New client, chased from your default mailbox"}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            name="name"
            required
            maxLength={200}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              // A tick made about one name must not carry over to another.
              setAcknowledged(false);
            }}
            className={FIELD_CLASS}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input name="email" type="email" maxLength={320} className={FIELD_CLASS} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Phone
          <input name="phone" maxLength={50} className={FIELD_CLASS} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Your reference
          <input name="reference" maxLength={100} className={FIELD_CLASS} />
        </label>
      </div>
      {duplicates.length > 0 && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-warning-border bg-warning-tint px-4 py-3"
        >
          <p className="text-sm font-semibold text-warning-strong">
            {duplicates.length === 1
              ? `You already have a client called "${name.trim()}".`
              : `You already have ${String(duplicates.length)} clients called "${name.trim()}".`}
          </p>
          <ul className="flex flex-col gap-1">
            {duplicates.map((client) => (
              <li key={client.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">
                  {[client.reference ? `Ref ${client.reference}` : null, client.email]
                    .filter(Boolean)
                    .join(" · ") || "No reference or email"}
                </span>
                {/* The way OUT of the warning, not just a description of it. */}
                <Link
                  href={`/app/clients/${client.id}/invoices`}
                  className="font-medium text-link hover:underline"
                >
                  Open this one
                </Link>
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            This is a different client — add it anyway
          </label>
          <p className="text-xs text-muted-foreground">
            If it is, give it a reference below. It is the only thing that will tell the two apart
            on a list, and Eva matches on it before the name.
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending || mustAcknowledge} className={BUTTON_CLASS}>
          {pending ? "Adding…" : duplicates.length > 0 ? "Add as a separate client" : "Add client"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          className={SMALL_BUTTON_CLASS}
        >
          Cancel
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/**
 * The book, with who chases whom, and bulk filing.
 *
 * The whole table sits in ONE form so the tick boxes and the mailbox chooser
 * submit together as a single request — which is what makes it one transaction
 * on the API side (ALLOCATION-SCOPE trap 3). Moving a book of clients as one
 * request per row would leave a half-moved book if it failed in the middle.
 */
export function ClientTable({
  organisationId,
  clients,
  mailboxes,
  chasedBy,
  defaultEmailAddress,
  totalCount,
}: {
  organisationId: string;
  clients: ClientRow[];
  mailboxes: MailboxRow[];
  chasedBy: Map<string, AllocationRow>;
  defaultEmailAddress: string | null;
  totalCount: number;
}) {
  const [assignState, assignAction, assignPending] = useActionState(assignClients, INITIAL_STATE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * Select-all is CAPPED at what one request can carry.
   *
   * The API bounds a batch at 500 so a single request cannot open an unbounded
   * transaction. Without a matching cap here, an organisation with 2,000
   * clients could tick every row, see a button reading "File 2000 clients", and
   * get back the validation pipe's raw text — `customerIds: Too big: expected
   * array to have <=500 items` — which is not a sentence anybody should be
   * shown. Selecting the first 500 and saying so is the honest version.
   */
  function toggleAll() {
    setSelected((current) =>
      current.size > 0
        ? new Set()
        : new Set(clients.slice(0, MAX_CLIENTS_PER_ALLOCATION).map((row) => row.id)),
    );
  }

  const capped = clients.length > MAX_CLIENTS_PER_ALLOCATION;
  /** How many rows select-all can actually take — the cap, or the whole list. */
  const selectableCount = Math.min(clients.length, MAX_CLIENTS_PER_ALLOCATION);

  // Resolved once, and the source of truth for whether the edit panel renders
  // at all — see the note where it is used.
  const editingClient = editing ? (clients.find((row) => row.id === editing) ?? null) : null;

  if (totalCount === 0) {
    return (
      <p className="w-full max-w-4xl text-sm text-muted-foreground">
        No clients yet. Add your first one above, or import a list once invoice import lands.
      </p>
    );
  }

  return (
    <section className="flex w-full max-w-4xl flex-col gap-3">
      <form action={assignAction} className="flex flex-col gap-3">
        <input type="hidden" name="organisationId" value={organisationId} />

        {/* Only worth showing with somewhere to move clients TO. With one
            mailbox every client is chased from it either way, and a chooser
            offering a single option is noise. */}
        {mailboxes.length > 1 && (
          <div className="flex flex-wrap items-end gap-2 rounded-[var(--radius-card)] border border-border bg-muted px-4 py-3">
            <label className="flex flex-col gap-1 text-sm">
              Chase the selected clients from
              <select name="emailAccountId" className={FIELD_CLASS} defaultValue="">
                {/* "" is an explicit action — back to the default (ruling 1) —
                    not an absent value. */}
                <option value="">
                  {defaultEmailAddress
                    ? `Default mailbox (${defaultEmailAddress})`
                    : "Default mailbox"}
                </option>
                {mailboxes.map((mailbox) => (
                  <option key={mailbox.id} value={mailbox.id}>
                    {mailbox.emailAddress}
                    {mailbox.healthStatus === "active" ? "" : " — needs reconnecting"}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={assignPending || selected.size === 0}
              className={BUTTON_CLASS}
            >
              {assignPending
                ? "Filing…"
                : `File ${selected.size === 1 ? "1 client" : `${selected.size} clients`}`}
            </button>
            {capped && (
              <p className="w-full text-xs text-muted-foreground">
                {`You can file up to ${MAX_CLIENTS_PER_ALLOCATION} clients at a time, so Select all takes the first ${MAX_CLIENTS_PER_ALLOCATION}. Repeat to do the rest.`}
              </p>
            )}
          </div>
        )}

        <Feedback state={assignState} />

        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
          {/* 36rem was the floor when the client, its email and its reference
              shared one cell. Splitting email and phone out added two columns
              that need real room before they start wrapping mid-address. */}
          <table className="w-full min-w-[52rem] text-left text-sm">
            <thead>
              {/* ⚠️ NOT UPPERCASE ANY MORE (2026-08-18). Invoices sets its
                  headers in sentence case and this table shouted them, so the
                  two tables in the product disagreed about what a table header
                  looks like. The design package uses uppercase for pills and
                  small section labels — "Outstanding · GBP", "Modules" — and
                  never for a column heading. Noted as a snag on 2026-08-12. */}
              <tr className="border-b border-hairline text-[11.5px] font-semibold tracking-[0.04em] text-faint">
                {mailboxes.length > 1 && (
                  <th scope="col" className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label="Select all clients"
                      /**
                       * Ticked only when EVERY selectable row is selected —
                       * `selected.size > 0` claimed "all" while three of eight
                       * were ticked, which is a header lying about the rows
                       * underneath it. Seen on staging, not in a test.
                       *
                       * Compared against the capped count, because select-all
                       * takes at most MAX_CLIENTS_PER_ALLOCATION.
                       */
                      checked={selected.size > 0 && selected.size === selectableCount}
                      onChange={toggleAll}
                    />
                  </th>
                )}
                {/* Email and phone are columns here for the same reason they
                    are columns on Invoices: they are separate facts somebody
                    corrects one at a time, not one blob of "client details". */}
                <th scope="col" className="px-4 py-3 font-medium">
                  Client
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Email
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Phone
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Chased from
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => {
                const allocation = chasedBy.get(client.id);
                return (
                  <tr
                    key={client.id}
                    className="border-b border-hairline align-top hover:bg-row-hover"
                  >
                    {mailboxes.length > 1 && (
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          name="customerIds"
                          value={client.id}
                          checked={selected.has(client.id)}
                          onChange={() => toggle(client.id)}
                          aria-label={`Select ${client.name}`}
                        />
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <span className="font-medium">{client.name}</span>
                      {/* The reference stays under the name because it IS the
                          name — the customer's own code for this client — and
                          not a way of contacting anybody. */}
                      {client.reference && (
                        <span className="block text-xs text-muted-foreground">
                          {`Ref ${client.reference}`}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {client.email ?? <span className="text-faint">—</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {client.phone ?? <span className="text-faint">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {/* The API resolved this, not the browser. A client with
                          no allocation of its own is shown as falling back —
                          visibly different from a deliberate filing, so nobody
                          mistakes "not sorted yet" for "sorted". */}
                      {allocation?.resolvedEmailAddress ? (
                        <span className={allocation.isFallback ? "text-muted-foreground" : ""}>
                          {allocation.isFallback
                            ? `Default (${allocation.resolvedEmailAddress})`
                            : allocation.resolvedEmailAddress}
                        </span>
                      ) : (
                        <span className="text-danger">No mailbox — nothing will be sent</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {/* The only route to a client's invoices (slice 1.6c).
                            A plain link, not a button: it navigates, and it
                            must keep working inside this form without
                            submitting it. */}
                        {/* ⚠️ STILL AN ANCHOR, ONLY DRESSED LIKE ITS NEIGHBOUR.
                            It navigates, so it must stay a link — middle-click
                            and "open in new tab" are real things people do with
                            it, and a <button> takes both away. What changed on
                            2026-08-18 is the look: bare blue text beside a
                            bordered "Edit" read as two unrelated things when
                            they are two controls on the same row. */}
                        <Link
                          href={`/app/clients/${client.id}/invoices`}
                          className={SMALL_BUTTON_CLASS}
                        >
                          Invoices
                        </Link>
                        <button
                          type="button"
                          onClick={() => setEditing(editing === client.id ? null : client.id)}
                          className={SMALL_BUTTON_CLASS}
                        >
                          {editing === client.id ? "Close" : "Edit"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </form>

      {/* Edit sits OUTSIDE the bulk-assign form: nested forms are invalid HTML
          and the inner submit would post to the outer action.

          Looked up by find() and rendered only if FOUND — never with a
          non-null assertion. Removing a client revalidates the page, the row
          leaves `clients`, and `editing` still holds its id: asserting here
          passed `undefined` into a component that reads `client.name`, so a
          SUCCESSFUL removal crashed the page into the error boundary and took
          the "Client removed." message with it. The user could not tell whether
          it had worked, and the natural response is to try again. */}
      {editingClient && (
        <EditClientForm
          organisationId={organisationId}
          client={editingClient}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function EditClientForm({
  organisationId,
  client,
  onClose,
}: {
  organisationId: string;
  client: ClientRow;
  onClose: () => void;
}) {
  const [updateState, updateAction, updatePending] = useActionState(updateClient, INITIAL_STATE);
  const [removeState, removeAction, removePending] = useActionState(removeClient, INITIAL_STATE);
  // Inline two-step confirm, never window.confirm(): a native dialog freezes
  // the page for browser automation, and the e2e has to drive this button.
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-4">
      <form action={updateAction} className="flex flex-col gap-3">
        <input type="hidden" name="organisationId" value={organisationId} />
        <input type="hidden" name="customerId" value={client.id} />
        <p className="text-sm font-medium">{`Edit ${client.name}`}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            Name
            <input
              name="name"
              required
              maxLength={200}
              defaultValue={client.name}
              className={FIELD_CLASS}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              name="email"
              type="email"
              maxLength={320}
              defaultValue={client.email ?? ""}
              className={FIELD_CLASS}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Phone
            <input
              name="phone"
              maxLength={50}
              defaultValue={client.phone ?? ""}
              className={FIELD_CLASS}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Your reference
            <input
              name="reference"
              maxLength={100}
              defaultValue={client.reference ?? ""}
              className={FIELD_CLASS}
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={updatePending} className={BUTTON_CLASS}>
            {updatePending ? "Saving…" : "Save changes"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={updatePending}
            className={SMALL_BUTTON_CLASS}
          >
            Close
          </button>
          {!confirming && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className={SMALL_BUTTON_CLASS}
            >
              Remove
            </button>
          )}
        </div>
        <Feedback state={updateState} />
      </form>

      {confirming && (
        <div className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-background p-3">
          <p className="text-sm">
            {`Remove ${client.name}? Their invoices stay on record and Eva stops chasing them.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <form action={removeAction}>
              <input type="hidden" name="organisationId" value={organisationId} />
              <input type="hidden" name="customerId" value={client.id} />
              <button type="submit" disabled={removePending} className={DANGER_BUTTON_CLASS}>
                {removePending ? "Removing…" : "Yes, remove"}
              </button>
            </form>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={removePending}
              className={SMALL_BUTTON_CLASS}
            >
              Keep them
            </button>
          </div>
          <Feedback state={removeState} />
        </div>
      )}
    </div>
  );
}

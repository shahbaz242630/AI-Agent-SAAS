"use client";

import { useActionState, useState } from "react";
import {
  addClient,
  assignClients,
  removeClient,
  updateClient,
  type ClientActionState,
} from "./actions";

const INITIAL_STATE: ClientActionState = {};

const BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60";
const SMALL_BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-muted px-3 py-1.5 text-xs font-medium hover:opacity-80 disabled:opacity-60";
const DANGER_BUTTON_CLASS =
  "rounded-[var(--radius-card)] bg-danger px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60";
const FIELD_CLASS =
  "w-full rounded-[var(--radius-card)] border border-muted-foreground/30 bg-background px-3 py-2 text-sm outline-none focus:border-primary";

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
}: {
  organisationId: string;
  emailAccountId: string | null;
  mailboxAddress: string | null;
}) {
  const [state, action, pending] = useActionState(addClient, INITIAL_STATE);
  const [open, setOpen] = useState(false);

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
      className="flex w-full max-w-4xl flex-col gap-3 rounded-[var(--radius-card)] bg-muted px-6 py-4"
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
          <input name="name" required maxLength={200} className={FIELD_CLASS} />
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
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className={BUTTON_CLASS}>
          {pending ? "Adding…" : "Add client"}
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

  function toggleAll() {
    setSelected((current) =>
      current.size === clients.length ? new Set() : new Set(clients.map((row) => row.id)),
    );
  }

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
          <div className="flex flex-wrap items-end gap-2 rounded-[var(--radius-card)] bg-muted px-4 py-3">
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
          </div>
        )}

        <Feedback state={assignState} />

        <div className="overflow-x-auto rounded-[var(--radius-card)] bg-muted">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead>
              <tr className="border-b border-muted-foreground/20">
                {mailboxes.length > 1 && (
                  <th scope="col" className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label="Select all clients"
                      checked={clients.length > 0 && selected.size === clients.length}
                      onChange={toggleAll}
                    />
                  </th>
                )}
                <th scope="col" className="px-4 py-3 font-medium">
                  Client
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
                  <tr key={client.id} className="border-b border-muted-foreground/10 align-top">
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
                      {client.email && (
                        <span className="block text-xs text-muted-foreground">{client.email}</span>
                      )}
                      {client.reference && (
                        <span className="block text-xs text-muted-foreground">
                          {`Ref ${client.reference}`}
                        </span>
                      )}
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
                      <button
                        type="button"
                        onClick={() => setEditing(editing === client.id ? null : client.id)}
                        className={SMALL_BUTTON_CLASS}
                      >
                        {editing === client.id ? "Close" : "Edit"}
                      </button>
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
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-muted px-6 py-4">
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

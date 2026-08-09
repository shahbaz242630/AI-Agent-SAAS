import Link from "next/link";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { defaultInvoiceCurrency } from "@/lib/currencies";
import { invoiceCountLine, noInvoicesLine } from "@/lib/invoice-messages";
import { can, readOnlyInvoicesLine } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { AddInvoiceForm, InvoiceTable, type InvoiceRow } from "./invoice-controls";

/**
 * One client's invoices (slice 1.6c, task 1).
 *
 * The API has had full invoice CRUD since slice 1.2 and there has never been a
 * screen, so nobody with a browser could see what a debtor owes — which is why
 * slice 1.7 has nothing to send. This is the first half of fixing that.
 *
 * ⚠️ THIS SCREEN COMPUTES NOTHING ABOUT MONEY OR TIME. The balance arrives as
 * `outstandingMinorUnits` and the status as `displayStatus`, both derived by the
 * API — the balance because a third number can disagree with the other two, and
 * the status because `overdue` depends on the ORGANISATION's timezone. Derive
 * either here and an invoice changes its meaning when the reader travels
 * (traps 1 and 2).
 */

interface OrganisationSummary {
  id: string;
  name: string;
  roleKey: string;
  /** What this person may do here — resolved by the API, never by us. */
  permissions: string[];
  /** What a new invoice's currency dropdown opens on (task 13). */
  defaultCurrency?: string;
}

interface ClientRow {
  id: string;
  name: string;
  email: string | null;
  reference: string | null;
}

export default async function CustomerInvoicesPage({
  params,
}: {
  // Next 16: `params` is a Promise and must be awaited.
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await params;
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims) redirect("/sign-in");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) redirect("/sign-in");

  // Single-org app today — the /app/clients precedent.
  const organisations = (await (
    await apiFetch("/organisations", accessToken)
  ).json()) as OrganisationSummary[];
  const organisation = organisations[0];

  if (!organisation) {
    return (
      <Shell customerId={null}>
        <p className="w-full max-w-4xl text-sm text-muted-foreground">
          Create an organisation first.{" "}
          <Link href="/app/organisations/new" className="font-medium text-primary hover:underline">
            New organisation
          </Link>
        </p>
      </Shell>
    );
  }

  /**
   * The CLIENT is fetched first and separately, and the reason is the gate
   * order 404 → 403 → 402 (standing rule §0d).
   *
   * `customers:read` is core; `invoices:read` belongs to the email credit
   * controller. So a customer id that does not exist must 404 before anything
   * mentions entitlement — otherwise "you don't have Invoice Chasing" becomes a
   * way to ask whether an arbitrary id exists in somebody else's organisation.
   */
  let client: ClientRow | null = null;
  let clientMissing = false;
  let clientForbidden = false;
  try {
    client = (await (
      await apiFetch(`/organisations/${organisation.id}/customers/${customerId}`, accessToken)
    ).json()) as ClientRow;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    else if (error instanceof ApiError && error.status === 404) clientMissing = true;
    else if (error instanceof ApiError && error.status === 403) clientForbidden = true;
    else throw error;
  }

  if (clientMissing) {
    return (
      <Shell customerId={null}>
        <p className="w-full max-w-4xl text-sm text-muted-foreground">
          That client no longer exists. It may have been removed in another tab.
        </p>
      </Shell>
    );
  }

  if (clientForbidden || !client) {
    return (
      <Shell customerId={null}>
        <p className="w-full max-w-4xl text-sm text-muted-foreground">
          {`Your role doesn't have access to clients for ${organisation.name}. Ask an owner or administrator.`}
        </p>
      </Shell>
    );
  }

  let invoices: InvoiceRow[] = [];
  let forbidden = false;
  let notEntitled = false;
  try {
    invoices = (await (
      await apiFetch(
        `/organisations/${organisation.id}/customers/${customerId}/invoices`,
        accessToken,
      )
    ).json()) as InvoiceRow[];
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    else if (error instanceof ApiError && error.status === 403) forbidden = true;
    else if (error instanceof ApiError && error.status === 402) notEntitled = true;
    else throw error;
  }

  if (notEntitled) {
    return (
      <Shell customerId={customerId}>
        <section className="flex w-full max-w-4xl flex-col gap-3 rounded-[var(--radius-card)] bg-muted px-6 py-4">
          {/* One interpolated string, never `{name}` beside wrapping JSX text —
              Next 16's build drops the space between them (handoff §0c), and
              `{" "}` does not survive Prettier. */}
          <p className="text-sm">
            {`${organisation.name} doesn't have Invoice Chasing, so there are no invoices to show yet.`}
          </p>
          <div>
            <Link
              href="/app/settings/modules"
              className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              See your products
            </Link>
          </div>
        </section>
      </Shell>
    );
  }

  if (forbidden) {
    return (
      <Shell customerId={customerId}>
        <p className="w-full max-w-4xl text-sm text-muted-foreground">
          {`Your role can see ${client.name} but not their invoices. Ask an owner or administrator.`}
        </p>
      </Shell>
    );
  }

  /**
   * Contacts are fetched SEPARATELY and a refusal here is swallowed.
   *
   * The 1.6b lesson: fetching two things in one `try` means a 403 on the second
   * replaces the whole screen with a message about the first, and that message
   * is then wrong. A reminder recipient is optional on the API, so if this list
   * cannot be read the form simply does not offer the field — which is a
   * smaller loss than not being able to raise an invoice at all.
   */
  let contacts: { id: string; name: string }[] = [];
  try {
    contacts = (await (
      await apiFetch(
        `/organisations/${organisation.id}/customers/${customerId}/contacts`,
        accessToken,
      )
    ).json()) as { id: string; name: string }[];
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    // 403 and 402 both just mean "no recipient picker". Anything else is a
    // genuine fault and should not be hidden.
    else if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 402)) {
      throw error;
    }
  }

  /**
   * Which currency the add form opens on — the rule and its ordering live in
   * `lib/currencies.ts` (task 13), because the book's own add-a-row form has to
   * answer the same question and two copies would drift.
   */
  const defaultCurrency = defaultInvoiceCurrency({
    existingCurrencies: invoices.map((invoice) => invoice.currency),
    organisationDefault: organisation.defaultCurrency,
  });

  /**
   * Task 8. `sales`, `reception` and `read_only` hold `invoices:read` and not
   * `invoices:write`, so they belong on this screen and belong nowhere near its
   * buttons. Read from the API's own answer rather than from `roleKey`, because
   * an organisation may have granted the write to a role the BRD matrix does
   * not — see `lib/permissions.ts`.
   */
  const canWrite = can(organisation, "invoices:write");

  return (
    <Shell customerId={customerId}>
      <section className="flex w-full max-w-4xl flex-col gap-2">
        <h1 className="text-2xl font-bold text-primary">{`Invoices — ${client.name}`}</h1>
        <p className="text-sm text-muted-foreground">
          {invoiceCountLine(invoices.length, client.name)}
        </p>
      </section>

      {canWrite ? (
        <AddInvoiceForm
          organisationId={organisation.id}
          customerId={customerId}
          clientName={client.name}
          contacts={contacts}
          defaultCurrency={defaultCurrency}
        />
      ) : (
        /* Said rather than silently omitted: somebody who cannot find "Add an
           invoice" concludes the product is broken, and looks for the fault in
           the wrong place. */
        <p className="w-full max-w-4xl rounded-[var(--radius-card)] bg-muted px-6 py-3 text-sm text-muted-foreground">
          {readOnlyInvoicesLine(organisation.name)}
        </p>
      )}

      {invoices.length === 0 ? (
        <p className="w-full max-w-4xl rounded-[var(--radius-card)] bg-muted px-6 py-4 text-sm">
          {noInvoicesLine(client.name)}
        </p>
      ) : (
        <InvoiceTable
          organisationId={organisation.id}
          customerId={customerId}
          invoices={invoices}
          contacts={contacts}
          canWrite={canWrite}
        />
      )}
    </Shell>
  );
}

function Shell({ children, customerId }: { children: React.ReactNode; customerId: string | null }) {
  return (
    <main className="flex w-full max-w-[1080px] flex-1 flex-col gap-[26px] px-10 pt-8 pb-9">
      {children}
      <Link
        href="/app/clients"
        className="text-sm font-medium text-muted-foreground hover:underline"
      >
        Back to clients
      </Link>
      {customerId === null && (
        <Link href="/app" className="text-sm font-medium text-muted-foreground hover:underline">
          Back to your organisations
        </Link>
      )}
    </main>
  );
}

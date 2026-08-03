import Link from "next/link";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { invoiceCountLine, noInvoicesLine } from "@/lib/invoice-messages";
import {
  invoiceStatusLabel,
  invoiceStatusTone,
  type InvoiceStatusTone,
} from "@/lib/invoice-status";
import { formatDueDate, formatMoney } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";

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
}

interface ClientRow {
  id: string;
  name: string;
  email: string | null;
  reference: string | null;
}

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  description: string | null;
  amountMinorUnits: number;
  amountPaidMinorUnits: number;
  /** `amount - paid`, clamped at zero. Derived by the API, never stored. */
  outstandingMinorUnits: number;
  currency: string;
  dueDate: string;
  status: string;
  /** Stored status, or due_soon/due_today/overdue for Active rows. */
  displayStatus: string;
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

  return (
    <Shell customerId={customerId}>
      <section className="flex w-full max-w-4xl flex-col gap-2">
        <h1 className="text-2xl font-bold text-primary">{`Invoices — ${client.name}`}</h1>
        <p className="text-sm text-muted-foreground">
          {invoiceCountLine(invoices.length, client.name)}
        </p>
      </section>

      {invoices.length === 0 ? (
        <p className="w-full max-w-4xl rounded-[var(--radius-card)] bg-muted px-6 py-4 text-sm">
          {noInvoicesLine(client.name)}
        </p>
      ) : (
        <InvoiceTable invoices={invoices} />
      )}
    </Shell>
  );
}

function InvoiceTable({ invoices }: { invoices: InvoiceRow[] }) {
  return (
    <section className="w-full max-w-4xl overflow-x-auto">
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
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => (
            <tr key={invoice.id} className="border-b border-muted/50 align-top">
              <td className="px-3 py-3">
                <span className="font-medium">{invoice.invoiceNumber}</span>
                {invoice.description && (
                  <span className="block text-xs text-muted-foreground">{invoice.description}</span>
                )}
              </td>
              <td className="px-3 py-3 whitespace-nowrap">{formatDueDate(invoice.dueDate)}</td>
              <td className="px-3 py-3 text-right whitespace-nowrap">
                {formatMoney(invoice.amountMinorUnits, invoice.currency)}
              </td>
              <td className="px-3 py-3 text-right whitespace-nowrap">
                <span className={invoice.outstandingMinorUnits > 0 ? "font-medium" : ""}>
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
              <td className="px-3 py-3 whitespace-nowrap">
                <StatusBadge status={invoice.displayStatus} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/*
        ⚠️ NO TOTAL ROW, AND THAT IS DELIBERATE (trap 3b). Currency is per
        invoice, so a column of AED and GBP cannot honestly be added up. A
        confident wrong total is worse than no total. When a total is wanted it
        has to group by currency — that is the org-wide list in task 9.
      */}
    </section>
  );
}

const TONE_CLASSES: Record<InvoiceStatusTone, string> = {
  urgent: "bg-destructive/10 text-destructive",
  attention: "bg-primary/10 text-primary",
  positive: "bg-muted text-foreground",
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

function Shell({ children, customerId }: { children: React.ReactNode; customerId: string | null }) {
  return (
    <main className="flex flex-1 flex-col items-center gap-6 p-8">
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

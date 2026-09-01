import Link from "next/link";
import { redirect } from "next/navigation";
import { moduleHref } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import { createClient } from "@/lib/supabase/server";
import { AddClientForm, ClientTable } from "./client-controls";

/**
 * The clients screen (slice 1.6b, Tasks 8 + 9).
 *
 * ONE page, two modes, because they are the same table:
 *
 * - `/app/clients` — the whole book, with which mailbox chases each client.
 * - `/app/clients?mailbox=<id>` — one mailbox's book. Adding a client here
 *   files it under THAT mailbox automatically, which is the founder's model:
 *   you connect a mailbox for a new business, then add that business's clients
 *   while you are inside it. No groups, no ticking, and nothing to drift.
 *
 * Until this existed a human with a browser could not add a client at all —
 * the API had three ways in and the web app had none.
 */

interface OrganisationSummary {
  id: string;
  name: string;
  roleKey: string;
}

export interface ClientRow {
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

interface MailboxList {
  mailboxes: MailboxRow[];
  seats: number;
}

/** The API's own answer to "who chases this client", never recomputed here.
 *  Resolution lives in one place (ALLOCATION-SCOPE trap 1) and this screen
 *  reads it rather than reimplementing "allocated ?? default" in a second
 *  language. */
interface AllocationRow {
  customerId: string;
  emailAccountId: string | null;
  resolvedEmailAddress: string | null;
  isFallback: boolean;
}

interface AllocationList {
  allocations: AllocationRow[];
  defaultEmailAddress: string | null;
}

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims) redirect("/sign-in");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) redirect("/sign-in");

  // Single-org app today — the /app and mailbox-settings precedent.
  const organisations = await fetchOrganisations<OrganisationSummary>(accessToken);
  const organisation = organisations[0];

  if (!organisation) {
    return (
      <Shell>
        <p className="w-full max-w-4xl text-sm text-muted-foreground">
          Create an organisation first.{" "}
          <Link href="/app/organisations/new" className="font-medium text-link hover:underline">
            New organisation
          </Link>
        </p>
      </Shell>
    );
  }

  let clients: ClientRow[] = [];
  let mailboxes: MailboxRow[] = [];
  let allocation: AllocationList = { allocations: [], defaultEmailAddress: null };
  let forbidden = false;
  let notEntitled = false;

  try {
    clients = (await (
      await apiFetch(`/organisations/${organisation.id}/customers`, accessToken)
    ).json()) as ClientRow[];
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    if (error instanceof ApiError && error.status === 403) forbidden = true;
    else if (error instanceof ApiError && error.status === 402) notEntitled = true;
    else throw error;
  }

  /**
   * The mailbox half is fetched SEPARATELY, and a refusal here does not take
   * the page down.
   *
   * `customers:read` is a core permission but `mailbox:read` is not: `sales`,
   * `reception` and `read_only` hold the first and not the second
   * (`DEFAULT_ROLE_PERMISSIONS`). Fetching both in one try meant a 403 on the
   * mailbox call replaced the whole screen with "your role doesn't have access
   * to clients" — false, and it removed the only browser route to the client
   * book from three of the six roles. Standing rule §0d: when two causes are
   * distinguishable, do not name the wrong one.
   *
   * A 402 DOES still take the page, deliberately: an organisation that has not
   * got Invoice Chasing should see the upgrade prompt, not a working screen for
   * a product it does not hold (ALLOCATION-SCOPE trap 4, plan decision D1).
   */
  let mailboxAccess = true;
  if (!forbidden && !notEntitled) {
    try {
      const list = (await (
        await apiFetch(`/organisations/${organisation.id}/mailboxes`, accessToken)
      ).json()) as MailboxList;
      mailboxes = list.mailboxes;
      allocation = (await (
        await apiFetch(`/organisations/${organisation.id}/customers/allocation`, accessToken)
      ).json()) as AllocationList;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
      if (error instanceof ApiError && error.status === 402) notEntitled = true;
      else if (error instanceof ApiError && error.status === 403) mailboxAccess = false;
      else throw error;
    }
  }

  if (forbidden) {
    return (
      <Shell>
        <p className="w-full max-w-4xl text-sm text-muted-foreground">
          {`Your role doesn't have access to clients for ${organisation.name}. Ask an owner or administrator.`}
        </p>
      </Shell>
    );
  }

  if (notEntitled) {
    return (
      <Shell>
        <section className="flex w-full flex-col gap-3 rounded-[var(--radius-card)] border border-warning-border bg-warning-tint px-6 py-4">
          {/* One interpolated string, never `{name}` beside wrapping JSX text —
              Next 16's build drops the space between them (handoff §0c), and
              `{" "}` does not survive Prettier. */}
          <p className="text-sm">
            {`${organisation.name} doesn't have Invoice Chasing, so there's nothing to chase clients with yet.`}
          </p>
          <div>
            <Link
              href="/app/settings/modules"
              className="rounded-[var(--radius-control)] bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-[var(--shadow-primary)] hover:opacity-90"
            >
              See your products
            </Link>
          </div>
        </section>
      </Shell>
    );
  }

  const mailboxFilter = typeof params.mailbox === "string" ? params.mailbox : null;
  const focused = mailboxFilter
    ? (mailboxes.find((mailbox) => mailbox.id === mailboxFilter) ?? null)
    : null;
  // An unknown or stale id shows the whole book rather than an empty page — a
  // mailbox may have been disconnected in another tab.
  const visible = focused ? clients.filter((row) => row.emailAccountId === focused.id) : clients;
  const chasedBy = new Map(allocation.allocations.map((row) => [row.customerId, row]));

  return (
    <Shell>
      <section className="flex w-full flex-col gap-2">
        <h1 className="font-display text-[29px] leading-tight font-semibold">
          {focused ? "Clients chased from this mailbox" : "Clients"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {focused
            ? `Anyone you add here will be chased from ${focused.emailAddress}.`
            : "The people who owe your organisation money. Eva chases them from the mailbox each one is filed under."}
        </p>
        {focused && (
          <p className="text-sm">
            <Link href="/app/clients" className="font-medium text-link hover:underline">
              Show all clients
            </Link>
          </p>
        )}
      </section>

      {/* A role that can read clients but not mailboxes still gets the book —
          just without the parts that are about mailboxes. Saying so beats
          silently omitting a column they can see colleagues using. */}
      {!mailboxAccess && (
        <p className="w-full rounded-[var(--radius-card)] border border-border bg-surface px-6 py-3 text-sm text-muted-foreground">
          Your role can see clients but not mailbox settings, so which mailbox chases whom is
          hidden. Ask an owner or administrator if you need it.
        </p>
      )}

      {mailboxAccess && mailboxes.length === 0 && (
        <section className="flex w-full flex-col gap-3 rounded-[var(--radius-card)] border border-warning-border bg-warning-tint px-6 py-4">
          <p className="text-sm">
            No mailbox is connected yet, so nothing can be chased. You can still add clients now and
            connect a mailbox afterwards.
          </p>
          <div>
            <Link
              href={moduleHref("email_credit_controller", "mailbox")}
              className="rounded-[var(--radius-control)] bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-[var(--shadow-primary)] hover:opacity-90"
            >
              Connect a mailbox
            </Link>
          </div>
        </section>
      )}

      <AddClientForm
        organisationId={organisation.id}
        /* The founder's model, in one prop: inside a mailbox's book, a new
           client is filed there without anyone choosing. */
        emailAccountId={focused?.id ?? null}
        mailboxAddress={focused?.emailAddress ?? null}
        /* ⚠️ `clients`, NOT `visible`. The duplicate check has to see the whole
           organisation, or a same-named client filed under another mailbox is
           invisible to exactly the warning meant to catch it. */
        existing={clients}
      />

      <ClientTable
        organisationId={organisation.id}
        clients={visible}
        mailboxes={mailboxes}
        chasedBy={chasedBy}
        defaultEmailAddress={allocation.defaultEmailAddress}
        totalCount={clients.length}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    /* ⚠️ WIDER THAN THE DESIGN PACKAGE'S 1080, FOR THE SAME REASON AS INVOICES
       (founder, 2026-08-18). 1080 is a reading measure and this screen is a
       table; see the note on `Shell` in `app/invoices/page.tsx`, which owns the
       full reasoning. These two are the only screens that get the wider column,
       and they get it because they are the only two that are mostly table. */
    <main className="flex w-full max-w-[1600px] flex-1 flex-col gap-[26px] px-10 pt-8 pb-9">
      {children}
    </main>
  );
}

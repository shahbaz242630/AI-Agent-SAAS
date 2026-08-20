import Link from "next/link";
import { redirect } from "next/navigation";
import { moduleHref } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import { importFieldLabel } from "@/products/invoice-follow-up/import-messages";
import { can, readOnlyImportsLine } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { BackChip } from "@/components/ui";
import { UploadForm } from "./import-controls";

/**
 * ⚠️ BUILT, NOT WRITTEN OUT — this was `/app/invoices`, which stopped being
 * an address when the products got their own URLs, so the way off this
 * screen led nowhere.
 */
const BOOK = moduleHref("email_credit_controller", "invoices");

/**
 * Upload a book (slice 1.6c — the founder's "user lands on this table, uploads
 * excel or csv, sees preview, confirms").
 *
 * The engine behind this has existed since slice 1.3 and has never had a
 * screen: the API stages the file, maps the headings, and creates nothing until
 * a confirm. This page is the front of that.
 */

/** What the importer can read, so nobody has to guess at their headings. */
const UNDERSTOOD_FIELDS = [
  "invoiceNumber",
  "amount",
  "currency",
  "issueDate",
  "dueDate",
  "customerName",
  "customerEmail",
  "customerReference",
  "contactName",
  "contactEmail",
];

interface OrganisationSummary {
  id: string;
  name: string;
  /** What this person may do here — resolved by the API, never by us. */
  permissions: string[];
}

export default async function ImportInvoicesPage() {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims) redirect("/sign-in");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) redirect("/sign-in");

  const organisations = await fetchOrganisations<OrganisationSummary>(accessToken);
  const organisation = organisations[0];

  if (!organisation) {
    return (
      <Shell>
        <p className="w-full max-w-3xl text-sm text-muted-foreground">
          Create an organisation first.
        </p>
      </Shell>
    );
  }

  /**
   * ⚠️ THIS PAGE HAD NO PERMISSION CHECK OF ANY KIND UNTIL TASK 8. It rendered
   * a working-looking upload form for every role and every organisation, and
   * the first thing a read-only user learnt was a raw
   * `Role 'read_only' lacks permission 'imports:write'` after choosing a file
   * — and an organisation without Invoice Chasing got a 402 in the same place.
   *
   * ⚠️ ENTITLEMENT IS ASKED OF THE API, NOT INFERRED. There is no other read on
   * this page, so the list of past imports is fetched purely to put the real
   * gate in front of the form: `imports:read` is module-owned, so a 402 here is
   * the same 402 the upload would have hit. Working it out from the role would
   * answer a different question, and `modules:read` — the obvious way to check
   * — is a permission the three read-only roles do not hold, so it would 403
   * for exactly the people this is protecting.
   */
  let forbidden = false;
  let notEntitled = false;
  try {
    await apiFetch(`/organisations/${organisation.id}/imports`, accessToken);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    else if (error instanceof ApiError && error.status === 403) forbidden = true;
    else if (error instanceof ApiError && error.status === 402) notEntitled = true;
    else throw error;
  }

  if (notEntitled) {
    return (
      <Shell>
        <section className="flex w-full max-w-3xl flex-col gap-3 rounded-[var(--radius-card)] bg-muted px-6 py-4">
          <p className="text-sm">
            {`${organisation.name} doesn't have Invoice Chasing, so there's nowhere for these invoices to go yet.`}
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
      <Shell>
        <p className="w-full max-w-3xl text-sm text-muted-foreground">
          {`Your role doesn't have access to ${organisation.name}'s uploads. Ask an owner or administrator.`}
        </p>
      </Shell>
    );
  }

  const canImport = can(organisation, "imports:write");

  return (
    <Shell>
      <section className="flex w-full max-w-3xl flex-col gap-2">
        {/* ⚠️ Dressed 2026-08-11. This screen still carried the pre-design
            heading (`text-2xl font-bold text-primary`) from before the app had
            a display face, so the one step in the flow that asks a customer to
            hand over their whole book looked like a different product. */}
        <h1 className="font-display text-[29px] leading-tight font-semibold">
          Upload your invoices
        </h1>
        <p className="text-sm text-muted-foreground">
          Drop in the spreadsheet you already keep. Eva reads it, shows you what it found, and
          creates nothing until you say so.
        </p>
      </section>

      {/* A card on the paper, like every other panel in the app — not a grey
          block with no edge. */}
      <section className="flex w-full max-w-3xl flex-col gap-4 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-5">
        {canImport ? (
          <UploadForm organisationId={organisation.id} />
        ) : (
          <p className="text-sm text-muted-foreground">{readOnlyImportsLine(organisation.name)}</p>
        )}
      </section>

      <section className="flex w-full max-w-3xl flex-col gap-2">
        <h2 className="text-sm font-semibold">Columns Eva understands</h2>
        <p className="text-xs text-muted-foreground">
          Headings are matched automatically, so they do not have to be named exactly like this.
          Anything Eva cannot place is left alone and shown to you.
        </p>
        <ul className="flex flex-wrap gap-2">
          {UNDERSTOOD_FIELDS.map((field) => (
            <li
              key={field}
              /* ⚠️ Was `bg-muted` — the same grey as the panel above it, on a
                 page whose background is already warm off-white. Chips that do
                 not read as chips are just wrapped text. */
              className="rounded-[var(--radius-pill)] border border-neutral-border bg-surface px-3 py-1 text-xs font-medium text-label"
            >
              {importFieldLabel(field)}
            </li>
          ))}
        </ul>
        {/*
          ⚠️ SAID OUT LOUD RATHER THAN DISCOVERED. Phone is not one of the
          importable columns, and the founder wants phone numbers for the
          calling agent — so somebody uploading a spreadsheet WITH a phone
          column would otherwise assume it came across. It did not.
        */}
        <p className="text-xs text-muted-foreground">
          Phone numbers cannot be imported yet — a phone column in your file will be ignored, and
          you can add numbers to a client afterwards.
        </p>
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex w-full max-w-[1080px] flex-1 flex-col gap-[26px] px-10 pt-8 pb-9">
      {/* ⚠️ FIRST, NOT LAST. It used to sit under everything as grey text, which
          read as a footnote rather than a way out (founder, 2026-08-18). */}
      <BackChip href={BOOK}>Back to your invoices</BackChip>
      {children}
    </main>
  );
}

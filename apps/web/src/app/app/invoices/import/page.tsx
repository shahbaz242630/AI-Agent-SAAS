import Link from "next/link";
import { redirect } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { importFieldLabel } from "@/lib/import-messages";
import { createClient } from "@/lib/supabase/server";
import { UploadForm } from "./import-controls";

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
}

export default async function ImportInvoicesPage() {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims) redirect("/sign-in");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) redirect("/sign-in");

  const organisations = (await (
    await apiFetch("/organisations", accessToken)
  ).json()) as OrganisationSummary[];
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

  return (
    <Shell>
      <section className="flex w-full max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-bold text-primary">Upload your invoices</h1>
        <p className="text-sm text-muted-foreground">
          Drop in the spreadsheet you already keep. Eva reads it, shows you what it found, and
          creates nothing until you say so.
        </p>
      </section>

      <section className="flex w-full max-w-3xl flex-col gap-4 rounded-[var(--radius-card)] bg-muted px-6 py-5">
        <UploadForm organisationId={organisation.id} />
      </section>

      <section className="flex w-full max-w-3xl flex-col gap-2">
        <h2 className="text-sm font-medium">Columns Eva understands</h2>
        <p className="text-xs text-muted-foreground">
          Headings are matched automatically, so they do not have to be named exactly like this.
          Anything Eva cannot place is left alone and shown to you.
        </p>
        <ul className="flex flex-wrap gap-2">
          {UNDERSTOOD_FIELDS.map((field) => (
            <li
              key={field}
              className="rounded-[var(--radius-card)] bg-muted px-3 py-1 text-xs text-muted-foreground"
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
    <main className="flex flex-1 flex-col items-center gap-6 p-8">
      {children}
      <Link
        href="/app/invoices"
        className="text-sm font-medium text-muted-foreground hover:underline"
      >
        Back to your invoices
      </Link>
    </main>
  );
}

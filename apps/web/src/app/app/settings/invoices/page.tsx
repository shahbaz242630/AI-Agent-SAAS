import Link from "next/link";
import { redirect } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { FALLBACK_CURRENCY } from "@/lib/currencies";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { CurrencyControls } from "./currency-controls";

/**
 * Invoice settings (slice 1.6c, task 13).
 *
 * ⚠️ THE WHOLE PAGE IS ABOUT ONE WORD: **default**. "Organisation default
 * currency" is a phrase a customer can reasonably read as "convert my book", so
 * every sentence here says plainly that it only pre-selects a dropdown and that
 * every invoice keeps its own currency. Founder's ruling, 2026-08-04: a UK
 * seller with buyers in Singapore and the UAE holds GBP, SGD and AED at once.
 *
 * ⚠️ NO SEPARATE READ. `defaultCurrency` rides on the organisation summary this
 * page already fetches for its permission check, so there is no settings GET to
 * keep in step with the PATCH.
 */

interface OrganisationSummary {
  id: string;
  name: string;
  permissions: string[];
  defaultCurrency?: string;
}

export default async function InvoiceSettingsPage() {
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
        <p className="w-full max-w-2xl text-sm text-muted-foreground">
          Create an organisation first.
        </p>
      </Shell>
    );
  }

  // Task 8's mechanism: the API's own answer, never a role name.
  const canWrite = can(organisation, "invoices:write");
  const current = organisation.defaultCurrency ?? FALLBACK_CURRENCY;

  return (
    <Shell>
      <section className="flex w-full max-w-2xl flex-col gap-2">
        <h1 className="text-2xl font-bold text-primary">Invoice settings</h1>
        <p className="text-sm text-muted-foreground">
          {`What a new invoice starts as for ${organisation.name}.`}
        </p>
      </section>

      <section className="flex w-full max-w-2xl flex-col gap-4 rounded-[var(--radius-card)] bg-muted px-6 py-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">Currency</h2>
          <p className="text-sm text-muted-foreground">
            The currency a new invoice opens on, so you are not picking the same one every time.
          </p>
        </div>

        {/*
          ⚠️ SAID BEFORE IT IS ASKED. The obvious fear on reading "default
          currency" is that it converts or restricts something. It does neither,
          and a customer should not have to test that to find out.
        */}
        <p className="text-sm">
          You can still choose any currency on any invoice, and invoices you have already raised
          never change. This only decides which one is filled in first.
        </p>

        {canWrite ? (
          <CurrencyControls organisationId={organisation.id} current={current} />
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm">{`New invoices currently start in ${current}.`}</p>
            <p className="text-sm text-muted-foreground">
              {`Your role can see ${organisation.name}'s invoice settings but not change them. Ask an owner or administrator.`}
            </p>
          </div>
        )}
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center gap-6 p-8">
      {children}
      <div className="flex gap-4">
        <Link
          href="/app/invoices"
          className="text-sm font-medium text-muted-foreground hover:underline"
        >
          Invoices
        </Link>
        <Link href="/app" className="text-sm font-medium text-muted-foreground hover:underline">
          Your account
        </Link>
      </div>
    </main>
  );
}

import { redirect } from "next/navigation";
import { fetchOrganisations } from "@/lib/organisations";
import { FALLBACK_CURRENCY } from "@/lib/currencies";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { CurrencyControls } from "./currency-controls";
import { SettingsTabs } from "../settings-tabs";

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

  const organisations = await fetchOrganisations<OrganisationSummary>(accessToken);
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
        {/* Matches its tab (2026-08-11): this screen holds one setting, and
            calling it "Invoice settings" promised more than it delivers. */}
        <h1 className="font-display text-[29px] leading-tight font-semibold">Currency</h1>
        <p className="text-sm text-muted-foreground">
          {`What a new invoice starts as for ${organisation.name}.`}
        </p>
      </section>

      <SettingsTabs current="invoices" />

      <section className="flex w-full max-w-2xl flex-col gap-4 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-5">
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
    <main className="flex w-full max-w-[1080px] flex-1 flex-col gap-[26px] px-10 pt-8 pb-9">
      {/* ⚠️ The footer links are gone (2026-08-11): "Invoices" duplicated the
          sidebar, and "Your account" pointed at `/app`, which has been Home
          rather than an account page since slice 1.9. */}
      {children}
    </main>
  );
}

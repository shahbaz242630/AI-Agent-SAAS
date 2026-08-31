import { redirect } from "next/navigation";
import { fetchOrganisations } from "@/lib/organisations";
import { FALLBACK_CURRENCY } from "@/lib/currencies";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui";
import { CurrencyControls } from "./currency-controls";
import { NoOrganisation, SettingsShell } from "../settings-shell";

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
 *
 * ⚠️ NO FOOTER LINKS, AND THAT IS A DECISION (2026-08-11, kept when the local
 * `Shell` was replaced by `SettingsShell` on 2026-08-30). This page used to end
 * with "Invoices", which duplicated the sidebar, and "Your account", which
 * pointed at `/app` — Home rather than an account page since slice 1.9.
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
      <SettingsShell title="Currency" subtitle="What a new invoice starts as." current="invoices">
        <NoOrganisation />
      </SettingsShell>
    );
  }

  // Task 8's mechanism: the API's own answer, never a role name.
  const canWrite = can(organisation, "invoices:write");
  const current = organisation.defaultCurrency ?? FALLBACK_CURRENCY;

  return (
    // Title matches its tab (2026-08-11): this screen holds one setting, and
    // calling it "Invoice settings" promised more than it delivers.
    <SettingsShell
      title="Currency"
      subtitle={`What a new invoice starts as for ${organisation.name}.`}
      current="invoices"
    >
      <Card className="flex flex-col gap-4 px-6 py-5">
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
              {`Your role can see ${organisation.name}'s currency settings but not change them. Ask an owner or administrator.`}
            </p>
          </div>
        )}
      </Card>
    </SettingsShell>
  );
}

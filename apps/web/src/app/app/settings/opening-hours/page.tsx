import { redirect } from "next/navigation";
import type { BusinessHours } from "@eva/types";
import { fetchOrganisations } from "@/lib/organisations";
import { describeOpeningHours } from "@/lib/opening-hours";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui";
import { OpeningHoursForm } from "./opening-hours-form";
import { NoOrganisation, SettingsShell } from "../settings-shell";

/**
 * The organisation's clock (slice 3.5a, ruling 93): its timezone and opening
 * hours — the fifth settings screen.
 *
 * ⚠️ THE TIMEZONE HAS BEEN A COLUMN SINCE THE FIRST MIGRATION AND NO SCREEN
 * COULD CHANGE IT. Every organisation was `Europe/London`, so a Dubai
 * plumber's Eva greeted them by London's clock and counted invoice days by it.
 * Opening hours were a column too, with no shape, no reader and no writer.
 * Both get their screen here because the out-of-hours reply is the first
 * thing that needs them.
 *
 * ⚠️ NO SEPARATE READ. The timezone and the hours ride on the organisation
 * summary this page already fetches for its permission check.
 */

interface OrganisationSummary {
  id: string;
  name: string;
  permissions: string[];
  timezone?: string;
  businessHours?: BusinessHours | null;
}

export default async function OpeningHoursPage() {
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
      <SettingsShell
        title="Opening hours"
        subtitle="When you are open, and which clock Eva keeps."
        current="opening-hours"
      >
        <NoOrganisation />
      </SettingsShell>
    );
  }

  const canWrite = can(organisation, "settings:manage");
  const timezone = organisation.timezone ?? "Europe/London";
  const hours = organisation.businessHours ?? null;

  return (
    <SettingsShell
      title="Opening hours"
      subtitle={`When ${organisation.name} is open, and which clock Eva keeps.`}
      current="opening-hours"
    >
      <Card className="flex flex-col gap-4 px-6 py-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">Your clock</h2>
          <p className="text-sm text-muted-foreground">
            Eva uses these to tell when an enquiry arrives outside your hours, and to keep every
            date in your own time.
          </p>
        </div>

        {canWrite ? (
          <OpeningHoursForm organisationId={organisation.id} timezone={timezone} hours={hours} />
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm">{`Eva keeps ${timezone} time.`}</p>
            <p className="text-sm">{describeOpeningHours(hours)}</p>
            <p className="text-sm text-muted-foreground">
              {`Your role can see ${organisation.name}'s opening hours but not change them. Ask an owner or administrator.`}
            </p>
          </div>
        )}
      </Card>
    </SettingsShell>
  );
}

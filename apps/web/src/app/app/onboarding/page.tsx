import { redirect } from "next/navigation";
import { fetchOrganisations } from "@/lib/organisations";
import { createClient } from "@/lib/supabase/server";
import { PrimaryLink } from "@/components/ui";
import { signOut } from "../actions";
import { OnboardingFrame } from "./onboarding-frame";
import { OrganisationStep } from "./organisation-step";

/**
 * Setup (Slice 1.13). The step is DERIVED from server state on every render —
 * no wizard position is stored, so a refresh, a back button or a second tab all
 * land on the truth.
 *
 * ⚠️ IT ASKED FOR A MAILBOX AND NO LONGER DOES — FOUNDER RULING 2026-09-01.
 * A mailbox belongs to ONE product (ruling 36, migration 0034), and onboarding
 * runs BEFORE a customer has chosen a product: the step had nothing to connect
 * a mailbox *for*, and would have had to guess Invoice Chasing on behalf of
 * somebody who might be buying Lead Follow-up. You now connect a mailbox inside
 * the product that will use it, which is also the moment the request makes
 * obvious sense.
 *
 * ⚠️ WHAT THAT COSTS, SAID PLAINLY: signing up no longer ends with a working
 * mailbox. The pane below therefore does NOT claim setup is finished and stop —
 * it names the next thing and links to it, because the gap between "account
 * created" and "Eva can actually send" is now real and has to be visible.
 */

// Response shapes mirror the API contracts (apps/api modules/mailboxes).
interface OrganisationSummary {
  id: string;
  name: string;
  roleKey: string;
}

export default async function OnboardingPage() {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims) redirect("/sign-in");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) redirect("/sign-in");
  const email = typeof claimsData.claims.email === "string" ? claimsData.claims.email : "";

  // Single-org app today — the /app list precedent; org switching is a later slice.
  const organisations = await fetchOrganisations<OrganisationSummary>(accessToken);
  const organisation = organisations[0];

  const step = organisation ? 2 : 1;

  return (
    <OnboardingFrame
      current={step}
      organisationName={organisation?.name ?? null}
      email={email}
      signOutSlot={
        <form action={signOut} className="flex">
          <button
            type="submit"
            className="cursor-pointer text-muted-foreground underline hover:text-foreground"
          >
            Sign out
          </button>
        </form>
      }
      paneTitle={step === 1 ? "Your business" : "You're set up"}
    >
      {step === 1 && <OrganisationStep />}

      {step === 2 && (
        <div className="flex flex-1 flex-col pt-1">
          {/* ⚠️ NAMES THE NEXT STEP RATHER THAN CONGRATULATING. Setup used to
              end with a connected mailbox, so "you're set up" was the whole
              truth. It is not any more: Eva cannot send anything until a
              product has a mailbox, and a customer who reads "done" and leaves
              would find nothing happening with no idea why. */}
          <p className="text-[13.5px] text-muted-foreground">
            Your business is set up. Next, choose what you want Eva to do — and connect the mailbox
            she should send from, inside that product.
          </p>

          <p className="pt-[18px] text-[13.5px] text-muted-foreground">
            Each product has its own mailbox, so switching one off never affects the other.
          </p>

          <div className="min-h-8 flex-1" />

          <div className="flex flex-wrap justify-end gap-3">
            <PrimaryLink href="/app">Choose what Eva does</PrimaryLink>
          </div>
        </div>
      )}
    </OnboardingFrame>
  );
}

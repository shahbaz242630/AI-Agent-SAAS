import Link from "next/link";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import { createClient } from "@/lib/supabase/server";
import { ModuleControls } from "./module-controls";
import { SettingsTabs } from "../settings-tabs";

/**
 * The products an organisation holds (Slice 1.6a).
 *
 * Guarded by CORE permissions on the API side, which is a requirement rather
 * than an oversight: an organisation with nothing must still be able to reach
 * this page and turn something on, or it can never become a customer. That is
 * the lockout trap.
 */

interface OrganisationSummary {
  id: string;
  name: string;
  roleKey: string;
}

interface ModuleStatus {
  moduleKey: string;
  enabled: boolean;
  source: string | null;
  seats: number;
  seatsUsed: number | null;
  enabledAt: string | null;
  disabledAt: string | null;
  missingDependencies: string[];
}

/** Product names and one honest line each. The database key is not a name a
 *  customer should ever have to read. */
const PRODUCTS: Record<string, { name: string; blurb: string }> = {
  email_credit_controller: {
    name: "Invoice Chasing",
    blurb: "Chases your unpaid invoices by email, from your own mailbox.",
  },
  voice_credit_controller: {
    name: "Voice Credit Control",
    blurb: "Follows up overdue invoices by phone when email has not worked.",
  },
  lead_follow_up_agent: {
    name: "Lead Follow-Up",
    blurb: "Calls back new enquiries before they go cold.",
  },
  ai_receptionist: {
    name: "AI Receptionist",
    blurb: "Answers the phone when you cannot get to it.",
  },
};

const nameOf = (key: string): string => PRODUCTS[key]?.name ?? key;

export default async function ModulesPage() {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims) redirect("/sign-in");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) redirect("/sign-in");

  const organisations = await fetchOrganisations<OrganisationSummary>(accessToken);
  const organisation = organisations[0];

  let modules: ModuleStatus[] = [];
  let forbidden = false;
  if (organisation) {
    try {
      modules = (await (
        await apiFetch(`/organisations/${organisation.id}/modules`, accessToken)
      ).json()) as ModuleStatus[];
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
      if (error instanceof ApiError && error.status === 403) forbidden = true;
      else throw error;
    }
  }

  // Turning a product on commits the business to money, so it is the account
  // owner's call rather than a delegated administrator's. The API enforces
  // this (`modules:manage`, owner-only in the default matrix); hiding the
  // controls just avoids offering a button that will 403. Everyone who can
  // reach this page can still SEE what the organisation holds — that is
  // `modules:read`, and it is what makes a 402 elsewhere legible rather than
  // looking like a fault.
  const canManage = organisation?.roleKey === "owner";

  return (
    <main className="flex w-full max-w-[1080px] flex-1 flex-col gap-[26px] px-10 pt-8 pb-9">
      <section className="flex w-full max-w-2xl flex-col gap-2">
        <h1 className="font-display text-[29px] leading-tight font-semibold">Your products</h1>
        <p className="text-sm text-muted-foreground">
          Switch a product off and Eva stops using it straight away — including anything it would
          have done in the background.
        </p>
      </section>

      <SettingsTabs current="modules" />

      {!organisation ? (
        <p className="w-full max-w-2xl text-sm text-muted-foreground">
          Create an organisation first.{" "}
          <Link href="/app/organisations/new" className="font-medium text-primary hover:underline">
            New organisation
          </Link>
        </p>
      ) : forbidden ? (
        <p className="w-full max-w-2xl text-sm text-muted-foreground">
          Your role doesn&apos;t have access to {organisation.name}&apos;s products. Ask an owner.
        </p>
      ) : (
        <section className="flex w-full max-w-2xl flex-col gap-4">
          {modules.map((module) => {
            const product = PRODUCTS[module.moduleKey];
            const blocked = module.missingDependencies.length > 0 && !module.enabled;
            return (
              <article
                key={module.moduleKey}
                className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-base font-semibold">{product?.name ?? module.moduleKey}</h2>
                  <span
                    className={
                      module.enabled ? "text-sm text-success" : "text-sm text-muted-foreground"
                    }
                  >
                    {module.enabled ? "On" : "Off"}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{product?.blurb}</p>

                {module.enabled && module.seatsUsed !== null && (
                  <p className="text-sm text-muted-foreground">
                    {module.seatsUsed} of {module.seats} {module.seats === 1 ? "seat" : "seats"} in
                    use ·{" "}
                    <Link
                      href="/app/settings/mailbox"
                      className="font-medium text-primary hover:underline"
                    >
                      Mailboxes
                    </Link>
                  </p>
                )}

                {blocked && (
                  <p className="text-sm text-muted-foreground">
                    Needs {module.missingDependencies.map(nameOf).join(" and ")} first.
                  </p>
                )}

                {canManage ? (
                  <ModuleControls
                    organisationId={organisation.id}
                    moduleKey={module.moduleKey}
                    enabled={module.enabled}
                    seats={module.seats}
                    seatsUsed={module.seatsUsed}
                    blocked={blocked}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">Only an owner can change this.</p>
                )}
              </article>
            );
          })}
        </section>
      )}

      {/* ⚠️ "Back to your organisations" is gone (2026-08-11): `/app` has been
          Home rather than a list of organisations since slice 1.9, and the
          sidebar reaches Home from every screen inside the shell. */}
    </main>
  );
}

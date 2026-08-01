import Link from "next/link";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/server";
import { ModuleControls } from "./module-controls";

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

  const organisations = (await (
    await apiFetch("/organisations", accessToken)
  ).json()) as OrganisationSummary[];
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
  // this; hiding the controls just avoids offering a button that will 403.
  const canManage = organisation?.roleKey === "owner";

  return (
    <main className="flex flex-1 flex-col items-center gap-6 p-8">
      <section className="flex w-full max-w-2xl flex-col gap-2">
        <h1 className="text-2xl font-bold text-primary">Your products</h1>
        <p className="text-sm text-muted-foreground">
          Switch a product off and Eva stops using it straight away — including anything it would
          have done in the background.
        </p>
      </section>

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
                className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-muted px-6 py-5"
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

      <Link href="/app" className="text-sm font-medium text-muted-foreground hover:underline">
        Back to your organisations
      </Link>
    </main>
  );
}

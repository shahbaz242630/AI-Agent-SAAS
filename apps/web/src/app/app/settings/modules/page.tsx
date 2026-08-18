import Link from "next/link";
import { redirect } from "next/navigation";
import { MODULE_CATALOGUE, type ModuleKey } from "@eva/types";
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

/**
 * ⚠️ THE NAMES AND BLURBS USED TO LIVE HERE, AND THE SIDEBAR HAD ITS OWN COPY
 * THAT DISAGREED. They are `MODULE_CATALOGUE` in `@eva/types` now — one list,
 * read by this screen, the sidebar and the API's 402 message alike.
 */
const productOf = (key: string) => MODULE_CATALOGUE[key as ModuleKey] ?? null;

const nameOf = (key: string): string => productOf(key)?.name ?? key;

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
          <Link href="/app/organisations/new" className="font-medium text-link hover:underline">
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
            const product = productOf(module.moduleKey);
            /**
             * ⚠️ "NOT BUILT" OUTRANKS "NEEDS SOMETHING FIRST". Lead Follow-up
             * and the receptionist are blocked on Voice Credit Control, which
             * is itself unbuilt — so telling somebody to turn Voice on first
             * would send them to a button that no longer exists. When a product
             * does not exist, that is the only thing worth saying about it.
             */
            const comingSoon = product ? !product.live : false;
            const blocked = !comingSoon && module.missingDependencies.length > 0 && !module.enabled;
            return (
              <article
                key={module.moduleKey}
                className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-base font-semibold">{product?.name ?? module.moduleKey}</h2>
                  {comingSoon ? (
                    <span className="rounded-[var(--radius-pill)] border border-border px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                      Coming soon
                    </span>
                  ) : (
                    <span
                      className={
                        module.enabled ? "text-sm text-success" : "text-sm text-muted-foreground"
                      }
                    >
                      {module.enabled ? "On" : "Off"}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{product?.blurb}</p>

                {module.enabled && module.seatsUsed !== null && (
                  <p className="text-sm text-muted-foreground">
                    {module.seatsUsed} of {module.seats} {module.seats === 1 ? "seat" : "seats"} in
                    use ·{" "}
                    <Link
                      href="/app/settings/mailbox"
                      className="font-medium text-link hover:underline"
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

                {comingSoon ? (
                  /* No control at all, deliberately. A disabled button invites
                     somebody to keep pressing it and to wonder what they are
                     missing; a sentence says the true thing once. */
                  <p className="text-xs text-muted-foreground">
                    We&apos;re still building this one. It isn&apos;t available to switch on yet.
                  </p>
                ) : canManage ? (
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

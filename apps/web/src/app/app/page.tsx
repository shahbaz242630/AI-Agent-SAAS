import Link from "next/link";
import { redirect } from "next/navigation";
import { MODULE_CATALOGUE, MODULE_KEYS, moduleHref, type ModuleKey } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import { createClient } from "@/lib/supabase/server";

/**
 * The hub — which of Eva's products you have, and a way into each.
 *
 * Founder, 2026-08-19: *"instead of confusing user with one dashboard we route
 * them to the service they want to use"*. `/app` used to BE the invoice
 * dashboard, which was fine while there was one product and would have been
 * wrong the moment there were two.
 *
 * ⚠️ ONE PRODUCT SKIPS STRAIGHT PAST THIS SCREEN, and that is the whole design.
 * A hub in front of a customer who holds a single product is an extra click
 * every login, forever, to solve a problem they do not have — and today every
 * customer holds exactly one. The wall appears when there is something to
 * choose between.
 *
 * ⚠️ IT IS A PLATFORM SCREEN. It reads the catalogue and the organisation's
 * entitlements and knows nothing about what any product DOES. Adding the CRM
 * means adding a catalogue entry, not editing this file.
 */

interface OrganisationSummary {
  id: string;
  name: string;
  roleKey: string;
}

interface ModuleStatus {
  moduleKey: string;
  enabled: boolean;
}

export default async function AppHubPage() {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims) redirect("/sign-in");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) redirect("/sign-in");

  const organisations = await fetchOrganisations<OrganisationSummary>(accessToken);
  const organisation = organisations[0];
  if (!organisation) redirect("/app/onboarding");

  let held: ModuleKey[] = [];
  let unreadable = false;
  try {
    const modules = (await (
      await apiFetch(`/organisations/${organisation.id}/modules`, accessToken)
    ).json()) as ModuleStatus[];
    held = modules
      .filter((module) => module.enabled)
      .map((module) => module.moduleKey as ModuleKey)
      .filter((key) => MODULE_KEYS.includes(key));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    if (!(error instanceof ApiError)) throw error;
    /**
     * ⚠️ A FAILED READ MUST NOT LOOK LIKE "YOU OWN NOTHING". Showing the
     * empty-handed screen would tell a paying customer their products are gone
     * because one request failed. The hub says so instead, and every product
     * stays reachable below.
     */
    unreadable = true;
  }

  /**
   * ⚠️ THE SKIP HAPPENS BEFORE ANYTHING RENDERS, and only when we actually
   * know. `unreadable` deliberately does not redirect: bouncing somebody into a
   * product on a guess is worse than showing them the choice.
   */
  if (!unreadable && held.length === 1) redirect(moduleHref(held[0]!));

  const live = MODULE_KEYS.filter((key) => MODULE_CATALOGUE[key].live);
  const yours = live.filter((key) => held.includes(key));
  const available = MODULE_KEYS.filter((key) => !held.includes(key));

  return (
    <main className="flex w-full max-w-[1080px] flex-1 flex-col gap-[26px] px-10 pt-8 pb-9">
      <section className="flex w-full max-w-2xl flex-col gap-2">
        <h1 className="font-display text-[29px] leading-tight font-semibold">
          {organisation.name}
        </h1>
        <p className="text-sm text-muted-foreground">
          {unreadable
            ? "We couldn't load your products just now. Nothing has changed — try again in a moment."
            : yours.length > 0
              ? "Pick what you want to work on."
              : "You haven't switched any products on yet."}
        </p>
      </section>

      {yours.length > 0 && (
        <section className="flex w-full max-w-2xl flex-col gap-4">
          {yours.map((key) => (
            <Link
              key={key}
              href={moduleHref(key)}
              className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-5 hover:border-accent"
            >
              <span className="text-base font-semibold">{MODULE_CATALOGUE[key].name}</span>
              <span className="text-sm text-muted-foreground">{MODULE_CATALOGUE[key].blurb}</span>
            </Link>
          ))}
        </section>
      )}

      {available.length > 0 && (
        <section className="flex w-full max-w-2xl flex-col gap-3">
          <h2 className="text-[10.5px] font-bold tracking-[0.08em] text-muted-foreground uppercase">
            Not switched on
          </h2>
          {/* Named rather than hidden, the sidebar's rule: somebody who cannot
              see a product cannot tell "not built" from "not bought", and both
              are things a customer may want to act on. */}
          {available.map((key) => (
            <div
              key={key}
              className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-card)] border border-border px-6 py-4"
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold">{MODULE_CATALOGUE[key].name}</span>
                <span className="text-sm text-muted-foreground">{MODULE_CATALOGUE[key].blurb}</span>
              </span>
              <span className="text-xs font-semibold text-muted-foreground">
                {MODULE_CATALOGUE[key].live ? "Off" : "Coming soon"}
              </span>
            </div>
          ))}
          <p className="text-sm text-muted-foreground">
            Switch a product on in{" "}
            <Link href="/app/settings/modules" className="font-medium text-link hover:underline">
              your products
            </Link>
            .
          </p>
        </section>
      )}
    </main>
  );
}

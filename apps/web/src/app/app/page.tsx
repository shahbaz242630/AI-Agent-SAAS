import Link from "next/link";
import { redirect } from "next/navigation";
import { MODULE_CATALOGUE, MODULE_KEYS, moduleHref, type ModuleKey } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import { hubGroups, startableProducts } from "@/lib/product-hub";
import { createClient } from "@/lib/supabase/server";
import { Notice } from "@/components/ui";
import { StartProductButton } from "./start-product-button";

/**
 * The hub — which of Eva's products you have, and a way into each.
 *
 * Founder, 2026-08-19: *"instead of confusing user with one dashboard we route
 * them to the service they want to use"*. `/app` used to BE the invoice
 * dashboard, which was fine while there was one product and would have been
 * wrong the moment there were two.
 *
 * ⚠️ EVERYBODY LANDS HERE, EVERY TIME. Founder, 2026-08-20: *"I should land on
 * page which shows all options so I can select which dashboard to check"*. This
 * comment used to say the opposite — that holding one product should skip
 * straight past — and that was my reasoning, approved and then overruled once
 * the founder actually used it. See the note above `hubGroups` below.
 *
 * ⚠️ IT IS ALSO WHERE PRODUCTS ARE CHOSEN, not just where owned ones are
 * listed. Somebody arriving for the first time holds nothing; sending them to a
 * settings screen to switch their first product on made the welcome screen an
 * inventory of what they lacked.
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

export default async function AppHubPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
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
   * ⚠️ THIS SCREEN NEVER REDIRECTS INTO A PRODUCT. DO NOT PUT THE SKIP BACK.
   *
   * It used to: holding exactly one built product sent you straight into it,
   * on my argument that a chooser in front of somebody with one product is an
   * extra click every login, forever. The founder approved that reasoning, then
   * used it, and overruled it on 2026-08-20: *"I signed in .. still land on
   * invoice chasing dashboard .. I should land on page which shows all options
   * so I can select which dashboard to check"*.
   *
   * The argument was wrong because it counted clicks and not purpose. This page
   * is not a toll gate on the way to the "real" screen — it is where somebody
   * sees everything Eva can do for them, including the four products they have
   * not bought. Skipping it hid the shop from the customer to save them a click.
   *
   * The archive still contains the old reasoning (ruling 15, slice 3.0). It is
   * superseded. `hubSkipTarget` is deleted rather than left returning null, so
   * there is nothing here to switch back on.
   */

  /** Three groups, and every key in the catalogue lands in exactly one. */
  const { yours, heldNotReady, available } = hubGroups(held);
  /** Of the ones they do not hold, those we have actually built. */
  const startable = new Set(startableProducts(held));
  /**
   * ⚠️ THE FIRST VISIT IS A DIFFERENT SCREEN FROM EVERY LATER ONE. Somebody who
   * holds nothing has not come to navigate — they have come to choose, and
   * until 2026-08-20 this screen answered that by listing five products they
   * could not click and sending them to a settings page. Founder: *"a page
   * where they choose which feature they want… once they choose they land at
   * that dashboard"*.
   */
  const firstVisit = !unreadable && held.length === 0;

  /**
   * Only the codes that can actually reach the hub — the ones raised BEFORE the
   * callback knows which product it is for. Everything else is rendered by the
   * product's own mailbox screen, which has the provider and the full story.
   */
  const errorCode = typeof params.error === "string" ? params.error : null;
  const mailboxError =
    errorCode === "invalid_state"
      ? "That mailbox connection attempt expired or could not be verified, so nothing was connected."
      : errorCode
        ? "That mailbox connection did not complete, so nothing was connected."
        : null;

  return (
    /* ⚠️ CENTRED AND NARROW, BECAUSE THERE IS NO SIDEBAR TO BALANCE AGAINST
       (founder, 2026-08-20). Every other signed-in screen is a working surface
       pinned beside the nav; this one is a choice, and a choice pushed against
       the left edge of a wide empty page reads as a page that failed to
       finish loading. `mx-auto` is doing the work the sidebar used to. */
    <main className="mx-auto flex w-full max-w-[860px] flex-1 flex-col gap-[26px] px-10 pt-10 pb-14">
      {/**
       * ⚠️ A FAILED MAILBOX CONNECTION CAN LAND HERE, AND MUST NOT LAND
       * SILENTLY (slice 3.1c-0).
       *
       * A mailbox belongs to one product now, so the callback returns the
       * browser to that product's mailbox screen. When the state cannot be
       * verified at all — forged, expired, or an admin-consent token used to
       * complete a connect — there IS no product to name, and guessing one
       * would drop the customer on a screen for something they were not
       * connecting (or on a 402 for a product they do not own). The hub is the
       * honest destination.
       *
       * But the hub was not listening. Before this, `?error=` arrived here and
       * rendered nothing: the customer clicked Connect, was sent to Microsoft,
       * came back, and saw an ordinary product list with no hint that anything
       * had failed. That is the silent-failure family, introduced by the very
       * change that made the redirect honest.
       */}
      {mailboxError && (
        <Notice tone="danger">
          {`${mailboxError} You can try again from the mailbox screen inside the product you were setting up.`}
        </Notice>
      )}
      <section className="flex w-full flex-col gap-2">
        <h1 className="font-display text-[29px] leading-tight font-semibold">
          {organisation.name}
        </h1>
        <p className="text-sm text-muted-foreground">
          {unreadable
            ? "We couldn't load your products just now. Nothing has changed — try again in a moment."
            : yours.length > 0
              ? "Pick what you want to work on."
              : /* ⚠️ `held`, NOT `yours`. Somebody holding only products we have
                   not built yet HAS switched something on, and telling them
                   they have not is the screen calling them a liar about their
                   own bill. */
                held.length > 0
                ? "Everything you have switched on is still being built."
                : /* An invitation, not an inventory of absence. This is the
                     first sentence a new customer reads after signing up. */
                  "Choose what you'd like Eva to do. You can switch on more later."}
        </p>
      </section>

      {yours.length > 0 && (
        <section className="grid w-full gap-4 sm:grid-cols-2">
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

      {heldNotReady.length > 0 && (
        <section className="flex w-full flex-col gap-3">
          <h2 className="text-[10.5px] font-bold tracking-[0.08em] text-muted-foreground uppercase">
            Switched on · still being built
          </h2>
          {/* ⚠️ NOT A LINK, DELIBERATELY. There is no route behind an unbuilt
              product, and a card that looks clickable and answers with a 404 is
              the defect this section exists to fix. Named and flat: the
              customer can see what they are holding without being invited into
              nothing. */}
          {heldNotReady.map((key) => (
            <div
              key={key}
              className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-card)] border border-border px-6 py-4"
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold">{MODULE_CATALOGUE[key].name}</span>
                <span className="text-sm text-muted-foreground">{MODULE_CATALOGUE[key].blurb}</span>
              </span>
              <span className="text-xs font-semibold text-muted-foreground">Coming soon</span>
            </div>
          ))}
        </section>
      )}

      {available.length > 0 && (
        <section className="flex w-full flex-col gap-3">
          {/* ⚠️ NO HEADING ON THE FIRST VISIT. "Not switched on" is a useful
              label beside things you DO have; as the title of the only section
              on somebody's first screen it names the absence instead of the
              offer. */}
          {!firstVisit && (
            <h2 className="text-[10.5px] font-bold tracking-[0.08em] text-muted-foreground uppercase">
              Not switched on
            </h2>
          )}
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
              {/* ⚠️ A CONTROL FOR WHAT EXISTS, A WORD FOR WHAT DOES NOT. The
                  button appears only for products we have built — offering to
                  switch on something with no screens behind it would land the
                  customer in the same bare 404 that PR #90 closed. */}
              {startable.has(key) ? (
                <StartProductButton
                  organisationId={organisation.id}
                  moduleKey={key}
                  productName={MODULE_CATALOGUE[key].name}
                />
              ) : (
                <span className="text-xs font-semibold text-muted-foreground">Coming soon</span>
              )}
            </div>
          ))}
          <p className="text-sm text-muted-foreground">
            You can switch products on and off any time in{" "}
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

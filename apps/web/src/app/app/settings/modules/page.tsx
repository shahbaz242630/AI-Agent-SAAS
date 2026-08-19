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
  endsAt: string | null;
  missingDependencies: string[];
  missingCapabilities: string[];
}

/**
 * What a product still needs in order to work, said as the thing to DO.
 *
 * ⚠️ THIS IS NOT A REFUSAL, AND IT MUST NEVER READ AS ONE. A missing
 * prerequisite used to block the sale; now it is a sentence with the fix
 * attached, which is the `noWorkingMailbox` pattern from 1.13. `invoice_ledger`
 * is absent on purpose — it is our own schema, so every organisation has it and
 * there is nothing for anyone to do about it.
 */
const CAPABILITY_FIX: Record<string, { says: string; href?: string; action?: string }> = {
  mailbox: {
    says: "Eva needs a mailbox to send from.",
    href: "/app/settings/mailbox",
    action: "Connect a mailbox",
  },
  voice: { says: "The calling side of Eva isn't built yet." },
};

/**
 * ⚠️ UTC, AND DELIBERATELY SO. This is the end of a billing period — a property
 * of the subscription, fixed by the billing system, not by where the customer
 * happens to be sitting. Rendering it in a local calendar would show two
 * customers different end dates for the same subscription.
 */
const formatEndDate = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
};

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
          Each product is separate. Switching one on or off never changes the others, and switching
          one off stops Eva using it straight away — including anything it would have done in the
          background. Your records stay either way.
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
             * ⚠️ A PRODUCT THIS BUILD HAS NEVER HEARD OF IS SKIPPED, NOT
             * PRINTED RAW (found by walking, 2026-08-19).
             *
             * The card fell back to `module.moduleKey`, so an unrecognised key
             * rendered as `lead_follow_up_agent` with an empty description —
             * database jargon on the screen that sells the product. And it is
             * a REACHABLE state, not a theoretical one: the deploy order is
             * migration → api → web, so the API is deliberately ahead of the
             * web app for the minutes between the two deploys, returning
             * products this build cannot name.
             *
             * Skipped rather than guessed at: the catalogue is the only place
             * that knows what a product is called and what it does, so without
             * an entry there is nothing true to say. The next web deploy shows
             * it properly.
             */
            if (!product) return null;
            /**
             * ⚠️ "NOT BUILT" OUTRANKS EVERYTHING ELSE ON THE CARD. When a
             * product does not exist yet, that is the only thing worth saying
             * about it — listing what it would still need reads as a shopping
             * list for something nobody can buy.
             *
             * It used to say these products were "blocked on Voice Credit
             * Control". They are not, and never should have been: that was the
             * dependency defect (founder ruling 2026-08-19) which made three of
             * our own six packages unsellable.
             */
            const comingSoon = !product.live;
            const blocked = !comingSoon && module.missingDependencies.length > 0 && !module.enabled;
            return (
              <article
                key={module.moduleKey}
                className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-base font-semibold">{product.name}</h2>
                  {comingSoon ? (
                    <span className="rounded-[var(--radius-pill)] border border-border px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                      Coming soon
                    </span>
                  ) : (
                    <span
                      className={
                        module.enabled && !module.endsAt
                          ? "text-sm text-success"
                          : "text-sm text-muted-foreground"
                      }
                    >
                      {/* ⚠️ `enabled` WITH AN `endsAt` IS NOT "On". The customer
                          has cancelled and is still using what they paid for;
                          a badge reading plain "On" would tell them nothing is
                          changing when something very much is. */}
                      {module.enabled ? (module.endsAt ? "Ending" : "On") : "Off"}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{product?.blurb}</p>

                {/* ⚠️ ONLY WHEN THERE IS SOMETHING IN USE (found by walking,
                    2026-08-19). At 0 of 1 this line sat directly above "Eva
                    needs a mailbox to send from · Connect a mailbox" — two
                    lines, two links, one subject, and the seat count adding
                    nothing a customer could act on. The readiness line below is
                    the one with the fix attached, so it wins the space. */}
                {module.enabled && module.seatsUsed !== null && module.seatsUsed > 0 && (
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

                {module.enabled && module.endsAt && (
                  <p className="text-sm text-muted-foreground">
                    Stays on until {formatEndDate(module.endsAt)}, then stops. Your records stay.
                    Turn it back on before then and nothing changes.
                  </p>
                )}

                {/* Always empty today — no product requires another (founder
                    ruling 2026-08-19). Kept because `MODULE_DEPENDENCIES` is
                    still the one place a genuine prerequisite would go, and the
                    API would otherwise refuse with the screen saying nothing. */}
                {blocked && (
                  <p className="text-sm text-muted-foreground">
                    Needs {module.missingDependencies.map(nameOf).join(" and ")} first.
                  </p>
                )}

                {/* ⚠️ SHOWN ALONGSIDE THE SWITCH, NOT INSTEAD OF IT. Missing
                    machinery is a next step, never a reason to refuse the sale
                    — that conflation is what made three of our own packages
                    unsellable. */}
                {!comingSoon &&
                  module.missingCapabilities.map((capability) => {
                    const fix = CAPABILITY_FIX[capability];
                    if (!fix) return null;
                    return (
                      <p key={capability} className="text-sm text-muted-foreground">
                        {fix.says}
                        {fix.href && (
                          <>
                            {" "}
                            <Link href={fix.href} className="font-medium text-link hover:underline">
                              {fix.action}
                            </Link>
                          </>
                        )}
                      </p>
                    );
                  })}

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
                    productName={product.name}
                    enabled={module.enabled}
                    endsAt={module.endsAt ? formatEndDate(module.endsAt) : null}
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

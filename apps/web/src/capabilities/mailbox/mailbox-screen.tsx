import Link from "next/link";
import { redirect } from "next/navigation";
import { moduleHref, moduleName, type ModuleKey } from "@eva/types";
import { AdminConsentHelp } from "@/components/admin-consent-help";
import { MailboxCard, type MailboxSummary } from "@/components/mailbox-card";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import {
  mailboxErrorMessage,
  mailboxProviderFrom,
  needsConsentHelp,
} from "@/capabilities/mailbox/mailbox-errors";
import { disconnectMessage } from "@/capabilities/mailbox/mailbox-messages";
import { createClient } from "@/lib/supabase/server";
import { Card, Notice, PageHeader, PageShell, PrimaryLink } from "@/components/ui";
import { ConnectMailboxForm, MailboxActions } from "./mailbox-controls";

/**
 * "Which mailbox does THIS product send from" — one screen, one door per
 * product (slice 3.1c-0).
 *
 * ⚠️ IT LIVES HERE RATHER THAN UNDER `/app/settings/mailbox`, AND THAT IS A
 * FOUNDER RULING (2026-09-01): *"they should have full complete seperate
 * setups.. nothing combined/shared"*. A mailbox belongs to ONE product now
 * (ruling 36, migration 0034), so a single shared settings screen could only
 * ever show one product's mailboxes as though they were the organisation's —
 * which is the confusion the whole slice removes.
 *
 * ⚠️ ONE COMPONENT, NOT TWO COPIES, AND RULING 44 IS WHY. The instruction for
 * the UI pass is to extract the shared piece properly so the next area is an
 * import rather than a paste. Two products want the identical screen; the only
 * thing that differs is which product's mailboxes it asks for and where its
 * links point. Both come from `moduleKey`, so both product pages are a
 * three-line wrapper and there is exactly one place to fix a defect.
 *
 * ⚠️ THE PRODUCT IS ALSO CARRIED INTO EVERY WRITE. `ConnectMailboxForm` and
 * `MailboxActions` take it and put it on the request, because the API refuses a
 * connect that does not name one rather than guessing — see the note on
 * `moduleKey` in `packages/validation`.
 */

// Response shapes mirror the API contracts (apps/api modules/mailboxes).
interface OrganisationSummary {
  id: string;
  name: string;
  roleKey: string;
}

interface MailboxList {
  mailboxes: MailboxSummary[];
  seats: number;
  seatLimitReached: boolean;
}

interface AdminConsent {
  accountKind: "work" | "personal" | "unknown";
  url: string | null;
  organisationName: string | null;
}

export async function MailboxScreen({
  moduleKey,
  searchParams,
}: {
  moduleKey: ModuleKey;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims) redirect("/sign-in");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) redirect("/sign-in");

  // Single-org app today — the /app list precedent; org switching is a later slice.
  const organisations = await fetchOrganisations<OrganisationSummary>(accessToken);
  const organisation = organisations[0];
  const productName = moduleName(moduleKey);

  let status: MailboxList | null = null;
  let forbidden = false;
  let notEntitled = false;
  if (organisation) {
    try {
      status = (await (
        await apiFetch(
          // ⚠️ `?module=` IS NOT OPTIONAL. The API refuses a mailbox list that
          // does not name a product rather than returning both products' rows
          // mixed together — the answer that would look right and be wrong.
          `/organisations/${organisation.id}/mailboxes?module=${moduleKey}`,
          accessToken,
        )
      ).json()) as MailboxList;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
      if (error instanceof ApiError && error.status === 403) forbidden = true;
      // 402 is not 403: "your organisation hasn't got this product" needs an
      // upgrade prompt, not "ask your owner for permission" (slice 1.6a).
      else if (error instanceof ApiError && error.status === 402) notEntitled = true;
      else throw error;
    }
  }

  const errorCode = typeof params.error === "string" ? params.error : null;
  // Which provider the customer just came back from. The callback puts it on
  // every redirect (founder ruling 2026-08-22 — separate paths, no crossing),
  // and everything below that speaks to the customer is keyed on it.
  const provider = mailboxProviderFrom(params.provider);
  const flashConnected = params.connected === "1";
  // Set only on a genuinely new connection — a reconnect sends nothing, so the
  // absence of this parameter is not a failure.
  const testEmailFailed = params.test_email === "failed";
  const attemptedAddress = typeof params.hint === "string" ? params.hint : null;

  // A declined consent is genuinely ambiguous (F1), so it gets a whole section
  // rather than a one-line flash: the customer may need to involve their
  // administrator, and that is the moment to hand them the link.
  const showConsentHelp = needsConsentHelp(errorCode, provider);
  let adminConsent: AdminConsent | null = null;
  if (showConsentHelp && organisation && !forbidden) {
    try {
      const query = attemptedAddress ? `?email=${encodeURIComponent(attemptedAddress)}` : "";
      adminConsent = (await (
        await apiFetch(
          `/organisations/${organisation.id}/mailboxes/admin-consent${query}`,
          accessToken,
        )
      ).json()) as AdminConsent;
    } catch (error) {
      // The help is an enhancement; the message below still explains the
      // situation without it. Never turn a failed connection into a crash.
      if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
      adminConsent = null;
    }
  }

  const flashError =
    errorCode && !showConsentHelp ? mailboxErrorMessage(errorCode, provider) : null;

  return (
    <PageShell>
      {/* ⚠️ THE SUBTITLE NAMES THE PRODUCT, AND THAT IS THE WHOLE POINT OF THE
          SPLIT. "The mailbox Eva sends from" was true when there was one; with
          a mailbox per product it is the sentence that would let somebody
          connect Gmail here and expect their invoice chasers to use it. */}
      <PageHeader
        title="Mailbox"
        subtitle={`Connect the mailbox ${productName} sends from — Outlook, Microsoft 365 or Gmail.`}
      />
      {/* ONE message, three endings. `test_email` only ever arrives alongside
          `connected=1`, so a separate box for the failure printed "Mailbox
          connected successfully" directly above "we couldn't send its test
          email" — two notices where the customer needs one. The failure is
          styled as a caveat, not an error: the connection succeeded and read
          access was proven, only the send did not land. */}
      {flashConnected && (
        <Notice tone={testEmailFailed ? "muted" : "success"}>
          {params.test_email === "sent"
            ? "Mailbox connected. We've sent a test email to it — check the inbox."
            : testEmailFailed
              ? "Mailbox connected, but we couldn't send its test email. Try Send test email below."
              : "Mailbox connected successfully."}
        </Notice>
      )}
      {/* An approving administrator no longer lands here at all — they get the
          public /microsoft-approved receipt, because they usually have no Eva
          account and this route would bounce them to sign-in. */}
      {/* RULING 3, and it has to outlive the card it describes — see
          `disconnectMailbox`. Both groups are named because they are different
          people: the ones filed under that mailbox, and everyone who was never
          filed and follows the default wherever it goes. */}
      {params.disconnected === "1" && (
        <Notice>
          {disconnectMessage(
            Number(params.moved ?? 0),
            Number(params.unfiled ?? 0),
            typeof params.to === "string" ? params.to : null,
          )}
        </Notice>
      )}
      {/* A replace was asked for and could not be done — the mailbox it named
          had already been disconnected. Degrading to a plain connect is right;
          doing it silently was not, because the outcome is exactly what ruling
          3 forbids: the old address is gone and its clients fell back to the
          default while the customer believes their book followed. */}
      {params.replace === "degraded" && (
        <Notice tone="danger">
          The mailbox you asked to replace had already been disconnected, so this address was added
          as a new one instead. Any clients filed under the old address are now chased from your
          default mailbox and need re-filing.
        </Notice>
      )}
      {flashError && <Notice tone="danger">{flashError}</Notice>}
      {showConsentHelp && (
        <AdminConsentHelp
          accountKind={adminConsent?.accountKind ?? "unknown"}
          url={adminConsent?.url ?? null}
          organisationName={adminConsent?.organisationName ?? null}
          attemptedAddress={attemptedAddress}
        />
      )}

      {!organisation ? (
        <Card className="flex flex-col gap-3 px-6 py-5">
          <p className="text-sm">Create an organisation first.</p>
          <div>
            <PrimaryLink href="/app/organisations/new">New organisation</PrimaryLink>
          </div>
        </Card>
      ) : forbidden ? (
        <p className="text-sm text-muted-foreground">
          {`Your role can't see ${organisation.name}'s mailbox settings. Ask an owner or administrator.`}
        </p>
      ) : notEntitled ? (
        <Card className="flex flex-col gap-3 px-6 py-5">
          {/*
            One interpolated string, deliberately — NOT `{organisation.name}`
            followed by JSX text. Next 16's build drops the space between an
            expression and text that wraps onto the following line, so the
            obvious spelling rendered "Malik Test Org Ltddoesn't have…" on
            staging while the source looked correct, and standalone @swc/core
            compiled it correctly. `{" "}` does not survive either: Prettier
            rejoins it on format. Same shape as the "If you arethe
            administrator" defect of 2026-07-31.
          */}
          <p className="text-sm">
            {`${organisation.name} doesn't have ${productName}, so there's no mailbox to connect yet.`}
          </p>
          <div>
            <PrimaryLink href="/app/settings/modules">See your products</PrimaryLink>
          </div>
        </Card>
      ) : status ? (
        <Card className="flex flex-col gap-4 px-6 py-5">
          {status.mailboxes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No mailbox connected yet.</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {status.mailboxes.length} of {status.seats} {status.seats === 1 ? "seat" : "seats"}{" "}
                in use
              </p>
              {status.mailboxes.map((mailbox) => (
                <MailboxCard
                  key={mailbox.id}
                  mailbox={mailbox}
                  showPrimary={status!.mailboxes.length > 1}
                  // Through to this mailbox's own book, where adding a client
                  // files it here automatically (slice 1.6b).
                  clientsHref={`/app/clients?mailbox=${mailbox.id}`}
                  // Ruling 6: is there anywhere healthy left to stand in for
                  // this one? Decides between "chasing continues elsewhere"
                  // and "chasing has stopped" — see the card.
                  hasHealthyAlternative={status!.mailboxes.some(
                    (other) => other.id !== mailbox.id && other.healthStatus === "active",
                  )}
                  actions={
                    <MailboxActions
                      organisationId={organisation.id}
                      moduleKey={moduleKey}
                      mailbox={mailbox}
                      canPromote={status!.mailboxes.length > 1}
                    />
                  }
                />
              ))}
            </>
          )}

          {/* Hidden entirely at the limit rather than shown-and-refused: the
              seat check the API does here is a pre-check for exactly this
              reason — nobody should consent at Microsoft for nothing. */}
          {status.seatLimitReached ? (
            <p className="text-sm text-muted-foreground">
              Every seat is in use. Disconnect one, or add a seat on{" "}
              <Link href="/app/settings/modules" className="font-medium text-link hover:underline">
                your products
              </Link>
              , to connect another.
            </p>
          ) : (
            <ConnectMailboxForm
              organisationId={organisation.id}
              moduleKey={moduleKey}
              defaultAddress={attemptedAddress}
              /* ⚠️ NO LABEL ON THE FIRST CONNECT SINCE 3.1b. It used to read
                 "Connect Outlook mailbox", which stopped being true the moment
                 Gmail became selectable — so the form names whichever provider
                 the customer actually picked. The SECOND-mailbox wording is
                 still fixed, because "another" is true of either. */
              {...(status.mailboxes.length === 0 ? {} : { label: "Connect another mailbox" })}
            />
          )}
        </Card>
      ) : null}

      {/* Back into the product this mailbox belongs to, rather than to
          `/app/clients` as the shared settings screen did. Clients are Invoice
          Chasing's filing (founder ruling 2026-09-01) and mean nothing here for
          any other product. */}
      <div className="flex flex-wrap items-center gap-4">
        <Link
          href={moduleHref(moduleKey)}
          className="text-sm font-medium text-link hover:underline"
        >
          {`Back to ${productName}`}
        </Link>
      </div>
    </PageShell>
  );
}

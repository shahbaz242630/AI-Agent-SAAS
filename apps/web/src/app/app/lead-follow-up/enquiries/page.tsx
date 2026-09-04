import Link from "next/link";
import { redirect } from "next/navigation";
import { moduleHref, moduleName } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import { createClient } from "@/lib/supabase/server";
import { EmptyState, StatusPill } from "@/components/ui";
import {
  bookCountLine,
  contactLine,
  leadName,
  leadSourceLabel,
  leadStatusLabel,
  leadStatusTone,
} from "@/products/lead-follow-up/lead-book";
import { describeMoment } from "@/lib/today";
import { EnquiryAddressPanel } from "@/capabilities/mailbox/enquiry-address-panel";

/**
 * The enquiry book (Slice 3.1a).
 *
 * ⚠️ THIS SCREEN COMPUTES NOTHING ABOUT A LEAD. Status, source and the moment
 * an enquiry arrived all come from the API exactly as stored — the same rule
 * the invoice book follows, for the same reason: the thing that ACTS on a lead
 * is the API, and a screen that works out its own answer starts disagreeing
 * with whatever Eva actually does.
 *
 * ⚠️ THE 402 IS THE ORDINARY CASE HERE, NOT AN EDGE. `leads:read` is carried by
 * `lead_follow_up` alone, so every organisation that has not bought this
 * product gets one — including, today, ours. "You haven't got this product" and
 * "your role can't" are different problems with different fixes and must never
 * share a sentence (standing rule §0d).
 */

/** Built from the catalogue. A literal path here is what `app-links.spec.ts`
 *  now fails on, after 29 of them went stale in a single slice. */
const BOOK = moduleHref("lead_follow_up", "enquiries");

interface OrganisationSummary {
  id: string;
  name: string;
  permissions: string[];
  timezone?: string | undefined;
}

/** `GET /organisations/:id/leads` — dates arrive as ISO strings over JSON. */
interface LeadRow {
  id: string;
  source: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  enquiry: string | null;
  status: string;
  receivedAt: string;
  firstRespondedAt: string | null;
  hasEvidence: boolean;
}

export default async function EnquiryBookPage() {
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
      <Shell>
        <p className="w-full text-sm text-muted-foreground">
          Create an organisation first.{" "}
          <Link href="/app/organisations/new" className="font-medium text-link hover:underline">
            New organisation
          </Link>
        </p>
      </Shell>
    );
  }

  // `?? "Europe/London"` covers a web build newer than the API it talks to —
  // the same fallback Home uses.
  const timezone = organisation.timezone ?? "Europe/London";

  let leads: LeadRow[] | null = null;
  let forbidden = false;
  let notEntitled = false;
  try {
    leads = (await (
      await apiFetch(`/organisations/${organisation.id}/leads`, accessToken)
    ).json()) as LeadRow[];
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    else if (error instanceof ApiError && error.status === 403) forbidden = true;
    else if (error instanceof ApiError && error.status === 402) notEntitled = true;
    else throw error;
  }

  if (notEntitled) {
    return (
      <Shell>
        <section className="flex w-full flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-4">
          <p className="text-sm">
            {`${organisation.name} doesn't have ${moduleName("lead_follow_up")}, so there are no enquiries to show yet.`}
          </p>
          <div>
            <Link
              href="/app/settings/modules"
              className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              See your products
            </Link>
          </div>
        </section>
      </Shell>
    );
  }

  /**
   * ⚠️ FETCHED SEPARATELY, AND A FAILURE HERE MUST NOT TAKE THE BOOK DOWN.
   * The address and the enquiries answer two different questions — "where do
   * they arrive" and "what has arrived" — and an environment with no inbound
   * domain configured answers 503 to the first while the second is perfectly
   * fine. Letting that 503 escape would blank a screen full of real enquiries
   * to report that a panel could not be drawn.
   */
  let inboundAddress: string | null = null;
  if (!forbidden && !notEntitled) {
    try {
      const response = await apiFetch(
        `/organisations/${organisation.id}/inbound-address`,
        accessToken,
      );
      inboundAddress = ((await response.json()) as { address: string }).address;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
      // 402, 403 and 503 all mean "no address to show", and the book still stands.
      else if (!(error instanceof ApiError)) throw error;
    }
  }

  if (forbidden || !leads) {
    return (
      <Shell>
        <p className="w-full text-sm text-muted-foreground">
          {`Your role doesn't have access to ${organisation.name}'s enquiries. Ask an owner or administrator.`}
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <section className="flex w-full flex-col gap-2">
        <h1 className="font-display text-[29px] leading-tight font-semibold">Enquiries</h1>
        <p className="text-sm text-muted-foreground">
          Everyone who has written to {organisation.name} to ask about something, newest first.
        </p>
      </section>

      {/**
       * ⚠️ THIS REPLACED A SENTENCE THIS SLICE MADE FALSE. Until 3.1b the
       * screen said enquiries would land here "once your mailbox is forwarding
       * to Eva… neither is switched on yet". Half of that stopped being true
       * the moment the front door opened: mail sent to the address below DOES
       * now become an enquiry. The other half — that Eva does not reply — is
       * still true and is said inside the panel, where somebody reading it is
       * about to publish the address.
       *
       * ⚠️ ABSENT RATHER THAN BROKEN WHEN THERE IS NO ADDRESS. An environment
       * with no inbound domain configured has nothing honest to show here, and
       * an empty box with a heading would read as a fault.
       */}
      {inboundAddress && (
        <EnquiryAddressPanel
          address={inboundAddress}
          forwardingHref={moduleHref("lead_follow_up", "forwarding")}
        />
      )}

      <section className="flex w-full flex-col gap-3">
        {/**
         * ⚠️ NOT SHOWN WHEN THE BOOK IS EMPTY, because the empty state three
         * lines below opens with the same sentence. Walked on production and
         * "No enquiries yet." appeared twice in one glance, which reads as a
         * rendering fault rather than as emphasis. The empty state says it
         * better — it says what to do next as well.
         */}
        {leads.length > 0 && (
          <p className="text-sm text-muted-foreground">{bookCountLine(leads.length)}</p>
        )}

        {/**
         * ⚠️ ONE SENTENCE, NOT TWO BY PERMISSION. Until 2026-08-21 the empty
         * state said something different to somebody who could write, because
         * there was a form for them to use. There is no longer anything anyone
         * can do from this screen — an enquiry arrives by email or not at all —
         * so a role-dependent message would only be inventing a difference.
         */}
        {leads.length === 0 ? (
          <EmptyState
            headline="No enquiries yet."
            /**
             * ⚠️ TWO SENTENCES BECAUSE THERE ARE TWO SITUATIONS, NOT TO BE
             * CLEVER. "The address above" is a lie when the panel above is not
             * there — and it is not there whenever this environment has no
             * inbound domain configured. Pointing somebody at something that
             * is not on their screen is the same defect as telling them there
             * is no undo when there is.
             */
            detail={
              inboundAddress
                ? "Send an email to the address above — or point your website's enquiry form at it — and it will appear here with the proof of who sent it and when."
                : "Enquiries will appear here, with the proof of who sent them and when, as soon as your enquiry address is set up."
            }
          />
        ) : (
          <div className="w-full overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface px-6 py-3">
            {/* The header is smaller, bolder and fainter than the rows, so it
                reads as a label rather than as one more enquiry — the same
                correction the invoice book had on 2026-08-18. */}
            <table className="w-full min-w-[860px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-hairline text-left text-[11.5px] font-semibold tracking-[0.04em] text-faint">
                  <th className="px-3 pt-1 pb-2.5">Who</th>
                  <th className="px-3 pt-1 pb-2.5">How to reach them</th>
                  <th className="px-3 pt-1 pb-2.5">What they asked</th>
                  <th className="px-3 pt-1 pb-2.5">How it came in</th>
                  <th className="px-3 pt-1 pb-2.5">When</th>
                  <th className="px-3 pt-1 pb-2.5">State</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id} className="border-b border-hairline">
                    <td className="px-3 py-3">
                      <Link
                        href={`${BOOK}/${lead.id}`}
                        className="font-medium text-link hover:underline"
                      >
                        {leadName(lead)}
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">{contactLine(lead)}</td>
                    {/* Truncated, not summarised: the whole thing is on the
                        detail screen, and inventing a shorter version of what
                        somebody actually said is how a quote stops being one. */}
                    <td className="max-w-[280px] truncate px-3 py-3 text-muted-foreground">
                      {lead.enquiry ?? "—"}
                    </td>
                    <td className="px-3 py-3">{leadSourceLabel(lead.source)}</td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {describeMoment(lead.receivedAt, timezone)}
                    </td>
                    <td className="px-3 py-3">
                      <StatusPill tone={leadStatusTone(lead.status)}>
                        {leadStatusLabel(lead.status)}
                      </StatusPill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex w-full max-w-[1080px] flex-1 flex-col gap-[26px] px-10 pt-8 pb-9">
      {children}
    </main>
  );
}

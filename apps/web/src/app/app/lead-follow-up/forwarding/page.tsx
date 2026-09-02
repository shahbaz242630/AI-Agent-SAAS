import Link from "next/link";
import { redirect } from "next/navigation";
import { FORWARDING_ARMED_WINDOW_MINUTES, moduleHref, moduleName } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import { createClient } from "@/lib/supabase/server";
import { EnquiryAddressPanel } from "@/capabilities/mailbox/enquiry-address-panel";
import {
  GMAIL_FORWARDING_STEPS,
  armedWindowSentence,
} from "@/capabilities/mailbox/forwarding-guide";
import { describeMoment } from "@/lib/today";
import {
  ForwardingRequestActions,
  StartSetupButton,
  type ForwardingRequestRow,
} from "./forwarding-controls";

/**
 * Getting a Gmail customer's enquiries to Eva (Slice 3.1b, step 4).
 *
 * ⚠️ THIS SCREEN EXISTS BECAUSE READING A GMAIL INBOX COSTS AN ANNUAL AUDIT
 * (ruling 25) AND FORWARDING COSTS NOTHING. Everything on it is in service of
 * one thing the decision document promised: the customer never has to hunt for
 * Google's confirmation code, because that email comes to an address we own.
 *
 * ⚠️ IT IS ALSO WHERE A SECURITY QUESTION GETS ASKED IN PLAIN ENGLISH. Google's
 * confirmation is the only thing standing between a guessed enquiry address and
 * somebody else's lead book, so a request nobody armed is shown here rather
 * than answered quietly.
 */

const BOOK = moduleHref("lead_follow_up", "enquiries");

interface OrganisationSummary {
  id: string;
  name: string;
  permissions: string[];
  timezone?: string | undefined;
}

export default async function ForwardingSetupPage() {
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

  const timezone = organisation.timezone ?? "Europe/London";
  const canSetUp = organisation.permissions.includes("leads:write");

  /**
   * ⚠️ FETCHED SEPARATELY AND FORGIVINGLY, THE SAME RULE THE BOOK FOLLOWS. The
   * address and the requests answer different questions, and an environment
   * with no inbound domain configured answers 503 to the first while the second
   * is perfectly fine. One failing must not blank the other.
   */
  let address: string | null = null;
  let notEntitled = false;
  try {
    const response = await apiFetch(
      `/organisations/${organisation.id}/inbound-address`,
      accessToken,
    );
    address = ((await response.json()) as { address: string }).address;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    else if (error instanceof ApiError && error.status === 402) notEntitled = true;
    else if (!(error instanceof ApiError)) throw error;
  }

  let requests: ForwardingRequestRow[] = [];
  try {
    const response = await apiFetch(
      `/organisations/${organisation.id}/forwarding/requests`,
      accessToken,
    );
    requests = (await response.json()) as ForwardingRequestRow[];
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    else if (error instanceof ApiError && error.status === 402) notEntitled = true;
    else if (!(error instanceof ApiError)) throw error;
  }

  if (notEntitled) {
    return (
      <Shell>
        <section className="flex w-full flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-4">
          <p className="text-sm">
            {`${organisation.name} doesn't have ${moduleName("lead_follow_up")}, so there is nothing to forward yet.`}
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

  const pending = requests.filter((request) => request.status === "pending");
  const settled = requests.filter((request) => request.status !== "pending");

  return (
    <Shell>
      <section className="flex w-full flex-col gap-2">
        <h1 className="font-display text-[29px] leading-tight font-semibold">
          Forward your enquiries to Eva
        </h1>
        <p className="text-sm text-muted-foreground">
          Eva never reads your mailbox. You send her a copy of the enquiries instead, and she
          replies from your own address.
        </p>
      </section>

      {address && <EnquiryAddressPanel address={address} />}

      {/**
       * ⚠️ THE UNEXPECTED REQUESTS COME FIRST, ABOVE THE INSTRUCTIONS. Somebody
       * arriving here mid-setup wants step 1; somebody whose address has been
       * guessed needs to see that before anything else on the page, and burying
       * it under a five-step guide would be the wrong order on the one day it
       * matters.
       */}
      {pending.length > 0 && (
        <section className="flex w-full flex-col gap-3 rounded-[var(--radius-card)] border border-warning bg-surface px-6 py-4">
          <h2 className="text-[13.5px] font-semibold">
            {pending.length === 1
              ? "Someone asked to forward mail here"
              : `${pending.length} requests to forward mail here`}
          </h2>
          {pending.map((request) => (
            <div key={request.id} className="flex flex-col gap-2 border-t border-hairline pt-3">
              {canSetUp ? (
                <ForwardingRequestActions organisationId={organisation.id} request={request} />
              ) : (
                <p className="text-sm">
                  {`${request.sourceAddress} asked to forward its mail here. Ask an owner or administrator to answer it.`}
                </p>
              )}
              <p className="text-[12.5px] text-faint">
                Asked {describeMoment(request.requestedAt, timezone)}
              </p>
            </div>
          ))}
        </section>
      )}

      {address && (
        <section className="flex w-full flex-col gap-4 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-[13.5px] font-semibold">In Gmail</h2>
            <p className="text-sm text-muted-foreground">
              {armedWindowSentence(FORWARDING_ARMED_WINDOW_MINUTES)}
            </p>
          </div>

          {canSetUp ? (
            <StartSetupButton organisationId={organisation.id} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Your role can view this, but setting up forwarding needs an owner or administrator.
            </p>
          )}

          <ol className="flex flex-col gap-3">
            {GMAIL_FORWARDING_STEPS.map((step, index) => (
              <li key={step.instruction} className="flex gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11.5px] font-semibold">
                  {index + 1}
                </span>
                <div className="flex flex-col gap-1">
                  <p className="text-sm">{step.instruction}</p>
                  {step.warning && (
                    <p className="text-[12.5px] text-muted-foreground">{step.warning}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {settled.length > 0 && (
        <section className="flex w-full flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-4">
          <h2 className="text-[13.5px] font-semibold">Already answered</h2>
          {settled.map((request) => (
            <p key={request.id} className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{request.sourceAddress}</span>{" "}
              {request.status === "confirmed"
                ? request.confirmedAutomatically
                  ? "— confirmed by Eva while you were setting it up."
                  : "— you confirmed this one."
                : "— you turned this one down, so Eva never confirmed it."}
            </p>
          ))}
        </section>
      )}

      <p className="w-full text-sm text-muted-foreground">
        <Link href={BOOK} className="font-medium text-link hover:underline">
          Back to enquiries
        </Link>
      </p>
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

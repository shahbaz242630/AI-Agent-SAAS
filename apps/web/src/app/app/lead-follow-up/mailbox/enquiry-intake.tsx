import { redirect } from "next/navigation";
import { FORWARDING_ARMED_WINDOW_MINUTES, moduleHref } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { describeMoment } from "@/lib/today";
import { EnquiryAddressPanel } from "@/capabilities/mailbox/enquiry-address-panel";
import {
  GMAIL_FORWARDING_SETTINGS_URL,
  GMAIL_FORWARDING_STEPS,
  armedWindowSentence,
  type ForwardingStep,
} from "@/capabilities/mailbox/forwarding-guide";
import type { MailboxProviderKey } from "@/capabilities/mailbox/mailbox-errors";
import {
  OUTLOOK_FORWARDING_HELP_URL,
  OUTLOOK_FORWARDING_STEPS,
} from "@/capabilities/mailbox/outlook-forwarding-guide";
import { Card, SectionHeading } from "@/components/ui";
import {
  ForwardingRequestActions,
  StartSetupButton,
  type ForwardingRequestRow,
} from "./forwarding-controls";

/**
 * Where enquiries come in — the receiving half of the Mailbox tab (2026-09-05).
 *
 * ⚠️ THIS WAS THREE SCREENS, AND A CUSTOMER COULD FIND ONE OF THEM. The
 * enquiry address sat as a card on top of the enquiry book, the only screen a
 * customer had in August; the Gmail steps and the confirmation logic lived on
 * a Forwarding page reachable only from a link inside that card; and the
 * Mailbox tab connected the sending mailbox and said nothing about receiving.
 * The founder, walking the book: *"this card shouldnt be here anyways.. it
 * should be on mailbox tab.. with a short step by step guide"*. So: one tab,
 * two halves — where Eva replies from, where enquiries come in.
 *
 * ⚠️ A PRODUCT FILE, DELIBERATELY. The mailbox screen is a capability shared
 * with Invoice Chasing, which has no enquiry address and must never grow one.
 * The capability exposes an `after` slot and knows nothing about what fills
 * it; this is what the lead product puts there.
 *
 * ⚠️ THE GUIDE FOLLOWS THE MAILBOX THE CUSTOMER CONNECTED (ruling 35). A Gmail
 * customer sees Gmail's steps and never a word of Outlook's, and the reverse.
 * A customer with both providers connected sees both cards, each in its own
 * world. A customer with neither is told to connect first.
 */

const REPLIES = moduleHref("lead_follow_up", "replies");

export async function EnquiryIntake({
  organisationId,
  accessToken,
  canSetUp,
  timezone,
  providers,
}: {
  organisationId: string;
  accessToken: string;
  /** `leads:write` — arming the window and answering requests need it. */
  canSetUp: boolean;
  timezone: string;
  /** The providers of the mailboxes connected to this product. */
  providers: readonly MailboxProviderKey[];
}) {
  /**
   * ⚠️ FETCHED FORGIVINGLY, THE RULE THE BOOK USED TO FOLLOW. An environment
   * with no inbound domain configured answers 503 to the address, and that
   * must not take the sending half of the tab down with it.
   */
  let address: string | null = null;
  try {
    const response = await apiFetch(
      `/organisations/${organisationId}/inbound-address`,
      accessToken,
    );
    address = ((await response.json()) as { address: string }).address;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    else if (!(error instanceof ApiError)) throw error;
  }

  let requests: ForwardingRequestRow[] = [];
  try {
    const response = await apiFetch(
      `/organisations/${organisationId}/forwarding/requests`,
      accessToken,
    );
    requests = (await response.json()) as ForwardingRequestRow[];
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    else if (!(error instanceof ApiError)) throw error;
  }

  // Absent rather than broken: with no address there is nothing honest to
  // draw, and a heading over an empty space reads as a fault.
  if (!address && requests.length === 0) return null;

  const pending = requests.filter((request) => request.status === "pending");
  const settled = requests.filter((request) => request.status !== "pending");
  const connected = new Set(providers);

  return (
    <>
      <SectionHeading title="Where enquiries come in" />

      {address && <EnquiryAddressPanel address={address} repliesHref={REPLIES} />}

      {/**
       * ⚠️ THE UNEXPECTED REQUESTS COME FIRST, ABOVE THE INSTRUCTIONS. Somebody
       * arriving here mid-setup wants step 1; somebody whose address has been
       * guessed needs to see that before anything else, and burying it under
       * a five-step guide would be the wrong order on the one day it matters.
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
                <ForwardingRequestActions organisationId={organisationId} request={request} />
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

      {address && connected.has("google") && (
        <GuideCard
          title="In Gmail"
          intro={armedWindowSentence(FORWARDING_ARMED_WINDOW_MINUTES)}
          steps={GMAIL_FORWARDING_STEPS}
          link={{ href: GMAIL_FORWARDING_SETTINGS_URL, label: "Open Gmail's forwarding settings" }}
        >
          {canSetUp ? (
            <StartSetupButton organisationId={organisationId} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Your role can view this, but setting up forwarding needs an owner or administrator.
            </p>
          )}
        </GuideCard>
      )}

      {address && connected.has("microsoft") && (
        <GuideCard
          title="In Outlook"
          intro="Nothing for Eva to confirm — Microsoft starts forwarding the moment you save."
          steps={OUTLOOK_FORWARDING_STEPS}
          link={{
            href: OUTLOOK_FORWARDING_HELP_URL,
            label: "Microsoft's own guide to the same steps",
          }}
        />
      )}

      {address && connected.size === 0 && (
        <p className="text-sm text-muted-foreground">
          Connect the mailbox above first. The steps for Gmail or for Outlook appear here once Eva
          knows which one you use.
        </p>
      )}

      {address && (
        <p className="text-sm text-muted-foreground">
          How you know it is working: send an email to your own address from another account. It
          appears in Enquiries within a minute or two.
        </p>
      )}

      {settled.length > 0 && (
        <Card className="flex w-full flex-col gap-3 px-6 py-4">
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
        </Card>
      )}
    </>
  );
}

/**
 * One provider's steps, in that provider's own words and nobody else's.
 *
 * The link opens in a new tab on purpose: the customer is about to follow
 * these steps inside a screen we do not control, and taking this page away
 * from them at that moment is the one thing the guide must not do.
 */
function GuideCard({
  title,
  intro,
  steps,
  link,
  children,
}: {
  title: string;
  intro: string;
  steps: readonly ForwardingStep[];
  link: { href: string; label: string };
  children?: React.ReactNode;
}) {
  return (
    <Card className="flex w-full flex-col gap-4 px-6 py-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-[13.5px] font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{intro}</p>
      </div>

      {children}

      <ol className="flex flex-col gap-3">
        {steps.map((step, index) => (
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

      <p className="text-[12.5px] text-muted-foreground">
        <a
          href={link.href}
          target="_blank"
          rel="noreferrer noopener"
          className="font-medium text-link hover:underline"
        >
          {link.label}
        </a>{" "}
        — opens in a new tab, so these steps stay in view.
      </p>
    </Card>
  );
}

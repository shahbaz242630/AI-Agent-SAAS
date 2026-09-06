import Link from "next/link";
import { redirect } from "next/navigation";
import { moduleHref, moduleName, REPLY_CHANNEL_LABELS, type LeadPlaybooksDto } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/permissions";
import { Card, Notice, PageHeader, PageShell, PrimaryLink } from "@/components/ui";
import { instantReplyOff, silentChannels } from "@/products/lead-follow-up/automations-screen";
import { PlaybookCard } from "./playbook-controls";

/**
 * What Eva does on her own (slice 3.5a, ruling 93) — the Replies screen of
 * 3.1c-1 and ruling 89, reshaped into cards.
 *
 * ⚠️ A CARD PER THING EVA DOES, EACH WITH A SWITCH (blueprint §3.6, ruling
 * 71). The founder's question of 2026-09-05 — *"how is out of hours
 * activated? shouldn't there be a toggle?"* — had no answer on the old
 * screen because there was nothing to toggle: one flag picked one wording and
 * the rest were stored and read by nothing. Now the instant reply is a card
 * that is on, the out-of-hours reply is a card that is off until opening
 * hours exist, and each has a box of words per channel.
 *
 * ⚠️ THE LIST OF NAMED WORDINGS IS GONE. "Add another reply", the pill and the
 * ten-per-channel cap went with it: a wording bound to no behaviour was one
 * nothing read, and a screen that keeps them promises what nothing does.
 *
 * ⚠️ NOTHING HERE PROMISES A SEND BY HAND. Ruling 89 dropped it and ruling 93
 * kept it dropped; `automations.spec.ts` refuses the words "by hand" in this
 * screen's three files.
 *
 * ⚠️ ON THE KIT, NOT HAND-ROLLED. `PageShell`, `PageHeader` and `Card` exist;
 * a new screen retyping them is how the count of copies went up before.
 */

const BOOK = moduleHref("lead_follow_up", "enquiries");

interface OrganisationSummary {
  id: string;
  name: string;
  permissions: string[];
}

export default async function AutomationsPage() {
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

  let data: LeadPlaybooksDto | null = null;
  let notEntitled = false;
  let refused = false;
  try {
    const response = await apiFetch(
      `/organisations/${organisation.id}/lead-playbooks`,
      accessToken,
    );
    data = (await response.json()) as LeadPlaybooksDto;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    else if (error instanceof ApiError && error.status === 402) notEntitled = true;
    /**
     * ⚠️ 403 IS A DIFFERENT SENTENCE FROM 402, AND CONFLATING THEM IS THE
     * STANDING §0d MISTAKE. "Your role can't" and "you haven't bought this"
     * send a customer to two different people.
     */ else if (error instanceof ApiError && error.status === 403) refused = true;
    else if (!(error instanceof ApiError)) throw error;
  }

  if (notEntitled) {
    return (
      <Shell>
        <Card className="flex w-full flex-col gap-3 px-6 py-4">
          <p className="text-sm">
            {`${organisation.name} doesn't have ${moduleName("lead_follow_up")}, so there is nothing for Eva to do on her own yet.`}
          </p>
          <div>
            <PrimaryLink href="/app/settings/modules">See your products</PrimaryLink>
          </div>
        </Card>
      </Shell>
    );
  }

  if (refused || !data) {
    return (
      <Shell>
        <Notice tone="muted">
          {`Your role can't see what Eva does for ${organisation.name}. Ask an owner or administrator.`}
        </Notice>
      </Shell>
    );
  }

  /**
   * ⚠️ OWNER ONLY (founder ruling 2026-09-01), NOT `leads:write`. Sales and
   * reception can READ these — what Eva sends in the business's name is worth
   * knowing when you answer the phone about it — but the switch and the words
   * are the owner's. Hiding the controls is not enforcement; the API refuses
   * either way. This is so nobody is offered a button that can only fail.
   */
  const canEdit = can(organisation, "lead_templates:manage");
  const silent = silentChannels(data.playbooks, data.sendsFrom);

  return (
    <Shell>
      <PageHeader
        title="What Eva does on her own"
        subtitle="Each card is one thing Eva does without being asked. Switch it on or off, and write the words she uses on each channel."
      />

      {/**
       * ⚠️ THE HONEST STATE, AT THE TOP — AND ITS PREDECESSOR WENT STALE
       * TWICE. `automations.spec.ts` asserts the CLAIM (Eva sends the instant
       * reply on her own; the out-of-hours reply goes instead when closed;
       * nothing else sends until switched on), so it fails when reality moves
       * rather than when the prose does.
       */}
      <Notice tone="muted">
        Eva sends the instant reply the moment an enquiry arrives. When you are closed, the
        out-of-hours reply goes instead. Nothing else sends until you switch it on.
      </Notice>

      {instantReplyOff(data.playbooks) && (
        <Notice tone="danger">
          The instant reply is switched off, so nobody who gets in touch hears back on their own.
        </Notice>
      )}

      {/**
       * ⚠️ ONE WARNING PER CHANNEL, AND ONLY FOR A CHANNEL THAT CAN SEND. A
       * channel with nothing connected cannot send at all, so "nobody hears
       * back" on it is noise the customer cannot act on here — its own line
       * says what is actually wrong (ruling 89's rule, kept).
       */}
      {silent.map((channel) => (
        <Notice key={channel} tone="danger">
          {`The instant reply has no ${REPLY_CHANNEL_LABELS[channel]} wording, so nobody hears back on ${REPLY_CHANNEL_LABELS[channel]}.`}
        </Notice>
      ))}

      {data.playbooks.map((playbook) => (
        <Card key={playbook.key} className="flex w-full flex-col gap-4 px-6 py-5">
          <PlaybookCard
            organisationId={organisation.id}
            playbook={playbook}
            sendsFrom={data.sendsFrom}
            openingHoursSet={data.openingHoursSet}
            canEdit={canEdit}
          />
        </Card>
      ))}

      <p className="w-full text-sm text-muted-foreground">
        Or go{" "}
        <Link href={BOOK} className="font-medium text-link hover:underline">
          back to enquiries
        </Link>
        .
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <PageShell>{children}</PageShell>;
}

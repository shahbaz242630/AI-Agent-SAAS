import Link from "next/link";
import { redirect } from "next/navigation";
import {
  moduleHref,
  moduleName,
  REPLY_CHANNEL_LABELS,
  REPLY_CHANNELS,
  type LeadReplyTemplatesDto,
  type ReplyChannel,
} from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/permissions";
import { Card, Notice, PageHeader, PageShell, PrimaryLink } from "@/components/ui";
import { sendsFromLine } from "@/products/lead-follow-up/replies-screen";
import { ChannelWordings } from "./reply-controls";

/**
 * The words Eva replies to an enquiry with (slice 3.1c-1; reshaped under
 * ruling 89, 2026-09-05).
 *
 * ⚠️ THIS IS THE FIRST SCREEN THE LEAD PRODUCT OWNS. Everything before it —
 * the enquiry book, the forwarding guide, the mailbox — reads platform records
 * or capability machinery. This one edits the product's own table, which is
 * what finally makes `products/lead-follow-up/` a folder rather than a
 * gesture.
 *
 * ⚠️ TWO PANELS, EMAIL THEN WHATSAPP, EACH SAYING WHERE ITS REPLIES LEAVE
 * FROM (ruling 89). The founder wanted email on top and WhatsApp under it,
 * visible together — so no tabs — and a channel with nothing connected has to
 * say so on the screen that edits its wordings, because the wordings seed for
 * every channel on first sight whether or not the channel can send.
 *
 * ⚠️ NOTHING HERE PROMISES A SEND BY HAND. That screen (3.1c-4) was never
 * built, and four sentences promised it for four days on production. Ruling
 * 89 dropped it: a person replies from their own mailbox or WhatsApp, and the
 * wordings that are not automatic are kept for when Eva can choose between
 * them (3.5). `reply-templates.spec.ts` refuses the words "by hand" in this
 * screen's three files.
 *
 * ⚠️ ON THE KIT, NOT HAND-ROLLED. `PageShell`, `PageHeader` and `Card` exist
 * and fourteen screens still retype them; a NEW screen adding a fifteenth copy
 * is how that count went up in the first place.
 */

const BOOK = moduleHref("lead_follow_up", "enquiries");

interface OrganisationSummary {
  id: string;
  name: string;
  permissions: string[];
}

export default async function ReplyTemplatesPage() {
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

  let data: LeadReplyTemplatesDto | null = null;
  let notEntitled = false;
  let refused = false;
  try {
    const response = await apiFetch(
      `/organisations/${organisation.id}/lead-reply-templates`,
      accessToken,
    );
    data = (await response.json()) as LeadReplyTemplatesDto;
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
            {`${organisation.name} doesn't have ${moduleName("lead_follow_up")}, so there are no replies to set up yet.`}
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
          {`Your role can't see ${organisation.name}'s enquiry replies. Ask an owner or administrator.`}
        </Notice>
      </Shell>
    );
  }

  /**
   * ⚠️ OWNER ONLY (founder ruling 2026-09-01), NOT `leads:write`. Sales and
   * reception can READ these — the wording Eva sends in the business's name
   * is worth knowing when you answer the phone about it — but the wording Eva
   * sends unread to every stranger is the owner's. Hiding the controls is not
   * enforcement; the API refuses either way. This is so nobody is offered a
   * button that can only fail.
   */
  const canEdit = can(organisation, "lead_templates:manage");

  return (
    <Shell>
      <PageHeader
        title="What Eva replies"
        subtitle="The wordings that go back to someone who has just got in touch."
      />

      {/**
       * ⚠️ THE HONEST STATE, AT THE TOP — AND IT WENT STALE TWICE ALREADY.
       * From 3.1c-1 this said "sending these replies is the next thing being
       * built"; 3.1c-3 built it and the sentence stayed. Then it said "the
       * screen for sending one by hand is the next thing being built"; that
       * screen was dropped (ruling 89) and the sentence stayed four days on
       * production. `reply-templates.spec.ts` now asserts the CLAIM — Eva
       * sends the automatic wording; nothing promises a send by hand — so it
       * fails when reality moves, not when the prose does.
       */}
      <Notice tone="muted">
        Eva sends the wording marked automatic, on her own, the moment an enquiry arrives. The other
        wordings are kept for when Eva can choose between them.
      </Notice>

      {/**
       * ⚠️ ONE WARNING PER CHANNEL, AND ONLY FOR A CHANNEL THAT CAN SEND. A
       * single warning could only ever describe one channel, so a customer
       * answering on email but silent on WhatsApp would see either nothing
       * wrong or a warning that looked already-fixed. And a channel with
       * nothing connected cannot send at all, so "nobody hears back" on it is
       * noise the customer cannot act on here — its panel says what is
       * actually wrong. Until ruling 89 the proxy for "can send" was "has
       * wordings", which every channel has from first sight.
       */}
      {REPLY_CHANNELS.filter(
        (channel) =>
          data.automaticTemplateIds[channel] === null && data.sendsFrom[channel] !== null,
      ).map((channel) => (
        <Notice key={channel} tone="danger">
          {`No automatic ${REPLY_CHANNEL_LABELS[channel]} reply is switched on, so nobody hears back on their own. Choose “Eva sends this one” on whichever wording should go out.`}
        </Notice>
      ))}

      {/**
       * ⚠️ A PANEL PER CHANNEL, ALWAYS, IN THE CATALOGUE'S ORDER — not only
       * the channels that hold a wording. A customer who emptied a channel's
       * list still needs the place to add one back, and the panel's own line
       * is where "nothing is connected" gets said.
       */}
      {REPLY_CHANNELS.map((channel) => (
        <ChannelPanel
          key={channel}
          channel={channel}
          data={data}
          organisationId={organisation.id}
          canEdit={canEdit}
        />
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

/**
 * One channel: its name, where its replies leave from, and its wordings as a
 * list that opens one editor at a time (ruling 89).
 *
 * The line under the heading is the connection state, asked of the api the
 * same way the sender asks it — so this screen and the send can never
 * disagree about which mailbox or number is "connected".
 */
function ChannelPanel({
  channel,
  data,
  organisationId,
  canEdit,
}: {
  channel: ReplyChannel;
  data: LeadReplyTemplatesDto;
  organisationId: string;
  canEdit: boolean;
}) {
  const sendsFrom = data.sendsFrom[channel];
  const line = sendsFromLine(channel, sendsFrom);

  return (
    <Card className="flex w-full flex-col gap-4 px-6 py-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-bold">{REPLY_CHANNEL_LABELS[channel]}</h2>
        <p className="text-[12.5px] text-muted-foreground">
          {line.text}
          {line.action && (
            <>
              {" "}
              <Link href={line.action.href} className="font-medium text-link hover:underline">
                {line.action.label}
              </Link>
            </>
          )}
        </p>
      </div>
      <ChannelWordings
        organisationId={organisationId}
        channel={channel}
        templates={data.templates.filter((template) => template.channel === channel)}
        automaticTemplateId={data.automaticTemplateIds[channel]}
        canEdit={canEdit}
        connected={sendsFrom !== null}
      />
    </Card>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <PageShell>{children}</PageShell>;
}

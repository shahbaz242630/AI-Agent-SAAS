import Link from "next/link";
import { redirect } from "next/navigation";
import { moduleHref, moduleName, type LeadReplyTemplatesDto } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/permissions";
import { Card, EmptyState, Notice, PageHeader, PageShell, PrimaryLink } from "@/components/ui";
import { ReplyTemplateList } from "./reply-controls";

/**
 * The words Eva replies to an enquiry with (slice 3.1c-1).
 *
 * ⚠️ THIS IS THE FIRST SCREEN THE LEAD PRODUCT OWNS. Everything before it —
 * the enquiry book, the forwarding guide, the mailbox — reads platform records
 * or capability machinery. This one edits the product's own table, which is
 * what finally makes `products/lead-follow-up/` a folder rather than a
 * gesture.
 *
 * ⚠️ THE AUTOMATIC REPLY NOW SENDS (3.1c-3); SENDING ONE BY HAND DOES NOT
 * (3.1c-4). This comment said "it cannot send anything yet" for one slice too
 * long — see the note on the `Notice` below, which is where that cost something.
 * Letting the page imply more than is built would be the same defect as Voice
 * Credit Control's blurb: copy describing a product we have not built, on the
 * screen that shows it off.
 *
 * ⚠️ ON THE KIT, NOT HAND-ROLLED. `PageShell`, `PageHeader` and `Card` exist
 * and fourteen screens still retype them; a NEW screen adding a fifteenth copy
 * is how that count went up in the first place.
 */

const BOOK = moduleHref("lead_follow_up", "enquiries");
const MAILBOX = moduleHref("lead_follow_up", "mailbox");

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
   * reception can READ these — they need to, to send one by hand from an
   * enquiry — but the wording Eva sends unread to every stranger is the
   * owner's. Hiding the controls is not enforcement; the API refuses either
   * way. This is so nobody is offered a button that can only fail.
   */
  const canEdit = can(organisation, "lead_templates:manage");

  return (
    <Shell>
      <PageHeader
        title="What Eva replies"
        subtitle="The wordings that go back to someone who has just got in touch."
      />

      {/**
       * ⚠️ THE HONEST STATE, AT THE TOP, IN BOTH DIRECTIONS — AND IT WENT STALE
       * ONCE ALREADY. This said "sending these replies is the next thing being
       * built" from 3.1c-1. Slice 3.1c-3 built it and deployed it, and this
       * sentence stayed, so the screen spent its first hours live telling
       * customers Eva could not do the thing she had just started doing.
       *
       * 🚨 THE GUARD THAT WAS SUPPOSED TO CATCH THAT POINTED THE WRONG WAY.
       * `reply-templates.spec.ts` asserted the words "being built" were
       * PRESENT, so it fired when somebody deleted the sentence — never when
       * the sentence became false. A tripwire on removal is not a tripwire on
       * staleness. It now names what is true and what is not, so each half
       * fails when its own half changes.
       *
       * The by-hand half (3.1c-4) genuinely is unbuilt, which is why the second
       * sentence stays.
       */}
      <Notice tone="muted">
        Eva sends the automatic reply on her own, as soon as an enquiry arrives. The other wordings
        are saved for you — the screen for sending one by hand is the next thing being built.
      </Notice>

      {data.automaticTemplateId === null && (
        <Notice tone="danger">
          No automatic reply is switched on, so nobody hears back on their own. Choose “Eva sends
          this one” on whichever wording should go out.
        </Notice>
      )}

      {data.templates.length === 0 ? (
        <EmptyState
          headline="No replies yet"
          detail="Eva starts you off with three wordings you can rewrite. If this is empty, somebody has deleted them all — add one and mark it as the automatic reply."
        />
      ) : (
        <ReplyTemplateList
          organisationId={organisation.id}
          templates={data.templates}
          automaticTemplateId={data.automaticTemplateId}
          canEdit={canEdit}
        />
      )}

      <p className="w-full text-sm text-muted-foreground">
        Replies leave your own mailbox —{" "}
        <Link href={MAILBOX} className="font-medium text-link hover:underline">
          the address Eva replies from
        </Link>
        . Or go{" "}
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

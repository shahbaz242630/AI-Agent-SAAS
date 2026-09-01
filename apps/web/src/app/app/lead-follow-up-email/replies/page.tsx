import Link from "next/link";
import { redirect } from "next/navigation";
import { moduleHref, type LeadReplyTemplatesDto } from "@eva/types";
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
 * what finally makes `products/lead-follow-up-email/` a folder rather than a
 * gesture.
 *
 * ⚠️ IT CANNOT SEND ANYTHING YET, AND THE SCREEN SAYS SO. Slice 3.1c-3 composes
 * and sends the reply; until then these are words in a box. Letting the page
 * imply otherwise would be the same defect as Voice Credit Control's blurb —
 * copy describing a product we have not built, on the screen that shows it off.
 *
 * ⚠️ ON THE KIT, NOT HAND-ROLLED. `PageShell`, `PageHeader` and `Card` exist
 * and fourteen screens still retype them; a NEW screen adding a fifteenth copy
 * is how that count went up in the first place.
 */

const BOOK = moduleHref("lead_follow_up_email", "enquiries");
const MAILBOX = moduleHref("lead_follow_up_email", "mailbox");

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
            {`${organisation.name} doesn't have Lead Follow-up by Email, so there are no replies to set up yet.`}
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
       * ⚠️ THE HONEST STATE, AT THE TOP, IN BOTH DIRECTIONS. Until 3.1c-3 ships
       * nothing is sent at all, and a screen full of Save buttons implies
       * otherwise. When it does ship, this line is the thing to change — and it
       * is one line, in one file, on purpose.
       */}
      <Notice tone="muted">
        Eva files every enquiry today, and sending these replies is the next thing being built.
        Anything you write here is saved and will be used the moment it is switched on.
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

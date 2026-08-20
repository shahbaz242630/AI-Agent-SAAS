import { redirect } from "next/navigation";
import { moduleHref } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { BackChip, StatusPill } from "@/components/ui";
import {
  alsoAffectsLine,
  contactLine,
  describeMoment,
  evidenceSummary,
  leadName,
  leadSourceLabel,
  leadStatusLabel,
  leadStatusTone,
  type AlsoAffected,
} from "@/products/lead-follow-up/lead-book";
import { StopContactingControl } from "./stop-contacting-control";

/**
 * One enquiry, and the proof behind it (Slice 3.1a).
 *
 * ⚠️ THE EVIDENCE PANEL IS WHY THIS SCREEN EXISTS. Everything else here is on
 * the book already. BRD §4.3 requires that contacting anybody is backed by a
 * record of them getting in touch first, and that record is written in the same
 * transaction as the lead — so there is no such thing as an unevidenced lead.
 * The panel answers the question a person actually has, which is not "what is
 * stored" but "why is it lawful for Eva to write to this person".
 *
 * ⚠️ THE EVIDENCE CANNOT BE EDITED, BY ANYONE, INCLUDING US. `eva_app` holds
 * SELECT and INSERT on `lead_evidence` and nothing else — an explicit REVOKE in
 * migration 0026, because a GRANT alone would have left UPDATE in place from
 * the default privileges. So this screen has no edit control, and that is a
 * property of the database rather than an omission from the UI.
 */

const BOOK = moduleHref("lead_follow_up_email", "enquiries");

interface OrganisationSummary {
  id: string;
  name: string;
  permissions: string[];
  timezone?: string | undefined;
}

interface LeadDetail {
  id: string;
  source: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  enquiry: string | null;
  status: string;
  receivedAt: string;
  firstRespondedAt: string | null;
  /** Clients who share this person's details and would be silenced too. */
  alsoAffects: AlsoAffected[];
  evidence: {
    channel: string;
    externalId: string | null;
    senderAddress: string | null;
    recipientAddress: string | null;
    subject: string | null;
    occurredAt: string;
    rawExcerpt: string | null;
    recordedAt: string;
  } | null;
}

export default async function EnquiryDetailPage({
  params,
}: {
  // Next 16: `params` is a Promise and must be awaited.
  params: Promise<{ leadId: string }>;
}) {
  const { leadId } = await params;
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims) redirect("/sign-in");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) redirect("/sign-in");

  const organisations = await fetchOrganisations<OrganisationSummary>(accessToken);
  const organisation = organisations[0];
  if (!organisation) redirect("/app");

  const timezone = organisation.timezone ?? "Europe/London";

  /**
   * ⚠️ THE GATE ORDER IS 404 FIRST, THEN 403, THEN 402 — the standing rule
   * §0d, and the import screen's precedent. Answering "you haven't bought this
   * product" for an id that does not exist turns a wrong guess into a way of
   * asking what a stranger's organisation has bought.
   */
  let lead: LeadDetail | null = null;
  let missing = false;
  let forbidden = false;
  let notEntitled = false;
  try {
    lead = (await (
      await apiFetch(`/organisations/${organisation.id}/leads/${leadId}`, accessToken)
    ).json()) as LeadDetail;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    else if (error instanceof ApiError && error.status === 404) missing = true;
    else if (error instanceof ApiError && error.status === 403) forbidden = true;
    else if (error instanceof ApiError && error.status === 402) notEntitled = true;
    else throw error;
  }

  if (missing) {
    return (
      <Shell>
        <p className="w-full text-sm text-muted-foreground">
          That enquiry is not here. It may have been logged against another organisation.
        </p>
      </Shell>
    );
  }

  if (notEntitled) {
    return (
      <Shell>
        <p className="w-full text-sm text-muted-foreground">
          {`${organisation.name} doesn't have Lead Follow-up by Email, so there are no enquiries to show.`}
        </p>
      </Shell>
    );
  }

  if (forbidden || !lead) {
    return (
      <Shell>
        <p className="w-full text-sm text-muted-foreground">
          {`Your role doesn't have access to ${organisation.name}'s enquiries. Ask an owner or administrator.`}
        </p>
      </Shell>
    );
  }

  const canWrite = can(organisation, "leads:write");
  const stopped = lead.status === "do_not_contact";

  return (
    <Shell>
      <section className="flex w-full flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-[29px] leading-tight font-semibold">{leadName(lead)}</h1>
          <StatusPill tone={leadStatusTone(lead.status)}>{leadStatusLabel(lead.status)}</StatusPill>
        </div>
        <p className="text-sm text-muted-foreground">
          {`${leadSourceLabel(lead.source)} · ${describeMoment(lead.receivedAt, timezone)}`}
        </p>
      </section>

      <section className="flex w-full flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-5">
        <h2 className="text-sm font-semibold">The enquiry</h2>
        <Field label="How to reach them" value={contactLine(lead)} />
        {/* `whitespace-pre-wrap` because this is what somebody actually wrote,
            and re-flowing their paragraphs is editing their words. */}
        <div className="flex flex-col gap-1">
          <span className="text-[11.5px] font-semibold tracking-[0.04em] text-faint">
            What they asked for
          </span>
          <p className="text-sm whitespace-pre-wrap">
            {lead.enquiry ?? "Nothing was written down."}
          </p>
        </div>
        <Field
          label="Answered"
          value={
            lead.firstRespondedAt
              ? describeMoment(lead.firstRespondedAt, timezone)
              : "Not yet — Eva cannot reply until the next two pieces are built."
          }
        />
      </section>

      {/**
       * ⚠️ THE PANEL THIS SCREEN EXISTS FOR. It leads with the sentence, not
       * with the fields: a person checking whether Eva may contact somebody
       * needs an answer, and a list of channel / occurred-at / recorded-at is
       * the raw material for one rather than the thing itself.
       */}
      <section className="flex w-full flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-5">
        <h2 className="text-sm font-semibold">Why Eva may contact them</h2>
        <p className="text-sm">{evidenceSummary(lead.evidence, timezone)}</p>

        {lead.evidence && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="How it arrived" value={leadSourceLabel(lead.evidence.channel)} />
              <Field
                label="When it happened"
                value={describeMoment(lead.evidence.occurredAt, timezone)}
              />
              {lead.evidence.senderAddress && (
                <Field label="From" value={lead.evidence.senderAddress} />
              )}
              {lead.evidence.recipientAddress && (
                <Field label="Sent to" value={lead.evidence.recipientAddress} />
              )}
              {lead.evidence.subject && <Field label="Subject" value={lead.evidence.subject} />}
              {lead.evidence.externalId && (
                <Field label="Their reference" value={lead.evidence.externalId} />
              )}
              <Field label="Recorded" value={describeMoment(lead.evidence.recordedAt, timezone)} />
            </div>

            {lead.evidence.rawExcerpt && (
              <div className="flex flex-col gap-1">
                <span className="text-[11.5px] font-semibold tracking-[0.04em] text-faint">
                  What was recorded at the time
                </span>
                <p className="rounded-[var(--radius-card)] bg-background px-4 py-3 text-sm whitespace-pre-wrap">
                  {lead.evidence.rawExcerpt}
                </p>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              This record cannot be changed by anyone, including us — the database refuses an edit
              to it. That is what makes it evidence rather than a note.
            </p>
          </>
        )}
      </section>

      {/**
       * ⚠️ THIS IS A COMPLIANCE ACTION AND HAS NO UNDO, so it sits apart from
       * the record rather than among it, and the screen says what it reaches:
       * every channel, permanently, beyond this lead and beyond this product.
       */}
      <section className="flex w-full flex-col gap-3 rounded-[var(--radius-card)] border border-danger-border bg-danger-surface px-6 py-5">
        <h2 className="text-sm font-semibold">If they ask not to be contacted</h2>
        {stopped ? (
          <p className="text-sm">
            Recorded. Eva will not contact {leadName(lead)} again — on this enquiry, on any future
            one, or through any other Eva product.
          </p>
        ) : (
          <>
            <p className="text-sm">
              This is immediate and permanent, and it applies to every way of reaching them, not
              just this enquiry. There is no undo.
            </p>
            {/**
             * ⚠️ THE NAMED CONSEQUENCE, AND THE REASON THIS PANEL WAS CHANGED.
             * The sentence above is true and abstract. On the first enquiry ever
             * logged on production the person was ALSO a client's billing
             * contact, so this button would have stopped invoice chasers to a
             * paying client — and nothing on screen said so. It was caught by
             * reading the database by hand, which is not a plan.
             *
             * Named, not counted, and placed ABOVE the button rather than under
             * it: a consequence discovered after the click is not a warning.
             */}
            {alsoAffectsLine(lead.alsoAffects) && (
              <p className="rounded-[var(--radius-card)] border border-danger-border bg-danger-tint px-4 py-3 text-sm font-medium text-danger">
                {alsoAffectsLine(lead.alsoAffects)}
              </p>
            )}
            {canWrite ? (
              <StopContactingControl
                organisationId={organisation.id}
                leadId={lead.id}
                who={leadName(lead)}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Your role can see enquiries but not record a do-not-contact request. Ask an owner or
                administrator — this one should not wait.
              </p>
            )}
          </>
        )}
      </section>
    </Shell>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11.5px] font-semibold tracking-[0.04em] text-faint">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex w-full max-w-[1080px] flex-1 flex-col gap-[26px] px-10 pt-8 pb-9">
      {/* First, not last — the product's rule since 2026-08-18. */}
      <BackChip href={BOOK}>Back to enquiries</BackChip>
      {children}
    </main>
  );
}

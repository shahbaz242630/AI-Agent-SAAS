import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import { createClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/ui";
import {
  channelLabel,
  doNotContactCountLine,
  recordedByLine,
  suppressionReasonLine,
} from "@/lib/do-not-contact";
import { describeMoment } from "@/lib/today";
import { CorrectControl } from "./correct-control";
import { SettingsTabs } from "../settings-tabs";

/**
 * Everyone Eva will not contact, and the way to fix an entry made by mistake
 * (2026-08-21).
 *
 * ⚠️ THIS SCREEN EXISTS BECAUSE OF ONE CLICK THAT NEARLY HAPPENED. On
 * 2026-08-20 the founder logged an enquiry using their own address — which is
 * also a real client's billing contact — and the do-not-contact button on it
 * would have stopped invoice chasers to that client permanently, with no way
 * back for anyone including us. The warning added that day says who else gets
 * silenced; this is the other half, for when somebody presses it anyway.
 *
 * ⚠️ IT IS A SETTINGS SCREEN, NOT A LEAD SCREEN, AND THAT IS DELIBERATE. The
 * list is organisation-wide and crosses every product, so a correction reached
 * only from the enquiry it came from would be one nobody could find — and the
 * entry may not have come from an enquiry at all.
 *
 * ⚠️ `suppression:manage` GUARDS EVEN READING IT. This is a list of people who
 * asked a business to leave them alone, and undoing an entry has to be a
 * different act from making one: sales and reception press the button,
 * owners and administrators are who can say it was a mistake.
 */

interface OrganisationSummary {
  id: string;
  name: string;
  permissions: string[];
  timezone?: string | undefined;
}

/** `GET /organisations/:id/suppression` — dates arrive as ISO strings. */
interface SuppressionRow {
  channel: string;
  value: string;
  since: string;
  reason: string | null;
  recordedBy: string | null;
}

export default async function DoNotContactPage() {
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
        <p className="w-full max-w-2xl text-sm text-muted-foreground">
          Create an organisation first.
        </p>
      </Shell>
    );
  }

  // `?? "Europe/London"` covers a web build newer than the API it talks to.
  const timezone = organisation.timezone ?? "Europe/London";

  let rows: SuppressionRow[] | null = null;
  let forbidden = false;
  try {
    rows = (await (
      await apiFetch(`/organisations/${organisation.id}/suppression`, accessToken)
    ).json()) as SuppressionRow[];
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    else if (error instanceof ApiError && error.status === 403) forbidden = true;
    else throw error;
  }

  return (
    <Shell>
      <section className="flex w-full max-w-3xl flex-col gap-2">
        <h1 className="font-display text-[29px] leading-tight font-semibold">Do not contact</h1>
        <p className="text-sm text-muted-foreground">
          {`People Eva will never write to or ring for ${organisation.name}, whichever product they came from.`}
        </p>
      </section>

      <SettingsTabs current="do-not-contact" />

      {/*
        ⚠️ THE PERMANENCE IS SAID FIRST, NOT AS A FOOTNOTE. Everything below is
        about the one exception to it, and a reader who meets the exception
        before the rule takes away the wrong impression.
      */}
      <section className="flex w-full max-w-3xl flex-col gap-2 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-4">
        <p className="text-sm">
          When somebody asks not to be contacted, that holds forever and across everything — email
          and phone, enquiries and invoices alike.
        </p>
        <p className="text-sm text-muted-foreground">
          The only thing you can change here is an entry that should never have been made. Nothing
          is ever deleted: a correction is recorded alongside the original, with who made it and
          why.
        </p>
      </section>

      {forbidden || !rows ? (
        <p className="w-full max-w-3xl text-sm text-muted-foreground">
          {`Your role can't see ${organisation.name}'s do-not-contact list. Ask an owner or administrator.`}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          headline="Nobody is on this list."
          detail="When somebody asks not to be contacted, they will appear here — and stay here."
        />
      ) : (
        <section className="flex w-full max-w-3xl flex-col gap-3">
          <p className="text-sm text-muted-foreground">{doNotContactCountLine(rows.length)}</p>

          <ul className="flex flex-col gap-3">
            {rows.map((row) => (
              <li
                key={`${row.channel} ${row.value}`}
                className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-4"
              >
                <div className="flex flex-col gap-1">
                  <p className="font-medium">{row.value}</p>
                  <p className="text-sm text-muted-foreground">
                    {`${channelLabel(row.channel)} · added ${describeMoment(row.since, timezone)} by ${recordedByLine(row.recordedBy)}`}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {suppressionReasonLine(row.reason)}
                  </p>
                </div>

                <CorrectControl
                  organisationId={organisation.id}
                  channel={row.channel}
                  value={row.value}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
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

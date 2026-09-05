import Link from "next/link";
import { redirect } from "next/navigation";
import { moduleHref, moduleName } from "@eva/types";
import { ApiError, apiFetch } from "@/lib/api";
import { fetchOrganisations } from "@/lib/organisations";
import { createClient } from "@/lib/supabase/server";
import { PageShell } from "@/components/ui";
import {
  bookHref,
  bookQueryString,
  parseBookFilters,
  type LeadBook,
} from "@/products/lead-follow-up/lead-book";
import { loadEnquiryBook } from "./actions";
import { EnquiryBook } from "./book";

/**
 * The enquiry book (Slice 3.1a; a table with filters, search, paging and a
 * CSV since ruling 81, 2026-09-05).
 *
 * ⚠️ THIS SCREEN COMPUTES NOTHING ABOUT A LEAD. Status, stage, source and the
 * moment an enquiry arrived all come from the API exactly as stored — the
 * same rule the invoice book follows, for the same reason: the thing that
 * ACTS on a lead is the API, and a screen that works out its own answer
 * starts disagreeing with whatever Eva actually does.
 *
 * ⚠️ FILTERS LIVE IN THE URL, deliberately, the invoice book's rule. It makes
 * "unanswered WhatsApp enquiries" a link somebody can bookmark, and it keeps
 * the filter and the page in step. The client half (`book.tsx`) swaps pages
 * in place and pushes the same addresses into history, so the two never
 * disagree about what an address means.
 *
 * ⚠️ THE 402 IS THE ORDINARY CASE HERE, NOT AN EDGE. `leads:read` is carried by
 * `lead_follow_up` alone, so every organisation that has not bought this
 * product gets one. "You haven't got this product" and "your role can't" are
 * different problems with different fixes and must never share a sentence
 * (standing rule §0d).
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

export default async function EnquiryBookPage({
  searchParams,
}: {
  // Next 16: `searchParams` is a Promise and must be awaited.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { filters, page } = parseBookFilters(params);

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

  let book: LeadBook | null = null;
  let forbidden = false;
  let notEntitled = false;
  try {
    book = (await (
      await apiFetch(
        `/organisations/${organisation.id}/leads?${bookQueryString(filters, page)}`,
        accessToken,
      )
    ).json()) as LeadBook;
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

  if (forbidden || !book) {
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
       * ⚠️ NO ADDRESS CARD HERE ANY MORE (founder, 2026-09-05: *"this card
       * shouldnt be here anyways.. it should be on mailbox tab"*). Set-up has a
       * home — the receiving half of the Mailbox tab — and the book is for
       * what arrived. `enquiry-address-panel.spec.tsx` asserts this file never
       * draws the card again.
       *
       * ⚠️ KEYED ON THE ADDRESS. The book swaps pages in place and pushes the
       * address itself; when the browser goes Back, Next re-renders this page
       * with the earlier address, and the key is what makes the book start
       * again from that page's data rather than keep the state it had.
       */}
      <EnquiryBook
        key={bookHref(BOOK, filters, page)}
        organisationId={organisation.id}
        timezone={timezone}
        initial={{ book, filters, page }}
        load={loadEnquiryBook}
      />
    </Shell>
  );
}

/**
 * ⚠️ WIDE, LIKE THE INVOICE BOOK. Seven columns in the 1080px shell forced a
 * sideways scroll that cut the Answered column off (the founder, 2026-09-05:
 * *"widen the box. otherwise the answered message gets cut off"*).
 */
function Shell({ children }: { children: React.ReactNode }) {
  return <PageShell wide>{children}</PageShell>;
}

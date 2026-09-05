import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EnquiryBook } from "@/app/app/lead-follow-up/enquiries/book";
import type { LeadBook, LeadBookRow } from "@/products/lead-follow-up/lead-book";

/**
 * The enquiry book, actually rendered at volume (ruling 81, 2026-09-05).
 *
 * The book is a client component with state, so it renders here as a
 * browser would first see it: the tabs and their counts, the rows, the
 * pager and the download link, all from one page of data.
 */

const stages = [
  { id: "s-new", key: "new", name: "New", position: 1, count: 212 },
  { id: "s-contacted", key: "contacted", name: "Contacted", position: 2, count: 61 },
  { id: "s-quoted", key: "quoted", name: "Quoted", position: 4, count: 0 },
];

function row(overrides: Partial<LeadBookRow> & { id: string }): LeadBookRow {
  return {
    source: "email_enquiry",
    contactName: "Tom Bright",
    contactEmail: "tom@example.com",
    contactPhone: null,
    enquiry: "Quote for a loft conversion, please.",
    status: "new",
    receivedAt: "2026-09-05T08:00:00.000Z",
    firstRespondedAt: "2026-09-05T08:00:03.000Z",
    hasEvidence: true,
    stage: { key: "new", name: "New" },
    ...overrides,
  };
}

const book: LeadBook = {
  rows: [
    row({ id: "lead-1" }),
    row({
      id: "lead-2",
      source: "whatsapp_enquiry",
      contactName: "Sarah Khan",
      contactEmail: null,
      contactPhone: "+971 50 000 1234",
      enquiry: "Boiler making a banging noise.",
      firstRespondedAt: null,
    }),
    row({ id: "lead-3", contactName: "A Stranger", status: "do_not_contact" }),
  ],
  totalCount: 273,
  // More than the stages sum to: the All tab must say this, not 273.
  bookCount: 300,
  stages,
};

const load = async () => ({ ok: true as const, book });

const render = (filters = {}, page = 1) =>
  renderToStaticMarkup(
    <EnquiryBook
      organisationId="org-1"
      timezone="Europe/London"
      initial={{ book, filters, page }}
      load={load}
    />,
  );

describe("the enquiry book", () => {
  it("shows a tab per stage that holds something, with its count, and an All tab", () => {
    const html = render();
    expect(html).toContain("All 300");
    expect(html).toContain("New 212");
    expect(html).toContain("Contacted 61");
    // An empty stage is not a tab — until it is the one selected.
    expect(html).not.toContain("Quoted 0");
    expect(render({ stage: "quoted" })).toContain("Quoted 0");
  });

  it("makes All the whole book: it clears every filter, not only the stage (founder, 2026-09-05)", () => {
    const html = render({ stage: "new", channel: "whatsapp", search: "boiler" });
    // The number is the book's whatever is on, and the link carries nothing.
    expect(html).toMatch(/href="\/app\/lead-follow-up\/enquiries"[^>]*>All 300</);
    expect(html).not.toMatch(/aria-current="true"[^>]*>All 300</);
    // A chip alone is a filter too: All is selected only when nothing is on.
    expect(render({ channel: "email" })).not.toMatch(/aria-current="true"[^>]*>All 300</);
    expect(render()).toMatch(
      /href="\/app\/lead-follow-up\/enquiries" aria-current="true"[^>]*>All 300</,
    );
  });

  it("draws the eight columns and a row per enquiry, each linking into the enquiry", () => {
    const html = render();
    for (const heading of [
      "#",
      "Who",
      "How to reach them",
      "What they asked",
      "Channel",
      "Received",
      "Answered",
      "Stage",
    ]) {
      expect(html).toContain(`>${heading}<`);
    }
    expect(html).toContain('href="/app/lead-follow-up/enquiries/lead-1"');
    expect(html).toContain("Sarah Khan");
    expect(html).toContain(">WhatsApp<");
    expect(html).toContain("3 seconds later");
    expect(html).toContain("Not yet");
  });

  /** Page 2 starts at 11, so a number means the same thing on every page. */
  it("numbers the rows through the whole book, not just the page", () => {
    expect(render({}, 1)).toMatch(/tabular-nums[^>]*>1<\/td>/);
    expect(render({}, 2)).toMatch(/tabular-nums[^>]*>11<\/td>/);
  });

  /** A do-not-contact outranks the stage: it is the one thing not to miss. */
  it("shows a do-not-contact instead of the stage on that row", () => {
    const html = render();
    expect(html).toContain("Do not contact");
    expect((html.match(/>New</g) ?? []).length).toBe(2);
  });

  it("pages with numbers and arrows, and marks the page it is on", () => {
    const html = render({}, 3);
    // 273 enquiries at ten a page is twenty-eight pages.
    expect(html).toContain('aria-label="Page 28"');
    expect(html).not.toContain('aria-label="Page 29"');
    expect(html).toMatch(/aria-current="page"[^>]*>3</);
    expect(html).toContain('aria-label="Previous page"');
    expect(html).toContain('aria-label="Next page"');
  });

  it("says what is showing, and links a CSV of exactly that", () => {
    const html = render({ stage: "new", channel: "whatsapp" }, 2);
    expect(html).toContain("Showing 11–13 of 273 new enquiries by WhatsApp, newest first.");
    expect(html).toContain(
      'href="/app/lead-follow-up/enquiries/export?stage=new&amp;channel=whatsapp"',
    );
  });

  it("keeps every filter a real address", () => {
    const html = render({ channel: "email" });
    expect(html).toContain('href="/app/lead-follow-up/enquiries?channel=email&amp;answered=no"');
    // Pressing the selected chip again clears it.
    expect(html).toContain('href="/app/lead-follow-up/enquiries" aria-current="true"');
  });

  it("offers the way in when the book is empty, and a way out when a filter empties it", () => {
    const empty: LeadBook = {
      rows: [],
      totalCount: 0,
      bookCount: 0,
      stages: stages.map((s) => ({ ...s, count: 0 })),
    };
    const asIs = renderToStaticMarkup(
      <EnquiryBook
        organisationId="org-1"
        timezone="Europe/London"
        initial={{ book: empty, filters: {}, page: 1 }}
        load={load}
      />,
    );
    expect(asIs).toContain("No enquiries yet.");
    expect(asIs).toContain('href="/app/lead-follow-up/mailbox"');
    const filtered = renderToStaticMarkup(
      <EnquiryBook
        organisationId="org-1"
        timezone="Europe/London"
        initial={{ book: empty, filters: { search: "zzz" }, page: 1 }}
        load={load}
      />,
    );
    expect(filtered).toContain("Nothing matches.");
    expect(filtered).toContain("Clear the filters");
    expect(filtered).toContain("Clear all filters");
    // The search that is on shows as a chip that clears it.
    expect(filtered).toContain("“zzz” ×");
  });
});

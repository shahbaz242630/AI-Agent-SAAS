import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EnquiryAddressPanel } from "@/capabilities/mailbox/enquiry-address-panel";

/**
 * The enquiry address panel, actually rendered.
 *
 * ⚠️ THE GUARD FOR A SENTENCE THAT LIED ON PRODUCTION FOR FOUR DAYS. From
 * 3.1b the panel said Eva did not answer enquiries yet and that the answering
 * was unbuilt, under a comment promising the sentence would stay until she
 * did. Slice 3.1c-3 shipped the automatic reply on 2026-09-01; the sentence
 * stayed; the founder read it on 2026-09-05. The reply-templates tripwire had
 * already taught the lesson once — a test that a sentence is PRESENT fires
 * when somebody deletes it, never when it becomes false — so these assert the
 * claim, not the words.
 *
 * ⚠️ AND THE GUARD FOR WHERE IT LIVES. The founder moved it off the enquiry
 * book and onto the Mailbox tab the same day; the last two tests keep it there.
 */

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(`${WEB_ROOT}${relative}`, "utf8");

const ADDRESS = "acme-plumbing-x1y2z3@example.resend.app";

describe("the enquiry address panel", () => {
  it("never says that Eva does not reply", () => {
    const source = read("src/capabilities/mailbox/enquiry-address-panel.tsx");
    for (const stale of ["does not reply", "not reply to them yet", "still being built"]) {
      expect(source, `the panel must not say "${stale}"`).not.toContain(stale);
    }
  });

  it("says what Eva does with an enquiry, and where to see the wording", () => {
    const html = renderToStaticMarkup(
      <EnquiryAddressPanel address={ADDRESS} repliesHref="/app/lead-follow-up/automations" />,
    );
    // The card's name since 3.5a — what a customer who switched it off will look for.
    expect(html).toContain("answers it with your instant reply");
    expect(html).toContain('href="/app/lead-follow-up/automations"');
    expect(html).toContain("what Eva does on her own");
    expect(html).toContain(ADDRESS);
    // The old sentence named a flag that no longer exists.
    expect(html).not.toContain("marked as automatic");
  });

  it("reads correctly with no automations link at all", () => {
    const html = renderToStaticMarkup(<EnquiryAddressPanel address={ADDRESS} />);
    expect(html).toContain("your instant reply.");
    expect(html).not.toContain("what Eva does on her own");
  });

  /**
   * ⚠️ THE BOOK IS AN ASYNC SERVER COMPONENT AND CANNOT BE RENDERED HERE, so
   * where the panel lives is asserted at the source: the enquiry book never
   * imports it, and the Mailbox tab's receiving half does. If somebody puts
   * the card back on the book, this goes red before the founder sees it.
   */
  it("lives on the Mailbox tab, not on the enquiry book", () => {
    expect(read("src/app/app/lead-follow-up/enquiries/page.tsx")).not.toContain(
      "EnquiryAddressPanel",
    );
    expect(read("src/app/app/lead-follow-up/mailbox/enquiry-intake.tsx")).toContain(
      "EnquiryAddressPanel",
    );
  });

  it("no longer links out to a separate forwarding page — the steps are underneath it", () => {
    const source = read("src/capabilities/mailbox/enquiry-address-panel.tsx");
    expect(source).not.toContain("forwardingHref");
  });
});

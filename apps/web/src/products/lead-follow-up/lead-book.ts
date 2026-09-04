/**
 * The enquiry book's own words and arithmetic (Slice 3.1a).
 *
 * ⚠️ EVERYTHING HERE IS PURE, AND THAT IS THE POINT. Both lead screens are
 * async server components — they redirect, they fetch, and no plain node test
 * can render one. The hub taught this lesson expensively in 3.0: a product a
 * customer HELD vanished from their screen and 1,438 tests noticed nothing,
 * because the rules lived inside a component nothing could call. Every rule
 * worth getting right lives in this file instead, where a test can reach it.
 */

import { describeMoment } from "@/lib/today";

/**
 * The sources whose English `sentenceCase` cannot reach.
 *
 * ⚠️ THE MAP IS BACK, FOR ONE ENTRY, AND THE DOC BELOW SAYS WHEN IT WAS
 * PROMISED. WhatsApp spells itself with a capital A, and sentence-casing the
 * key would put "Whatsapp enquiry" on a customer's screen — a brand name
 * misspelt, which reads as carelessness about their own enquiry. Anything
 * not listed here still falls through to `sentenceCase`.
 */
const LEAD_SOURCE_LABELS: Readonly<Record<string, string>> = {
  whatsapp_enquiry: "WhatsApp enquiry",
};

/**
 * How an enquiry came in, in English.
 *
 * ⚠️ THE LOOKUP TABLE WAS REMOVED ON 2026-08-21 AND CAME BACK ON 2026-09-04,
 * BOTH TIMES FOR A REASON. Until 2026-08-21 this mapped three hand-logged
 * sources — `missed_call`, `existing_customer`, `callback_request` — which
 * were removed with the manual form when the founder ruled that this product
 * is one mailbox in and a reply out; `email_enquiry` reads correctly straight
 * out of `sentenceCase` ("Email enquiry"), so the map was three lines
 * restating the function. The comment then said a map comes back the moment
 * a source needs wording `sentenceCase` cannot reach. `whatsapp_enquiry`
 * (slice 3.3b, ruling 62) is that source.
 */
export function leadSourceLabel(source: string): string {
  return LEAD_SOURCE_LABELS[source] ?? sentenceCase(source);
}

/**
 * ⚠️ AN UNKNOWN SOURCE MUST STILL READ AS ENGLISH, AND ONE IS ALREADY IN THE
 * DATABASE. The retired call sources stay legal in Postgres — migration 0027
 * widened rather than narrowed, because lead `cc1c3243` on production is a
 * `callback_request` and evidence must not be rewritten — so this screen still
 * renders them, as "Callback request". The same fallback covers a web deploy
 * trailing an API deploy that has started writing a source this build has never
 * heard of. Printing the raw key is how a database word reaches a customer,
 * which is the same defect as "modules" leaking onto the sidebar.
 */
function sentenceCase(value: string): string {
  const words = value.replace(/_/g, " ").trim();
  if (words === "") return "Enquiry";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** How a lead's state reads, and how loudly. */
export function leadStatusLabel(status: string): string {
  if (status === "do_not_contact") return "Do not contact";
  if (status === "new") return "New";
  return sentenceCase(status);
}

/**
 * ⚠️ THE TONES ARE `StatusPill`'S OWN VOCABULARY, NOT INVENTED HERE.
 * It accepts good / warn / bad / mute; "neutral" is not one of them and
 * would have been a type error at the call site rather than a wrong colour —
 * but only because the pill types its tone. Returning the union keeps that.
 *
 * A new enquiry is deliberately `mute` rather than `good`: nothing has gone
 * right yet, it has merely arrived, and a green pill on an unanswered enquiry
 * would read as "handled".
 */
export function leadStatusTone(status: string): "mute" | "bad" {
  return status === "do_not_contact" ? "bad" : "mute";
}

/**
 * The one line saying how to reach somebody.
 *
 * ⚠️ NEVER EMPTY, BECAUSE THE RECORD CANNOT BE. A lead needs an email address
 * or a phone number — the API refuses one with neither, and so does a CHECK
 * constraint. If both are somehow missing we say so plainly rather than
 * printing an empty cell that reads as a rendering fault.
 */
export function contactLine(lead: {
  contactEmail: string | null;
  contactPhone: string | null;
}): string {
  const parts = [lead.contactEmail, lead.contactPhone].filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );
  return parts.length > 0 ? parts.join(" · ") : "No contact details";
}

/** What to call somebody who did not leave a name. */
export function leadName(lead: { contactName: string | null }): string {
  const name = lead.contactName?.trim();
  return name && name !== "" ? name : "Someone who didn't leave a name";
}

/** The count line above the book. */
export function bookCountLine(total: number): string {
  if (total === 0) return "No enquiries yet.";
  if (total === 1) return "1 enquiry.";
  return `${total} enquiries.`;
}

/**
 * What the evidence behind a lead actually proves, said in a sentence.
 *
 * ⚠️ THIS SCREEN EXISTS FOR THIS SENTENCE. BRD §4.3 requires that contacting
 * anybody is backed by evidence of them getting in touch first, and a detail
 * page that lists `channel: missed_call` next to a timestamp has shown the
 * data without answering the question a person actually has, which is "why is
 * it lawful for Eva to write to this person". So it is spelled out.
 */
export function evidenceSummary(
  evidence: { channel: string; occurredAt: string } | null,
  timezone: string,
): string {
  if (!evidence) {
    return "No evidence is recorded against this enquiry, so Eva will not contact them.";
  }
  const when = describeMoment(evidence.occurredAt, timezone);
  return `They got in touch themselves — ${leadSourceLabel(evidence.channel).toLowerCase()}, ${when}. That is what makes contacting them lawful.`;
}

/** A client who shares this person's email address or phone number. */
export interface AlsoAffected {
  customerId: string;
  customerName: string;
  matchedOn: ("email" | "phone")[];
}

/**
 * What a do-not-contact request will actually reach, said before it happens.
 *
 * ⚠️ THIS SENTENCE IS THE FIX FOR A TRAP THE FOUNDER WALKED INTO ON THE FIRST
 * ENQUIRY EVER LOGGED (2026-08-20). Suppression is by VALUE, organisation-wide
 * and cross-product, so recording a do-not-contact on an enquiry ALSO stops
 * invoice chasers to the same address. The screen said "every channel,
 * permanently" — true, and abstract enough that nobody reads it as "this will
 * stop you chasing Meridian Logistics". Naming the client is what turns a
 * disclaimer into a warning.
 *
 * ⚠️ IT NAMES THEM, IT DOES NOT COUNT THEM. "1 other client affected" is the
 * same disclaimer wearing a number: it tells somebody there is a consequence
 * without telling them what it is, which leaves them exactly as unable to
 * decide. Beyond three, the list is trimmed and the remainder counted, because
 * a paragraph of names is not read either.
 */
export function alsoAffectsLine(affected: readonly AlsoAffected[]): string | null {
  if (affected.length === 0) return null;

  const names = affected.map((row) => row.customerName);
  const listed =
    names.length <= 3 ? list(names) : `${list(names.slice(0, 3))} and ${names.length - 3} more`;
  const verb = affected.length === 1 ? "is" : "are";
  const they = affected.length === 1 ? "them" : "them";

  return `${listed} ${verb} on your client list with the same details, so this will stop Eva contacting ${they} about invoices too.`;
}

/** "A", "A and B", "A, B and C" — the way a person writes a list. */
function list(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

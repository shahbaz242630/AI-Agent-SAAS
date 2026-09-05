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

// ---------------------------------------------------------------------------
// The conversation (slice 3.3c)
// ---------------------------------------------------------------------------

/** One row of the API's timeline — the `person_timeline` view, per person. */
export interface TimelineItem {
  id: string;
  type: "message" | "activity";
  /** `email` | `whatsapp` for a message; null for an activity. */
  channel: string | null;
  /** A message's direction (`inbound` | `outbound`); an activity's kind. */
  detail: string;
  /** `person` | `user` | `assistant` | `system`. */
  actorKind: string;
  subject: string | null;
  summary: string | null;
  happenedAt: string;
}

/** What one timeline row says on the screen. */
export interface TimelineEntry {
  /** Who did it: the person's name, "Eva", or "Your team". */
  who: string;
  /** The channel or the kind of activity, and when. */
  meta: string;
  /** Email subject lines only; null everywhere else. */
  subject: string | null;
  body: string;
  /** True for something the person sent — the screen sets those apart. */
  fromThem: boolean;
}

const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  email: "Email",
  whatsapp: "WhatsApp",
};

const ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  note: "Note",
  stage_changed: "Stage changed",
};

/**
 * How one timeline row reads.
 *
 * ⚠️ THE PERSON IS NAMED BY THE ENQUIRY, NOT BY THE ROW. The view carries no
 * name — it is a union of messages and activities keyed by person — so the
 * screen passes down what it already calls them (`leadName`), and "Someone
 * who didn't leave a name" reads correctly here too.
 *
 * ⚠️ A MESSAGE WITH NO WORDS STILL SAYS SOMETHING. A bare photo or sticker
 * arrives as a message with a null body; printing nothing would look like a
 * rendering fault, and inventing words for a compliance record is worse.
 */
export function timelineEntry(item: TimelineItem, who: string, timezone: string): TimelineEntry {
  const when = describeMoment(item.happenedAt, timezone);
  if (item.type === "message") {
    const fromThem = item.detail === "inbound";
    const channel = CHANNEL_LABELS[item.channel ?? ""] ?? sentenceCase(item.channel ?? "");
    return {
      who: fromThem ? who : item.actorKind === "assistant" ? "Eva" : "Your team",
      meta: `${channel} · ${when}`,
      subject: item.channel === "email" ? item.subject : null,
      body:
        item.summary ??
        (fromThem
          ? "They sent something without words — a photo, a sticker or a file."
          : "Nothing was written down."),
      fromThem,
    };
  }
  const kind = ACTIVITY_LABELS[item.detail] ?? sentenceCase(item.detail);
  return {
    who: item.actorKind === "user" ? "Your team" : "Eva",
    meta: `${kind} · ${when}`,
    subject: null,
    body: item.summary ?? "",
    fromThem: false,
  };
}

/** What the conversation panel says when there is nothing in it. */
export function timelineEmptyLine(who: string): string {
  return `Nothing has been exchanged with ${who} yet.`;
}

/**
 * Whether and when the enquiry was answered.
 *
 * ⚠️ THIS REPLACED "Eva cannot reply until the next two pieces are built",
 * WHICH STOPPED BEING TRUE ON 2026-09-02 (#131) AND STAYED ON THE SCREEN FOR
 * TWO DAYS. Eva answers an email enquiry when a mailbox is connected and an
 * automatic wording is on; what she still cannot do is answer on WhatsApp,
 * and the sentence says which, so the screen never claims more or less
 * than the product does.
 */
export function answeredLine(
  lead: { firstRespondedAt: string | null; source: string },
  timezone: string,
): string {
  if (lead.firstRespondedAt) return describeMoment(lead.firstRespondedAt, timezone);
  /**
   * ⚠️ NO CLAIM ABOUT WHAT EVA CANNOT DO. Until 3.4a this said "Eva cannot
   * reply on WhatsApp until a later piece is built", which was true for one
   * day and false from the next deploy — the same defect as the sentence it
   * replaced. Eva answers on both channels now; "Not yet." is the whole truth
   * for either, and the reason lives on the decision, not here.
   */
  return "Not yet.";
}

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

/**
 * The three ways a human can log an enquiry by hand.
 *
 * ⚠️ THE SAME THREE THE API'S CHECK CONSTRAINT ALLOWS, AND NO MORE. `source`
 * is a CHECK in the database, so a fourth value invented here does not render
 * a new option — it produces a 400 at the moment somebody presses Save. 3.1b
 * widens the constraint when Eva can read a mailbox; the list grows then, in
 * the migration, and here afterwards.
 */
export const MANUAL_LEAD_SOURCES = [
  "missed_call",
  "existing_customer",
  "callback_request",
] as const;

export type ManualLeadSource = (typeof MANUAL_LEAD_SOURCES)[number];

/**
 * ⚠️ `Record<ManualLeadSource, …>` IS THE EXHAUSTIVENESS GUARANTEE, the same
 * device `humanRefusal` uses for write actions: adding a source without a
 * sentence for it is a compile error rather than a raw `missed_call` appearing
 * on a screen a customer is reading.
 */
const SOURCE_LABELS: Record<ManualLeadSource, string> = {
  missed_call: "Missed call",
  existing_customer: "Existing client",
  callback_request: "Callback request",
};

/** What each source means, for the person choosing between them on a form. */
const SOURCE_HINTS: Record<ManualLeadSource, string> = {
  missed_call: "They rang and nobody picked up.",
  existing_customer: "Somebody you already work for, asking about something new.",
  callback_request: "They asked to be called back — a note, a text, a message passed on.",
};

export function leadSourceLabel(source: string): string {
  return SOURCE_LABELS[source as ManualLeadSource] ?? sentenceCase(source);
}

export function leadSourceHint(source: ManualLeadSource): string {
  return SOURCE_HINTS[source];
}

/**
 * ⚠️ AN UNKNOWN SOURCE MUST STILL READ AS ENGLISH. 3.1b starts writing sources
 * this build has never heard of — `email_enquiry` and whatever follows it — and
 * a web deploy always trails an API deploy by a few minutes. For that window
 * the screen shows "Email enquiry", not `email_enquiry`. Falling back to the
 * raw key is how a database word reaches a customer, which is the same defect
 * as "modules" leaking onto the sidebar.
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

/**
 * A moment, in the ORGANISATION's timezone: "Tuesday 19 August at 2:30pm".
 *
 * ⚠️ NEVER THE SERVER'S CLOCK — `lib/today.ts` carries the full reasoning, and
 * it bites harder here than on a dashboard heading. Speed-to-lead (BRD §4.3) is
 * measured from this exact moment, and our compute runs eight hours behind
 * London. An enquiry logged at 9am in Manchester printed as 1am is not a
 * cosmetic slip: it is the number every response target is derived from.
 */
export function describeMoment(iso: string, timezone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "at an unknown time";
  try {
    return formatIn(at, timezone);
  } catch {
    // An unrecognised zone costs the reader a few hours of accuracy. Throwing
    // costs them the whole screen.
    return formatIn(at, "UTC");
  }
}

function formatIn(at: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(at)
    .replace(/\s/g, "")
    .toLowerCase();
  return `${day} at ${time}`;
}

/**
 * Turn what somebody typed into a `datetime-local` box into a real instant.
 *
 * ⚠️ A `datetime-local` VALUE CARRIES NO TIMEZONE, AND THE SERVER'S GUESS IS
 * WRONG BY EIGHT HOURS. The browser hands us `2026-08-20T14:30` — wall-clock
 * digits and nothing else. `new Date("2026-08-20T14:30")` on our API host reads
 * that as 2:30pm in `us-west2`, i.e. 10:30pm in London, so Friday's missed call
 * gets filed at the wrong time and every response target computed from it is
 * wrong by the offset. The person typing meant 2:30pm where THEY are, which is
 * the organisation's timezone.
 *
 * The method: guess that the wall clock is UTC, ask what that instant looks
 * like in the target zone, and correct by the difference.
 *
 * ⚠️ THE SECOND PASS EARNS ITS KEEP IN EXACTLY ONE CASE, AND IT IS NOT THE ONE
 * THIS COMMENT FIRST CLAIMED. The original text said two passes are "what makes
 * it right across a DST boundary". That is false, and it was proved false by
 * cutting the loop to one pass — all 23 tests still passed. A single pass is
 * already correct for every time that actually exists, on both sides of a
 * transition, because a real local time and its UTC instant only straddle the
 * boundary when the local time is one that never occurs.
 *
 * What the second pass actually settles is the spring-forward GAP. On
 * 29 March 2026 London jumps 01:00 → 02:00, so "01:30" is a time nobody can
 * have meant — but a date box will happily offer it. One pass files it an hour
 * EARLIER than typed (00:30 local), which would date an enquiry before it
 * arrived; two passes push it forward past the gap (02:30 local). Pinned by a
 * test in `lead-book.spec.ts` that fails if the loop is cut back.
 *
 * Returns `null` for anything unparseable, so the caller can refuse rather than
 * invent a date.
 */
export function wallClockToInstant(value: string, timezone: string): string | null {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const asUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? "0"),
  );
  if (Number.isNaN(asUtc)) return null;

  let instant = asUtc;
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      instant = asUtc - offsetOf(instant, timezone);
    }
  } catch {
    // An unknown zone falls back to treating the digits as UTC, which is the
    // only honest answer left — and never throws away what somebody typed.
    return new Date(asUtc).toISOString();
  }
  return new Date(instant).toISOString();
}

/** How far `timezone` is ahead of UTC at a given instant, in milliseconds. */
function offsetOf(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instant));

  const find = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const local = Date.UTC(
    find("year"),
    find("month") - 1,
    find("day"),
    // `hour12: false` renders midnight as 24 in some engines; normalise it.
    find("hour") % 24,
    find("minute"),
    find("second"),
  );
  return local - instant;
}

/**
 * The default the "when did this arrive" box opens on — now, in the
 * organisation's timezone, formatted the way the input expects.
 *
 * ⚠️ NOT `new Date().toISOString().slice(0, 16)`. That is UTC, so a customer in
 * Dubai opens the form on a time four hours behind their own clock and either
 * corrects it every time or, more likely, does not notice.
 */
export function nowForInput(timezone: string, now: Date = new Date()): string {
  const parts = (() => {
    try {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(now);
    } catch {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(now);
    }
  })();
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "00";
  const hour = String(Number(get("hour")) % 24).padStart(2, "0");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
}

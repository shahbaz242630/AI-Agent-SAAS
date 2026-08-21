/**
 * What day it is, and what part of the day — in the ORGANISATION's timezone.
 *
 * ⚠️ NEVER THE SERVER'S CLOCK, AND THIS IS NOT THEORETICAL. These render on a
 * server in `us-west2`, eight hours behind London. Using its local time would
 * greet a Manchester customer with "Good afternoon" at midnight and — far
 * worse — print YESTERDAY'S DATE at the top of a screen full of overdue
 * invoices, where the whole question is how late things are. A date that is
 * wrong by a day, beside money that is late by days, is the kind of error that
 * makes someone stop trusting the rest of the number on the page.
 *
 * It is the same rule the product already follows for display statuses and
 * ageing buckets — the org timezone decides when "today" is — extended to the
 * two places a screen says it out loud.
 */

/** How the header greets someone, by their own clock. */
export function greeting(timezone: string, now: Date = new Date()): string {
  const hour = hourIn(timezone, now);
  if (hour === null) return "Hello";
  if (hour < 12) return "Morning";
  if (hour < 18) return "Afternoon";
  return "Evening";
}

/**
 * Today, written out: "Saturday 9 August".
 *
 * No year, deliberately — it is the current date on a screen someone is
 * looking at now, and the year is noise until it is wrong, at which point the
 * problem is not the label.
 */
export function todayLabel(timezone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(now);
  } catch {
    // An unknown timezone must not take the header down. Falling back to UTC
    // is at most a few hours out; throwing loses the whole screen.
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(now);
  }
}

/**
 * The hour 0–23 in `timezone`, or `null` when the zone is not one Intl knows.
 *
 * ⚠️ `null` MEANS "DO NOT CLAIM A TIME OF DAY". A bad timezone string should
 * cost us the word "Morning", not turn the greeting into a guess that is
 * confidently wrong half the time.
 */
function hourIn(timezone: string, now: Date): number | null {
  try {
    const hour = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).format(now);
    const parsed = Number(hour);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 24 ? parsed % 24 : null;
  } catch {
    return null;
  }
}

/**
 * A past moment, in the ORGANISATION's timezone: "Tuesday 19 August at 2:30pm".
 *
 * ⚠️ LIVES HERE, NOT IN A PRODUCT, SINCE 2026-08-21. It was written for the
 * enquiry book and the do-not-contact screen needs the same sentence — and that
 * screen is platform, so importing it from `products/lead-follow-up` would be a
 * boundary violation and, worse, would make a platform screen depend on a
 * product a customer might not own. Same rule as the rest of this file: the
 * organisation's clock, never the server's.
 *
 * ⚠️ IT BITES HARDER THAN A DASHBOARD HEADING. Speed-to-lead (BRD §4.3) is
 * measured from the moment this prints, and our compute runs eight hours behind
 * London. An enquiry that arrived at 9am in Manchester shown as 1am is not a
 * cosmetic slip: it is the number every response target derives from.
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

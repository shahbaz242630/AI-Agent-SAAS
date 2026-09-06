import { WEEKDAY_LABELS, WEEKDAYS, type BusinessHours, type Weekday } from "@eva/types";

/**
 * The Opening hours screen's pure parts (slice 3.5a): reading the form, and
 * saying what is set. Kept out of the page so a node test can hold them.
 */

/** The range a day is given when it is first ticked open. */
export const DEFAULT_RANGE = { open: "08:00", close: "17:00" } as const;

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Seven days from the form: `open-<day>` ticked means open, with `from-<day>`
 * and `to-<day>` as the range; unticked means closed.
 *
 * ⚠️ EVERY DAY IS ALWAYS PRESENT IN THE RESULT. The api refuses a missing day
 * rather than reading it as closed, so this never produces one.
 */
export function readOpeningHoursForm(
  get: (name: string) => string | null,
): { hours: BusinessHours } | { error: string } {
  const hours = {} as BusinessHours;
  for (const day of WEEKDAYS) {
    if (!get(`open-${day}`)) {
      hours[day] = null;
      continue;
    }
    const open = (get(`from-${day}`) ?? "").trim();
    const close = (get(`to-${day}`) ?? "").trim();
    if (!CLOCK.test(open) || !CLOCK.test(close)) {
      return { error: `${WEEKDAY_LABELS[day]} needs an opening time and a closing time.` };
    }
    if (open >= close) {
      return { error: `${WEEKDAY_LABELS[day]} closes before it opens.` };
    }
    hours[day] = { open, close };
  }
  return { hours };
}

/**
 * The zones a customer can pick from — the runtime's own list, which is also
 * the list the api validates against. "UTC" is appended because some runtimes
 * list it as "Etc/UTC" only.
 */
export function timeZoneOptions(): string[] {
  const zones = new Set<string>(Intl.supportedValuesOf("timeZone"));
  zones.add("UTC");
  return [...zones].sort();
}

/** One line saying when the business is open, for the read-only view. */
export function describeOpeningHours(hours: BusinessHours | null): string {
  if (!hours) return "No opening hours set.";
  const parts = WEEKDAYS.map((day) => {
    const range = hours[day];
    return range
      ? `${WEEKDAY_LABELS[day]} ${range.open}–${range.close}`
      : `${WEEKDAY_LABELS[day]} closed`;
  });
  return `${parts.join(", ")}.`;
}

/** A day's short label for a form row. */
export function dayLabel(day: Weekday): string {
  return WEEKDAY_LABELS[day];
}

import type { BusinessHours, Weekday } from "@eva/types";
import { businessHoursSchema } from "@eva/validation";

/**
 * Whether an organisation is open right now, by its own clock (slice 3.5a).
 *
 * 🔑 THE ONE PLACE "CLOSED" IS DECIDED. The out-of-hours reply asks it at the
 * moment an enquiry arrives; the nudge (3.5c) will ask it before every send so
 * nothing goes out at night. Both products read `organisation_settings`'s
 * `timezone` and `business_hours`, so it lives in the platform, beside the
 * settings it reads, rather than in either product.
 *
 * ⚠️ `unset` IS A THIRD ANSWER, NOT A KIND OF `open`. An organisation that has
 * never set opening hours is not "always open" — it has not said. The
 * out-of-hours card cannot be switched on in that state, and a caller that
 * treated `unset` as `closed` would send the out-of-hours wording to everybody.
 *
 * ⚠️ THE COLUMN IS JSON AND IS NEVER TRUSTED RAW. `parseBusinessHours` runs the
 * same Zod schema the PATCH accepted it through; anything else — a shape from
 * before 3.5a, a hand edit, a null — is "no hours".
 */

export type OpeningState = "open" | "closed" | "unset";

/** The column as the shape 3.5a gave it, or `null` for "no hours". */
export function parseBusinessHours(value: unknown): BusinessHours | null {
  if (value === null || value === undefined) return null;
  const parsed = businessHoursSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Open, closed, or never said — at `at`, in `timezone`.
 *
 * A day with no range is closed all day. A range is `[open, close)`: a
 * business that closes at 17:00 is closed at 17:00 exactly, which is what
 * "we close at five" means. DST is the runtime's business — `Intl` resolves
 * the wall clock for the zone on that date, so the same code is right in
 * March and October without a table of offsets.
 */
export function openingState(
  hours: BusinessHours | null,
  timezone: string,
  at: Date,
): OpeningState {
  if (!hours) return "unset";
  const local = localClock(at, timezone);
  /**
   * ⚠️ A ZONE THE RUNTIME CANNOT RESOLVE IS "UNSET", NOT A THROW. The PATCH
   * refuses an unknown zone, so this is a row from before that rule or a
   * runtime with a smaller ICU — and this runs inside the webhook that files
   * an enquiry. Losing the enquiry to a RangeError would be far worse than
   * sending the instant wording.
   */
  if (!local) return "unset";
  const range = hours[local.weekday];
  if (!range) return "closed";
  return range.open <= local.time && local.time < range.close ? "open" : "closed";
}

const WEEKDAY_BY_SHORT: Record<string, Weekday> = {
  mon: "mon",
  tue: "tue",
  wed: "wed",
  thu: "thu",
  fri: "fri",
  sat: "sat",
  sun: "sun",
};

/** The weekday and the `"HH:MM"` wall clock in `timezone`, or null if the zone is unknown. */
function localClock(at: Date, timezone: string): { weekday: Weekday; time: string } | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      // `h23`, not `hour12: false`: some engines print midnight as "24" under the latter.
      hourCycle: "h23",
    }).formatToParts(at);
  } catch {
    return null;
  }
  const read = (type: Intl.DateTimeFormatPart["type"]) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekday = WEEKDAY_BY_SHORT[read("weekday").slice(0, 3).toLowerCase()];
  const hour = read("hour").padStart(2, "0");
  const minute = read("minute").padStart(2, "0");
  if (!weekday || hour.length !== 2 || minute.length !== 2) return null;
  return { weekday, time: `${hour}:${minute}` };
}

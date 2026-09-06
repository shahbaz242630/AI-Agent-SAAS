"use client";

import { useActionState } from "react";
import { WEEKDAYS, type BusinessHours } from "@eva/types";
import { PrimarySubmit } from "@/components/ui";
import { DEFAULT_RANGE, dayLabel, timeZoneOptions } from "@/lib/opening-hours";
import { saveOpeningHours, type OpeningHoursActionState } from "./actions";

/**
 * The organisation's clock (slice 3.5a): a timezone and seven rows of
 * opening hours.
 *
 * ⚠️ A `<select>` WITH A `defaultValue`, NEVER `value` ALONE. React 19 resets
 * the form when the action returns, and a select driven by `value` has no HTML
 * default to land on — it snapped to the first option and moved a reminder to
 * the wrong side of a due date on 2026-08-31. `defaultValue` gives the reset
 * something true.
 *
 * ⚠️ THE CHECKBOX MEANS "OPEN THAT DAY". Unticked is closed; the time boxes
 * stay on screen so a day can be re-opened without retyping, and the action
 * ignores them for a closed day.
 */

const FIELD =
  "rounded-[var(--radius-control)] border border-input-border bg-surface px-3 py-2 text-sm";

const ZONES = timeZoneOptions();

export function OpeningHoursForm({
  organisationId,
  timezone,
  hours,
}: {
  organisationId: string;
  timezone: string;
  hours: BusinessHours | null;
}) {
  const [state, action, pending] = useActionState<OpeningHoursActionState, FormData>(
    saveOpeningHours,
    {},
  );

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="organisationId" value={organisationId} />

      <label className="flex max-w-sm flex-col gap-1 text-sm">
        Timezone
        <select name="timezone" defaultValue={timezone} className={FIELD}>
          {ZONES.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
        {/*
         * ⚠️ SAID BEFORE IT IS CHANGED. The timezone decides what "today" is
         * for the invoice reminders as well as when Eva thinks you are closed;
         * a customer changing it for one product should know it moves both.
         */}
        <span className="text-[12.5px] text-muted-foreground">
          Every date and time Eva shows or acts on is in this zone — including when invoice
          reminders count a day as passed.
        </span>
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">Opening hours</legend>
        {WEEKDAYS.map((day) => {
          const range = hours?.[day] ?? null;
          return (
            <div key={day} className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex w-32 items-center gap-2">
                <input
                  type="checkbox"
                  name={`open-${day}`}
                  defaultChecked={range !== null}
                  className="size-4 accent-primary"
                />
                {dayLabel(day)}
              </label>
              <input
                type="time"
                name={`from-${day}`}
                defaultValue={range?.open ?? DEFAULT_RANGE.open}
                aria-label={`${dayLabel(day)} opens at`}
                className={FIELD}
              />
              <span className="text-muted-foreground">to</span>
              <input
                type="time"
                name={`to-${day}`}
                defaultValue={range?.close ?? DEFAULT_RANGE.close}
                aria-label={`${dayLabel(day)} closes at`}
                className={FIELD}
              />
            </div>
          );
        })}
      </fieldset>

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.success && (
        <p role="status" className="text-sm text-success">
          {state.success}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <PrimarySubmit disabled={pending} name="intent" value="save">
          {pending ? "Saving…" : "Save"}
        </PrimarySubmit>
        {hours && (
          /* A second submit of the SAME form, told apart by its value — the
             Products screen precedent. Removing the hours keeps the timezone. */
          <PrimarySubmit disabled={pending} name="intent" value="clear">
            Remove opening hours
          </PrimarySubmit>
        )}
      </div>
    </form>
  );
}

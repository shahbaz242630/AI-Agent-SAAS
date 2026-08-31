"use client";

import { useActionState, useState } from "react";
import type { ReminderStepDto } from "@eva/types";
import { stageLabel } from "@/products/invoice-follow-up/reminder-activity";
import {
  MAX_OFFSET_DAYS,
  describeDisabling,
  describeOffsetShort,
  isHandover,
  splitOffset,
  stepPurpose,
  type OffsetDirection,
} from "@/products/invoice-follow-up/reminder-sequence";
import { updateReminderStep, type ReminderStepActionState } from "./actions";

/**
 * One stage of the chasing ladder, drawn as a point on a timeline.
 *
 * ⚠️ THE SHAPE OF THE CONTENT IS A SEQUENCE IN TIME, AND TWO EARLIER VERSIONS
 * DREW IT AS A LIST. First six open forms stacked vertically — you scrolled to
 * the bottom to learn what was even on the screen. Then six equal rows, each
 * with an amber numbered disc and an Edit chip, which failed the squint test:
 * nothing led, and the timing — the answer this screen exists to give — was a
 * grey clause after a middle dot.
 *
 * The fix is structural, not decorative. Every reminder is measured from the
 * invoice's due date, so the due date is drawn ONCE as the anchor of a rail,
 * with the timings in the left column a reader scans. The phrase "the due
 * date", previously repeated on all six rows, now appears where it belongs: on
 * the row that IS it.
 *
 * ⚠️ NO ORDINAL DISCS. Numbering a sequence is worth ink only when the ordinal
 * carries information the reader needs; here the TIMING does, and six saturated
 * amber circles spent the palette's only bright colour on decoration. Amber now
 * marks one thing on this screen — the due date.
 *
 * ⚠️ ONE FORM PER STEP, NOT ONE "SAVE ALL". The API is a per-step PATCH and each
 * call recomputes every live invoice in the organisation inside a transaction —
 * so a single Save button would fire six of those in a row and look like a hang.
 * Saving a stage at a time makes the cost honest and matches what the API does.
 *
 * ⚠️ NO MINUS SIGNS ANYWHERE. Before/on/after plus a positive number; the sign
 * conversion is `toOffsetDays` in `products/invoice-follow-up/reminder-sequence`, tested there.
 */

const FIELD =
  "rounded-[var(--radius-control)] border border-input-border bg-surface px-3 py-2 text-sm";

export function StepControls({
  organisationId,
  step,
}: {
  organisationId: string;
  step: ReminderStepDto;
}) {
  const [state, action, pending] = useActionState<ReminderStepActionState, FormData>(
    updateReminderStep,
    {},
  );

  /**
   * ⚠️ OPENS ON A REFUSAL AND STAYS OPEN AFTER A SAVE. A row that collapsed on
   * error would hide the message explaining what went wrong, and one that
   * collapsed on success would hide the confirmation — both leaving somebody
   * staring at an unchanged-looking row wondering whether it took.
   */
  const [editing, setEditing] = useState(false);
  const open = editing || Boolean(state.error) || Boolean(state.success);

  // What was typed wins over what is stored, so a refusal keeps the user's work.
  const enabled = state.submitted?.enabled ?? step.enabled;
  const handover = isHandover(step.actionType);
  const anchor = step.offsetDays === 0;

  /**
   * ⚠️ THE TIMELINE IS A DESKTOP STRUCTURE AND COLLAPSES BELOW `sm`. Held at
   * every width, the fixed timing column plus a right-hand chip squeezed the
   * description to one word per line on a phone — caught by rendering both
   * widths side by side rather than assuming the grid would cope. Narrow, the
   * timing becomes a label above its stage and the rail disappears; there is no
   * room for a rail to mean anything at 390px.
   */
  return (
    <li className="flex flex-col gap-2 border-b border-hairline py-4 last:border-none sm:grid sm:grid-cols-[140px_1fr] sm:gap-0 sm:border-none sm:py-0">
      {/* The schedule, in the column the eye runs down. Tabular so the numbers
          line up and the ladder reads as a shape rather than six sentences. */}
      <p
        className={`text-[13px] leading-5 tabular-nums sm:py-4 sm:pr-5 sm:text-right ${
          anchor ? "font-semibold text-foreground" : "text-muted-foreground"
        } ${enabled ? "" : "line-through decoration-from-font"}`}
      >
        {describeOffsetShort(step.offsetDays)}
      </p>

      {/*
       * The rail is this border, repeated on every row, so the rows join into
       * one continuous line without any first/last trimming. The marker punches
       * a hole in it with a ring in the surface colour.
       */}
      <div className="sm:relative sm:border-l sm:border-hairline sm:py-4 sm:pl-6">
        <span
          aria-hidden
          className={`absolute top-[21px] -left-1 hidden size-2 rounded-full ring-4 ring-surface sm:block ${
            anchor
              ? "bg-accent"
              : enabled
                ? "bg-neutral-border"
                : "border border-input-border bg-surface"
          }`}
        />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="flex min-w-0 flex-col gap-1 sm:flex-1">
            <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
              {stageLabel(step.key)}
              {!enabled && (
                <span className="rounded-[var(--radius-pill)] border border-neutral-border bg-neutral-tint px-2 py-px text-[10.5px] font-bold tracking-[0.04em] text-faint uppercase">
                  Off
                </span>
              )}
              {handover && (
                <span className="rounded-[var(--radius-pill)] border border-neutral-border bg-neutral-tint px-2 py-px text-[10.5px] font-bold tracking-[0.04em] text-faint uppercase">
                  Not an email
                </span>
              )}
            </h3>
            <p className="max-w-[52ch] text-[13px] leading-[1.5] text-muted-foreground">
              {stepPurpose(step.key)}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setEditing((was) => !was)}
            aria-expanded={open}
            className="cursor-pointer self-start rounded-[var(--radius-pill)] border border-input-border bg-surface px-3.5 py-[7px] text-[12.5px] font-semibold text-label transition-colors hover:bg-chip-hover"
          >
            {open ? "Close" : "Edit"}
          </button>
        </div>

        {open && (
          /**
           * ⚠️ REMOUNTED ON EVERY ANSWER FROM THE SERVER, AND THAT IS THE FIX
           * FOR A REAL DEFECT. `state.at` changes each time the action returns,
           * so the form is rebuilt from whatever is true at that moment — the
           * refreshed step after a save, the echoed `submitted` after a
           * refusal. See `StepForm` for what went wrong without it.
           */
          <StepForm
            key={state.at ?? "idle"}
            organisationId={organisationId}
            step={step}
            state={state}
            action={action}
            pending={pending}
          />
        )}
      </div>
    </li>
  );
}

/**
 * The editor for one stage. Its own component so that the whole form can be
 * REMOUNTED when the server answers, and so a test can render it — the parent
 * only draws it after a click, which `renderToStaticMarkup` cannot perform.
 *
 * ⚠️ THIS EXISTS BECAUSE OF A DEFECT THAT MOVED A REMINDER TO THE WRONG SIDE OF
 * THE DUE DATE. Found by clicking Save twice on 2026-08-31, having changed
 * nothing in between: the first chase went from 7 days AFTER to 7 days BEFORE,
 * so Eva would have chased for money that was not due yet.
 *
 * React 19 resets a form once its action returns. `form.reset()` puts every
 * control back to its HTML default — and a `<select>` React drives through the
 * `value` prop alone has no HTML default, so the browser fell back to the FIRST
 * option, "before the due date". React's own state still said "after", so
 * nothing re-rendered and nothing corrected it: the box on screen disagreed
 * with the stored value, the confirmation directly under it, and the timing in
 * the left-hand column. The next Save then submitted what the box showed.
 *
 * The `Days` box and the checkbox never had this problem because
 * `defaultValue`/`defaultChecked` give the reset something correct to land on.
 * So the select is given one too, and the remount above re-establishes it from
 * the truth each time. Belt and braces, deliberately: either alone would fix
 * the case we found, and neither alone is obviously enough for the next one.
 */
export function StepForm({
  organisationId,
  step,
  state,
  action,
  pending,
}: {
  organisationId: string;
  step: ReminderStepDto;
  state: ReminderStepActionState;
  action: (formData: FormData) => void;
  pending: boolean;
}) {
  const stored = splitOffset(step.offsetDays);

  // What was typed wins over what is stored, so a refusal keeps the user's work.
  const days = state.submitted?.days ?? String(stored.days);
  const enabled = state.submitted?.enabled ?? step.enabled;
  const handover = isHandover(step.actionType);

  /**
   * ⚠️ STATE HERE ONLY GREYS THE DAY COUNT. "On the due date" makes the number
   * meaningless, so the box must dim the moment it is chosen — that needs a
   * re-render, which an uncontrolled select does not give us on its own.
   *
   * ⚠️ BUT THE SELECT IS NO LONGER CONTROLLED BY IT. It carries `defaultValue`
   * and reports changes; it does not take its displayed value from this state.
   * That is the whole point: state and DOM can no longer drift apart, because
   * the DOM is the one telling us what it holds.
   */
  const [direction, setDirection] = useState<OffsetDirection>(
    state.submitted?.direction ?? stored.direction,
  );

  return (
    <form action={action} className="mt-4 flex flex-col gap-3.5">
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="stepId" value={step.id} />

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex w-24 flex-col gap-1 text-[13px] font-semibold text-label">
          Days
          <input
            name="days"
            type="number"
            min={0}
            max={MAX_OFFSET_DAYS}
            step={1}
            inputMode="numeric"
            defaultValue={days}
            disabled={direction === "on"}
            className={`${FIELD} font-normal disabled:opacity-50`}
          />
        </label>

        <label className="flex flex-col gap-1 text-[13px] font-semibold text-label">
          When
          <select
            name="direction"
            defaultValue={state.submitted?.direction ?? stored.direction}
            onChange={(event) => setDirection(event.target.value as OffsetDirection)}
            className={`${FIELD} font-normal`}
          >
            <option value="before">before the due date</option>
            <option value="on">on the due date</option>
            <option value="after">after the due date</option>
          </select>
        </label>
      </div>

      <label className="flex items-start gap-2.5 text-[13px]">
        <input
          name="enabled"
          type="checkbox"
          defaultChecked={enabled}
          className="mt-0.5 size-4 accent-primary"
        />
        <span className="flex flex-col gap-0.5">
          <span className="font-semibold text-label">
            {handover ? "Hand this invoice back to me" : "Send this reminder"}
          </span>
          <span className="text-xs leading-[1.5] text-muted-foreground">
            {describeDisabling(step.actionType)}
          </span>
        </span>
      </label>

      {state.error && (
        <p role="alert" className="text-[13px] text-danger">
          {state.error}
        </p>
      )}
      {state.success && (
        <p role="status" className="text-[13px] text-success">
          {state.success}
        </p>
      )}

      <div>
        <button
          type="submit"
          disabled={pending}
          className="cursor-pointer rounded-[var(--radius-control)] bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-[var(--shadow-primary)] transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save this stage"}
        </button>
      </div>
    </form>
  );
}

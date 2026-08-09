"use client";

import { useActionState, useState } from "react";
import type { ReminderStepDto } from "@eva/types";
import { stageLabel } from "@/lib/reminder-activity";
import {
  MAX_OFFSET_DAYS,
  describeDisabling,
  isHandover,
  splitOffset,
  stepPurpose,
  type OffsetDirection,
} from "@/lib/reminder-sequence";
import { updateReminderStep, type ReminderStepActionState } from "./actions";

/**
 * One editable stage (Slice 1.8).
 *
 * ⚠️ ONE FORM PER STEP, NOT ONE "SAVE ALL". The API is a per-step PATCH and each
 * call recomputes every live invoice in the organisation inside a transaction —
 * so a single Save button would fire six of those in a row and look like a hang.
 * Saving a stage at a time makes the cost honest and matches what the API does.
 *
 * ⚠️ NO MINUS SIGNS ANYWHERE. Before/on/after plus a positive number; the sign
 * conversion is `toOffsetDays` in `lib/reminder-sequence`, tested there.
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

  const stored = splitOffset(step.offsetDays);

  /**
   * ⚠️ THE ONLY CONTROLLED FIELD, AND IT HAS TO BE. "On the due date" makes the
   * day count meaningless, so the number must grey out the moment it is chosen
   * — and an uncontrolled `<select>` does not re-render, so the box would stay
   * live and accept a number that is then silently dropped. Local state
   * survives a refusal too, because the component never unmounts.
   */
  const [direction, setDirection] = useState<OffsetDirection>(stored.direction);

  // What was typed wins over what is stored, so a refusal keeps the user's work.
  const days = state.submitted?.days ?? String(stored.days);
  const enabled = state.submitted?.enabled ?? step.enabled;
  const handover = isHandover(step.actionType);

  return (
    <li className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface px-5 py-4">
      <div className="flex flex-col gap-1">
        <span className="text-base font-semibold">{stageLabel(step.key)}</span>
        <p className="text-sm text-muted-foreground">{stepPurpose(step.key)}</p>
      </div>

      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="organisationId" value={organisationId} />
        <input type="hidden" name="stepId" value={step.id} />

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex w-24 flex-col gap-1 text-sm">
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
              className={`${FIELD} disabled:opacity-50`}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            When
            <select
              name="direction"
              value={direction}
              onChange={(event) => setDirection(event.target.value as OffsetDirection)}
              className={FIELD}
            >
              <option value="before">before the due date</option>
              <option value="on">on the due date</option>
              <option value="after">after the due date</option>
            </select>
          </label>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input name="enabled" type="checkbox" defaultChecked={enabled} className="mt-1 h-4 w-4" />
          <span className="flex flex-col gap-0.5">
            <span>{handover ? "Hand this invoice back to me" : "Send this reminder"}</span>
            <span className="text-xs text-muted-foreground">
              {describeDisabling(step.actionType)}
            </span>
          </span>
        </label>

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

        <div>
          <button
            type="submit"
            disabled={pending}
            className="rounded-[var(--radius-control)] bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-[var(--shadow-primary)] disabled:opacity-60"
          >
            {pending ? "Saving…" : "Save this stage"}
          </button>
        </div>
      </form>
    </li>
  );
}

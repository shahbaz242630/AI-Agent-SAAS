import type { ReminderStepDto } from "@eva/types";
import { stageLabel } from "@/lib/reminder-activity";
import { describeOffset, isHandover, stepPurpose } from "@/lib/reminder-sequence";

/**
 * The sequence, read-only (Slice 1.8).
 *
 * Shown to anyone without `reminders:write`, and — deliberately — it is also
 * the component the render test drives. It holds NO hooks and no client
 * directive precisely so it can be rendered to a string in a plain node test:
 * `apps/web` has no jsdom and no testing-library, and adding two dependencies
 * to a repo that spent a week clearing advisories is a worse trade than
 * shaping one component to be renderable.
 *
 * ⚠️ A ROLE THAT CANNOT EDIT STILL NEEDS TO SEE THE TIMING. "Ask an owner" with
 * nothing above it tells a credit controller nothing about when their customers
 * will be chased, which is information they need to do their job.
 */
export function ReminderStepList({ steps }: { steps: ReminderStepDto[] }) {
  return (
    <ol className="flex w-full flex-col gap-3">
      {steps.map((step) => (
        <li
          key={step.id}
          className="flex flex-col gap-1 rounded-[var(--radius-card)] bg-muted px-5 py-4"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-base font-semibold">{stageLabel(step.key)}</span>
            <span className="text-sm tabular-nums text-muted-foreground">
              {step.enabled ? describeOffset(step.offsetDays) : "Switched off"}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{stepPurpose(step.key)}</p>
          {isHandover(step.actionType) ? (
            <p className="text-xs font-medium text-muted-foreground">
              Handed to you — this one is never sent to your customer.
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

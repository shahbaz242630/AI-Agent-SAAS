import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReminderStepDto } from "@eva/types";
import { DEFAULT_REMINDER_STEPS } from "@eva/types";
import { ReminderStepList } from "@/app/app/settings/reminders/reminder-step-list";

/**
 * ⚠️ THE FIRST TEST IN THIS REPO THAT ACTUALLY RENDERS A COMPONENT (slice 1.8).
 *
 * Every web test before this one exercised a `lib` function, so the rendering
 * layer had no coverage at all — and that is exactly where three defects in
 * slice 1.6c and a fourth in 1.7 lived. `renderToStaticMarkup` needs no DOM and
 * no new dependency: it runs in the plain `node` environment and returns HTML
 * as a string, which is enough to prove a component renders and says what it
 * is supposed to say.
 *
 * It does NOT test interaction — no clicks, no form submission. That limit is
 * deliberate and should be stated rather than discovered: this catches "the
 * component throws" and "the copy is wrong", not "the button does nothing".
 */

function stepsFromDefaults(): ReminderStepDto[] {
  return DEFAULT_REMINDER_STEPS.map((step, index) => ({
    id: `step-${index}`,
    key: step.key,
    offsetDays: step.offsetDays,
    actionType: step.actionType,
    enabled: true,
  }));
}

describe("the reminder sequence, rendered", () => {
  it("renders every stage without throwing", () => {
    const html = renderToStaticMarkup(<ReminderStepList steps={stepsFromDefaults()} />);
    expect(html).toContain("<ol");
    // Six stages, six list items.
    expect(html.match(/<li/g)).toHaveLength(DEFAULT_REMINDER_STEPS.length);
  });

  it("shows the first reminder as three days BEFORE the due date", () => {
    const html = renderToStaticMarkup(<ReminderStepList steps={stepsFromDefaults()} />);
    expect(html).toContain("3 days before the due date");
  });

  it("never leaks a raw step key or a minus sign to the screen", () => {
    const html = renderToStaticMarkup(<ReminderStepList steps={stepsFromDefaults()} />);
    for (const step of DEFAULT_REMINDER_STEPS) {
      expect(html).not.toContain(step.key);
    }
    // The sign lives in the wording ("before"), never in the number shown.
    expect(html).not.toMatch(/>-\d/);
  });

  it("marks the handover as never going to the customer", () => {
    const html = renderToStaticMarkup(<ReminderStepList steps={stepsFromDefaults()} />);
    expect(html).toContain("never sent to your customer");
  });

  /**
   * A switched-off stage must not silently read as if it still fires — the
   * whole reason a customer visits this screen is to know what Eva will do.
   */
  it("says a disabled stage is switched off instead of showing its timing", () => {
    const steps = stepsFromDefaults().map((step) =>
      step.key === "overdue_14" ? { ...step, enabled: false } : step,
    );
    const html = renderToStaticMarkup(<ReminderStepList steps={steps} />);
    expect(html).toContain("Switched off");
    expect(html).not.toContain("14 days after the due date");
  });
});

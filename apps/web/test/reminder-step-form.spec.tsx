import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReminderStepDto } from "@eva/types";
import { StepForm } from "@/app/app/settings/reminders/step-controls";
import type { ReminderStepActionState } from "@/app/app/settings/reminders/actions";

/**
 * ⚠️ THIS SPEC EXISTS BECAUSE OF A DEFECT THAT CHANGED WHEN CUSTOMERS GET
 * CHASED. Walked on 2026-08-31: open a stage, press Save, then press Save again
 * having touched nothing. The first chase moved from 7 days AFTER the due date
 * to 7 days BEFORE it — Eva chasing for money that was not owed yet, and the
 * "3 days before" nudge landing after the first chase.
 *
 * React 19 resets a form once its action returns, and `form.reset()` restores
 * every control to its HTML default. A `<select>` driven only through React's
 * `value` prop HAS no HTML default, so the browser fell back to the first
 * option — "before the due date" — while React's state still said "after". No
 * re-render followed, so nothing corrected it: the box disagreed with the
 * stored value, with the confirmation directly beneath it, and with the timing
 * in the left-hand column. The next Save submitted what the box showed.
 *
 * ⚠️ THE OBVIOUS TEST FOR THIS DOES NOT WORK, AND THAT IS WORTH RECORDING SO
 * NOBODY WRITES IT AGAIN. Asserting the rendered markup marks the right
 * `<option selected>` passes on BOTH the broken and the fixed code — React's
 * server renderer emits `selected` either way, and the divergence only appears
 * on the client after hydration. It was written, it passed against the bug, and
 * it was thrown away. This suite runs in `node` with no DOM, so the reset
 * itself cannot be performed here at all.
 *
 * So the guard is a source scan, in the manner of `settings-consistency`: the
 * two things that make the reset survivable must stay in the file, and the
 * scanner is run against the ORIGINAL BROKEN CODE below to prove it can fail.
 * The behaviour itself was proved by clicking, on 2026-08-31, and re-proving it
 * needs a browser rather than this file.
 */

const SOURCE = fileURLToPath(
  new URL("../src/app/app/settings/reminders/step-controls.tsx", import.meta.url),
);

/** Comments explain this fix by quoting the broken code — never scan them. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The `<select name="direction">` element, comments removed. */
function directionSelect(source: string): string {
  const body = stripComments(source);
  const at = body.indexOf('name="direction"');
  if (at === -1) return "";
  return body.slice(at, body.indexOf(">", at));
}

/**
 * The two things that make React's reset survivable. Each is checked against
 * the broken original at the bottom of this file.
 */
function weaknesses(source: string): string[] {
  const body = stripComments(source);
  const select = directionSelect(source);
  const found: string[] = [];
  if (select === "") {
    found.push("the direction select has gone missing entirely");
  } else if (!/\bdefaultValue=/.test(select)) {
    found.push("the direction select has no HTML default for a form reset to land on");
  }
  if (/<select\b[^>]*\bvalue=\{/.test(body.replace(/\bdefaultValue=\{/g, "defaultOK={"))) {
    found.push("the direction select is controlled again, so its DOM can drift from React");
  }
  if (!/key=\{state\.at/.test(body)) {
    found.push("the form is not rebuilt when the server answers");
  }
  return found;
}

/** The code exactly as it stood before the fix — the scanner must reject it. */
const BROKEN_ORIGINAL = `
        {open && (
          <form action={action} className="mt-4 flex flex-col gap-3.5">
            <select
              name="direction"
              value={direction}
              onChange={(event) => setDirection(event.target.value as OffsetDirection)}
            >
              <option value="before">before the due date</option>
            </select>
          </form>
        )}
`;

function step(overrides: Partial<ReminderStepDto> = {}): ReminderStepDto {
  return {
    id: "step-1",
    key: "overdue_7",
    offsetDays: 7,
    actionType: "email",
    enabled: true,
    ...overrides,
  };
}

function render(stepValue: ReminderStepDto, state: ReminderStepActionState = {}): string {
  return renderToStaticMarkup(
    <StepForm
      organisationId="org-1"
      step={stepValue}
      state={state}
      action={() => {}}
      pending={false}
    />,
  );
}

describe("the reminder stage editor, and the reset it has to survive", () => {
  it("keeps an HTML default on the direction, and rebuilds when the server answers", () => {
    expect(weaknesses(readFileSync(SOURCE, "utf8"))).toEqual([]);
  });

  /**
   * Habit 3: a check that cannot go red is not evidence. This is the code that
   * shipped the defect, and every probe above must name what is wrong with it.
   */
  it("rejects the code that caused the defect", () => {
    const found = weaknesses(BROKEN_ORIGINAL);
    expect(found).toContain("the direction select has no HTML default for a form reset to land on");
    expect(found).toContain(
      "the direction select is controlled again, so its DOM can drift from React",
    );
    expect(found).toContain("the form is not rebuilt when the server answers");
  });

  it("reads a file that actually contains the control", () => {
    // Guards against a rename quietly turning every probe above into a no-op.
    expect(directionSelect(readFileSync(SOURCE, "utf8"))).not.toBe("");
  });
});

describe("the reminder stage editor, rendered", () => {
  it("shows the stored day count", () => {
    expect(render(step({ offsetDays: 14 }))).toContain('value="14"');
  });

  /**
   * A refusal keeps the customer's work: they typed 45, the API said no, and
   * the box must still say 45 rather than snapping back to what is stored.
   */
  it("keeps what was submitted when the save was refused", () => {
    const refused = render(step({ offsetDays: 14 }), {
      stepId: "step-1",
      at: 1,
      error: "That is too far out.",
      submitted: { direction: "before", days: "45", enabled: true },
    });
    expect(refused).toContain('value="45"');
    expect(refused).toContain("That is too far out.");
  });

  /**
   * ⚠️ THE ATTRIBUTE, NOT THE WORD. `disabled:opacity-50` is in the class list
   * of every render, so a bare `toContain("disabled")` passes both ways — it
   * did, on the first attempt at this test.
   */
  it("greys the day count out only when the stage sits on the due date", () => {
    const daysInput = (html: string) => html.match(/<input[^>]*name="days"[^>]*>/)?.[0] ?? "";
    expect(daysInput(render(step({ offsetDays: 0 })))).toMatch(/\sdisabled=""/);
    expect(daysInput(render(step({ offsetDays: 7 })))).not.toMatch(/\sdisabled=""/);
  });
});

import { describe, expect, it } from "vitest";
import { humanRefusal, type WriteAction } from "@/lib/permissions";

/**
 * What a refused write says to the person who was refused.
 *
 * ⚠️ THIS FILE EXISTS BECAUSE ONE OF THESE SENTENCES HAS BEEN PRINTING TWICE
 * ON A LIVE SCREEN. `humanRefusal` used to append " Ask an owner or
 * administrator." to every message, and `correct-suppression` already ended
 * with that sentence in its own text — so the do-not-contact screen said it
 * back to back, from the day the correction path shipped until 2026-09-01.
 *
 * Nothing caught it. Copy has no assertions unless somebody writes them, which
 * is this project's most repeated lesson (seven false sentences in one slice,
 * then two more the session after).
 *
 * ⚠️ AND THE APPENDING HAD TO GO ANYWAY. `edit-reply-template` is OWNER ONLY
 * (founder ruling 2026-09-01, "owner only for templates"), so a blanket "ask an
 * owner or administrator" now points a refused administrator at a colleague who
 * will be refused in exactly the same way.
 */

/**
 * Every action, listed so the exhaustiveness check below is real. A `Record`
 * keyed by `WriteAction` will not compile if one is missing, which is the same
 * guarantee `REFUSED` itself carries.
 */
const ACTIONS: Record<WriteAction, true> = {
  "create-invoice": true,
  "edit-invoice": true,
  "edit-contact": true,
  "record-payment": true,
  "change-invoice": true,
  "add-row": true,
  "upload-import": true,
  "confirm-import": true,
  "cancel-import": true,
  "change-settings": true,
  "change-reminder-timing": true,
  "stop-contacting": true,
  "correct-suppression": true,
  "forwarding-setup": true,
  "forwarding-request": true,
  "edit-reply-template": true,
};

const EVERY_ACTION = Object.keys(ACTIONS) as WriteAction[];

describe("every refusal tells somebody who to ask, exactly once", () => {
  it.each(EVERY_ACTION)("%s names who to ask", (action) => {
    const message = humanRefusal(403, action)!;
    expect(message, `${action} does not say who to ask`).toMatch(/Ask an owner/);
  });

  /**
   * ⚠️ THE DEFECT THIS FILE WAS WRITTEN FOR. Two "Ask an owner" sentences in
   * one message is what shipped; counting them is the only way to see it,
   * because each half reads perfectly well on its own.
   */
  it.each(EVERY_ACTION)("%s says it only once", (action) => {
    const message = humanRefusal(403, action)!;
    const asks = message.match(/Ask an owner/g) ?? [];
    expect(asks, `${action} repeats itself: "${message}"`).toHaveLength(1);
  });

  it.each(EVERY_ACTION)("%s is a finished sentence, not a fragment", (action) => {
    const message = humanRefusal(403, action)!;
    expect(message.trim()).toBe(message);
    expect(message.endsWith("."), `${action} does not end in a full stop`).toBe(true);
    expect(message).not.toContain("  ");
  });

  /**
   * ⚠️ OWNER ONLY MEANS THE COPY MUST NOT OFFER AN ADMINISTRATOR. Founder
   * ruling 2026-09-01. An administrator is refused this write like everybody
   * but the owner, so naming one costs the refused person a second
   * conversation to discover they were sent to the wrong colleague.
   */
  it("does not offer an administrator for the owner-only write", () => {
    const message = humanRefusal(403, "edit-reply-template")!;
    expect(message).not.toContain("administrator");
    expect(message).toContain("Ask an owner.");
  });

  /** Everything else still names both, which is true for those writes. */
  it("still offers an administrator everywhere that is accurate", () => {
    for (const action of EVERY_ACTION.filter((a) => a !== "edit-reply-template")) {
      expect(humanRefusal(403, action), action).toContain("owner or administrator");
    }
  });

  /**
   * The API's own message is kept for every other status — it is written for
   * people and carries detail this layer does not have.
   */
  it.each([400, 401, 402, 404, 409, 500])("returns null for %i, not a refusal", (status) => {
    expect(humanRefusal(status, "edit-reply-template")).toBeNull();
  });

  /**
   * ⚠️ THE CASE THAT MUST FAIL (habit 3). Without it, every assertion above
   * passes just as happily against a helper that returns one fixed string, and
   * this file would be decoration.
   */
  it("would catch a doubled sentence and a missing one", () => {
    const doubled = "Your role can't do it. Ask an owner or administrator. Ask an owner.";
    expect((doubled.match(/Ask an owner/g) ?? []).length).toBe(2);
    const silent = "Your role can't do it.";
    expect(silent).not.toMatch(/Ask an owner/);
  });

  /** And that the sentences are actually distinct — one shared line for
   *  sixteen different refusals would pass everything above. */
  it("says something different for each action", () => {
    const messages = EVERY_ACTION.map((action) => humanRefusal(403, action));
    expect(new Set(messages).size).toBe(EVERY_ACTION.length);
  });
});

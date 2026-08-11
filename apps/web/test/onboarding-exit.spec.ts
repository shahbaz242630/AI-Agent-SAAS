import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { attentionItems } from "@/lib/dashboard";

/**
 * ⚠️ SETUP MUST HAVE A WAY OUT, AND UNTIL 2026-08-11 IT DID NOT.
 *
 * Step two offered "Connect mailbox" or nothing. No skip, no link onward, and
 * the sidebar is hidden during setup — so the only other control on the screen
 * was "Sign out". The founder hit it on the first real walk-through: the
 * production mailbox connection fails on an Entra redirect URI, and there was
 * no way to reach the product at all.
 *
 * The customer it traps for real is the one whose IT administrator has to
 * approve the connection — a wait of days, which this very page has a helper
 * for. They could not add an invoice, import a spreadsheet, or look at the
 * thing they had just signed up for. They would assume it was broken.
 *
 * Read from source rather than rendered: `mailbox-step.tsx` imports the
 * `connectMailbox` server action, and pulling that into a unit test drags the
 * server Supabase client with it.
 */

const MAILBOX_STEP = fileURLToPath(
  new URL("../src/app/app/onboarding/mailbox-step.tsx", import.meta.url),
);

const source = readFileSync(MAILBOX_STEP, "utf8")
  // The comments explain the defect by name, so they are not evidence of the fix.
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");

describe("onboarding step two", () => {
  it("offers a way into the product without a mailbox", () => {
    expect(source).toMatch(/href="\/app"/);
  });

  /**
   * ⚠️ FORWARD, NOT BACK. The step above cannot be undone — the organisation
   * exists by then and no endpoint renames one — so a "Back" here would offer
   * something impossible. This link goes on into the product.
   */
  it("does not present the exit as a way backwards", () => {
    const linkText = /href="\/app"[\s\S]{0,200}?>([^<]+)</.exec(source)?.[1]?.trim() ?? "";

    expect(linkText.length).toBeGreaterThan(0);
    expect(linkText).not.toMatch(/back/i);
  });

  it("still leads with connecting the mailbox — skipping is the quieter option", () => {
    expect(source).toMatch(/Connect mailbox/);
    // The primary action is a button; the exit is a plain link.
    expect(source).toMatch(/PrimaryButton/);
  });
});

/**
 * ⚠️ THE PROMISE THE EXIT RELIES ON. Skipping is only honest because Home says
 * what skipping cost: a customer who lands there with no mailbox is told that
 * nothing will send until one is connected, and given the way back. If this
 * card ever stops appearing, the link above becomes a quiet dead end instead of
 * a choice.
 */
describe("what Home tells someone who skipped", () => {
  const noActivity = { sentLast7Days: 0, waiting: 0, failedLast7Days: 0 };

  it("warns that nothing will send, and offers the way back", () => {
    const items = attentionItems({
      mailboxConnected: false,
      counts: noActivity,
      waitingReason: null,
    });
    const card = items.find((item) => item.kind === "no_mailbox");

    expect(card).toBeDefined();
    expect(card?.headline).toMatch(/no mailbox/i);
    expect(card?.detail).toMatch(/nothing will go out/i);
    // Nothing is lost by skipping — anything waiting sends once a mailbox is on.
    expect(card?.detail).toMatch(/nothing is lost/i);
    expect(card?.href).toBe("/app/settings/mailbox");
  });

  /** `null` means "we could not tell" — no permission, or no Invoice Chasing —
   *  and must stay quiet rather than nag about a mailbox that may be fine. */
  it("says nothing when it cannot tell", () => {
    const items = attentionItems({
      mailboxConnected: null,
      counts: noActivity,
      waitingReason: null,
    });

    expect(items.find((item) => item.kind === "no_mailbox")).toBeUndefined();
  });
});

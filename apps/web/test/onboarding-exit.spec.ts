import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { attentionItems } from "@/products/invoice-follow-up/dashboard";

/**
 * ⚠️ SETUP MUST HAVE A WAY OUT, AND UNTIL 2026-08-11 IT DID NOT.
 *
 * Step two offered "Connect mailbox" or nothing. No skip, no link onward, and
 * the sidebar is hidden during setup — so the only other control on the screen
 * was "Sign out". The founder hit it on the first real walk-through: the
 * production mailbox connection fails on an Entra redirect URI, and there was
 * no way to reach the product at all.
 *
 * ⚠️ THAT STEP IS GONE AS OF 2026-09-01, AND THE TESTS THAT READ IT WENT WITH
 * IT. A mailbox belongs to one product (ruling 36) and onboarding runs before a
 * product is chosen, so the founder ruled the step out entirely — you connect a
 * mailbox inside the product that will use it. The old trap is now structurally
 * impossible: there is no mailbox step to be stuck on.
 *
 * ⚠️ BUT THE PROMISE IT RELIED ON MATTERS MORE NOW, NOT LESS. Before, most
 * people left setup WITH a mailbox and skipping was the exception. Now EVERY
 * new customer reaches the product without one, so "Home says what is missing"
 * is no longer a safety net for a minority — it is the only thing standing
 * between a new customer and a product that silently does nothing. Both halves
 * are asserted below: what onboarding says on the way out, and what Home says
 * when they arrive.
 */

const ONBOARDING_PAGE = fileURLToPath(
  new URL("../src/app/app/onboarding/page.tsx", import.meta.url),
);

const onboardingSource = readFileSync(ONBOARDING_PAGE, "utf8")
  // The comments explain the change by name, so they are not evidence of it.
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");

describe("the end of setup", () => {
  it("no longer asks for a mailbox", () => {
    expect(onboardingSource).not.toMatch(/MailboxStep/);
    expect(onboardingSource).not.toMatch(/mailboxes\/connect/);
  });

  /**
   * ⚠️ THE SENTENCE THAT REPLACES THE STEP. Ending on "you're set up" with
   * nothing else would be false in the one way that costs a customer: Eva
   * cannot send anything until a product has a mailbox, and somebody who reads
   * "done" and leaves would find nothing happening with no idea why.
   */
  it("names the mailbox as the next thing, rather than claiming setup is finished", () => {
    expect(onboardingSource).toMatch(/mailbox/i);
    expect(onboardingSource).toMatch(/href="\/app"/);
  });

  /** Forward, not back: the organisation exists by now and nothing renames one. */
  it("does not present the way out as a way backwards", () => {
    const linkText =
      /href="\/app"[\s\S]{0,200}?>([^<]+)</.exec(onboardingSource)?.[1]?.trim() ?? "";
    expect(linkText.length).toBeGreaterThan(0);
    expect(linkText).not.toMatch(/back/i);
  });
});

describe("what Home tells someone who skipped", () => {
  const noActivity = { sentLast7Days: 0, waiting: 0, failedLast7Days: 0, scheduled: 0 };

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
    // Invoice Chasing's own mailbox screen since slice 3.1c-0 — there is no
    // organisation-wide one left to send anybody to.
    expect(card?.href).toBe("/app/invoice-chasing/mailbox");
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

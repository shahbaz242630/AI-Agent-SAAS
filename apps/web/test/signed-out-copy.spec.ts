import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The words on /signed-out, which is the one screen a customer reads at the
 * exact moment the product has interrupted them.
 *
 * ⚠️ COPY HAS NO ASSERTIONS UNLESS SOMEBODY WRITES THEM. Shipping Gmail made
 * seven pieces of customer-facing copy untrue in a single slice (#108, #109) and
 * not one thing failed, because a sentence that has quietly become false is not
 * a broken feature — it is just a sentence. This file is one of those
 * assertions.
 *
 * ⚠️ COMMENTS ARE STRIPPED BEFORE THE CHECK, AND THAT IS NOT AN OPTIMISATION.
 * The page explains its own ruling by NAMING the claim it refuses to make, so
 * scanning the raw source would fail on the very comment that exists to prevent
 * the mistake — the same trap `auth-frame.spec.tsx` and `design-tokens.spec.ts`
 * both record. Forcing the next person to delete the explanation to get a green
 * suite is how the knowledge gets lost.
 */
const source = readFileSync(
  fileURLToPath(new URL("../src/app/(auth)/signed-out/page.tsx", import.meta.url)),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the signed-out screen", () => {
  /**
   * ⚠️ THE SESSION WENT IDLE. THE ACCOUNT DID NOT, AND WE CANNOT KNOW THAT IT
   * DID. This screen used to say "nobody had used this account for two days".
   * Both halves of the idle rule are about one session, not one person: the
   * proxy's has always been per-browser, and the API's became per-session with
   * ruling 37. So a customer who uses Eva daily on their phone and rarely on the
   * laptop was told nobody had touched their account — a false statement, made
   * on the subject of security, on the screen whose entire job is being
   * trustworthy. Say what we actually know.
   */
  it("never claims the whole account went unused", () => {
    expect(source).not.toMatch(/used this account/i);
    expect(source).not.toMatch(/nobody had used/i);
  });

  /**
   * The other half of the same duty: somebody who chose to sign out knows why
   * they are here, and somebody we signed out does not. Removing the reason
   * turns an explained interruption back into an unexplained one.
   */
  it("still tells an idled customer why it happened", () => {
    expect(source).toMatch(/two days/i);
  });
});

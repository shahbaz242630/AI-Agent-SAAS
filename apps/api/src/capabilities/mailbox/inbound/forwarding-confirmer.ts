import { isConfirmationUrl } from "./gmail-forwarding-confirmation.js";

/**
 * Answering Google's confirmation link on the customer's behalf (Slice 3.1b).
 *
 * ⚠️ THIS IS THE ONE PLACE WHERE A STRING FROM A STRANGER'S EMAIL BECOMES AN
 * OUTBOUND REQUEST FROM INSIDE OUR NETWORK. Everything defensive about it lives
 * here or in `isConfirmationUrl`, and neither may be relaxed without the other
 * being read first.
 *
 * ⚠️ FETCHING THE LINK DOES NOT CONFIRM ANYTHING, AND THE FIRST VERSION OF THIS
 * FILE BELIEVED IT DID. Measured against Google on 2026-08-22: a GET of the
 * `vf-` link answers **200 OK** with an interstitial page reading "Please
 * confirm mail forwarding of a@b to c@d" and a single button. The forwarding is
 * still unverified at that point — Gmail's own settings screen went on saying
 * "Verify" — so a confirmer that treated 200 as success would have reported a
 * working front door for every customer while no mail was ever forwarded.
 *
 * That page is a real HTML form:
 *
 *     <form action="" method="post"><input type="submit" value="Confirm"></form>
 *
 * `action=""` means the same URL, there is no CSRF token and no other field, so
 * confirming is a bare POST to the URL the GET finally landed on. The GET still
 * matters: it is what follows Google's redirect from `mail-settings.google.com`
 * to `mail.google.com`, and posting to the un-redirected address is not the
 * same request.
 */

/** Why a confirmation attempt did not work, in words a screen can show. */
export class ForwardingConfirmationError extends Error {}

/**
 * The seam. An interface rather than a bare `fetch` so the service can be
 * tested without the network — and so that if Google changes this dance again,
 * it is one class rather than a rewrite.
 */
export const FORWARDING_CONFIRMER = Symbol("FORWARDING_CONFIRMER");

export interface ForwardingConfirmer {
  /** Resolves when Google accepted it; throws `ForwardingConfirmationError`. */
  confirm(url: string): Promise<void>;
}

/**
 * ⚠️ REDIRECTS ARE FOLLOWED BY HAND, NOT BY `fetch`. `redirect: "follow"` would
 * check the first URL and then obey whatever `Location` came back — which is an
 * open redirect away from every guard above, and the classic way an SSRF check
 * gets walked straight past. Each hop is re-checked against the same rule.
 *
 * Google really does redirect here (`mail-settings` → `mail`), so this path is
 * exercised on every single confirmation rather than being a defensive branch
 * nobody has run.
 */
const MAX_HOPS = 3;

/** Google is not slow. A hung connection must not hold a request open. */
const TIMEOUT_MS = 10_000;

/**
 * ⚠️ THE SUCCESS TEST IS THE ABSENCE OF THE FORM, NOT THE PRESENCE OF A WORD.
 * Matching Google's "Confirm" button text would tie us to English on a page
 * Google localises; a `method="post"` form is the same shape in every language.
 * So: before we post there must be one, and afterwards there must not.
 */
const POST_FORM = /<form[^>]*\bmethod\s*=\s*["']?post\b/i;

/** `<form action="…">` — empty or absent means "post back to this same URL". */
const FORM_ACTION = /<form[^>]*\baction\s*=\s*["']([^"']*)["']/i;

export class HttpForwardingConfirmer implements ForwardingConfirmer {
  async confirm(url: string): Promise<void> {
    const page = await this.request(url, "GET");

    if (!POST_FORM.test(page.body)) {
      /**
       * No form to submit. The likeliest cause by far is a link that has
       * already been used — Gmail's confirmation is one-shot — and the next
       * likeliest is Google having changed this page again. Either way we have
       * NOT confirmed anything, and saying so is the whole point: the caller
       * leaves the request open and the screen offers the customer the link.
       */
      throw new ForwardingConfirmationError(
        "Google did not ask us to confirm anything; the link may already have been used",
      );
    }

    const action = page.body.match(FORM_ACTION)?.[1]?.trim() ?? "";
    // `action=""` is the common case and resolves back to the page's own URL.
    const target = new URL(action, page.url).toString();

    const result = await this.request(target, "POST");

    if (POST_FORM.test(result.body)) {
      throw new ForwardingConfirmationError(
        "Google is still asking for confirmation, so nothing was confirmed",
      );
    }
  }

  /** One request, following Google's own redirects and re-checking every hop. */
  private async request(
    url: string,
    method: "GET" | "POST",
  ): Promise<{ url: string; body: string }> {
    let target = url;

    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      /**
       * ⚠️ CHECKED EVERY TIME ROUND, INCLUDING THE FIRST. The caller has
       * already validated the URL it stored, but this loop's later passes carry
       * a `Location` header that nothing has vetted, and a guard that only runs
       * on the way in is not a guard.
       */
      if (!isConfirmationUrl(target)) {
        throw new ForwardingConfirmationError(
          "That confirmation link is not one of Google's, so it was not followed",
        );
      }

      let response: Response;
      try {
        response = await globalThis.fetch(target, {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: {
            Accept: "text/html,application/xhtml+xml",
            // Pin the language so the page we parse is the page we tested.
            "Accept-Language": "en",
          },
        });
      } catch (error) {
        /**
         * ⚠️ THE SHAPE OF THE FAULT, NEVER THE PROVIDER'S TEXT. This string is
         * stored on the request row and shown to the customer, and an error
         * body from Google can quote the URL — which carries the confirmation
         * token. Putting that on a screen hands the token to anyone who can see
         * the screen.
         */
        throw new ForwardingConfirmationError(
          error instanceof Error && error.name === "TimeoutError"
            ? "Google did not answer in time"
            : "Google could not be reached",
        );
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new ForwardingConfirmationError("Google redirected us to nowhere");
        }
        // Relative `Location` headers are legal and common; resolved against
        // the hop we are on, then re-checked at the top of the loop.
        target = new URL(location, target).toString();
        continue;
      }

      if (!response.ok) {
        throw new ForwardingConfirmationError(
          `Google refused the confirmation (HTTP ${response.status})`,
        );
      }

      return { url: target, body: await response.text() };
    }

    throw new ForwardingConfirmationError("Google redirected us too many times");
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { ForwardingConfirmationError, HttpForwardingConfirmer } from "./forwarding-confirmer.js";

/**
 * Answering Google's confirmation link (Slice 3.1b, step 4).
 *
 * ⚠️ EVERY SHAPE HERE WAS MEASURED AGAINST GOOGLE ON 2026-08-22, NOT IMAGINED.
 * A real forwarding request was made from a real Gmail account to the test
 * organisation's live intake address, and the pages below are what Google
 * actually served — including the one that cost this file its first version.
 *
 * ⚠️ THE DEFECT THESE TESTS EXIST TO PREVENT. The first implementation fetched
 * the `vf-` link and treated `200 OK` as confirmation. Google answers a GET
 * with **200 and a page asking you to confirm** — Gmail's settings went on
 * saying "Verify" throughout. Shipped, every Gmail customer would have read
 * "Forwarding confirmed" on our screen while not one enquiry was forwarded, and
 * no test written from an invented fixture would have disagreed.
 */

/** What Google really serves on a GET of the `vf-` link. */
const CONFIRM_PAGE =
  "<html><body><p>Please confirm mail forwarding of a@gmail.com to b@example.com.</p>" +
  '<form action="" method="post"><input type="submit" value="Confirm"></form></body></html>';

/** What it serves once the POST has been accepted: no form left to submit. */
const DONE_PAGE = "<html><body><p>Confirmation successful.</p></body></html>";

const START = "https://mail-settings.google.com/mail/vf-%5Bexample-token%5D-tail";
const LANDED = "https://mail.google.com/mail/vf-%5Bexample-token%5D-tail";

interface Call {
  url: string;
  method: string;
}

/** Records every request, and answers from a per-URL script. */
function stubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), method: (init?.method ?? "GET").toUpperCase() });
      return handler(String(input), init ?? {});
    }),
  );
  return calls;
}

function html(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html", ...headers } });
}

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { location: to } });
}

/** Google's real behaviour: redirect the GET, then serve the form. */
function googleAsItBehaves(): Call[] {
  return stubFetch((url, init) => {
    if (url === START) return redirect(LANDED);
    if (url === LANDED && (init.method ?? "GET") === "GET") return html(200, CONFIRM_PAGE);
    if (url === LANDED && init.method === "POST") return html(200, DONE_PAGE);
    return html(404, "no");
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Confirming Gmail forwarding: the happy path Google actually serves", () => {
  it("follows the redirect, posts the form, and reports success", async () => {
    const calls = googleAsItBehaves();
    await expect(new HttpForwardingConfirmer().confirm(START)).resolves.toBeUndefined();
    expect(calls).toEqual([
      { url: START, method: "GET" },
      { url: LANDED, method: "GET" },
      { url: LANDED, method: "POST" },
    ]);
  });

  /**
   * ⚠️ THE POST GOES TO WHERE THE GET LANDED, NOT TO THE LINK IN THE EMAIL.
   * Google redirects `mail-settings.google.com` to `mail.google.com` on every
   * confirmation, and the form's `action=""` means "this URL" — the one after
   * the redirect. Posting to the address out of the email is a different
   * request, and this assertion is the only thing that says so.
   */
  it("posts to the redirected URL, not the one from the email", async () => {
    const calls = googleAsItBehaves();
    await new HttpForwardingConfirmer().confirm(START);
    expect(calls.find((call) => call.method === "POST")?.url).toBe(LANDED);
  });

  /**
   * ⚠️ WRITTEN AS "resolves a relative action" AND CORRECTED BY ITS OWN RED
   * RUN. Google's form carries `action=""`, which resolves back to the same
   * `vf-` URL — so a relative action pointing anywhere else is a shape Google
   * does not produce, and the guard refuses it. The first version of this test
   * asserted that we would follow such an action, which was imagination
   * dressed as coverage: it described a page nobody has ever been served.
   *
   * Refusing is the right answer. `isConfirmationUrl` allows exactly the
   * confirmation endpoint, so a form action that leads off it is either Google
   * changing this dance again or a page we should not be trusting. Failing
   * closed costs the customer the link as a fallback; following blindly would
   * make the form's own markup a way to steer our server.
   */
  it("refuses a form action that points away from the confirmation endpoint", async () => {
    const calls = stubFetch((url, init) => {
      if (url === LANDED && (init.method ?? "GET") === "GET") {
        return html(200, '<form action="/mail/u/0/somewhere-else" method="post"></form>');
      }
      return html(200, DONE_PAGE);
    });
    await expect(new HttpForwardingConfirmer().confirm(LANDED)).rejects.toThrow(
      /not one of Google's/i,
    );
    // Nothing was posted anywhere.
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
});

describe("Confirming Gmail forwarding: the failures that look like success", () => {
  /**
   * ⚠️ THIS IS THE TEST THAT WOULD HAVE CAUGHT THE REAL DEFECT. A 200 carrying
   * the confirmation form is Google saying "not yet", and the first version of
   * this class called it done.
   */
  it("refuses to call a 200 that still shows the form a confirmation", async () => {
    stubFetch((url, init) =>
      init.method === "POST" ? html(200, CONFIRM_PAGE) : html(200, CONFIRM_PAGE),
    );
    await expect(new HttpForwardingConfirmer().confirm(LANDED)).rejects.toThrow(
      /still asking for confirmation/i,
    );
  });

  /**
   * A link that has already been used serves a page with nothing to submit.
   * Treating that as success would tell a customer their forwarding is live on
   * the strength of a page that never confirmed anything.
   */
  it("refuses a page with no form to submit", async () => {
    stubFetch(() => html(200, DONE_PAGE));
    await expect(new HttpForwardingConfirmer().confirm(LANDED)).rejects.toThrow(
      /may already have been used/i,
    );
  });
});

describe("Confirming Gmail forwarding: the SSRF boundary", () => {
  /**
   * ⚠️ REDIRECTS ARE RE-CHECKED, WHICH IS THE WHOLE REASON THEY ARE FOLLOWED BY
   * HAND. `redirect: "follow"` would obey this `Location` without asking, and
   * an open redirect on Google's own domain would then point our server
   * wherever the attacker liked.
   */
  it("refuses to follow a redirect off Google's hosts", async () => {
    const calls = stubFetch((url) =>
      url === START ? redirect("https://evil.test/steal") : html(200, CONFIRM_PAGE),
    );
    await expect(new HttpForwardingConfirmer().confirm(START)).rejects.toThrow(
      /not one of Google's/i,
    );
    expect(calls.map((call) => call.url)).toEqual([START]);
  });

  it("refuses a link that was never Google's to begin with", async () => {
    const calls = stubFetch(() => html(200, CONFIRM_PAGE));
    await expect(
      new HttpForwardingConfirmer().confirm("https://evil.test/mail/vf-abc"),
    ).rejects.toThrow(/not one of Google's/i);
    expect(calls).toEqual([]);
  });

  it("refuses the cancel endpoint even though it is Google's", async () => {
    stubFetch(() => html(200, CONFIRM_PAGE));
    await expect(
      new HttpForwardingConfirmer().confirm("https://mail.google.com/mail/uf-%5Btoken%5D-tail"),
    ).rejects.toThrow(/not one of Google's/i);
  });

  it("gives up rather than following a redirect loop forever", async () => {
    const calls = stubFetch(() => redirect(LANDED));
    await expect(new HttpForwardingConfirmer().confirm(START)).rejects.toThrow(/too many times/i);
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it("refuses a redirect that names nowhere", async () => {
    stubFetch(() => new Response(null, { status: 302 }));
    await expect(new HttpForwardingConfirmer().confirm(START)).rejects.toThrow(/to nowhere/i);
  });
});

describe("Confirming Gmail forwarding: what the customer is told", () => {
  it("reports a refusal by status, never by Google's own words", async () => {
    stubFetch(() => html(403, "<p>token abc123 is invalid for user jane@example.com</p>"));
    await expect(new HttpForwardingConfirmer().confirm(LANDED)).rejects.toThrow(
      "Google refused the confirmation (HTTP 403)",
    );
  });

  /**
   * ⚠️ THE ERROR TEXT IS STORED ON THE REQUEST ROW AND SHOWN ON A SCREEN, AND
   * THE URL CARRIES THE CONFIRMATION TOKEN. A message that quoted Google's body
   * — or the address it was fetching — would put that token in front of anyone
   * who can see the screen.
   */
  it("never leaks the confirmation token into the message", async () => {
    stubFetch(() => html(500, `error confirming ${LANDED}`));
    const error = await new HttpForwardingConfirmer()
      .confirm(LANDED)
      .catch((caught: unknown) => caught);
    expect((error as Error).message).not.toContain("example-token");
    expect((error as Error).message).toBe("Google refused the confirmation (HTTP 500)");
  });

  it("says so plainly when Google does not answer in time", async () => {
    stubFetch(() => {
      const timeout = new Error("timed out");
      timeout.name = "TimeoutError";
      return Promise.reject(timeout);
    });
    await expect(new HttpForwardingConfirmer().confirm(LANDED)).rejects.toThrow(
      "Google did not answer in time",
    );
  });

  it("says so plainly when Google cannot be reached", async () => {
    stubFetch(() => Promise.reject(new Error("ECONNRESET")));
    const error = await new HttpForwardingConfirmer()
      .confirm(LANDED)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForwardingConfirmationError);
    expect((error as Error).message).toBe("Google could not be reached");
  });
});

import { describe, expect, it } from "vitest";
import {
  MAILBOX_ERROR_MESSAGES,
  PROVIDER_ERROR_MESSAGES,
  mailboxErrorMessage,
  mailboxProviderFrom,
  needsConsentHelp,
} from "../src/capabilities/mailbox/mailbox-errors";

/**
 * The sentences a customer reads when connecting a mailbox goes wrong.
 *
 * ⚠️ THIS FILE EXISTED FOR THREE WEEKS WITH NOTHING PINNING IT, AND THAT IS THE
 * WHOLE REASON IT DRIFTED. Shipping Gmail made four of its messages untrue and
 * not one assertion failed, because copy has none unless somebody writes them.
 * The rule from 3.1b: pin it when you find it, and prove the pin by breaking it.
 *
 * The founder's ruling on 2026-08-22 — "they should be separate, no crossing
 * paths" — is what most of this file now enforces.
 */
describe("mailbox connect error messages", () => {
  /**
   * ⚠️ THE CODES `handleCallback` CAN RETURN FOR EITHER PROVIDER. It takes the
   * provider as an argument and every one of these is reachable from a Google
   * connection, so naming a provider in them is a claim we cannot make. This
   * list is the guard: it went red on `missing_code`, `exchange_failed` and
   * `connect_failed`, which is how the defect was found.
   */
  const SHARED_PATH_CODES = [
    "invalid_state",
    "missing_code",
    "exchange_failed",
    "connect_failed",
    "not_authorised",
    "module_not_entitled",
    "seat_limit_reached",
  ];

  it("never names one provider on a path both providers reach", () => {
    for (const code of SHARED_PATH_CODES) {
      const message = MAILBOX_ERROR_MESSAGES[code];
      expect(message, `${code} has no message`).toBeDefined();
      expect(message, code).not.toMatch(/microsoft|outlook|entra|google|gmail/i);
    }
  });

  it("keeps every provider-specific message out of the shared map", () => {
    // The structural half of the ruling: if a message names a provider it has
    // to live in that provider's map, where the other one cannot reach it.
    for (const [provider, messages] of Object.entries(PROVIDER_ERROR_MESSAGES)) {
      for (const code of Object.keys(messages)) {
        expect(MAILBOX_ERROR_MESSAGES[code], `${provider}.${code} leaked`).toBeUndefined();
      }
    }
  });

  describe("the two paths never cross", () => {
    it("tells a Gmail customer who cancelled that they cancelled — and nothing about admins", () => {
      const message = mailboxErrorMessage("consent_denied", "google");
      expect(message).toMatch(/cancelled/i);
      expect(message).toMatch(/google/i);
      // The defect: Google has no administrator to involve, so inventing one
      // hands them a step they cannot take.
      expect(message).not.toMatch(/microsoft|administrator|admin|approve/i);
    });

    it("still tells a Microsoft customer about their administrator", () => {
      // F1: the two causes are genuinely indistinguishable there, so hedging is
      // correct for Microsoft even though it would be wrong for Google.
      const message = mailboxErrorMessage("consent_denied", "microsoft");
      expect(message).toMatch(/administrator/i);
      expect(message).not.toMatch(/google|gmail/i);
    });

    it("never shows the Entra approval panel to a Google customer", () => {
      // `AdminConsentHelp` carries an approval link and an email to forward to
      // an IT contact. For someone who cancelled at Google it is fiction.
      expect(needsConsentHelp("consent_denied", "google")).toBe(false);
      expect(needsConsentHelp("admin_consent_required", "google")).toBe(false);
      expect(needsConsentHelp("consent_denied", "microsoft")).toBe(true);
    });

    it("keeps the Exchange licence story on the Microsoft side only", () => {
      // Only GraphMailProvider.probeMailbox raises it — Gmail's probe is a
      // documented no-op, so Google can never produce this code.
      expect(mailboxErrorMessage("mailbox_unavailable", "microsoft")).toMatch(/licence/i);
      expect(mailboxErrorMessage("mailbox_unavailable", "google")).not.toMatch(/licence|exchange/i);
    });
  });

  describe("reading the provider off the redirect", () => {
    it("recognises Google", () => {
      expect(mailboxProviderFrom("google")).toBe("google");
    });

    it("falls back to Microsoft for anything else, including old links", () => {
      // Every link written before this slice has no provider parameter at all.
      for (const value of [undefined, null, "", "microsoft", "MICROSOFT", ["google"], 7]) {
        expect(mailboxProviderFrom(value), String(value)).toBe("microsoft");
      }
    });
  });

  /**
   * The defect this slice fixed. A customer who clicks past Google's tickbox
   * connects successfully and can never send — so the message has to name the
   * tickbox, in Google's own words, or it is not a fix.
   */
  describe("send_permission_denied", () => {
    const message = PROVIDER_ERROR_MESSAGES.google.send_permission_denied!;

    it("quotes the checkbox Google actually shows", () => {
      expect(message).toContain("Send email on your behalf");
    });

    it("tells them to try again, because unlike F3 this one is fixable", () => {
      expect(message).toMatch(/try again/i);
    });

    it("does not blame the customer for a screen designed to be clicked through", () => {
      expect(message).not.toMatch(/you failed|you didn't|invalid|error|denied by you/i);
    });

    it("is reachable for Google and never for Microsoft", () => {
      expect(mailboxErrorMessage("send_permission_denied", "google")).toBe(message);
      expect(mailboxErrorMessage("send_permission_denied", "microsoft")).toBe(
        "Something went wrong — please try again.",
      );
    });
  });

  it("falls back to something harmless for a code it has never seen", () => {
    for (const provider of ["microsoft", "google"] as const) {
      expect(mailboxErrorMessage("something_new_from_a_future_slice", provider)).toBe(
        "Something went wrong — please try again.",
      );
    }
  });
});

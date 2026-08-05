import { describe, expect, it } from "vitest";
import {
  can,
  humanRefusal,
  readOnlyImportsLine,
  readOnlyInvoicesLine,
  type WriteAction,
} from "@/lib/permissions";

/**
 * Task 8's web half. The assertions worth having here are the ones about what
 * the screen does when it is UNSURE, and about the sentence a refused person
 * reads — both of which are decisions, not plumbing.
 */

describe("can", () => {
  const org = { name: "Acme Ltd", permissions: ["invoices:read", "imports:read"] };

  it("answers from the list the API sent", () => {
    expect(can(org, "invoices:read")).toBe(true);
    expect(can(org, "invoices:write")).toBe(false);
    expect(can(org, "imports:read")).toBe(true);
    expect(can(org, "imports:write")).toBe(false);
  });

  it("fails CLOSED when the API sent no list at all", () => {
    // An older API build, a partial response, a mocked fixture that forgot the
    // field. "I don't know" must read as "no" — the cost is a hidden button
    // with an explanation beside it, and the alternative is a button that 403s.
    expect(can({ name: "Acme Ltd" }, "invoices:write")).toBe(false);
    expect(can({ name: "Acme Ltd", permissions: [] }, "invoices:read")).toBe(false);
  });

  it("does not treat a role name as a permission", () => {
    // Guards against the shortcut this module exists to prevent: deciding from
    // the role rather than from what the organisation actually granted it.
    expect(can({ name: "Acme Ltd", permissions: ["owner"] }, "invoices:write")).toBe(false);
  });
});

describe("the read-only lines", () => {
  it("name the organisation, because being read-only in one is not being read-only in all", () => {
    expect(readOnlyInvoicesLine("Acme Ltd")).toContain("Acme Ltd");
    expect(readOnlyImportsLine("Acme Ltd")).toContain("Acme Ltd");
  });

  it("say who to ask, not just what is missing", () => {
    expect(readOnlyInvoicesLine("Acme Ltd")).toContain("owner or administrator");
    expect(readOnlyImportsLine("Acme Ltd")).toContain("owner or administrator");
  });

  it("never mentions a permission key", () => {
    // The whole point of this layer: a customer should not have to read
    // `invoices:write` to understand that they need to ask their boss.
    for (const line of [readOnlyInvoicesLine("Acme Ltd"), readOnlyImportsLine("Acme Ltd")]) {
      expect(line).not.toMatch(/invoices:|imports:|customers:|contacts:/);
    }
  });
});

describe("humanRefusal", () => {
  const ACTIONS: WriteAction[] = [
    "create-invoice",
    "edit-invoice",
    "record-payment",
    "change-invoice",
    "add-row",
    "upload-import",
    "confirm-import",
    "cancel-import",
  ];

  it("replaces a 403 with a sentence naming the action and who to ask", () => {
    expect(humanRefusal(403, "record-payment")).toBe(
      "Your role can't record payments. Ask an owner or administrator.",
    );
  });

  it("has a sentence for every write, and none of them leaks a permission key", () => {
    for (const action of ACTIONS) {
      const line = humanRefusal(403, action);
      expect(line, action).toBeTruthy();
      expect(line, action).not.toMatch(/invoices:|imports:|lacks permission|Role '/);
      expect(line, action).toContain("Ask an owner or administrator.");
    }
  });

  it("leaves every other status to the API's own wording", () => {
    /**
     * ⚠️ THIS IS THE ONE THAT MATTERS. The API's 4xx messages are written for
     * people and carry detail this layer does not have — "INV-3001 has already
     * changed since this page was loaded", "amount 'not-a-number' is not a
     * valid positive GBP amount", "Microsoft authorisation expired". Rewriting
     * those would undo defect F4, where a real instruction was replaced by
     * "unexpected error (400). Please try again."
     */
    for (const status of [400, 402, 404, 409, 422, 500, undefined]) {
      expect(humanRefusal(status, "create-invoice"), String(status)).toBeNull();
    }
  });
});

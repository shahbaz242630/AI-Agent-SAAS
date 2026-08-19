import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ClientPicker,
  type PickableClient,
} from "@/app/app/invoice-chasing/invoices/client-picker";

/**
 * The founder's scenario, 2026-08-18: *"a freelancer made content for Imran
 * Khalid, 1 client, then he/she made content for 2nd client also named imran
 * khalid"*.
 *
 * ⚠️ THE WARNING HAS TO FIRE BEFORE THE SAVE, NOT AFTER. The API refuses an
 * ambiguous name with a 409, which is correct and is also the worst moment to
 * find out — the whole invoice has been typed by then. This renders the picker
 * in the state a refusal leaves it in (the name filled, nothing picked) and
 * checks it says so on the spot.
 *
 * `renderToStaticMarkup` needs no DOM — the `SidebarBody` precedent. It can only
 * see the FIRST render, which is exactly why `defaultName` exists as a prop.
 */

const TWINS: PickableClient[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Imran Khalid",
    email: "imran@brightfold.example",
    reference: "IK-001",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "imran khalid",
    email: "i.khalid@meridian.example",
    reference: "IK-002",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Northgate Ltd",
    email: null,
    reference: null,
  },
];

describe("ClientPicker", () => {
  it("warns when the typed name belongs to more than one client", () => {
    const html = renderToStaticMarkup(<ClientPicker clients={TWINS} defaultName="Imran Khalid" />);
    expect(html).toContain("2 of your clients are called");
    // The instruction has to be the way out, not just the diagnosis.
    expect(html).toContain("Choose the one you mean");
  });

  it("matches the twins case-insensitively, exactly as the API does", () => {
    // "imran khalid" is stored lowercase on the second client. If this compared
    // raw strings the warning would miss the very pair it exists for, and the
    // person would meet the API's 409 instead.
    const html = renderToStaticMarkup(<ClientPicker clients={TWINS} defaultName="IMRAN KHALID" />);
    expect(html).toContain("2 of your clients are called");
  });

  it("says nothing when the name belongs to exactly one client", () => {
    const html = renderToStaticMarkup(<ClientPicker clients={TWINS} defaultName="Northgate Ltd" />);
    expect(html).not.toContain("of your clients are called");
  });

  it("says nothing on an empty form, so a new client is not nagged at", () => {
    const html = renderToStaticMarkup(<ClientPicker clients={TWINS} defaultName="" />);
    expect(html).not.toContain("of your clients are called");
    expect(html).toContain("or type a new name to create one");
  });

  it("carries no customerId until one is picked", () => {
    // The hidden field is what makes the API skip name matching. Present when
    // nothing has been chosen, it would send an invoice to whichever client
    // happened to be in state — so its absence here is the safety property.
    const html = renderToStaticMarkup(<ClientPicker clients={TWINS} defaultName="Imran Khalid" />);
    expect(html).not.toContain('name="customerId"');
  });

  it("renders with no clients at all, which is a new account's normal state", () => {
    const html = renderToStaticMarkup(<ClientPicker clients={[]} defaultName="" />);
    expect(html).toContain('name="clientName"');
  });
});
